//! `sd`: drive the running app from a terminal, a script or another Claude Code session. The app
//! serves `POST /sd` on 127.0.0.1 (its port in `<claude dir>/session-dashboard/port`, the hook
//! token in the `X-SD-Token` header); this is the client: a small HTTP/1.1 call over std's
//! TcpStream, the `sd …` command line, and the backend of the MCP server (`sd mcp`, mcp.rs).
//!
//! Started as `sd …` (a link or copy of the app binary named sd) or `session-dashboard sd …`.
//! `SD_PORT` and `SD_TOKEN` override the port file and the token (tests, scripts, a second app).
use serde_json::{json, Map, Value};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::{Duration, Instant};

/// The app may wait up to 60 s for its window before it answers; a little more than that.
const READ_TIMEOUT: Duration = Duration::from_secs(75);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
/// How often `sd wait` and `wait_for_session` ask for the status.
pub const POLL: Duration = Duration::from_secs(2);

pub const USAGE: &str = "sd: drive Session Dashboard from a terminal, a script or another Claude Code session

Usage:
  sd list [--query Q] [--status S] [--workspace W] [--json]
  sd new --dir D [--prompt P | --prompt -] [--name N] [--model M] [--effort E]
         [--mode M] [--worktree] [--open] [--json]       prints the new session's id
  sd send <session> <text...>        text \"-\" reads it from stdin
  sd read <session> [--last N] [--json]
  sd status <session> [--json]       first line: the status alone
  sd wait <session> [--timeout SECONDS] [--json]
  sd stop <session>
  sd open <session>                  show it in the dashboard window
  sd mcp                             MCP server on stdio (for Claude Code)
  sd help

<session> is an id, an id prefix (6+ characters) or a unique part of the title.
Status: starting, working, waiting_permission, waiting_input, idle, done_unseen, error, stopped.

sd wait asks every 2 s until the session is no longer starting or working (timeout 600 s).
Exit codes: 0 ok; for wait 0 idle or done_unseen, 2 waiting for you (waiting_permission,
waiting_input), 1 error, stopped or timeout. 1 when the app is not running or says no,
64 bad usage.

Runs as `sd` (a link or copy of the app binary named sd) or as `session-dashboard sd ...`.
For Claude Code:  claude mcp add session-dashboard -- /path/to/session-dashboard sd mcp
SD_PORT and SD_TOKEN override the app's port file and token (tests, scripts).
";

#[derive(Debug, Clone, PartialEq)]
pub enum SdError {
    /// connection refused or no port file: the app is not running (detail may be empty)
    NotRunning(String),
    /// HTTP 504 or no answer in time: the app is running but did not answer
    NoAnswer,
    /// the app answered with `{"error": …}`
    App(String),
    Other(String),
}

impl std::fmt::Display for SdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SdError::NotRunning(d) if d.is_empty() => write!(f, "Session Dashboard is not running"),
            SdError::NotRunning(d) => write!(f, "Session Dashboard is not running ({d})"),
            SdError::NoAnswer => write!(f, "Session Dashboard did not answer in time (it waits up to 60 s for its window); try again"),
            SdError::App(m) | SdError::Other(m) => f.write_str(m),
        }
    }
}

/// A backend: `cmd` + `args` → the app's result object. The real one is [`call`]; tests pass fakes.
pub type Backend<'a> = dyn Fn(&str, Value) -> Result<Value, SdError> + Sync + 'a;

fn port_file() -> std::path::PathBuf {
    crate::claude::discover::claude_dir().join("session-dashboard").join("port")
}

/// The app's port and token: `SD_PORT`/`SD_TOKEN`, else the port file and the hook token.
pub fn endpoint() -> Result<(u16, String), SdError> {
    let port = match std::env::var("SD_PORT") {
        Ok(p) => p.trim().parse::<u16>().map_err(|_| SdError::Other(format!("SD_PORT is not a port: {p}")))?,
        Err(_) => {
            let f = port_file();
            let s = std::fs::read_to_string(&f).map_err(|_| SdError::NotRunning(format!("no {}", f.display())))?;
            s.trim().parse::<u16>().ok().filter(|p| *p != 0).ok_or_else(|| SdError::NotRunning(format!("no port in {}", f.display())))?
        }
    };
    let token = std::env::var("SD_TOKEN").ok().filter(|t| !t.trim().is_empty()).map(|t| t.trim().to_string()).unwrap_or_else(crate::claude::hooks::hook_token);
    Ok((port, token))
}

/// One command to the running app.
pub fn call(cmd: &str, args: Value) -> Result<Value, SdError> {
    let (port, token) = endpoint()?;
    call_at(port, &token, cmd, args, READ_TIMEOUT)
}

pub fn call_at(port: u16, token: &str, cmd: &str, args: Value, timeout: Duration) -> Result<Value, SdError> {
    let body = serde_json::to_vec(&json!({"cmd": cmd, "args": args})).unwrap_or_default();
    let (status, resp) = post(port, token, &body, timeout)?;
    interpret(status, &resp)
}

fn post(port: u16, token: &str, body: &[u8], timeout: Duration) -> Result<(u16, Vec<u8>), SdError> {
    if token.bytes().any(|b| b.is_ascii_control()) {
        return Err(SdError::Other("the token has control characters".into()));
    }
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).map_err(|e| match e.kind() {
        io::ErrorKind::ConnectionRefused => SdError::NotRunning(String::new()),
        io::ErrorKind::TimedOut => SdError::NotRunning(format!("nothing answers on port {port}")),
        _ => SdError::Other(format!("cannot reach Session Dashboard on port {port}: {e}")),
    })?;
    let _ = s.set_read_timeout(Some(timeout));
    let _ = s.set_write_timeout(Some(Duration::from_secs(10)));
    let head = format!(
        "POST /sd HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nAccept: application/json\r\nX-SD-Token: {token}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    s.write_all(head.as_bytes())
        .and_then(|_| s.write_all(body))
        .and_then(|_| s.flush())
        .map_err(|e| SdError::Other(format!("cannot send to Session Dashboard: {e}")))?;
    read_response(BufReader::new(s)).map_err(|e| match e.kind() {
        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut => SdError::NoAnswer,
        io::ErrorKind::UnexpectedEof => SdError::Other("Session Dashboard closed the connection without answering (a wrong token? see SD_TOKEN or the hook-token file)".into()),
        _ => SdError::Other(format!("bad answer from Session Dashboard: {e}")),
    })
}

/// An HTTP/1.1 response: the status code and the body (Content-Length, chunked, or up to EOF).
fn read_response<R: BufRead>(mut r: R) -> io::Result<(u16, Vec<u8>)> {
    let bad = |m: &str| io::Error::new(io::ErrorKind::InvalidData, m.to_string());
    loop {
        let mut line = String::new();
        if r.read_line(&mut line)? == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        let mut parts = line.split_whitespace();
        if !parts.next().is_some_and(|v| v.starts_with("HTTP/1.")) {
            return Err(bad("not an HTTP/1.x status line"));
        }
        let status: u16 = parts.next().and_then(|c| c.parse().ok()).ok_or_else(|| bad("no status code"))?;
        let mut len: Option<usize> = None;
        let mut chunked = false;
        let mut header_bytes = 0;
        loop {
            let mut h = String::new();
            let n = r.read_line(&mut h)?;
            header_bytes += n;
            if n == 0 {
                return Err(io::ErrorKind::UnexpectedEof.into());
            }
            if header_bytes > 64 * 1024 {
                return Err(bad("headers too long"));
            }
            if h == "\r\n" || h == "\n" {
                break;
            }
            if let Some((k, v)) = h.split_once(':') {
                match k.trim().to_ascii_lowercase().as_str() {
                    "content-length" => len = Some(v.trim().parse().map_err(|_| bad("bad Content-Length"))?),
                    "transfer-encoding" => chunked = v.to_ascii_lowercase().contains("chunked"),
                    _ => {}
                }
            }
        }
        // 1xx (100 Continue): another status line follows
        if (100..200).contains(&status) {
            continue;
        }
        let mut body = Vec::new();
        if chunked {
            loop {
                let mut size = String::new();
                r.read_line(&mut size)?;
                let size = usize::from_str_radix(size.trim().split(';').next().unwrap_or(""), 16).map_err(|_| bad("bad chunk size"))?;
                if size == 0 {
                    break;
                }
                let start = body.len();
                body.resize(start + size, 0);
                r.read_exact(&mut body[start..])?;
                let mut crlf = String::new();
                r.read_line(&mut crlf)?;
            }
        } else if let Some(n) = len {
            body.resize(n, 0);
            r.read_exact(&mut body)?;
        } else {
            r.read_to_end(&mut body)?;
        }
        return Ok((status, body));
    }
}

fn interpret(status: u16, body: &[u8]) -> Result<Value, SdError> {
    let v: Option<Value> = serde_json::from_slice(body).ok();
    let err = v.as_ref().and_then(|v| v.get("error")).map(|e| e.as_str().map(str::to_string).unwrap_or_else(|| e.to_string()));
    match status {
        200 => match (v, err) {
            (_, Some(e)) => Err(SdError::App(e)),
            (Some(v), None) if v.is_object() => Ok(v),
            _ => Err(SdError::Other("Session Dashboard answered something that is not a JSON object".into())),
        },
        504 => Err(SdError::NoAnswer),
        401 | 403 => Err(SdError::App(err.unwrap_or_else(|| "Session Dashboard refused the token (see SD_TOKEN or the hook-token file)".into()))),
        404 => Err(SdError::App(err.unwrap_or_else(|| "this Session Dashboard has no /sd endpoint yet (update the app)".into()))),
        _ => Err(SdError::App(err.unwrap_or_else(|| format!("Session Dashboard answered HTTP {status}")))),
    }
}

// ---- waiting -------------------------------------------------------------------------------

pub struct WaitEnd {
    pub status: Value,
    pub timed_out: bool,
}

/// Asks for the status every `interval` until the session is no longer starting or working, or
/// `timeout` passes. A 504 from a busy app is retried; `cancelled` ends the wait early.
pub fn wait_for(backend: &Backend, session: &str, timeout: Duration, interval: Duration, cancelled: &dyn Fn() -> bool) -> Result<WaitEnd, SdError> {
    let deadline = Instant::now() + timeout;
    let mut last = None;
    loop {
        match backend("status", json!({"session": session})) {
            Ok(st) => {
                if !matches!(st.get("status").and_then(Value::as_str), Some("starting" | "working")) {
                    return Ok(WaitEnd { status: st, timed_out: false });
                }
                last = Some(st);
            }
            Err(SdError::NoAnswer) => {}
            Err(e) => return Err(e),
        }
        if Instant::now() >= deadline {
            return Ok(WaitEnd { status: last.unwrap_or_else(|| json!({"status": "unknown"})), timed_out: true });
        }
        let until = (Instant::now() + interval).min(deadline);
        loop {
            if cancelled() {
                return Err(SdError::Other("cancelled".into()));
            }
            let now = Instant::now();
            if now >= until {
                break;
            }
            std::thread::sleep((until - now).min(Duration::from_millis(200)));
        }
    }
}

/// `sd wait`'s exit code: 0 done, 2 waiting for the human, 1 error, stopped or timeout.
pub fn wait_exit(end: &WaitEnd) -> i32 {
    if end.timed_out {
        return 1;
    }
    match end.status.get("status").and_then(Value::as_str) {
        Some("idle" | "done_unseen") => 0,
        Some("waiting_permission" | "waiting_input") => 2,
        _ => 1,
    }
}

/// The text of the last assistant message in a `read` result.
pub fn last_assistant(read: &Value) -> Option<String> {
    read.get("messages")?.as_array()?.iter().rev().find(|m| m.get("role").and_then(Value::as_str) == Some("assistant")).and_then(|m| m.get("text")).and_then(Value::as_str).map(str::to_string)
}

// ---- output --------------------------------------------------------------------------------

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

/// A value for one line: strings as they are, anything else as compact JSON.
fn inline(v: &Value) -> String {
    match v {
        Value::String(s) => s.replace('\n', " "),
        Value::Null => String::new(),
        v => v.to_string(),
    }
}

fn clip(t: &str, max: usize) -> String {
    let t = t.replace(['\n', '\r', '\t'], " ");
    if t.chars().count() <= max {
        return t;
    }
    let mut c: String = t.chars().take(max - 1).collect();
    c.push('…');
    c
}

fn short_path(p: &str) -> String {
    let home = crate::sys::home().to_string_lossy().replace('\\', "/");
    let n = p.replace('\\', "/");
    match n.strip_prefix(&home) {
        Some(rest) if !home.is_empty() && (rest.is_empty() || rest.starts_with('/')) => format!("~{rest}"),
        _ => n,
    }
}

/// The `list` result as aligned columns. `full_ids` for models (MCP), short ids for people.
pub fn fmt_list(v: &Value, full_ids: bool) -> String {
    let sessions = v.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default();
    if sessions.is_empty() {
        return "No sessions.\n".into();
    }
    let mut rows = vec![["ID".to_string(), "STATUS".into(), "TITLE".into(), "FOLDER".into()]];
    for x in &sessions {
        let id = s(x, "id");
        let id = if full_ids { id.to_string() } else { id.chars().take(8).collect() };
        let mut status = s(x, "status").to_string();
        if x.get("unread").and_then(Value::as_bool) == Some(true) && status != "done_unseen" {
            status.push_str(" *");
        }
        let mut folder = short_path(s(x, "cwd"));
        if let Some(m) = x.get("machine").and_then(Value::as_str).filter(|m| !m.is_empty()) {
            folder = format!("{m}:{folder}");
        }
        rows.push([id, status, clip(s(x, "title"), 60), folder]);
    }
    let width = |i: usize| rows.iter().map(|r| r[i].chars().count()).max().unwrap_or(0);
    let w = [width(0), width(1), width(2)];
    let mut out = String::new();
    for r in &rows {
        let line = format!("{:<a$}  {:<b$}  {:<c$}  {}", r[0], r[1], r[2], r[3], a = w[0], b = w[1], c = w[2]);
        out.push_str(line.trim_end());
        out.push('\n');
    }
    out
}

/// The `read` result as a plain transcript.
pub fn fmt_read(v: &Value) -> String {
    let mut out = format!("{}  [{}]  {}\n", s(v, "title"), s(v, "status"), s(v, "id"));
    for m in v.get("messages").and_then(Value::as_array).into_iter().flatten() {
        out.push('\n');
        out.push_str(&format!("[{}]", s(m, "role")));
        if let Some(at) = m.get("at").filter(|a| !a.is_null()) {
            out.push_str(&format!(" {}", inline(at)));
        }
        out.push('\n');
        out.push_str(s(m, "text").trim_end());
        out.push('\n');
    }
    out
}

/// The `status` result for a terminal: the status alone on the first line, details after it.
pub fn fmt_status(v: &Value) -> String {
    let mut out = format!("{}\n", s(v, "status"));
    out.push_str(&format!("title: {}\nid: {}\n", s(v, "title"), s(v, "id")));
    for (k, label) in [("outcome", "outcome"), ("waitingFor", "waiting for")] {
        if let Some(x) = v.get(k).filter(|x| !x.is_null()) {
            out.push_str(&format!("{label}: {}\n", inline(x)));
        }
    }
    out
}

// ---- the command line ----------------------------------------------------------------------

#[derive(Debug, PartialEq)]
pub enum Cmd {
    Help,
    Mcp,
    List { query: Option<String>, status: Option<String>, workspace: Option<String>, json: bool },
    New { dir: String, prompt: Option<String>, name: Option<String>, model: Option<String>, effort: Option<String>, mode: Option<String>, worktree: bool, open: bool, json: bool },
    /// text "-": read from stdin
    Send { session: String, text: String },
    Read { session: String, last: Option<u64>, json: bool },
    Status { session: String, json: bool },
    Wait { session: String, timeout: u64, json: bool },
    Stop { session: String },
    Open { session: String },
}

struct Parsed {
    pos: Vec<String>,
    vals: std::collections::HashMap<&'static str, String>,
    flags: std::collections::HashSet<&'static str>,
}

impl Parsed {
    fn val(&mut self, k: &str) -> Option<String> {
        self.vals.remove(k)
    }
    fn flag(&self, k: &str) -> bool {
        self.flags.contains(k)
    }
}

/// `--name value`, `--name=value` and `--flag`; `--` ends the options.
fn split(args: &[String], values: &[&'static str], bools: &[&'static str]) -> Result<Parsed, String> {
    let mut p = Parsed { pos: vec![], vals: Default::default(), flags: Default::default() };
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "--" {
            p.pos.extend(it.by_ref().cloned());
            break;
        }
        let Some(opt) = a.strip_prefix("--") else {
            p.pos.push(a.clone());
            continue;
        };
        let (name, inline) = match opt.split_once('=') {
            Some((n, v)) => (n, Some(v.to_string())),
            None => (opt, None),
        };
        if let Some(k) = values.iter().find(|k| **k == name) {
            let v = match inline {
                Some(v) => v,
                None => it.next().cloned().ok_or_else(|| format!("--{name} needs a value"))?,
            };
            p.vals.insert(k, v);
        } else if let Some(k) = bools.iter().find(|k| **k == name) {
            if inline.is_some() {
                return Err(format!("--{name} takes no value"));
            }
            p.flags.insert(k);
        } else {
            return Err(format!("unknown option --{name}"));
        }
    }
    Ok(p)
}

fn one_session(p: &Parsed, cmd: &str) -> Result<String, String> {
    match p.pos.as_slice() {
        [s] if !s.trim().is_empty() => Ok(s.clone()),
        [] => Err(format!("sd {cmd} needs a session (id, id prefix or part of the title)")),
        _ => Err(format!("sd {cmd} takes one session, got: {}", p.pos.join(" "))),
    }
}

fn number(v: Option<String>, name: &str) -> Result<Option<u64>, String> {
    v.map(|v| v.trim().parse::<u64>().map_err(|_| format!("--{name} needs a whole number, got {v}"))).transpose()
}

pub fn parse(args: &[String]) -> Result<Cmd, String> {
    let Some(sub) = args.first() else { return Ok(Cmd::Help) };
    let rest = &args[1..];
    if sub != "send" && rest.iter().any(|a| a == "--help" || a == "-h") {
        return Ok(Cmd::Help);
    }
    let no_pos = |p: &Parsed, cmd: &str| if p.pos.is_empty() { Ok(()) } else { Err(format!("sd {cmd} takes no argument {}", p.pos[0])) };
    Ok(match sub.as_str() {
        "help" | "-h" | "--help" => Cmd::Help,
        "mcp" => {
            no_pos(&split(rest, &[], &[])?, "mcp")?;
            Cmd::Mcp
        }
        "list" | "ls" => {
            let mut p = split(rest, &["query", "status", "workspace"], &["json"])?;
            no_pos(&p, "list")?;
            Cmd::List { query: p.val("query"), status: p.val("status"), workspace: p.val("workspace"), json: p.flag("json") }
        }
        "new" => {
            let mut p = split(rest, &["dir", "prompt", "name", "model", "effort", "mode"], &["worktree", "open", "json"])?;
            no_pos(&p, "new")?;
            let dir = p.val("dir").filter(|d| !d.trim().is_empty()).ok_or("sd new needs --dir (the project folder)")?;
            Cmd::New { dir, prompt: p.val("prompt"), name: p.val("name"), model: p.val("model"), effort: p.val("effort"), mode: p.val("mode"), worktree: p.flag("worktree"), open: p.flag("open"), json: p.flag("json") }
        }
        "send" => {
            // everything after the session is the message, options included
            let session = rest.first().filter(|s| !s.trim().is_empty()).ok_or("sd send needs a session and a message")?.clone();
            let mut words = &rest[1..];
            if words.first().map(String::as_str) == Some("--") {
                words = &words[1..];
            }
            let text = words.join(" ");
            if text.trim().is_empty() {
                return Err("sd send needs a message (or - to read it from stdin)".into());
            }
            Cmd::Send { session, text }
        }
        "read" => {
            let mut p = split(rest, &["last"], &["json"])?;
            Cmd::Read { session: one_session(&p, "read")?, last: number(p.val("last"), "last")?, json: p.flag("json") }
        }
        "status" => {
            let p = split(rest, &[], &["json"])?;
            Cmd::Status { session: one_session(&p, "status")?, json: p.flag("json") }
        }
        "wait" => {
            let mut p = split(rest, &["timeout"], &["json"])?;
            Cmd::Wait { session: one_session(&p, "wait")?, timeout: number(p.val("timeout"), "timeout")?.unwrap_or(600), json: p.flag("json") }
        }
        "stop" => Cmd::Stop { session: one_session(&split(rest, &[], &[])?, "stop")? },
        "open" => Cmd::Open { session: one_session(&split(rest, &[], &[])?, "open")? },
        other => return Err(format!("unknown command {other}")),
    })
}

fn read_stdin() -> Result<String, SdError> {
    let mut t = String::new();
    io::stdin().read_to_string(&mut t).map_err(|e| SdError::Other(format!("cannot read stdin: {e}")))?;
    let t = t.trim_end_matches(['\n', '\r']).to_string();
    if t.trim().is_empty() {
        return Err(SdError::Other("stdin was empty".into()));
    }
    Ok(t)
}

fn pretty(v: &Value) -> String {
    format!("{}\n", serde_json::to_string_pretty(v).unwrap_or_default())
}

fn put(o: &mut Map<String, Value>, k: &str, v: Option<String>) {
    if let Some(v) = v {
        o.insert(k.into(), Value::String(v));
    }
}

/// Runs one command (stdin already read): the text for stdout and the exit code.
pub fn run(cmd: Cmd, backend: &Backend, poll: Duration) -> Result<(String, i32), SdError> {
    let id_line = |v: &Value| format!("{}\n", s(v, "id"));
    Ok(match cmd {
        Cmd::Help => (USAGE.to_string(), 0),
        Cmd::Mcp => unreachable!("handled by main"),
        Cmd::List { query, status, workspace, json } => {
            let mut a = Map::new();
            put(&mut a, "query", query);
            put(&mut a, "status", status);
            put(&mut a, "workspace", workspace);
            let v = backend("list", Value::Object(a))?;
            (if json { pretty(&v) } else { fmt_list(&v, false) }, 0)
        }
        Cmd::New { dir, prompt, name, model, effort, mode, worktree, open, json } => {
            let mut a = Map::new();
            put(&mut a, "dir", Some(dir));
            put(&mut a, "prompt", prompt);
            put(&mut a, "name", name);
            put(&mut a, "model", model);
            put(&mut a, "effort", effort);
            put(&mut a, "permissionMode", mode);
            if worktree {
                a.insert("worktree".into(), true.into());
            }
            if open {
                a.insert("open".into(), true.into());
            }
            let v = backend("new", Value::Object(a))?;
            (if json { pretty(&v) } else { id_line(&v) }, 0)
        }
        Cmd::Send { session, text } => (id_line(&backend("send", json!({"session": session, "text": text}))?), 0),
        Cmd::Read { session, last, json } => {
            let mut a = json!({"session": session});
            if let Some(n) = last {
                a["last"] = n.into();
            }
            let v = backend("read", a)?;
            (if json { pretty(&v) } else { fmt_read(&v) }, 0)
        }
        Cmd::Status { session, json } => {
            let v = backend("status", json!({"session": session}))?;
            (if json { pretty(&v) } else { fmt_status(&v) }, 0)
        }
        Cmd::Wait { session, timeout, json } => {
            let end = wait_for(backend, &session, Duration::from_secs(timeout), poll, &|| false)?;
            let code = wait_exit(&end);
            let text = if json {
                let mut v = end.status.clone();
                if let Some(o) = v.as_object_mut() {
                    o.insert("timedOut".into(), end.timed_out.into());
                }
                pretty(&v)
            } else if end.timed_out {
                format!("timeout\n{}", fmt_status(&end.status).split_once('\n').map(|x| x.1).unwrap_or(""))
            } else {
                fmt_status(&end.status)
            };
            (text, code)
        }
        Cmd::Stop { session } => (id_line(&backend("stop", json!({"session": session}))?), 0),
        Cmd::Open { session } => (id_line(&backend("open", json!({"session": session}))?), 0),
    })
}

/// `sd …`: parses, runs and prints; returns the exit code.
pub fn main(args: &[String]) -> i32 {
    #[cfg(windows)]
    attach_parent_console();
    let mut cmd = match parse(args) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("sd: {e}\nRun `sd help` for usage.");
            return 64;
        }
    };
    if cmd == Cmd::Mcp {
        return crate::mcp::run_stdio();
    }
    // `--prompt -` and `sd send <session> -`: the text from stdin
    let stdin_text = match &mut cmd {
        Cmd::New { prompt: Some(p), .. } if p == "-" => Some(p),
        Cmd::Send { text, .. } if text == "-" => Some(text),
        _ => None,
    };
    if let Some(t) = stdin_text {
        match read_stdin() {
            Ok(s) => *t = s,
            Err(e) => {
                eprintln!("sd: {e}");
                return 1;
            }
        }
    }
    match run(cmd, &call, POLL) {
        Ok((text, code)) => {
            // not println!: a closed pipe (`sd list | head -1`) must not panic
            let mut out = io::stdout().lock();
            let _ = out.write_all(text.as_bytes());
            let _ = out.flush();
            code
        }
        Err(e) => {
            eprintln!("sd: {e}");
            1
        }
    }
}

/// The program name a command line was started with (argv[0]'s file name, without .exe).
pub fn prog_name(argv0: &str) -> String {
    let name = argv0.rsplit(['/', '\\']).next().unwrap_or(argv0);
    let lower = name.to_ascii_lowercase();
    match lower.strip_suffix(".exe") {
        Some(stem) => stem.to_string(),
        None => lower,
    }
}

/// Windows: the release app is a GUI-subsystem program (`windows_subsystem = "windows"` in
/// main.rs), so it starts without a console and `sd` would print nowhere. Attach to the console
/// of the shell that started it; Rust's stdout/stderr look up the standard handle on every write,
/// so println/eprintln reach that console from then on. Handles a parent passed explicitly (pipes,
/// files: `sd list > x`, an MCP client's stdio) are kept: "When attaching to a new console,
/// standard handles are always replaced with console handles unless STARTF_USESTDHANDLES was
/// specified during process creation" (learn.microsoft.com/windows/console/getstdhandle).
/// AttachConsole(ATTACH_PARENT_PROCESS = (DWORD)-1): learn.microsoft.com/windows/console/attachconsole.
/// It fails harmlessly when there is no parent console or the program already has one (debug
/// builds are console programs). kernel32 is always linked, so no crate is needed for one call.
/// A shell still does not wait for a GUI program (cmd returns to its prompt at once and drops the
/// exit code); for scripts and Claude Code that run it with pipes this does not matter.
#[cfg(windows)]
fn attach_parent_console() {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn AttachConsole(process_id: u32) -> i32;
    }
    const ATTACH_PARENT_PROCESS: u32 = u32::MAX;
    // SAFETY: a plain Win32 call with a constant argument
    unsafe {
        AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::Mutex;

    fn a(s: &str) -> Vec<String> {
        s.split_whitespace().map(String::from).collect()
    }

    #[test]
    fn parses_commands() {
        assert_eq!(parse(&[]).unwrap(), Cmd::Help);
        assert_eq!(parse(&a("help")).unwrap(), Cmd::Help);
        assert_eq!(parse(&a("list --help")).unwrap(), Cmd::Help);
        assert_eq!(parse(&a("mcp")).unwrap(), Cmd::Mcp);
        assert_eq!(
            parse(&a("list --json --query login --status=working")).unwrap(),
            Cmd::List { query: Some("login".into()), status: Some("working".into()), workspace: None, json: true }
        );
        assert_eq!(
            parse(&a("new --dir /tmp/x --prompt - --mode plan --worktree --open --model opus --effort high --name N")).unwrap(),
            Cmd::New {
                dir: "/tmp/x".into(),
                prompt: Some("-".into()),
                name: Some("N".into()),
                model: Some("opus".into()),
                effort: Some("high".into()),
                mode: Some("plan".into()),
                worktree: true,
                open: true,
                json: false
            }
        );
        assert_eq!(parse(&a("send abc123 fix the --json bug")).unwrap(), Cmd::Send { session: "abc123".into(), text: "fix the --json bug".into() });
        assert_eq!(parse(&a("send abc123 -- -v flag")).unwrap(), Cmd::Send { session: "abc123".into(), text: "-v flag".into() });
        assert_eq!(parse(&a("send abc123 -")).unwrap(), Cmd::Send { session: "abc123".into(), text: "-".into() });
        assert_eq!(parse(&a("read abc123 --last 5 --json")).unwrap(), Cmd::Read { session: "abc123".into(), last: Some(5), json: true });
        assert_eq!(parse(&a("status abc123")).unwrap(), Cmd::Status { session: "abc123".into(), json: false });
        assert_eq!(parse(&a("wait abc123")).unwrap(), Cmd::Wait { session: "abc123".into(), timeout: 600, json: false });
        assert_eq!(parse(&a("wait abc123 --timeout 30 --json")).unwrap(), Cmd::Wait { session: "abc123".into(), timeout: 30, json: true });
        assert_eq!(parse(&a("stop abc123")).unwrap(), Cmd::Stop { session: "abc123".into() });
        assert_eq!(parse(&a("open abc123")).unwrap(), Cmd::Open { session: "abc123".into() });
    }

    #[test]
    fn rejects_bad_usage() {
        assert!(parse(&a("frobnicate")).unwrap_err().contains("unknown command"));
        assert!(parse(&a("new --prompt hi")).unwrap_err().contains("--dir"));
        assert!(parse(&a("new --dir")).unwrap_err().contains("needs a value"));
        assert!(parse(&a("list --bogus")).unwrap_err().contains("unknown option"));
        assert!(parse(&a("list extra")).is_err());
        assert!(parse(&a("read")).unwrap_err().contains("needs a session"));
        assert!(parse(&a("read a b")).unwrap_err().contains("one session"));
        assert!(parse(&a("read abc --last many")).unwrap_err().contains("whole number"));
        assert!(parse(&a("send abc123")).unwrap_err().contains("needs a message"));
        assert!(parse(&a("wait abc --json=1")).unwrap_err().contains("takes no value"));
    }

    #[test]
    fn program_name() {
        assert_eq!(prog_name("/usr/local/bin/sd"), "sd");
        assert_eq!(prog_name(r"C:\Tools\SD.EXE"), "sd");
        assert_eq!(prog_name("session-dashboard"), "session-dashboard");
        assert_eq!(prog_name(r"C:\Program Files\Session Dashboard\session-dashboard.exe"), "session-dashboard");
    }

    #[test]
    fn runs_against_a_backend() {
        let seen = Mutex::new(vec![]);
        let backend = |cmd: &str, args: Value| -> Result<Value, SdError> {
            seen.lock().unwrap().push((cmd.to_string(), args.clone()));
            Ok(match cmd {
                "list" => json!({"sessions": [
                    {"id": "0123456789abcdef", "title": "Fix login", "status": "working", "cwd": "/srv/app", "control": "app", "updatedAt": 1},
                    {"id": "fedcba9876543210", "title": "Docs", "status": "idle", "cwd": "/srv/docs", "machine": "box", "control": "app", "updatedAt": 2, "unread": true}
                ]}),
                "new" => json!({"id": "newid-1", "title": "T"}),
                _ => json!({"id": "0123456789abcdef", "title": "Fix login", "status": "idle"}),
            })
        };
        let (out, code) = run(parse(&a("list")).unwrap(), &backend, Duration::ZERO).unwrap();
        assert_eq!(code, 0);
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines[0], "ID        STATUS   TITLE      FOLDER");
        assert_eq!(lines[1], "01234567  working  Fix login  /srv/app");
        assert_eq!(lines[2], "fedcba98  idle *   Docs       box:/srv/docs");
        let (out, _) = run(parse(&a("new --dir /srv/app --prompt hi --mode plan --worktree")).unwrap(), &backend, Duration::ZERO).unwrap();
        assert_eq!(out, "newid-1\n");
        let (out, code) = run(parse(&a("wait 012345")).unwrap(), &backend, Duration::ZERO).unwrap();
        assert_eq!((out.lines().next(), code), (Some("idle"), 0));
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0], ("list".to_string(), json!({})));
        assert_eq!(seen[1], ("new".to_string(), json!({"dir": "/srv/app", "prompt": "hi", "permissionMode": "plan", "worktree": true})));
        assert_eq!(seen[2], ("status".to_string(), json!({"session": "012345"})));
    }

    #[test]
    fn wait_polls_until_done_and_maps_exit_codes() {
        let n = Mutex::new(0);
        let backend = |_: &str, _: Value| -> Result<Value, SdError> {
            let mut n = n.lock().unwrap();
            *n += 1;
            match *n {
                1 => Ok(json!({"status": "starting"})),
                2 => Err(SdError::NoAnswer),
                3 => Ok(json!({"status": "working"})),
                _ => Ok(json!({"status": "waiting_permission", "waitingFor": "Bash: rm -rf build"})),
            }
        };
        let end = wait_for(&backend, "x", Duration::from_secs(5), Duration::ZERO, &|| false).unwrap();
        assert_eq!(*n.lock().unwrap(), 4);
        assert_eq!(wait_exit(&end), 2);
        let busy = |_: &str, _: Value| -> Result<Value, SdError> { Ok(json!({"status": "working"})) };
        let end = wait_for(&busy, "x", Duration::from_millis(50), Duration::from_millis(10), &|| false).unwrap();
        assert!(end.timed_out);
        assert_eq!(wait_exit(&end), 1);
        assert_eq!(wait_exit(&WaitEnd { status: json!({"status": "done_unseen"}), timed_out: false }), 0);
        assert_eq!(wait_exit(&WaitEnd { status: json!({"status": "error"}), timed_out: false }), 1);
        let gone = |_: &str, _: Value| -> Result<Value, SdError> { Err(SdError::NotRunning(String::new())) };
        assert_eq!(wait_for(&gone, "x", Duration::from_secs(1), Duration::ZERO, &|| false).err(), Some(SdError::NotRunning(String::new())));
    }

    /// A one-request HTTP server on a free port; `answer` gets (token header, body) and returns the
    /// raw response bytes.
    fn serve_once(answer: impl FnOnce(String, Value) -> String + Send + 'static) -> (u16, std::thread::JoinHandle<()>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            let (s, _) = l.accept().unwrap();
            let mut r = BufReader::new(s.try_clone().unwrap());
            let mut first = String::new();
            r.read_line(&mut first).unwrap();
            assert!(first.starts_with("POST /sd HTTP/1.1"), "{first}");
            let (mut len, mut token, mut close) = (0, String::new(), false);
            loop {
                let mut h = String::new();
                r.read_line(&mut h).unwrap();
                if h == "\r\n" {
                    break;
                }
                let (k, v) = h.split_once(':').unwrap();
                match k.to_ascii_lowercase().as_str() {
                    "content-length" => len = v.trim().parse().unwrap(),
                    "x-sd-token" => token = v.trim().to_string(),
                    "connection" => close = v.trim() == "close",
                    _ => {}
                }
            }
            assert!(close);
            let mut body = vec![0; len];
            r.read_exact(&mut body).unwrap();
            let resp = answer(token, serde_json::from_slice(&body).unwrap());
            (&s).write_all(resp.as_bytes()).unwrap();
        });
        (port, h)
    }

    fn http(status: &str, body: &str) -> String {
        format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
    }

    #[test]
    fn http_client_sends_token_and_reads_result() {
        let (port, h) = serve_once(|token, body| {
            if token != "secret-token" {
                return http("401 Unauthorized", r#"{"error":"bad token"}"#);
            }
            assert_eq!(body, json!({"cmd": "status", "args": {"session": "abc123"}}));
            http("200 OK", r#"{"id":"abc123def","title":"Fix","status":"idle"}"#)
        });
        let v = call_at(port, "secret-token", "status", json!({"session": "abc123"}), Duration::from_secs(5)).unwrap();
        assert_eq!(v["status"], "idle");
        h.join().unwrap();
        // a wrong token
        let (port, h) = serve_once(|token, _| if token == "secret-token" { http("200 OK", "{}") } else { http("401 Unauthorized", r#"{"error":"bad token"}"#) });
        assert_eq!(call_at(port, "nope", "list", json!({}), Duration::from_secs(5)), Err(SdError::App("bad token".into())));
        h.join().unwrap();
    }

    #[test]
    fn http_client_errors() {
        // the app's own error
        let (port, h) = serve_once(|_, _| http("200 OK", r#"{"error":"ambiguous: Fix login (0123ab), Fix logout (4567cd)"}"#));
        assert_eq!(call_at(port, "t", "status", json!({"session": "Fix"}), Duration::from_secs(5)), Err(SdError::App("ambiguous: Fix login (0123ab), Fix logout (4567cd)".into())));
        h.join().unwrap();
        // 504: the app did not answer
        let (port, h) = serve_once(|_, _| http("504 Gateway Timeout", r#"{"error":"timeout"}"#));
        let e = call_at(port, "t", "list", json!({}), Duration::from_secs(5)).unwrap_err();
        assert_eq!(e, SdError::NoAnswer);
        assert!(e.to_string().contains("did not answer"));
        h.join().unwrap();
        // closed without an answer (what the app's hook server does on a wrong token)
        let (port, h) = serve_once(|_, _| String::new());
        assert!(call_at(port, "t", "list", json!({}), Duration::from_secs(5)).unwrap_err().to_string().contains("without answering"));
        h.join().unwrap();
        // chunked transfer encoding
        let (port, h) = serve_once(|_, _| "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n7\r\n{\"id\":\"\r\n4\r\nab\"}\r\n0\r\n\r\n".to_string());
        assert_eq!(call_at(port, "t", "stop", json!({"session": "ab"}), Duration::from_secs(5)).unwrap(), json!({"id": "ab"}));
        h.join().unwrap();
        // nothing listening: not running
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let e = call_at(port, "t", "list", json!({}), Duration::from_secs(5)).unwrap_err();
        assert_eq!(e.to_string(), "Session Dashboard is not running");
    }

    #[test]
    fn http_client_times_out_as_no_answer() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            let (s, _) = l.accept().unwrap();
            std::thread::sleep(Duration::from_millis(600));
            drop(s);
        });
        assert_eq!(call_at(port, "t", "list", json!({}), Duration::from_millis(200)), Err(SdError::NoAnswer));
        h.join().unwrap();
    }

    #[test]
    fn formats_read_and_status() {
        let r = json!({"id": "abc", "title": "Fix", "status": "idle", "messages": [
            {"role": "user", "text": "fix it", "at": "2026-11-21T10:00:00Z"},
            {"role": "assistant", "text": "Done.\n"}
        ]});
        assert_eq!(fmt_read(&r), "Fix  [idle]  abc\n\n[user] 2026-11-21T10:00:00Z\nfix it\n\n[assistant]\nDone.\n");
        assert_eq!(last_assistant(&r).as_deref(), Some("Done.\n"));
        let st = json!({"id": "abc", "title": "Fix", "status": "waiting_permission", "waitingFor": {"tool": "Bash"}});
        assert_eq!(fmt_status(&st), "waiting_permission\ntitle: Fix\nid: abc\nwaiting for: {\"tool\":\"Bash\"}\n");
        assert_eq!(fmt_list(&json!({"sessions": []}), false), "No sessions.\n");
    }
}
