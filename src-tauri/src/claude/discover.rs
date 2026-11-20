//! Session discovery: live sessions from `claude agents --json` (the documented way to read session
//! state from outside Claude Code) and every past session from
//! `~/.claude/projects/<slug>/<session>.jsonl`. Transcripts can be tens of MB, so the list only
//! reads the head and the tail of each file and caches the result by (size, mtime).

use serde::{Deserialize, Serialize};
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
    crate::sys::home().join(".claude")
}

static EXTRA_DIRS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

/// Other Claude Code config folders (other accounts, `CLAUDE_CONFIG_DIR=~/.claude-work`), set from
/// the app's settings. Their sessions, transcripts and usage are read too.
pub fn set_extra_dirs(dirs: &[String]) {
    let home = crate::sys::home();
    let main = claude_dir();
    let list = dirs
        .iter()
        .map(|d| if let Some(rest) = d.strip_prefix("~/") { home.join(rest) } else { PathBuf::from(d) })
        .filter(|d| d.is_dir() && *d != main)
        .collect();
    *EXTRA_DIRS.lock().unwrap() = list;
}

/// Every config folder: the main one first.
pub fn claude_dirs() -> Vec<PathBuf> {
    let mut v = vec![claude_dir()];
    v.extend(EXTRA_DIRS.lock().unwrap().iter().cloned());
    v
}

/// The other config folder a path lies in, if any (None for the main one).
pub fn extra_dir_of(path: &Path) -> Option<String> {
    EXTRA_DIRS.lock().unwrap().iter().find(|d| path.starts_with(d)).map(|d| d.to_string_lossy().to_string())
}

/// The `claude` binary: what the user's shell would run. Desktop launches often have a minimal
/// PATH, so the usual install places are tried too.
pub fn claude_bin() -> String {
    if let Ok(p) = std::env::var("SD_CLAUDE_BIN") {
        return p;
    }
    let home = crate::sys::home();
    let h = |rel: &str| home.join(rel).to_string_lossy().to_string();
    #[cfg(windows)]
    let candidates = [
        h(".local\\bin\\claude.exe"),
        h("AppData\\Roaming\\npm\\claude.cmd"),
        h(".claude\\local\\claude.exe"),
        String::new(),
        String::new(),
        String::new(),
    ];
    #[cfg(not(windows))]
    let candidates = [
        h(".npm-global/bin/claude"),
        h(".local/bin/claude"),
        h(".claude/local/claude"),
        "/usr/local/bin/claude".to_string(),
        "/usr/bin/claude".to_string(),
        "/opt/homebrew/bin/claude".to_string(),
    ];
    for c in candidates {
        if !c.is_empty() && Path::new(&c).exists() {
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
        serde_json::json!({"init": m.remove("initialize").unwrap_or(Value::Null), "cloud": m.remove("cloud").unwrap_or(Value::Null), "effort": effort_settings()})
    })
}

/// The effort a session gets when none is chosen, from your Claude Code settings: `effortLevel`
/// and `modelSettings.<model>.effortLevel` (claude itself does not report it). Null: not set.
fn effort_settings() -> Value {
    let dir = std::env::var("CLAUDE_CONFIG_DIR").map(std::path::PathBuf::from).unwrap_or_else(|_| crate::sys::home().join(".claude"));
    let v: Value = std::fs::read_to_string(dir.join("settings.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    let mut by_model = serde_json::Map::new();
    if let Some(ms) = v.get("modelSettings").and_then(Value::as_object) {
        for (model, s) in ms {
            if let Some(e) = s.get("effortLevel").and_then(Value::as_str) {
                by_model.insert(model.clone(), Value::String(e.to_string()));
            }
        }
    }
    serde_json::json!({"default": v.get("effortLevel").cloned().unwrap_or(Value::Null), "byModel": by_model})
}

/// pids of the short-lived helper claudes below: they write a pid file like any session, so the
/// session list leaves them out
static HELPERS: Mutex<Vec<u32>> = Mutex::new(Vec::new());

/// A claude the built-in terminal opened only for one of its menus (`SD_HIDE=1 claude /mcp`): not a
/// session to list.
fn hidden(pid: u64) -> bool {
    if crate::sys::env_of(pid as u32).get("SD_HIDE").map(|v| v == "1").unwrap_or(false) {
        return true;
    }
    // macOS hides other processes' environment: a claude opened on a slash command (`claude /mcp`) is
    // one of those menus too
    if cfg!(not(target_os = "linux")) {
        let cmd = crate::sys::cmdline(pid as u32);
        if let Some(arg) = cmd.split_whitespace().nth(1) {
            return arg.len() > 1 && arg.starts_with('/') && !arg[1..].contains('/') && !arg[1..].contains('\\');
        }
    }
    false
}

fn is_helper(pid: u64) -> bool {
    HELPERS.lock().map(|h| h.contains(&(pid as u32))).unwrap_or(false)
}

/// Start claude as an SDK host would (no model call), send `initialize` and then `requests`, and
/// collect the answers by their id ("initialize" for the first). For questions only the program
/// that started the CLI may ask: cloud sessions and their transcripts.
pub fn host_requests(requests: Vec<(&str, Value)>, timeout: Duration) -> Result<serde_json::Map<String, Value>, String> {
    use std::io::{BufRead, BufReader, Write};
    let mut cmd = crate::sys::command(claude_bin());
    cmd.args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-prompt-tool", "stdio"])
        .current_dir(crate::sys::home())
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
    crate::sys::kill_tree(&mut child);
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
    let cache = crate::sys::config_dir().join("verbs.json");
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
    /// last asked: an idle helper (a claude, ~180 MB) is ended and started again when needed
    used: std::time::Instant,
}

impl HostHelper {
    fn spawn() -> Result<Helper, String> {
        use std::io::{BufRead, BufReader, Write};
        let mut cmd = crate::sys::command(claude_bin());
        cmd.args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-prompt-tool", "stdio"])
            .current_dir(crate::sys::home())
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
        Ok(Helper { child, stdin, pending, used: std::time::Instant::now() })
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
            h.used = std::time::Instant::now();
            h.pending.lock().unwrap().insert(id.clone(), tx);
            let line = serde_json::json!({"type": "control_request", "request_id": id, "request": req});
            if writeln!(h.stdin, "{line}").and_then(|_| h.stdin.flush()).is_err() {
                crate::sys::kill_tree(&mut h.child);
                *g = None;
                return Err("the helper claude stopped".into());
            }
        }
        rx.recv_timeout(timeout).map_err(|_| "claude did not answer".to_string())
    }

    /// End the helper when nothing asked it for `idle` (the cloud list stops while the window is
    /// hidden or the cloud is off): it holds a whole claude process for nothing.
    pub fn stop_if_idle(&self, idle: Duration) {
        let mut g = self.0.lock().unwrap();
        if g.as_ref().is_some_and(|h| h.used.elapsed() > idle && h.pending.lock().unwrap().is_empty()) {
            if let Some(mut h) = g.take() {
                crate::sys::kill_tree(&mut h.child);
            }
        }
    }

    pub fn stop(&self) {
        if let Some(mut h) = self.0.lock().unwrap().take() {
            crate::sys::kill_tree(&mut h.child);
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
    let mut cmd = crate::sys::command(claude_bin());
    cmd.args(["-p", "--cloud", session_id, "--output-format", "json"])
        .current_dir(crate::sys::home())
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
/// Starting the CLI costs a second of CPU (and a Defender scan on Windows): the last answer is
/// reused while no session's pid file changed, for up to 45 s.
pub fn live_sessions() -> Result<Value, String> {
    static LAST: Mutex<Option<(u64, std::time::Instant, Value)>> = Mutex::new(None);
    let fp = sessions_fingerprint();
    if let Some((f, at, v)) = LAST.lock().unwrap().as_ref() {
        if *f == fp && at.elapsed() < Duration::from_secs(45) {
            return Ok(v.clone());
        }
    }
    let v = live_sessions_now()?;
    *LAST.lock().unwrap() = Some((fp, std::time::Instant::now(), v.clone()));
    Ok(v)
}

/// Names, sizes and times of every pid file: changes when a session starts, ends or changes state.
fn sessions_fingerprint() -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for root in claude_dirs() {
        let Ok(rd) = fs::read_dir(root.join("sessions")) else { continue };
        let mut rows: Vec<_> = rd.flatten().filter_map(|e| Some((e.file_name(), e.metadata().ok().map(|m| (m.len(), m.modified().ok()))?))).collect();
        rows.sort();
        rows.hash(&mut h);
    }
    h.finish()
}

fn live_sessions_now() -> Result<Value, String> {
    let mut lc = crate::sys::command(claude_bin());
    clean_env(&mut lc);
    lc.args(["agents", "--json"]);
    // both pipes are read while it runs (a list over 64 KiB would otherwise stall it until the timeout)
    let o = crate::sys::output_timeout(&mut lc, 10).ok_or("claude agents --json timed out")?;
    let out = String::from_utf8_lossy(&o.stdout).to_string();
    let mut v: Value = serde_json::from_str(&out).map_err(|e| format!("bad claude agents output: {e}"))?;
    if let Some(list) = v.as_array_mut() {
        list.retain(|s| !s.get("pid").and_then(Value::as_u64).map(is_helper).unwrap_or(false));
    }
    Ok(v)
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
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
    /// the name you gave it (`/rename`, `--name`): wins over Claude's own title, as in `/resume`
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_title: Option<String>,
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
    /// it changed code: edited a file, committed, pushed or opened a PR (anywhere it was read):
    /// a session that only talked has nothing to ship
    pub made_changes: bool,
    /// it ended on an API error or a usage limit ("You've hit your limit · resets 4pm"); cleared by
    /// the next prompt or answer
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_error: Option<String>,
    pub last_text: Option<String>,
    /// what the session did last: "Edit src/x.ts", "Bash: npm test", …
    pub last_activity: Option<String>,
    /// files it edited (absolute paths, newest last, a few dozen), for sessions active in the last
    /// day only: two sessions editing the same file are about to collide
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub edited: Vec<String>,
    /// the other config folder (account) it belongs to; None for the main one
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_dir: Option<String>,
    /// the session this one continues (a conversation carried on after its context ran out starts
    /// a new session whose first message names the earlier transcript)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub continues: Option<String>,
}

const EDITED_MAX: usize = 40;
const EDITED_RECENT_MS: u64 = 24 * 3600 * 1000;

fn note_edits(m: &mut SessionMeta, parts: &[Value]) {
    for p in parts {
        if p.get("type").and_then(Value::as_str) != Some("tool_use") {
            continue;
        }
        let name = p.get("name").and_then(Value::as_str).unwrap_or("");
        if !matches!(name, "Edit" | "MultiEdit" | "Write" | "NotebookEdit") {
            continue;
        }
        let input = p.get("input");
        let Some(path) = input.and_then(|i| i.get("file_path").or_else(|| i.get("notebook_path"))).and_then(Value::as_str) else { continue };
        let path = crate::sys::norm(path);
        if let Some(i) = m.edited.iter().position(|x| *x == path) {
            m.edited.remove(i);
        }
        m.edited.push(path);
        if m.edited.len() > EDITED_MAX {
            m.edited.remove(0);
        }
    }
}

/// Live interactive sessions from `~/.claude/sessions/<pid>.json`, cheap enough to poll every few
/// seconds. An entry counts only while its process is alive and is the same process (pid reuse is
/// checked against the recorded start time).
pub fn pid_sessions() -> Vec<Value> {
    static LAST: Mutex<Option<(u64, std::time::Instant, Vec<Value>)>> = Mutex::new(None);
    let sgen = super::watch::sessions_gen(&claude_dirs());
    if let (Some(g), Some((lg, at, v))) = (sgen, LAST.lock().unwrap().as_ref()) {
        if g == *lg && at.elapsed() < Duration::from_secs(5) {
            return v.clone();
        }
    }
    let out = pid_sessions_now();
    if let Some(g) = sgen {
        *LAST.lock().unwrap() = Some((g, std::time::Instant::now(), out.clone()));
    }
    out
}

fn pid_sessions_now() -> Vec<Value> {
    let mut out = Vec::new();
    // without /proc (macOS, Windows): one listing of every process for all the pid files
    let live = crate::sys::live_pids();
    let mut kept = std::collections::HashSet::new();
    for root in claude_dirs() {
        pid_sessions_in(&root, &mut out, live.as_ref(), &mut kept);
    }
    // a pid gone (or reused later) is asked again
    if let Some(m) = HIDDEN.lock().unwrap().as_mut() {
        m.retain(|p, _| kept.contains(p));
    }
    out
}

/// `hidden()` per live pid: on macOS/Windows it reads the process's environment and command line
/// (a full process snapshot each), so it is asked once per process, not every poll.
static HIDDEN: Mutex<Option<HashMap<u32, bool>>> = Mutex::new(None);

fn hidden_cached(pid: u32) -> bool {
    if let Some(h) = HIDDEN.lock().unwrap().get_or_insert_with(HashMap::new).get(&pid) {
        return *h;
    }
    let h = hidden(pid as u64);
    HIDDEN.lock().unwrap().get_or_insert_with(HashMap::new).insert(pid, h);
    h
}

fn pid_sessions_in(root: &Path, out: &mut Vec<Value>, live: Option<&std::collections::HashSet<u32>>, kept: &mut std::collections::HashSet<u32>) {
    let dir = root.join("sessions");
    let extra = extra_dir_of(root);
    let Ok(entries) = fs::read_dir(&dir) else { return };
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
        if is_helper(pid) {
            continue;
        }
        if let Some(set) = live {
            if !set.contains(&(pid as u32)) {
                continue;
            }
        } else {
            let Ok(stat) = fs::read_to_string(format!("/proc/{pid}/stat")) else { continue };
            // field 22 (starttime) comes after the parenthesised command name
            let start = stat.rsplit_once(')').map(|(_, rest)| rest.split_whitespace().nth(19).unwrap_or("").to_string()).unwrap_or_default();
            if let Some(rec) = v.get("procStart").and_then(Value::as_str) {
                if rec != start {
                    continue;
                }
            }
        }
        // only live processes get the (costly off Linux) environment check
        kept.insert(pid as u32);
        if hidden_cached(pid as u32) {
            continue;
        }
        let mut v = v;
        if let Some(obj) = v.as_object_mut() {
            if let Some(x) = &extra {
                obj.insert("configDir".into(), Value::String(x.clone()));
            }
            if let Some(c) = obj.get("cwd").and_then(Value::as_str).map(crate::sys::norm) {
                obj.insert("cwd".into(), Value::String(c));
            }
        }
        out.push(v);
    }
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
    /// a big transcript's head, parsed: it does not change while the session appends, so a
    /// running session costs the tail only, every scan
    head: Option<SessionMeta>,
    /// the list version it last changed in
    ver: u64,
}

/// Every transcript's summary, kept between polls, with a version per change: the page asks for
/// what changed since the version it has (a few entries) instead of the whole list every 5 s.
#[derive(Default)]
pub struct ScanCache(Mutex<ScanState>);

#[derive(Default)]
pub struct ScanState {
    files: HashMap<PathBuf, Cached>,
    version: u64,
    /// sessions whose transcript went, with the version they went in (the last thousand or so)
    removed: Vec<(u64, String)>,
    /// versions before this one are not answered with changes (tombstones dropped): the whole list
    floor: u64,
    full_at: Option<std::time::Instant>,
}

/// What changed in the list since a version (`full`: the whole list, the page starts over).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanDelta {
    pub version: u64,
    pub full: bool,
    pub changed: Vec<SessionMeta>,
    pub removed: Vec<String>,
}

/// Even with change events, everything is read again this often (events can be lost).
const FULL_EVERY: Duration = Duration::from_secs(60);

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

/// What follows the `<bash-input>`/`<bash-stdout>`/`<bash-stderr>` blocks at the start of a message.
pub fn after_bash(text: &str) -> &str {
    let mut t = text.trim_start();
    loop {
        let Some(name) = ["bash-input", "bash-stdout", "bash-stderr"].into_iter().find(|n| t.starts_with(&format!("<{n}>"))) else { break };
        let close = format!("</{name}>");
        let Some(end) = t.find(&close) else { break };
        t = t[end + close.len()..].trim_start();
    }
    t.trim_end()
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
    if t.is_empty() || t.starts_with("Caveat:") {
        return None;
    }
    if t.starts_with('<') {
        // a slash command you ran ("/model opus") or a shell command ("! ls"); Claude Code's own
        // wrappers are not something you typed; anything else (pasted HTML, a <T> generic) is
        let inner = |name: &str| -> Option<String> {
            let open = format!("<{name}>");
            let close = format!("</{name}>");
            let a = t.find(&open)? + open.len();
            let b = t[a..].find(&close)? + a;
            Some(t[a..b].trim().to_string())
        };
        if let Some(name) = inner("command-name") {
            let args = inner("command-args").unwrap_or_default();
            let name = if name.starts_with('/') { name } else { format!("/{name}") };
            let line = if args.is_empty() { name } else { format!("{name} {args}") };
            return Some(line.chars().take(400).collect());
        }
        if let Some(cmd) = inner("bash-input") {
            // `! command` output the app sent in front of your message: that message is what you typed
            let rest = after_bash(t);
            if !rest.is_empty() {
                return Some(rest.chars().take(400).collect());
            }
            return Some(format!("! {cmd}").chars().take(400).collect());
        }
        const WRAPPERS: [&str; 10] = [
            "<local-command-stdout", "<local-command-stderr", "<local-command-caveat", "<bash-stdout", "<bash-stderr",
            "<system-reminder", "<task-notification", "<user-prompt-submit-hook", "<command-message", "<command-args",
        ];
        if WRAPPERS.iter().any(|w| t.starts_with(w)) {
            return None;
        }
    }
    Some(t.chars().take(400).collect())
}

/// "This session is being continued from a previous conversation … the full transcript at:
/// …/<id>.jsonl": the earlier session's id.
fn continued_from(v: &Value) -> Option<String> {
    let c = v.get("message")?.get("content")?;
    let text = match c {
        Value::String(s) => s.as_str(),
        Value::Array(parts) => parts.iter().find_map(|p| p.get("text").and_then(Value::as_str))?,
        _ => return None,
    };
    if !text.starts_with("This session is being continued from a previous conversation") {
        return None;
    }
    // the summary may name other .jsonl files; the transcript path is a session id before ".jsonl"
    text.rmatch_indices(".jsonl").find_map(|(at, _)| {
        let id: String = text[..at].chars().rev().take_while(|c| c.is_ascii_hexdigit() || *c == '-').collect::<Vec<_>>().into_iter().rev().collect();
        (id.len() == 36 && id.matches('-').count() == 4).then_some(id)
    })
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
        "custom-title" => m.custom_title = s("customTitle").filter(|t| !t.trim().is_empty()).or(m.custom_title.take()),
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
            if let Some(c) = s("cwd").map(|c| crate::sys::norm(&c)) {
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
                if m.continues.is_none() && !from_tail && m.first_prompt.is_none() {
                    m.continues = continued_from(v);
                }
                if let Some(t) = user_text(v) {
                    if m.first_prompt.is_none() && !from_tail {
                        m.first_prompt = Some(t.clone());
                    }
                    // a new prompt: whatever failed before is behind it
                    m.api_error = None;
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
                // Claude Code writes an API error or a usage limit as an assistant message of its own
                m.api_error = if v.get("isApiErrorMessage").and_then(Value::as_bool) == Some(true) {
                    Some(assistant_text(v).map(|t| t.lines().next().unwrap_or("").chars().take(200).collect()).unwrap_or_else(|| "API error".into()))
                } else {
                    None
                };
                if !m.made_changes {
                    if let Some(parts) = v.get("message").and_then(|x| x.get("content")).and_then(Value::as_array) {
                        m.made_changes = parts.iter().any(changes_code);
                    }
                }
                if m.updated_ms + EDITED_RECENT_MS >= now_ms() {
                    if let Some(parts) = v.get("message").and_then(|x| x.get("content")).and_then(Value::as_array) {
                        note_edits(m, parts);
                    }
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

/// A tool call that changes code: an edit, or a commit, push or PR from the shell.
fn changes_code(part: &Value) -> bool {
    if part.get("type").and_then(Value::as_str) != Some("tool_use") {
        return false;
    }
    match part.get("name").and_then(Value::as_str).unwrap_or("") {
        "Edit" | "MultiEdit" | "Write" | "NotebookEdit" => true,
        "Bash" => {
            let c = part.get("input").and_then(|i| i.get("command")).and_then(Value::as_str).unwrap_or("");
            c.contains("git commit") || c.contains("git push") || c.contains("gh pr create") || c.contains("git merge")
        }
        _ => false,
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

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// What a transcript continues, found once per file: its first prompt can sit past the head that
/// a scan reads (large attachment records come first), so read lines until the first prompt.
fn continuation_of(path: &Path) -> Option<String> {
    use std::io::BufRead;
    static SEEN: Mutex<Option<HashMap<PathBuf, Option<String>>>> = Mutex::new(None);
    if let Some(hit) = SEEN.lock().unwrap().get_or_insert_with(HashMap::new).get(path) {
        return hit.clone();
    }
    let mut found = None;
    if let Ok(f) = File::open(path) {
        let mut r = std::io::BufReader::new(f.take(8 << 20));
        let mut line = Vec::new();
        for _ in 0..200 {
            line.clear();
            if r.read_until(b'\n', &mut line).unwrap_or(0) == 0 {
                break;
            }
            if !memfind(&line, br#""type":"user""#) {
                continue;
            }
            if let Ok(v) = serde_json::from_slice::<Value>(&line) {
                found = continued_from(&v);
                break;
            }
        }
    }
    SEEN.lock().unwrap().get_or_insert_with(HashMap::new).insert(path.to_path_buf(), found.clone());
    found
}

fn scan_file(path: &Path, size: u64, mtime: u64, head_hit: Option<&SessionMeta>) -> Option<(SessionMeta, Option<SessionMeta>)> {
    let session_id = path.file_stem()?.to_str()?.to_string();
    let mut f = File::open(path).ok()?;
    let mut m = SessionMeta { session_id, path: path.to_string_lossy().into(), updated_ms: mtime, size, config_dir: extra_dir_of(path), ..Default::default() };
    let mut head_meta = None;
    if size <= HEAD + TAIL {
        let all = read_range(&mut f, 0, size);
        parse_chunk(&mut m, &all, false, false);
    } else {
        if let Some(h) = head_hit {
            m = SessionMeta { updated_ms: mtime, size, ..h.clone() };
        } else {
            let head = read_range(&mut f, 0, HEAD);
            // the head may end mid-line: drop its last partial line
            let cut = head.iter().rposition(|b| *b == b'\n').unwrap_or(0);
            parse_chunk(&mut m, &head[..cut], false, false);
        }
        head_meta = Some(m.clone());
        let tail = read_range(&mut f, size - TAIL, TAIL);
        parse_chunk(&mut m, &tail, true, true);
    }
    if m.continues.is_none() {
        m.continues = continuation_of(path);
    }
    Some((m, head_meta))
}

/// A transcript's summary from its bytes read elsewhere (a machine over ssh): the whole file when it is
/// small, else its head and tail, read the same way as a local one.
pub fn meta_from_parts(path: &str, size: u64, mtime: u64, head: &[u8], tail: Option<&[u8]>) -> SessionMeta {
    let session_id = Path::new(path).file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
    let mut m = SessionMeta { session_id, path: path.to_string(), updated_ms: mtime, size, ..Default::default() };
    match tail {
        None => parse_chunk(&mut m, head, false, false),
        Some(tail) => {
            let cut = head.iter().rposition(|b| *b == b'\n').unwrap_or(0);
            parse_chunk(&mut m, &head[..cut], false, false);
            parse_chunk(&mut m, tail, true, true);
        }
    }
    m
}

/// Every session transcript under ~/.claude/projects (subagent transcripts excluded).
pub fn scan(cache: &ScanCache) -> Vec<SessionMeta> {
    let mut st = cache.0.lock().unwrap();
    refresh(&mut st);
    st.files.values().map(|c| c.meta.clone()).collect()
}

/// The list's changes since `since` (0, or a version too old or from before a restart: all of it).
pub fn scan_since(cache: &ScanCache, since: u64) -> ScanDelta {
    let mut st = cache.0.lock().unwrap();
    refresh(&mut st);
    let version = st.version;
    if since == 0 || since < st.floor || since > version {
        return ScanDelta { version, full: true, changed: st.files.values().map(|c| c.meta.clone()).collect(), removed: vec![] };
    }
    let changed = st.files.values().filter(|c| c.ver > since).map(|c| c.meta.clone()).collect();
    let removed = st.removed.iter().filter(|(v, _)| *v > since).map(|(_, id)| id.clone()).collect();
    ScanDelta { version, full: false, changed, removed }
}

/// A top-level transcript (`projects/<folder>/<id>.jsonl`), not a subagent's.
fn is_transcript(p: &Path) -> bool {
    p.extension().is_some_and(|e| e == "jsonl") && p.parent().and_then(Path::parent).and_then(Path::file_name).is_some_and(|n| n == "projects")
}

/// Bring the list up to date: with change events only the files that changed, else (and once a
/// minute) a listing of every folder.
fn refresh(st: &mut ScanState) {
    if st.version == 0 {
        // a page from before a restart holds a smaller version: it gets the whole list
        st.version = now_ms();
        st.floor = st.version;
    }
    let dirs = claude_dirs();
    let changed = super::watch::take_transcripts(&dirs);
    let full = changed.is_none() || st.full_at.is_none_or(|t| t.elapsed() > FULL_EVERY);
    if !full {
        for p in changed.unwrap_or_default() {
            if !is_transcript(&p) {
                continue;
            }
            match fs::metadata(&p) {
                Ok(md) if md.is_file() => update_one(st, p, &md),
                _ => remove_one(st, &p),
            }
        }
        return;
    }
    let mut seen = std::collections::HashSet::new();
    let folders: Vec<_> = dirs.iter().filter_map(|c| fs::read_dir(c.join("projects")).ok()).flat_map(|rd| rd.flatten().collect::<Vec<_>>()).collect();
    for d in folders {
        let Ok(files) = fs::read_dir(d.path()) else { continue };
        for f in files.flatten() {
            let p = f.path();
            if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            // from the listing itself on Windows: no extra call per file
            let Ok(md) = f.metadata() else { continue };
            seen.insert(p.clone());
            update_one(st, p, &md);
        }
    }
    let gone: Vec<PathBuf> = st.files.keys().filter(|k| !seen.contains(*k)).cloned().collect();
    for p in gone {
        remove_one(st, &p);
    }
    st.full_at = Some(std::time::Instant::now());
}

fn update_one(st: &mut ScanState, p: PathBuf, md: &fs::Metadata) {
    let size = md.len();
    let mtime = md.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
    let mut head = None;
    if let Some(hit) = st.files.get(&p) {
        if hit.size == size && hit.mtime == mtime {
            return;
        }
        // grown (appended): the head read before still holds; shorter: rewritten, read all
        if size > hit.size {
            head = hit.head.clone();
        }
    }
    match scan_file(&p, size, mtime, head.as_ref()) {
        Some((meta, head)) => {
            st.version += 1;
            let ver = st.version;
            st.files.insert(p, Cached { size, mtime, meta, head, ver });
        }
        None => remove_one(st, &p),
    }
}

fn remove_one(st: &mut ScanState, p: &Path) {
    let Some(c) = st.files.remove(p) else { return };
    st.version += 1;
    let v = st.version;
    st.removed.push((v, c.meta.session_id));
    if st.removed.len() > 2000 {
        let cut = st.removed.len() - 1000;
        st.floor = st.removed[cut - 1].0;
        st.removed.drain(..cut);
    }
}

#[cfg(test)]
mod continuation_tests {
    use super::*;

    #[test]
    fn a_message_after_shell_output_is_what_you_typed() {
        let v: Value = serde_json::from_str(r#"{"type":"user","message":{"role":"user","content":"<bash-input>git status</bash-input>\n<bash-stdout>clean</bash-stdout><bash-stderr></bash-stderr>\n\nwhy is it clean?"}}"#).unwrap();
        assert_eq!(user_text(&v).as_deref(), Some("why is it clean?"));
        let cli: Value = serde_json::from_str(r#"{"type":"user","message":{"role":"user","content":"<bash-input> ls</bash-input>"}}"#).unwrap();
        assert_eq!(user_text(&cli).as_deref(), Some("! ls"));
        let out: Value = serde_json::from_str(r#"{"type":"user","message":{"role":"user","content":"<bash-stdout>a</bash-stdout><bash-stderr></bash-stderr>"}}"#).unwrap();
        assert_eq!(user_text(&out), None);
    }

    #[test]
    fn finds_the_continued_session() {
        let v: Value = serde_json::from_str(r#"{"type":"user","message":{"role":"user","content":"This session is being continued from a previous conversation that ran out of context. The summary below …\n\nIf you need specific details from before compaction, read the full transcript at: /home/u/.claude/projects/-x/412bb752-493a-4e09-b136-ef4b343b8610.jsonl\nContinue"}}"#).unwrap();
        assert_eq!(continued_from(&v).as_deref(), Some("412bb752-493a-4e09-b136-ef4b343b8610"));
        let plain: Value = serde_json::from_str(r#"{"type":"user","message":{"role":"user","content":"fix the bug in a.jsonl"}}"#).unwrap();
        assert_eq!(continued_from(&plain), None);
    }
}

#[cfg(test)]
mod head_cache_tests {
    use super::*;

    /// A grown transcript read with the cached head equals a fresh read
    /// (`SD_BIG=a.jsonl:b.jsonl cargo test head_cache_same -- --ignored`).
    #[test]
    #[ignore]
    fn head_cache_same() {
        let dir = std::env::temp_dir().join(format!("sd-head-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        for src in std::env::var("SD_BIG").unwrap().split(':').filter(|s| !s.is_empty()) {
            let all = fs::read(src).unwrap();
            let p = dir.join(Path::new(src).file_name().unwrap());
            let cut = all[..all.len() - 50_000].iter().rposition(|b| *b == b'\n').unwrap() + 1;
            fs::write(&p, &all[..cut]).unwrap();
            let (_, head) = scan_file(&p, cut as u64, 1, None).unwrap();
            fs::write(&p, &all).unwrap();
            let size = all.len() as u64;
            let (fresh, _) = scan_file(&p, size, 2, None).unwrap();
            let (cached, _) = scan_file(&p, size, 2, head.as_ref()).unwrap();
            assert!(head.is_some(), "{src} is not big enough");
            assert_eq!(serde_json::to_string(&fresh).unwrap(), serde_json::to_string(&cached).unwrap(), "{src}");
        }
        let _ = fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod delta_tests {
    use super::*;

    #[test]
    fn changes_come_as_deltas() {
        let root = std::env::temp_dir().join(format!("sd-delta-{}", std::process::id()));
        let proj = root.join("projects").join("-tmp-x");
        fs::create_dir_all(&proj).unwrap();
        fs::create_dir_all(root.join("sessions")).unwrap();
        set_extra_dirs(&[root.to_string_lossy().to_string()]);
        let cache = ScanCache::default();
        let first = scan_since(&cache, 0);
        assert!(first.full);
        let id = "11111111-2222-3333-4444-555555555555";
        let t = proj.join(format!("{id}.jsonl"));
        fs::write(&t, r#"{"type":"user","cwd":"/tmp/x","sessionId":"x","message":{"role":"user","content":"hello there"}}"#.to_string() + "\n").unwrap();
        let wait = |since: u64, f: &dyn Fn(&ScanDelta) -> bool| {
            let until = std::time::Instant::now() + Duration::from_secs(5);
            loop {
                let d = scan_since(&cache, since);
                if f(&d) || std::time::Instant::now() > until {
                    return d;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        };
        let d = wait(first.version, &|d| d.changed.iter().any(|m| m.session_id == id));
        assert!(!d.full);
        let m = d.changed.iter().find(|m| m.session_id == id).expect("the new transcript comes as a change");
        assert_eq!(m.first_prompt.as_deref(), Some("hello there"));
        // nothing new: an empty delta
        let quiet = scan_since(&cache, d.version);
        assert!(!quiet.changed.iter().any(|m| m.session_id == id));
        fs::remove_file(&t).unwrap();
        let d2 = wait(d.version, &|d| d.removed.iter().any(|r| r == id));
        assert!(d2.removed.iter().any(|r| r == id), "the deleted transcript comes as removed");
        // a version from before a restart, or unknown: the whole list
        assert!(scan_since(&cache, 1).full);
        set_extra_dirs(&[]);
        let _ = fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod outcome_tests {
    use super::*;

    fn meta_of(lines: &[&str]) -> SessionMeta {
        let mut m = SessionMeta::default();
        parse_chunk(&mut m, lines.join("\n").as_bytes(), false, false);
        m
    }

    #[test]
    fn knows_changes_and_errors() {
        let ask = r#"{"type":"user","cwd":"/r","message":{"role":"user","content":"fix it"}}"#;
        let talk = r#"{"type":"assistant","cwd":"/r","message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"It works like this."}]}}"#;
        let edit = r#"{"type":"assistant","cwd":"/r","message":{"role":"assistant","stop_reason":"tool_use","content":[{"type":"tool_use","id":"t","name":"Edit","input":{"file_path":"/r/a.rs"}}]}}"#;
        let push = r#"{"type":"assistant","cwd":"/r","message":{"role":"assistant","stop_reason":"tool_use","content":[{"type":"tool_use","id":"t","name":"Bash","input":{"command":"git add -A && git commit -m x"}}]}}"#;
        let ls = r#"{"type":"assistant","cwd":"/r","message":{"role":"assistant","stop_reason":"tool_use","content":[{"type":"tool_use","id":"t","name":"Bash","input":{"command":"ls -la"}}]}}"#;
        let limit = r#"{"type":"assistant","cwd":"/r","isApiErrorMessage":true,"error":"rate_limit","message":{"role":"assistant","stop_reason":"stop_sequence","content":[{"type":"text","text":"You've hit your limit · resets 4pm"}]}}"#;

        let m = meta_of(&[ask, talk]);
        assert!(!m.made_changes && m.api_error.is_none() && m.ended_turn);
        assert!(meta_of(&[ask, edit, talk]).made_changes);
        assert!(meta_of(&[ask, push, talk]).made_changes);
        assert!(!meta_of(&[ask, ls, talk]).made_changes, "a read-only command is not a change");

        let m = meta_of(&[ask, limit]);
        assert_eq!(m.api_error.as_deref(), Some("You've hit your limit · resets 4pm"));
        // asked again and answered: the limit is behind it
        assert!(meta_of(&[ask, limit, ask, talk]).api_error.is_none());
        // stopped mid-task: the last word is the tool's, the turn never ended
        let m = meta_of(&[ask, edit]);
        assert!(!m.ended_turn && m.made_changes);
    }
}
