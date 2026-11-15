//! Session discovery: live sessions from `claude agents --json` (the documented way to read session
//! state from outside Claude Code) and every past session from
//! `~/.claude/projects/<slug>/<session>.jsonl`. Transcripts can be tens of MB, so the list only
//! reads the head and the tail of each file and caches the result by (size, mtime).

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, UNIX_EPOCH};

pub fn claude_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("CLAUDE_CONFIG_DIR") {
        return PathBuf::from(dir);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    Path::new(&home).join(".claude")
}

/// The `claude` binary: what the user's shell would run. Desktop launches often have a minimal
/// PATH, so the usual install places are tried too.
pub fn claude_bin() -> String {
    if let Ok(p) = std::env::var("SD_CLAUDE_BIN") {
        return p;
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        format!("{home}/.npm-global/bin/claude"),
        format!("{home}/.local/bin/claude"),
        format!("{home}/.claude/local/claude"),
        "/usr/local/bin/claude".to_string(),
        "/usr/bin/claude".to_string(),
        "/opt/homebrew/bin/claude".to_string(),
    ];
    for c in candidates {
        if Path::new(&c).exists() {
            return c;
        }
    }
    "claude".into()
}

/// Spawned claude processes must not look like children of another Claude Code session (the
/// app may itself be started from one): drop the session-scoped variables, keep the user's config.
pub fn clean_env(cmd: &mut Command) {
    for (k, _) in std::env::vars() {
        if k == "CLAUDECODE" || k.starts_with("CLAUDE_CODE_") || k == "CLAUDE_PID" || k == "CLAUDE_EFFORT" {
            cmd.env_remove(k);
        }
    }
}

/// What this claude offers, asked once without talking to a model: the `initialize` answer
/// (models with their effort levels and fast-mode support, output styles, agents, slash commands
/// and skills, the default permission mode, the account) plus the user's cloud sessions.
pub fn capabilities() -> Result<Value, String> {
    host_requests(vec![("cloud", serde_json::json!({"subtype": "list_cloud_sessions"}))], Duration::from_secs(20)).map(|mut m| {
        serde_json::json!({"init": m.remove("initialize").unwrap_or(Value::Null), "cloud": m.remove("cloud").unwrap_or(Value::Null)})
    })
}

/// pids of the short-lived helper claudes below: they write a pid file like any session, so the
/// session list leaves them out
static HELPERS: Mutex<Vec<u32>> = Mutex::new(Vec::new());

/// A claude the built-in terminal opened only for one of its menus (`SD_HIDE=1 claude /mcp`): not a
/// session to list.
fn hidden(pid: u64) -> bool {
    std::fs::read(format!("/proc/{pid}/environ")).map(|e| e.split(|b| *b == 0).any(|v| v == b"SD_HIDE=1")).unwrap_or(false)
}

fn is_helper(pid: u64) -> bool {
    HELPERS.lock().map(|h| h.contains(&(pid as u32))).unwrap_or(false)
}

/// Start claude as an SDK host would (no model call), send `initialize` and then `requests`, and
/// collect the answers by their id ("initialize" for the first). For questions only the program
/// that started the CLI may ask: cloud sessions and their transcripts.
pub fn host_requests(requests: Vec<(&str, Value)>, timeout: Duration) -> Result<serde_json::Map<String, Value>, String> {
    use std::io::{BufRead, BufReader, Write};
    let mut cmd = Command::new(claude_bin());
    cmd.args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-prompt-tool", "stdio"])
        .current_dir(std::env::var("HOME").unwrap_or_else(|_| "/".into()))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    clean_env(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("cannot run claude: {e}"))?;
    let pid = child.id();
    HELPERS.lock().unwrap().push(pid);
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let mut all = vec![("initialize".to_string(), serde_json::json!({"subtype": "initialize", "hooks": null}))];
    all.extend(requests.into_iter().map(|(id, r)| (id.to_string(), r)));
    let want = all.len();
    for (id, req) in &all {
        writeln!(stdin, "{}", serde_json::json!({"type": "control_request", "request_id": id, "request": req})).map_err(|e| e.to_string())?;
    }
    stdin.flush().ok();
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let (tx, rx) = std::sync::mpsc::channel::<Value>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if v.get("type").and_then(Value::as_str) == Some("control_response") && tx.send(v).is_err() {
                    break;
                }
            }
        }
    });
    let mut out = serde_json::Map::new();
    let deadline = std::time::Instant::now() + timeout;
    while out.len() < want {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            break;
        }
        match rx.recv_timeout(left) {
            Ok(v) => {
                let r = v.get("response").cloned().unwrap_or(Value::Null);
                let id = r.get("request_id").and_then(Value::as_str).unwrap_or("").to_string();
                let body = if r.get("subtype").and_then(Value::as_str) == Some("error") {
                    serde_json::json!({"status": "error", "message": r.get("error").cloned().unwrap_or(Value::Null)})
                } else {
                    r.get("response").cloned().unwrap_or(Value::Null)
                };
                out.insert(id, body);
            }
            Err(_) => break,
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    HELPERS.lock().unwrap().retain(|p| *p != pid);
    Ok(out)
}

/// The words Claude Code's spinner uses ("Drizzling…", and "Cooked for 26s" when a turn ends),
/// read from the installed claude itself so the app says what the terminal says. Cached per claude
/// build; the user's `spinnerVerbs` setting (append or replace) applies on top. None found: just
/// "Working" / "Worked".
pub fn spinner_verbs() -> Value {
    let bin = std::fs::canonicalize(claude_bin()).unwrap_or_else(|_| PathBuf::from(claude_bin()));
    let stamp = std::fs::metadata(&bin).map(|m| format!("{}:{}", m.len(), m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0))).unwrap_or_default();
    let cache = std::path::Path::new(&std::env::var("HOME").unwrap_or_default()).join(".config/session-dashboard/verbs.json");
    let mut found: Option<(Vec<String>, Vec<String>)> = None;
    if let Ok(v) = std::fs::read_to_string(&cache).map(|s| serde_json::from_str::<Value>(&s).unwrap_or(Value::Null)) {
        if v["stamp"] == stamp.as_str() {
            let list = |k: &str| v[k].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect::<Vec<_>>()).unwrap_or_default();
            found = Some((list("present"), list("past")));
        }
    }
    if found.is_none() {
        let (present, past) = scan_verbs(&bin);
        let _ = std::fs::create_dir_all(cache.parent().unwrap());
        let _ = std::fs::write(&cache, serde_json::json!({"stamp": stamp, "present": present, "past": past}).to_string());
        found = Some((present, past));
    }
    let (mut present, mut past) = found.unwrap_or_default();
    if present.is_empty() {
        present = vec!["Working".into()];
    }
    if past.is_empty() {
        past = vec!["Worked".into()];
    }
    // the user's own verbs (settings.json "spinnerVerbs": {"mode": "append"|"replace", "verbs": [...]})
    if let Ok(s) = std::fs::read_to_string(claude_dir().join("settings.json")) {
        if let Ok(v) = serde_json::from_str::<Value>(&s) {
            let sv = &v["spinnerVerbs"];
            let mine: Vec<String> = sv["verbs"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
            if !mine.is_empty() {
                if sv["mode"] == "replace" {
                    present = mine;
                } else {
                    present.extend(mine);
                }
            }
        }
    }
    serde_json::json!({"present": present, "past": past})
}

/// A JavaScript string array in the claude bundle that contains `needle` (e.g. `"Cooked"`):
/// its strings, with \xNN / \uNNNN escapes decoded.
fn js_array(data: &[u8], needle: &[u8]) -> Vec<String> {
    let Some(at) = data.windows(needle.len()).position(|w| w == needle) else { return vec![] };
    let Some(open) = data[at.saturating_sub(4000)..at].iter().rposition(|c| *c == b'[').map(|i| at.saturating_sub(4000) + i) else { return vec![] };
    let Some(close) = data[at..(at + 8000).min(data.len())].iter().position(|c| *c == b']').map(|i| at + i) else { return vec![] };
    let text = String::from_utf8_lossy(&data[open + 1..close]).to_string();
    let mut out = Vec::new();
    for part in text.split("\",\"") {
        let w = part.trim_matches('"');
        let mut s = String::new();
        let mut chars = w.chars().peekable();
        while let Some(c) = chars.next() {
            if c == '\\' {
                match chars.next() {
                    Some('x') => {
                        let h: String = chars.by_ref().take(2).collect();
                        if let Some(ch) = u32::from_str_radix(&h, 16).ok().and_then(char::from_u32) {
                            s.push(ch);
                        }
                    }
                    Some('u') => {
                        let h: String = chars.by_ref().take(4).collect();
                        if let Some(ch) = u32::from_str_radix(&h, 16).ok().and_then(char::from_u32) {
                            s.push(ch);
                        }
                    }
                    Some(o) => s.push(o),
                    None => {}
                }
            } else {
                s.push(c);
            }
        }
        // only words: the array must be the verb list, not code that happens to mention one
        if s.is_empty() || s.len() > 32 || !s.chars().next().map(|c| c.is_uppercase()).unwrap_or(false) || s.contains(' ') {
            return vec![];
        }
        out.push(s);
    }
    out
}

fn scan_verbs(bin: &Path) -> (Vec<String>, Vec<String>) {
    let Ok(data) = std::fs::read(bin) else { return (vec![], vec![]) };
    (js_array(&data, b"\"Accomplishing\",\"Actioning\""), js_array(&data, b"\"Cogitated\",\"Cooked\""))
}

/// One long-lived helper claude for the cloud questions (list, transcript pages): starting a
/// claude per question took 1–3 s, so a running cloud session looked frozen. The helper is an SDK
/// host that never sends a prompt (no model calls); it is restarted when it dies.
#[derive(Default)]
pub struct HostHelper(Mutex<Option<Helper>>);

pub struct Helper {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    pending: std::sync::Arc<Mutex<HashMap<String, std::sync::mpsc::Sender<Value>>>>,
}

impl HostHelper {
    fn spawn() -> Result<Helper, String> {
        use std::io::{BufRead, BufReader, Write};
        let mut cmd = Command::new(claude_bin());
        cmd.args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-prompt-tool", "stdio"])
            .current_dir(std::env::var("HOME").unwrap_or_else(|_| "/".into()))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        clean_env(&mut cmd);
        let mut child = cmd.spawn().map_err(|e| format!("cannot run claude: {e}"))?;
        let pid = child.id();
        HELPERS.lock().unwrap().push(pid);
        let mut stdin = child.stdin.take().ok_or("no stdin")?;
        writeln!(stdin, "{}", serde_json::json!({"type": "control_request", "request_id": "helper-init", "request": {"subtype": "initialize", "hooks": null}})).map_err(|e| e.to_string())?;
        stdin.flush().ok();
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let pending: std::sync::Arc<Mutex<HashMap<String, std::sync::mpsc::Sender<Value>>>> = Default::default();
        let p2 = pending.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                if v.get("type").and_then(Value::as_str) != Some("control_response") {
                    continue;
                }
                let r = v.get("response").cloned().unwrap_or(Value::Null);
                let id = r.get("request_id").and_then(Value::as_str).unwrap_or("").to_string();
                let body = if r.get("subtype").and_then(Value::as_str) == Some("error") {
                    serde_json::json!({"status": "error", "message": r.get("error").cloned().unwrap_or(Value::Null)})
                } else {
                    r.get("response").cloned().unwrap_or(Value::Null)
                };
                if let Some(tx) = p2.lock().unwrap().remove(&id) {
                    let _ = tx.send(body);
                }
            }
            // gone: waiting questions fail at once, the next one starts a new helper
            p2.lock().unwrap().clear();
            HELPERS.lock().unwrap().retain(|p| *p != pid);
        });
        Ok(Helper { child, stdin, pending })
    }

    /// Ask the helper one control request and wait for its answer.
    pub fn request(&self, req: Value, timeout: Duration) -> Result<Value, String> {
        use std::io::Write;
        let id = format!("h-{}", uuid::Uuid::new_v4());
        let (tx, rx) = std::sync::mpsc::channel();
        {
            let mut g = self.0.lock().unwrap();
            let dead = match g.as_mut() {
                Some(h) => !matches!(h.child.try_wait(), Ok(None)),
                None => true,
            };
            if dead {
                *g = Some(Self::spawn()?);
            }
            let h = g.as_mut().unwrap();
            h.pending.lock().unwrap().insert(id.clone(), tx);
            let line = serde_json::json!({"type": "control_request", "request_id": id, "request": req});
            if writeln!(h.stdin, "{line}").and_then(|_| h.stdin.flush()).is_err() {
                let _ = h.child.kill();
                *g = None;
                return Err("the helper claude stopped".into());
            }
        }
        rx.recv_timeout(timeout).map_err(|_| "claude did not answer".to_string())
    }

    pub fn stop(&self) {
        if let Some(mut h) = self.0.lock().unwrap().take() {
            let _ = h.child.kill();
        }
    }
}

/// The account's cloud sessions (claude.ai/code, Remote Control): {status, sessions, truncated}.
pub fn cloud_list(helper: &HostHelper) -> Result<Value, String> {
    let req = serde_json::json!({"subtype": "list_cloud_sessions", "user_initiated": false});
    if let Ok(v) = helper.request(req.clone(), Duration::from_secs(25)) {
        return Ok(v);
    }
    let mut m = host_requests(vec![("cloud", req)], Duration::from_secs(25))?;
    m.remove("cloud").ok_or_else(|| "claude did not answer".into())
}

/// One page of a cloud session's stored transcript: {status, entries, next_cursor}.
pub fn cloud_transcript(helper: &HostHelper, session_id: &str, cursor: Option<String>) -> Result<Value, String> {
    let mut req = serde_json::json!({"subtype": "get_cloud_session_transcript", "session_id": session_id});
    if let Some(c) = cursor {
        req["cursor"] = Value::String(c);
    }
    if let Ok(v) = helper.request(req.clone(), Duration::from_secs(30)) {
        return Ok(v);
    }
    let mut m = host_requests(vec![("t", req)], Duration::from_secs(30))?;
    m.remove("t").ok_or_else(|| "claude did not answer".into())
}

/// Send a message to a cloud session (`claude -p <text> --cloud <id>`): {ok, session_id, url}.
pub fn cloud_send(session_id: &str, text: &str) -> Result<Value, String> {
    if !session_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err("bad session id".into());
    }
    let mut cmd = Command::new(claude_bin());
    cmd.args(["-p", "--cloud", session_id, "--output-format", "json"])
        .current_dir(std::env::var("HOME").unwrap_or_else(|_| "/".into()))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    clean_env(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("cannot run claude: {e}"))?;
    let pid = child.id();
    HELPERS.lock().unwrap().push(pid);
    {
        use std::io::Write;
        let mut w = child.stdin.take().ok_or("no stdin")?;
        w.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string());
    HELPERS.lock().unwrap().retain(|p| *p != pid);
    let out = out?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let line = stdout.lines().rev().find(|l| l.trim_start().starts_with('{')).unwrap_or("");
    match serde_json::from_str::<Value>(line) {
        Ok(v) => Ok(v),
        Err(_) => {
            let err = String::from_utf8_lossy(&out.stderr);
            Err(err.lines().chain(stdout.lines()).filter(|l| !l.trim().is_empty()).last().unwrap_or("claude failed").to_string())
        }
    }
}

/// `claude agents --json`: running sessions (interactive and background) with their status.
pub fn live_sessions() -> Result<Value, String> {
    let mut lc = Command::new(claude_bin());
    clean_env(&mut lc);
    let mut child = lc
        .args(["agents", "--json"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("cannot run claude: {e}"))?;
    let mut out = String::new();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() > deadline => {
                let _ = child.kill();
                return Err("claude agents --json timed out".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(40)),
            Err(e) => return Err(e.to_string()),
        }
    }
    if let Some(mut so) = child.stdout.take() {
        let _ = so.read_to_string(&mut out);
    }
    let mut v: Value = serde_json::from_str(&out).map_err(|e| format!("bad claude agents output: {e}"))?;
    if let Some(list) = v.as_array_mut() {
        list.retain(|s| !s.get("pid").and_then(Value::as_u64).map(is_helper).unwrap_or(false));
    }
    Ok(v)
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub session_id: String,
    pub path: String,
    pub cwd: Option<String>,
    /// where the session was started (its first record): a session started in ~ that went on in
    /// a repo is a cross-repo agent, not that repo's
    pub start_cwd: Option<String>,
    /// the other folders it worked in (distinct, a few)
    pub cwds: Vec<String>,
    pub ai_title: Option<String>,
    pub agent_name: Option<String>,
    pub first_prompt: Option<String>,
    pub last_prompt: Option<String>,
    pub git_branch: Option<String>,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub cost_usd: Option<f64>,
    pub lines_added: Option<u64>,
    pub lines_removed: Option<u64>,
    pub pr_url: Option<String>,
    pub pr_number: Option<u64>,
    pub created_at: Option<String>,
    pub last_at: Option<String>,
    /// file modification time, ms since epoch
    pub updated_ms: u64,
    pub size: u64,
    /// role of the last conversational record ("user" / "assistant") and whether the last
    /// assistant record ended the turn: tells "finished" from "stopped mid-turn"
    pub last_role: Option<String>,
    pub ended_turn: bool,
    pub last_text: Option<String>,
    /// what the session did last: "Edit src/x.ts", "Bash: npm test", …
    pub last_activity: Option<String>,
}

/// Live interactive sessions from `~/.claude/sessions/<pid>.json`, cheap enough to poll every few
/// seconds. An entry counts only while its process is alive and is the same process (pid reuse is
/// checked against the recorded start time).
pub fn pid_sessions() -> Vec<Value> {
    let dir = claude_dir().join("sessions");
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(&dir) else { return out };
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        // claude rewrites the file in place: a read can catch it half-written, so try once more
        // (a skipped file made the session look stopped for a poll)
        let read = || fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
        let Some(v) = read().or_else(|| {
            std::thread::sleep(std::time::Duration::from_millis(15));
            read()
        }) else {
            continue;
        };
        let Some(pid) = v.get("pid").and_then(Value::as_u64) else { continue };
        if is_helper(pid) || hidden(pid) {
            continue;
        }
        let Ok(stat) = fs::read_to_string(format!("/proc/{pid}/stat")) else { continue };
        // field 22 (starttime) comes after the parenthesised command name
        let start = stat.rsplit_once(')').map(|(_, rest)| rest.split_whitespace().nth(19).unwrap_or("").to_string()).unwrap_or_default();
        if let Some(rec) = v.get("procStart").and_then(Value::as_str) {
            if rec != start {
                continue;
            }
        }
        out.push(v);
    }
    out
}

fn tool_activity(name: &str, input: &Value) -> String {
    let s = |k: &str| input.get(k).and_then(Value::as_str).unwrap_or("");
    let file = |k: &str| {
        let p = s(k);
        p.rsplit('/').next().unwrap_or(p).to_string()
    };
    match name {
        "Bash" => format!("Running {}", s("command").lines().next().unwrap_or("").chars().take(80).collect::<String>()),
        "Edit" | "MultiEdit" => format!("Editing {}", file("file_path")),
        "Write" => format!("Writing {}", file("file_path")),
        "Read" => format!("Reading {}", file("file_path")),
        "Grep" => format!("Searching for {}", s("pattern").chars().take(60).collect::<String>()),
        "Glob" => format!("Finding {}", s("pattern")),
        "WebFetch" | "WebSearch" => "Reading the web".into(),
        "Task" | "Agent" => format!("Running a subagent: {}", s("description")),
        "TodoWrite" => "Updating the plan".into(),
        other => format!("Using {other}"),
    }
}

struct Cached {
    size: u64,
    mtime: u64,
    meta: SessionMeta,
}

#[derive(Default)]
pub struct ScanCache(Mutex<HashMap<PathBuf, Cached>>);

const HEAD: u64 = 256 * 1024;
const TAIL: u64 = 768 * 1024;

fn read_range(f: &mut File, start: u64, len: u64) -> Vec<u8> {
    let mut buf = vec![0u8; len as usize];
    if f.seek(SeekFrom::Start(start)).is_err() {
        return vec![];
    }
    let mut n = 0;
    while n < buf.len() {
        match f.read(&mut buf[n..]) {
            Ok(0) => break,
            Ok(k) => n += k,
            Err(_) => break,
        }
    }
    buf.truncate(n);
    buf
}

/// Text of a user message, or None for tool results, meta and command wrappers.
pub fn user_text(v: &Value) -> Option<String> {
    if v.get("isMeta").and_then(Value::as_bool) == Some(true) || v.get("isCompactSummary").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let content = v.get("message")?.get("content")?;
    let text = match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => {
            let mut out = String::new();
            for p in parts {
                match p.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(t) = p.get("text").and_then(Value::as_str) {
                            out.push_str(t);
                        }
                    }
                    Some("tool_result") => return None,
                    _ => {}
                }
            }
            out
        }
        _ => return None,
    };
    let t = text.trim();
    if t.is_empty() || t.starts_with('<') || t.starts_with("Caveat:") {
        return None;
    }
    Some(t.chars().take(400).collect())
}

fn assistant_text(v: &Value) -> Option<String> {
    let parts = v.get("message")?.get("content")?.as_array()?;
    let mut out = String::new();
    for p in parts {
        if p.get("type").and_then(Value::as_str) == Some("text") {
            if let Some(t) = p.get("text").and_then(Value::as_str) {
                out.push_str(t);
            }
        }
    }
    let t = out.trim();
    if t.is_empty() { None } else { Some(t.chars().take(700).collect()) }
}

fn apply_line(m: &mut SessionMeta, v: &Value, from_tail: bool) {
    let ty = v.get("type").and_then(Value::as_str).unwrap_or("");
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    if v.get("isSidechain").and_then(Value::as_bool) == Some(true) {
        return;
    }
    match ty {
        "ai-title" => m.ai_title = s("aiTitle").or(m.ai_title.take()),
        "agent-name" => m.agent_name = s("agentName").or(m.agent_name.take()),
        "last-prompt" => m.last_prompt = s("lastPrompt").map(|p| p.chars().take(400).collect()).or(m.last_prompt.take()),
        "permission-mode" => m.permission_mode = s("permissionMode").or(m.permission_mode.take()),
        "cost-state" => {
            m.cost_usd = v.get("totalCostUSD").and_then(Value::as_f64).or(m.cost_usd);
            m.lines_added = v.get("totalLinesAdded").and_then(Value::as_u64).or(m.lines_added);
            m.lines_removed = v.get("totalLinesRemoved").and_then(Value::as_u64).or(m.lines_removed);
        }
        "pr-link" => {
            m.pr_url = s("prUrl").or(m.pr_url.take());
            m.pr_number = v.get("prNumber").and_then(Value::as_u64).or(m.pr_number);
        }
        "user" | "assistant" => {
            if let Some(c) = s("cwd") {
                if !from_tail && m.start_cwd.is_none() {
                    m.start_cwd = Some(c.clone());
                }
                if !m.cwds.contains(&c) && m.cwds.len() < 8 {
                    m.cwds.push(c.clone());
                }
                if m.cwd.is_none() || from_tail {
                    m.cwd = Some(c);
                }
            }
            if let Some(b) = s("gitBranch") {
                if !b.is_empty() && (m.git_branch.is_none() || from_tail) {
                    m.git_branch = Some(b);
                }
            }
            if let Some(t) = s("timestamp") {
                if m.created_at.is_none() {
                    m.created_at = Some(t.clone());
                }
                m.last_at = Some(t);
            }
            if ty == "user" {
                if let Some(t) = user_text(v) {
                    if m.first_prompt.is_none() && !from_tail {
                        m.first_prompt = Some(t.clone());
                    }
                    m.last_role = Some("user".into());
                    m.ended_turn = false;
                } else if v.get("message").and_then(|x| x.get("content")).and_then(Value::as_array).is_some() {
                    // tool results keep the turn going
                    m.last_role = Some("tool".into());
                    m.ended_turn = false;
                }
            } else {
                if let Some(model) = v.get("message").and_then(|x| x.get("model")).and_then(Value::as_str) {
                    if !model.starts_with('<') {
                        m.model = Some(model.to_string());
                    }
                }
                let stop = v.get("message").and_then(|x| x.get("stop_reason")).and_then(Value::as_str);
                let has_tool = v
                    .get("message")
                    .and_then(|x| x.get("content"))
                    .and_then(Value::as_array)
                    .map(|a| a.iter().any(|p| p.get("type").and_then(Value::as_str) == Some("tool_use")))
                    .unwrap_or(false);
                if let Some(t) = assistant_text(v) {
                    m.last_text = Some(t);
                }
                if let Some(tu) = v
                    .get("message")
                    .and_then(|x| x.get("content"))
                    .and_then(Value::as_array)
                    .and_then(|a| a.iter().rev().find(|p| p.get("type").and_then(Value::as_str) == Some("tool_use")))
                {
                    let name = tu.get("name").and_then(Value::as_str).unwrap_or("tool");
                    m.last_activity = Some(tool_activity(name, tu.get("input").unwrap_or(&Value::Null)));
                }
                m.last_role = Some("assistant".into());
                m.ended_turn = !has_tool && stop != Some("tool_use");
            }
        }
        _ => {}
    }
}

fn parse_chunk(m: &mut SessionMeta, bytes: &[u8], skip_first: bool, from_tail: bool) {
    let mut lines = bytes.split(|b| *b == b'\n');
    if skip_first {
        lines.next();
    }
    for line in lines {
        if line.len() < 2 {
            continue;
        }
        // skip the heavy records without parsing them
        if memfind(line, br#""type":"api-request"#) || memfind(line, br#""type":"file-history"#) || memfind(line, br#""type":"attachment""#) {
            continue;
        }
        if let Ok(v) = serde_json::from_slice::<Value>(line) {
            apply_line(m, &v, from_tail);
        }
    }
}

/// Whether a record line has `needle` near its start or its end. Record keys like `"type"` sit at
/// one end: older Claude Code wrote them first, newer versions write them after `message`, so a
/// long answer puts them past the first few KB (looking only at the head dropped long answers).
pub fn memfind(hay: &[u8], needle: &[u8]) -> bool {
    const EDGE: usize = 4096;
    let n = needle.len();
    if hay.len() < n {
        return false;
    }
    if hay.len() <= 2 * EDGE {
        return hay.windows(n).any(|w| w == needle);
    }
    hay[..EDGE + n].windows(n).any(|w| w == needle) || hay[hay.len() - EDGE - n..].windows(n).any(|w| w == needle)
}

fn scan_file(path: &Path, size: u64, mtime: u64) -> Option<SessionMeta> {
    let session_id = path.file_stem()?.to_str()?.to_string();
    let mut f = File::open(path).ok()?;
    let mut m = SessionMeta { session_id, path: path.to_string_lossy().into(), updated_ms: mtime, size, ..Default::default() };
    if size <= HEAD + TAIL {
        let all = read_range(&mut f, 0, size);
        parse_chunk(&mut m, &all, false, false);
    } else {
        let head = read_range(&mut f, 0, HEAD);
        // the head may end mid-line: drop its last partial line
        let cut = head.iter().rposition(|b| *b == b'\n').unwrap_or(0);
        parse_chunk(&mut m, &head[..cut], false, false);
        let tail = read_range(&mut f, size - TAIL, TAIL);
        parse_chunk(&mut m, &tail, true, true);
    }
    Some(m)
}

/// Every session transcript under ~/.claude/projects (subagent transcripts excluded).
pub fn scan(cache: &ScanCache) -> Vec<SessionMeta> {
    let root = claude_dir().join("projects");
    let mut out = Vec::new();
    let mut seen = Vec::new();
    let Ok(dirs) = fs::read_dir(&root) else { return out };
    for d in dirs.flatten() {
        let Ok(files) = fs::read_dir(d.path()) else { continue };
        for f in files.flatten() {
            let p = f.path();
            if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(md) = f.metadata() else { continue };
            let size = md.len();
            let mtime = md.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
            seen.push(p.clone());
            let mut c = cache.0.lock().unwrap();
            if let Some(hit) = c.get(&p) {
                if hit.size == size && hit.mtime == mtime {
                    out.push(hit.meta.clone());
                    continue;
                }
            }
            drop(c);
            if let Some(meta) = scan_file(&p, size, mtime) {
                c = cache.0.lock().unwrap();
                c.insert(p, Cached { size, mtime, meta: meta.clone() });
                out.push(meta);
            }
        }
    }
    cache.0.lock().unwrap().retain(|k, _| seen.contains(k));
    out
}
