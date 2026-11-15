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

pub struct Proc {
    stdin: ChildStdin,
    child: Child,
}

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
    /// another Claude Code config folder (account): CLAUDE_CONFIG_DIR for this session
    pub config_dir: Option<String>,
}

fn mode_flag(m: &str) -> &str {
    // the app's "default" is the CLI's "manual"
    if m == "default" { "manual" } else { m }
}

pub fn start(app: AppHandle, procs: Procs, o: StartOpts) -> Result<(), String> {
    if procs.0.lock().unwrap().contains_key(&o.key) {
        return Err("already running".into());
    }
    let mut args: Vec<String> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
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
    push("--permission-mode", &o.permission_mode.as_deref().map(|m| mode_flag(m).to_string()));
    push("--agent", &o.agent);
    push("--append-system-prompt", &o.append_system_prompt);
    push("--name", &o.name);
    push("--resume", &o.resume);
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
            let script = format!("cd {dir} && exec env CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1 claude {}", args.iter().map(|a| shell_quote(a)).collect::<Vec<_>>().join(" "));
            super::remote::ssh_cmd(host, &script)
        }
        None => {
            let mut c = crate::sys::command(claude_bin());
            c.args(&args).current_dir(&o.cwd);
            if let Some(d) = o.config_dir.as_ref().filter(|d| !d.is_empty()) {
                let home = std::env::var("HOME").unwrap_or_default();
                c.env("CLAUDE_CONFIG_DIR", d.strip_prefix("~/").map(|r| format!("{home}/{r}")).unwrap_or_else(|| d.clone()));
            }
            c
        }
    };
    super::discover::clean_env(&mut cmd);
    // exact state from claude itself: idle / running / requires_action, also while background
    // subagents or shells keep working after a turn's result
    cmd.env("CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS", "1");
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot start claude: {e}"))?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;

    // the host introduces itself first; then the first prompt
    writeln!(stdin, "{}", json!({"type": "control_request", "request_id": format!("init-{}", o.key), "request": {"subtype": "initialize", "hooks": null}})).map_err(|e| e.to_string())?;
    if let Some(p) = o.prompt.as_ref().filter(|p| !p.trim().is_empty()) {
        writeln!(stdin, "{}", user_message(p)).map_err(|e| e.to_string())?;
    }
    stdin.flush().ok();
    procs.0.lock().unwrap().insert(o.key.clone(), Proc { stdin, child });

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
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.trim().is_empty() {
                continue;
            }
            let ev: Value = serde_json::from_str(&line).unwrap_or_else(|_| json!({"type": "raw", "text": line}));
            let _ = app.emit("claude-event", json!({"key": key, "event": ev}));
        }
        let code = procs.0.lock().unwrap().remove(&key).and_then(|mut p| p.child.wait().ok()).and_then(|s| s.code());
        let stderr_tail = err_tail.lock().unwrap().join("\n");
        let _ = app.emit("claude-event", json!({"key": key, "exit": {"code": code, "stderr": stderr_tail}}));
    });
    Ok(())
}

fn user_message(text: &str) -> Value {
    json!({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": text}]}})
}

fn write(procs: &Procs, key: &str, v: Value) -> Result<(), String> {
    let mut map = procs.0.lock().unwrap();
    let p = map.get_mut(key).ok_or("session is not running in the app")?;
    writeln!(p.stdin, "{v}").map_err(|e| e.to_string())?;
    p.stdin.flush().map_err(|e| e.to_string())
}

pub fn send(procs: &Procs, key: &str, text: &str) -> Result<(), String> {
    write(procs, key, user_message(text))
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
            *m = Value::String(mode_flag(s).to_string());
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
    let pid = procs.0.lock().unwrap().get(key).map(|p| p.child.id());
    let Some(pid) = pid else { return Ok(()) };
    term(pid);
    let procs = procs.clone();
    let key = key.to_string();
    std::thread::spawn(move || {
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
    // Linux can say what the process is: never stop something that is not claude
    #[cfg(target_os = "linux")]
    {
        let cmdline = std::fs::read(format!("/proc/{pid}/cmdline")).unwrap_or_default();
        if !String::from_utf8_lossy(&cmdline).contains("claude") {
            return Err("that process is not claude".into());
        }
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
