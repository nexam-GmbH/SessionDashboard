//! Sessions the app runs ("owned"): `claude -p` with stream-json in and out and permission prompts
//! answered by the app over stdio (`--permission-prompt-tool stdio`, the Agent SDK control
//! protocol; protocol shape after BloopAI/vibe-kanban's executor, Apache-2.0, ideas only, and
//! checked against claude 2.1.321). Every stdout line goes to the UI as a `claude-event`; the UI
//! writes user messages, permission answers and control requests (interrupt, mode, model) back.
//! The same code drives a VPS session by running claude over ssh (`host`).

use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

use super::discover::claude_bin;
use super::remote::shell_quote;

/// One session's process. Its stdin has a lock of its own, so a slow write (a big picture over a
/// slow ssh link) never holds up the other sessions; `None` once it is stopping (writes fail
/// instead of going to a process that will never read them).
pub struct Proc {
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    child: Child,
    /// which start this is: the reader of an older process never removes a newer one
    generation: u64,
    remote: bool,
}

static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

#[derive(Default, Clone)]
pub struct Procs(Arc<Mutex<HashMap<String, Proc>>>);

impl Procs {
    /// Process ids of the local sessions the app runs (ssh ones run elsewhere).
    pub fn local_pids(&self) -> Vec<(String, u32)> {
        self.0.lock().unwrap().iter().map(|(k, p)| (k.clone(), p.child.id())).collect()
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct StartOpts {
    /// the app's id for this session: events carry it
    pub key: String,
    pub cwd: String,
    pub prompt: Option<String>,
    /// resume this Claude session id (history, or one taken over from a terminal)
    pub resume: Option<String>,
    pub fork: bool,
    /// a fixed id for a new session
    pub session_id: Option<String>,
    /// resume only up to this message (rewind the conversation, fork from a message)
    pub resume_session_at: Option<String>,
    /// the uuid of the first prompt (its record carries it: rewind and delivery checks find it)
    pub prompt_uuid: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<String>,
    pub add_dirs: Vec<String>,
    pub agent: Option<String>,
    pub append_system_prompt: Option<String>,
    pub name: Option<String>,
    pub worktree: Option<String>,
    /// extra settings JSON (fast mode, output style)
    pub settings: Option<String>,
    /// run on this ssh host (VPS) instead of locally
    pub host: Option<String>,
    /// pictures for the first message (data: URLs)
    pub images: Vec<String>,
    /// another Claude Code config folder (account): CLAUDE_CONFIG_DIR for this session
    pub config_dir: Option<String>,
}

/// The CLI flag for the app's mode. The app's "default" (nothing chosen) passes no flag, so the
/// session starts in the user's own `permissions.defaultMode` from ~/.claude/settings.json (e.g.
/// bypassPermissions) instead of forcing "manual" on every session the app starts or resumes.
/// A mode picked in the composer while the session runs still goes through set_permission_mode.
fn mode_flag(m: &str) -> Option<&str> {
    if m == "default" { None } else { Some(m) }
}

pub fn start(app: AppHandle, procs: Procs, o: StartOpts) -> Result<(), String> {
    if procs.0.lock().unwrap().contains_key(&o.key) {
        return Err("already running".into());
    }
    // pictures the API takes (anything else would fail this turn and every one after it)
    let images: Vec<String> = o.images.iter().filter(|u| image_ok(u)).cloned().collect();
    let mut args: Vec<String> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        // each message echoed back (isReplay, same uuid) once Claude takes it in, as Claude Code
        // desktop and the VS Code panel run it
        "--replay-user-messages",
        "--permission-prompt-tool",
        "stdio",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let mut push = |k: &str, v: &Option<String>| {
        if let Some(v) = v.as_ref().filter(|v| !v.is_empty()) {
            args.push(k.into());
            args.push(v.clone());
        }
    };
    push("--model", &o.model);
    push("--effort", &o.effort);
    push("--permission-mode", &o.permission_mode.as_deref().and_then(mode_flag).map(str::to_string));
    push("--agent", &o.agent);
    push("--append-system-prompt", &o.append_system_prompt);
    push("--name", &o.name);
    push("--resume", &o.resume);
    if o.resume.is_some() {
        push("--resume-session-at", &o.resume_session_at);
    }
    push("--worktree", &o.worktree);
    push("--settings", &o.settings);
    // a new session, or a fork (which gets a new id): the id the app already shows it under
    if o.resume.is_none() || o.fork {
        push("--session-id", &o.session_id);
    }
    if o.fork {
        args.push("--fork-session".into());
    }
    for d in &o.add_dirs {
        args.push("--add-dir".into());
        args.push(d.clone());
    }

    let mut cmd = match &o.host {
        Some(host) => {
            // VPS: the same protocol over ssh; claude runs in the remote folder ("~/x" is relative
            // to the remote home)
            let dir = o.cwd.strip_prefix("~/").map(|rest| format!("\"$HOME\"/{}", shell_quote(rest))).unwrap_or_else(|| shell_quote(&o.cwd));
            let script = format!("cd {dir} && exec env CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1 CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true claude {}", args.iter().map(|a| shell_quote(a)).collect::<Vec<_>>().join(" "));
            super::remote::ssh_cmd(host, &script)
        }
        None => {
            let mut c = crate::sys::command(claude_bin());
            c.args(&args).current_dir(&o.cwd);
            if let Some(d) = o.config_dir.as_ref().filter(|d| !d.is_empty()) {
                c.env("CLAUDE_CONFIG_DIR", crate::sys::expand(d));
            }
            c
        }
    };
    super::discover::clean_env(&mut cmd);
    // exact state from claude itself: idle / running / requires_action, also while background
    // subagents or shells keep working after a turn's result
    cmd.env("CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS", "1");
    // file snapshots per prompt (what the CLI keeps for /rewind): "Rewind code to here" can restore them
    cmd.env("CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING", "true");
    // check and insert in one step: two starts of the same key can't both get through
    let generation = GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let (stdout, stderr, stdin) = {
        let mut map = procs.0.lock().unwrap();
        if map.contains_key(&o.key) {
            return Err("already running".into());
        }
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("cannot start claude: {e}"))?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;
        let stdin = Arc::new(Mutex::new(child.stdin.take()));
        map.insert(o.key.clone(), Proc { stdin: stdin.clone(), child, generation, remote: o.host.is_some() });
        (stdout, stderr, stdin)
    };

    let err_tail = Arc::new(Mutex::new(Vec::<String>::new()));
    {
        let err_tail = err_tail.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let mut t = err_tail.lock().unwrap();
                t.push(line);
                if t.len() > 30 {
                    t.remove(0);
                }
            }
        });
    }
    let key = o.key.clone();
    let reader_procs = procs.clone();
    // stdout lines → batches: every event the web view gets is one script run there, and token
    // streaming is hundreds of lines a second per session; what arrives within ~40 ms goes as one
    let (tx, rx) = std::sync::mpsc::channel::<Value>();
    {
        let app = app.clone();
        let key = key.clone();
        std::thread::spawn(move || {
            while let Ok(first) = rx.recv() {
                let mut batch = vec![first];
                let until = std::time::Instant::now() + std::time::Duration::from_millis(40);
                while batch.len() < 400 {
                    match rx.recv_timeout(until.saturating_duration_since(std::time::Instant::now())) {
                        Ok(v) => batch.push(v),
                        Err(_) => break,
                    }
                }
                let _ = app.emit("claude-events", json!({"key": key, "events": batch}));
            }
        });
    }
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.trim().is_empty() {
                continue;
            }
            let ev: Value = serde_json::from_str(&line).unwrap_or_else(|_| json!({"type": "raw", "text": line}));
            if !wanted_by_ui(&ev) {
                continue;
            }
            let _ = tx.send(ev);
        }
        // everything read is out before the exit (the batcher ends when this sender is gone)
        drop(tx);
        std::thread::sleep(std::time::Duration::from_millis(60));
        // take this start's entry out under a short lock, then wait for the process outside it
        let mine = {
            let mut map = reader_procs.0.lock().unwrap();
            match map.get(&key) {
                Some(p) if p.generation == generation => map.remove(&key),
                _ => None,
            }
        };
        let code = mine.and_then(|mut p| p.child.wait().ok()).and_then(|s| s.code());
        let stderr_tail = err_tail.lock().unwrap().join("\n");
        let _ = app.emit("claude-event", json!({"key": key, "exit": {"code": code, "stderr": stderr_tail}}));
    });

    // the readers run before anything is written: claude answering `initialize` with more than a
    // pipe's worth never blocks the first prompt's write (and so the start)
    // perTaskStopAffordance: Stop ends the turn, background subagents and shells keep running (as in
    // Claude Code desktop)
    let init = json!({"type": "control_request", "request_id": format!("init-{}", o.key), "request": {"subtype": "initialize", "hooks": null, "perTaskStopAffordance": true}});
    let first = o.prompt.as_ref().filter(|p| !p.trim().is_empty()).map(|p| user_message_full(p, &images, o.prompt_uuid.as_deref()));
    let mut guard = stdin.lock().unwrap();
    if let Some(w) = guard.as_mut() {
        writeln!(w, "{init}").map_err(|e| e.to_string())?;
        if let Some(m) = first {
            writeln!(w, "{m}").map_err(|e| e.to_string())?;
        }
        w.flush().ok();
    }
    Ok(())
}

/// A picture the API accepts: png, jpeg, gif or webp, at most 5 MB.
fn image_ok(url: &str) -> bool {
    let Some((head, data)) = url.strip_prefix("data:").and_then(|u| u.split_once(";base64,")) else { return false };
    matches!(head, "image/png" | "image/jpeg" | "image/gif" | "image/webp") && data.len() <= 5 * 1024 * 1024 * 4 / 3 + 8
}

/// A user message as an SDK host sends it (pictures as image blocks, the way Claude Code sends a
/// pasted screenshot, then the text): typed by a person (`origin: human`, which Claude Code's
/// trust checks ask for), with its own uuid when given (its record in the transcript carries it).
fn user_message_full(text: &str, images: &[String], uuid: Option<&str>) -> Value {
    let mut content: Vec<Value> = images
        .iter()
        .filter(|u| image_ok(u))
        .filter_map(|u| {
            let (head, data) = u.strip_prefix("data:")?.split_once(";base64,")?;
            Some(json!({"type": "image", "source": {"type": "base64", "media_type": head, "data": data}}))
        })
        .collect();
    content.push(json!({"type": "text", "text": text}));
    let mut m = json!({"type": "user", "message": {"role": "user", "content": content}, "parent_tool_use_id": null, "origin": {"kind": "human"}});
    if let Some(u) = uuid.filter(|u| !u.is_empty()) {
        m["uuid"] = Value::String(u.to_string());
    }
    m
}

/// A message with its uuid (and pictures), and while Claude works its priority: "next" (read at
/// its next step), "later" (after the turn) or "now" (replaces a turn that has just begun).
pub fn send_full(procs: &Procs, key: &str, text: &str, images: &[String], uuid: Option<&str>, priority: Option<&str>) -> Result<(), String> {
    let mut m = user_message_full(text, images, uuid);
    if let Some(p) = priority.filter(|p| matches!(*p, "next" | "later" | "now")) {
        m["priority"] = Value::String(p.to_string());
    }
    write(procs, key, m)
}

/// Restore the files of a session to how they were before the prompt `uuid` (Claude Code's own
/// file snapshots; `claude -p --resume <id> --rewind-files <uuid>`, nothing is sent to a model).
pub fn rewind_files(cwd: &str, session_id: &str, uuid: &str, config_dir: Option<&str>) -> Result<String, String> {
    let ok_id = |s: &str| !s.is_empty() && s.len() < 80 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if !ok_id(session_id) || !ok_id(uuid) {
        return Err("bad session or message id".into());
    }
    let mut c = crate::sys::command(claude_bin());
    c.args(["-p", "--resume", session_id, "--rewind-files", uuid]).current_dir(crate::sys::expand(cwd));
    if let Some(d) = config_dir.filter(|d| !d.is_empty()) {
        c.env("CLAUDE_CONFIG_DIR", crate::sys::expand(d));
    }
    super::discover::clean_env(&mut c);
    let o = crate::sys::output_timeout(&mut c, 60).ok_or("claude did not answer within a minute")?;
    let out = format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr)).trim().to_string();
    if o.status.success() {
        Ok(out)
    } else {
        Err(if out.is_empty() { format!("claude exited with {:?}", o.status.code()) } else { out })
    }
}

fn write(procs: &Procs, key: &str, v: Value) -> Result<(), String> {
    // the map's lock only to find the session; the write holds this session's own lock
    let stdin = procs.0.lock().unwrap().get(key).map(|p| p.stdin.clone()).ok_or("session is not running in the app")?;
    let mut guard = stdin.lock().unwrap();
    let w = guard.as_mut().ok_or("session is stopping")?;
    writeln!(w, "{v}").map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())
}

/// Answer a `can_use_tool` request: `response` is {behavior: "allow", updatedInput, updatedPermissions?}
/// or {behavior: "deny", message}.
pub fn respond(procs: &Procs, key: &str, request_id: &str, response: Value) -> Result<(), String> {
    write(procs, key, json!({"type": "control_response", "response": {"subtype": "success", "request_id": request_id, "response": response}}))
}

/// A control request to claude: {subtype: "interrupt"} / {subtype: "set_permission_mode", mode} /
/// {subtype: "set_model", model}.
pub fn control(procs: &Procs, key: &str, request: Value, request_id: Option<String>) -> Result<(), String> {
    let id = request_id.unwrap_or_else(|| format!("req-{}", uuid::Uuid::new_v4()));
    let mut request = request;
    if let Some(m) = request.get_mut("mode") {
        if let Some(s) = m.as_str() {
            // picked in the composer while the session runs: the app's "default" is the CLI's "manual"
            *m = Value::String(if s == "default" { "manual" } else { s }.to_string());
        }
    }
    write(procs, key, json!({"type": "control_request", "request_id": id, "request": request}))
}

fn term(pid: u32) {
    crate::sys::terminate(pid);
}

/// Stop a session the app runs: SIGTERM so claude closes its MCP servers and shells, SIGKILL only
/// if it is still there after 3 s.
pub fn stop(procs: &Procs, key: &str) -> Result<(), String> {
    let found = procs.0.lock().unwrap().get(key).map(|p| (p.child.id(), p.stdin.clone(), p.remote));
    let Some((pid, stdin, remote)) = found else { return Ok(()) };
    // nothing more goes in (a message sent now fails instead of vanishing); a session on a server
    // is told to stop its turn first and sees its input end, since a signal to the local ssh
    // never reaches it
    if let Ok(mut g) = stdin.lock() {
        if remote {
            if let Some(w) = g.as_mut() {
                let _ = writeln!(w, "{}", json!({"type": "control_request", "request_id": format!("stop-{}", uuid::Uuid::new_v4()), "request": {"subtype": "interrupt"}}));
                let _ = w.flush();
            }
        }
        *g = None;
    }
    let procs = procs.clone();
    let key = key.to_string();
    std::thread::spawn(move || {
        if remote {
            std::thread::sleep(std::time::Duration::from_millis(800));
        }
        term(pid);
        std::thread::sleep(std::time::Duration::from_secs(3));
        if let Some(p) = procs.0.lock().unwrap().get_mut(&key) {
            if p.child.id() == pid && matches!(p.child.try_wait(), Ok(None)) {
                let _ = p.child.kill();
            }
        }
    });
    Ok(())
}

pub fn running(procs: &Procs) -> Vec<String> {
    procs.0.lock().unwrap().keys().cloned().collect()
}

/// The app quits: every session it runs gets SIGTERM, then up to 2 s, then SIGKILL.
pub fn stop_all(procs: &Procs) {
    let mut list: Vec<Proc> = procs.0.lock().unwrap().drain().map(|(_, p)| p).collect();
    for p in &list {
        term(p.child.id());
    }
    let until = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while std::time::Instant::now() < until && list.iter_mut().any(|p| matches!(p.child.try_wait(), Ok(None))) {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    for p in list.iter_mut() {
        if matches!(p.child.try_wait(), Ok(None)) {
            let _ = p.child.kill();
        }
    }
}

fn alive(pid: u32) -> bool {
    crate::sys::alive(pid)
}

/// Take over a session from a terminal: stop that claude the way Ctrl+C twice does (SIGINT, then
/// SIGTERM if it is still there). Its conversation stays on disk, so the app resumes it next.
pub fn takeover(pid: u32) -> Result<(), String> {
    if !alive(pid) {
        return Err("that session is not running any more".into());
    }
    // never stop something that is not claude
    let cmdline = crate::sys::cmdline(pid);
    if !cmdline.is_empty() && !cmdline.to_lowercase().contains("claude") {
        return Err("that process is not claude".into());
    }
    crate::sys::interrupt(pid);
    std::thread::sleep(std::time::Duration::from_millis(300));
    crate::sys::interrupt(pid);
    for (i, step) in [20, 20].iter().enumerate() {
        for _ in 0..*step {
            if !alive(pid) {
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        if i == 0 {
            crate::sys::terminate(pid);
        }
    }
    if alive(pid) {
        Err("it did not stop; close it in the terminal".into())
    } else {
        Ok(())
    }
}

/// Keep a file you attached (base64 from the prompt box) where Claude can read it; its full path.
pub fn save_attachment(name: &str, data_b64: &str) -> Result<String, String> {
    let base = std::path::Path::new(name).file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let clean: String = base.chars().map(|c| if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c }).collect();
    let clean = if clean.trim().is_empty() || clean == "." || clean == ".." { "file".to_string() } else { clean };
    let bytes = super::hooks::b64decode(data_b64);
    if bytes.len() > 64 * 1024 * 1024 {
        return Err("files over 64 MB are not attached".into());
    }
    let dir = crate::sys::attachments_dir().join(&uuid::Uuid::new_v4().to_string()[..8]);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(clean);
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// Stream fragments the app never shows (a tool call's input arriving piece by piece, thinking text,
/// signatures): left out instead of crossing into the web view many times a second.
fn wanted_by_ui(ev: &Value) -> bool {
    if ev.get("type").and_then(Value::as_str) != Some("stream_event") {
        return true;
    }
    let inner = ev.get("event");
    match inner.and_then(|e| e.get("type")).and_then(Value::as_str) {
        // message_delta: the message's final output_tokens (its assistant lines carry only the
        // count from message_start while partial messages stream)
        Some("message_start") | Some("content_block_start") | Some("message_delta") => true,
        Some("content_block_delta") => inner.and_then(|e| e.get("delta")).and_then(|d| d.get("type")).and_then(Value::as_str) == Some("text_delta"),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_what_the_ui_shows_crosses() {
        let se = |t: &str, d: Option<&str>| json!({"type": "stream_event", "event": {"type": t, "delta": d.map(|d| json!({"type": d}))}});
        assert!(wanted_by_ui(&json!({"type": "assistant"})));
        assert!(wanted_by_ui(&json!({"type": "result"})));
        assert!(wanted_by_ui(&se("message_start", None)));
        assert!(wanted_by_ui(&se("content_block_start", None)));
        assert!(wanted_by_ui(&se("message_delta", None)));
        assert!(wanted_by_ui(&se("content_block_delta", Some("text_delta"))));
        assert!(!wanted_by_ui(&se("content_block_delta", Some("input_json_delta"))));
        assert!(!wanted_by_ui(&se("content_block_delta", Some("thinking_delta"))));
        assert!(!wanted_by_ui(&se("content_block_stop", None)));
    }
}
