//! `sd mcp`: an MCP server on stdio that lets Claude Code drive the running app (start, message,
//! read and wait for dashboard sessions). Newline-delimited JSON-RPC 2.0 on stdin/stdout, logs
//! only on stderr (MCP 2025-11-25, basic/transports "stdio"). Lifecycle: `initialize` answers the
//! client's protocol version when supported, else the latest one here (basic/lifecycle "Version
//! Negotiation"); `notifications/initialized` and other notifications get no reply; `ping` → {}.
//! Tools (server/tools): unknown tools and malformed calls are JSON-RPC errors (-32602), failures
//! inside a tool are results with `isError: true` so the model can correct itself.
//! Spec: https://modelcontextprotocol.io/specification/2025-11-25
//!
//! Each tool call runs on its own thread (a long wait_for_session does not block ping or other
//! calls); `notifications/cancelled` ends a wait early and drops its response, as the spec asks.
use crate::sdcli::{self, Backend, SdError};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::io::{BufRead, Write};
use std::sync::Mutex;
use std::time::Duration;

/// Newest first; `initialize` answers the client's version if it is one of these.
pub const VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS: &str = "Session Dashboard is the desktop app where the human runs and watches their Claude Code sessions. \
These tools start sessions the human can follow there, message them, read them and wait for them. \
Name a session by its id, an id prefix of 6+ characters, or a unique part of its title (list_sessions shows them). \
A session in waiting_permission needs the human: they answer permission prompts in the dashboard (open_session shows it to them).";

pub fn run_stdio() -> i32 {
    eprintln!("session-dashboard MCP server {} on stdio", env!("CARGO_PKG_VERSION"));
    let stdin = std::io::stdin();
    serve(stdin.lock(), std::io::stdout(), &sdcli::call, sdcli::POLL);
    0
}

struct State {
    version: Mutex<String>,
    /// request ids (as JSON text) the client cancelled
    cancelled: Mutex<HashSet<String>>,
}

fn reply(id: &Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn error(id: &Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

fn send<W: Write>(out: &Mutex<W>, msg: &Value) {
    // serde_json escapes newlines inside strings: one message per line, as stdio requires
    let mut line = serde_json::to_string(msg).unwrap_or_default();
    line.push('\n');
    let mut w = out.lock().unwrap();
    let _ = w.write_all(line.as_bytes());
    let _ = w.flush();
}

/// Reads messages until EOF and answers them; returns once every running tool call has finished.
pub fn serve<R: BufRead, W: Write + Send>(input: R, output: W, backend: &Backend, poll: Duration) {
    let out = &Mutex::new(output);
    let state = &State { version: Mutex::new(VERSIONS[0].to_string()), cancelled: Mutex::new(HashSet::new()) };
    std::thread::scope(|scope| {
        for line in input.lines() {
            let Ok(line) = line else { break };
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let msg: Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => {
                    send(out, &error(&Value::Null, -32700, "Parse error"));
                    continue;
                }
            };
            let Some(obj) = msg.as_object() else {
                // batches were removed in 2025-06-18
                send(out, &error(&Value::Null, -32600, "Invalid Request: expected one JSON-RPC object"));
                continue;
            };
            let id = obj.get("id").cloned();
            let Some(method) = obj.get("method").and_then(Value::as_str) else {
                // a response to a request of ours (there are none) is ignored; anything else is invalid
                if !(obj.contains_key("result") || obj.contains_key("error")) {
                    send(out, &error(id.as_ref().unwrap_or(&Value::Null), -32600, "Invalid Request: no method"));
                }
                continue;
            };
            let params = obj.get("params").cloned().unwrap_or_else(|| json!({}));
            let Some(id) = id else {
                if method == "notifications/cancelled" {
                    if let Some(rid) = params.get("requestId") {
                        state.cancelled.lock().unwrap().insert(rid.to_string());
                    }
                }
                continue;
            };
            match method {
                "initialize" => {
                    let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
                    let version = VERSIONS.iter().find(|v| **v == asked).copied().unwrap_or(VERSIONS[0]);
                    *state.version.lock().unwrap() = version.to_string();
                    let result = json!({
                        "protocolVersion": version,
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": "session-dashboard", "title": "Session Dashboard", "version": env!("CARGO_PKG_VERSION")},
                        "instructions": INSTRUCTIONS,
                    });
                    send(out, &reply(&id, result));
                }
                "ping" => send(out, &reply(&id, json!({}))),
                "tools/list" => send(out, &reply(&id, json!({"tools": tools()}))),
                "tools/call" => {
                    scope.spawn(move || {
                        let key = id.to_string();
                        let cancelled = || state.cancelled.lock().unwrap().contains(&key);
                        let version = state.version.lock().unwrap().clone();
                        let msg = match call_tool(&params, backend, poll, &cancelled, &version) {
                            Ok(result) => reply(&id, result),
                            Err((code, m)) => error(&id, code, &m),
                        };
                        if !state.cancelled.lock().unwrap().remove(&key) {
                            send(out, &msg);
                        }
                    });
                }
                _ => send(out, &error(&id, -32601, &format!("Method not found: {method}"))),
            }
        }
    });
}

// ---- tools ---------------------------------------------------------------------------------

const SESSION_DESC: &str = "The session: its id, an id prefix of at least 6 characters, or a unique part of its title (see list_sessions).";

fn session_schema() -> Value {
    json!({"type": "object", "properties": {"session": {"type": "string", "description": SESSION_DESC}}, "required": ["session"]})
}

/// The tools with their input schemas (JSON Schema 2020-12, the MCP default).
pub fn tools() -> Value {
    json!([
        {
            "name": "list_sessions",
            "title": "List dashboard sessions",
            "description": "List the Claude Code sessions in Session Dashboard (the ones the dashboard runs and the terminal sessions it sees), with id, title, status, working folder (cwd), repo, machine, who controls it (control) and updatedAt. \
Status is one of: starting, working, waiting_permission (blocked on a permission prompt the human answers in the dashboard), waiting_input (asked a question), idle (finished its turn), done_unseen (finished, the human has not looked yet), error, stopped. \
Use this to find a session's id before send_message, read_session, session_status or wait_for_session.",
            "inputSchema": {"type": "object", "properties": {
                "query": {"type": "string", "description": "Only sessions whose title, folder or text match this."},
                "status": {"type": "string", "description": "Only sessions with this status, e.g. working or waiting_permission."},
                "workspace": {"type": "string", "description": "Only sessions in this dashboard workspace (its name)."}
            }},
            "annotations": {"readOnlyHint": true, "openWorldHint": false}
        },
        {
            "name": "new_session",
            "title": "Start a dashboard session",
            "description": "Start a new Claude Code session that Session Dashboard owns, in the folder dir, optionally with a first prompt, and return its id and title. \
Use this rather than running `claude` yourself or a subagent when the work should be visible to the human and outlive you: the session shows in the dashboard with its live status, the human can read it, reply and answer its permission prompts there, and the dashboard restores it after an app restart. \
Once running it is an ordinary Claude Code session, so Claude Code's native cross-session tools (ListAgents, SendMessage), where you have them, can reach it too; send_message, read_session and wait_for_session work either way. \
Typical flow: new_session with a prompt, then wait_for_session, then read_session.",
            "inputSchema": {"type": "object", "properties": {
                "dir": {"type": "string", "description": "Absolute path of the project folder the session works in."},
                "prompt": {"type": "string", "description": "The first message. Without it the session starts idle and waits for send_message."},
                "name": {"type": "string", "description": "A title for the session in the dashboard."},
                "model": {"type": "string", "description": "Model alias or id, e.g. opus, sonnet. Default: the user's default model."},
                "effort": {"type": "string", "description": "Reasoning effort, e.g. low, medium, high. Default: the user's default."},
                "permission_mode": {"type": "string", "description": "Claude Code permission mode, e.g. default, acceptEdits, plan. Default: the user's default. Do not loosen it unless the human asked."},
                "worktree": {"type": "boolean", "description": "Run the session in a new git worktree of dir, so it does not touch the main checkout. Default false."},
                "open": {"type": "boolean", "description": "Also show the session in the dashboard window. Default false."}
            }, "required": ["dir"]},
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false}
        },
        {
            "name": "send_message",
            "title": "Message a session",
            "description": "Send a user message to a session, as if the human typed it in the dashboard. Best when the session is idle or waiting_input (check with session_status). \
It does not wait for the answer: follow with wait_for_session, then read_session. The dashboard returns an error when it cannot deliver to that session.",
            "inputSchema": {"type": "object", "properties": {
                "session": {"type": "string", "description": SESSION_DESC},
                "text": {"type": "string", "description": "The message."}
            }, "required": ["session", "text"]},
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false}
        },
        {
            "name": "read_session",
            "title": "Read a session",
            "description": "Read the latest messages of a session (user and assistant text), oldest first, with its title and status.",
            "inputSchema": {"type": "object", "properties": {
                "session": {"type": "string", "description": SESSION_DESC},
                "last": {"type": "integer", "minimum": 1, "maximum": 500, "default": 20, "description": "How many of the latest messages. Default 20."}
            }, "required": ["session"]},
            "annotations": {"readOnlyHint": true, "openWorldHint": false}
        },
        {
            "name": "session_status",
            "title": "Session status",
            "description": "A session's status right now, without waiting: starting, working, waiting_permission, waiting_input, idle, done_unseen, error or stopped, plus outcome and what it is waiting for (waitingFor) when blocked.",
            "inputSchema": session_schema(),
            "annotations": {"readOnlyHint": true, "openWorldHint": false}
        },
        {
            "name": "wait_for_session",
            "title": "Wait for a session",
            "description": "Wait until a session stops working (its status is no longer starting or working) or timeout_seconds pass, then return its status and its last assistant message. \
waiting_permission: a permission prompt is open, which only the human can answer in the dashboard (open_session shows it to them). waiting_input: it asked a question you may answer with send_message. \
On timeout the result has timedOut: true and the current status; call again to keep waiting.",
            "inputSchema": {"type": "object", "properties": {
                "session": {"type": "string", "description": SESSION_DESC},
                "timeout_seconds": {"type": "integer", "minimum": 1, "maximum": 600, "default": 120, "description": "How long to wait at most. Default 120, at most 600."}
            }, "required": ["session"]},
            "annotations": {"readOnlyHint": true, "openWorldHint": false}
        },
        {
            "name": "stop_session",
            "title": "Stop a session",
            "description": "Stop a session: interrupts what it is doing and stops it in the dashboard (status becomes stopped). Its history stays. Only when the human asked, or the session is clearly stuck or doing the wrong thing.",
            "inputSchema": session_schema(),
            "annotations": {"readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false}
        },
        {
            "name": "open_session",
            "title": "Show a session to the human",
            "description": "Bring the Session Dashboard window forward with this session open, for when the human should look at it (for example a permission prompt in waiting_permission).",
            "inputSchema": session_schema(),
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}
        }
    ])
}

type Args = Map<String, Value>;

fn req_str(a: &Args, k: &str) -> Result<String, String> {
    match a.get(k) {
        Some(Value::String(s)) if !s.trim().is_empty() => Ok(s.clone()),
        Some(Value::String(_)) | None | Some(Value::Null) => Err(format!("{k} is required")),
        Some(_) => Err(format!("{k} must be a string")),
    }
}

fn opt_str(a: &Args, k: &str) -> Result<Option<String>, String> {
    match a.get(k) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.trim().is_empty() => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(format!("{k} must be a string")),
    }
}

fn opt_bool(a: &Args, k: &str) -> Result<Option<bool>, String> {
    match a.get(k) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(b)) => Ok(Some(*b)),
        Some(Value::String(s)) if s == "true" || s == "false" => Ok(Some(s == "true")),
        Some(_) => Err(format!("{k} must be true or false")),
    }
}

fn opt_int(a: &Args, k: &str, min: u64, max: u64) -> Result<Option<u64>, String> {
    let n = match a.get(k) {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Number(n)) => n.as_u64().or_else(|| n.as_f64().filter(|f| f.fract() == 0.0 && *f >= 0.0).map(|f| f as u64)),
        Some(Value::String(s)) => s.trim().parse().ok(),
        Some(_) => None,
    };
    match n {
        Some(n) if (min..=max).contains(&n) => Ok(Some(n)),
        _ => Err(format!("{k} must be a whole number from {min} to {max}")),
    }
}

/// `tools/call`: Ok(result) — a tool failure is a result with isError — or Err((code, message)).
fn call_tool(params: &Value, backend: &Backend, poll: Duration, cancelled: &dyn Fn() -> bool, version: &str) -> Result<Value, (i64, String)> {
    let name = params.get("name").and_then(Value::as_str).ok_or((-32602, "Invalid params: tools/call needs a tool name".to_string()))?;
    let args = match params.get("arguments") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(o)) => o.clone(),
        Some(_) => return Err((-32602, "Invalid params: arguments must be an object".into())),
    };
    if !tools().as_array().is_some_and(|t| t.iter().any(|t| t["name"] == name)) {
        return Err((-32602, format!("Unknown tool: {name}")));
    }
    // structuredContent came with 2025-06-18; older clients get the text only
    let structured = version >= "2025-06-18";
    Ok(match run_tool(name, &args, backend, poll, cancelled) {
        Ok((text, data)) => {
            let mut r = json!({"content": [{"type": "text", "text": text}], "isError": false});
            if structured && data.is_object() {
                r["structuredContent"] = data;
            }
            r
        }
        Err(e) => json!({"content": [{"type": "text", "text": e}], "isError": true}),
    })
}

/// One tool: (text for the model, the structured result) or an error message.
fn run_tool(name: &str, a: &Args, backend: &Backend, poll: Duration, cancelled: &dyn Fn() -> bool) -> Result<(String, Value), String> {
    let app = |cmd: &str, args: Value| backend(cmd, args).map_err(|e: SdError| e.to_string());
    let session = || req_str(a, "session");
    match name {
        "list_sessions" => {
            let mut q = Map::new();
            for k in ["query", "status", "workspace"] {
                if let Some(v) = opt_str(a, k)? {
                    q.insert(k.into(), v.into());
                }
            }
            let v = app("list", Value::Object(q))?;
            Ok((sdcli::fmt_list(&v, true), v))
        }
        "new_session" => {
            let mut q = Map::new();
            q.insert("dir".into(), req_str(a, "dir")?.into());
            for (k, to) in [("prompt", "prompt"), ("name", "name"), ("model", "model"), ("effort", "effort"), ("permission_mode", "permissionMode")] {
                if let Some(v) = opt_str(a, k)? {
                    q.insert(to.into(), v.into());
                }
            }
            for k in ["worktree", "open"] {
                if let Some(b) = opt_bool(a, k)? {
                    q.insert(k.into(), b.into());
                }
            }
            let v = app("new", Value::Object(q))?;
            let text = format!("Started session {} \"{}\". It shows in Session Dashboard; use wait_for_session to wait for its answer.", v["id"].as_str().unwrap_or(""), v["title"].as_str().unwrap_or(""));
            Ok((text, v))
        }
        "send_message" => {
            let v = app("send", json!({"session": session()?, "text": req_str(a, "text")?}))?;
            Ok((format!("Sent to session {}. Use wait_for_session to wait for the answer.", v["id"].as_str().unwrap_or("")), v))
        }
        "read_session" => {
            let last = opt_int(a, "last", 1, 500)?.unwrap_or(20);
            let v = app("read", json!({"session": session()?, "last": last}))?;
            Ok((sdcli::fmt_read(&v), v))
        }
        "session_status" => {
            let v = app("status", json!({"session": session()?}))?;
            Ok((status_text(&v), v))
        }
        "wait_for_session" => {
            let s = session()?;
            let secs = match a.get("timeout_seconds") {
                // a larger number is clamped rather than refused: the model meant "long"
                Some(Value::Number(n)) if n.as_f64().is_some_and(|f| f > 600.0) => 600,
                _ => opt_int(a, "timeout_seconds", 1, 600)?.unwrap_or(120),
            };
            let end = sdcli::wait_for(backend, &s, Duration::from_secs(secs), poll, cancelled).map_err(|e| e.to_string())?;
            let id = end.status.get("id").and_then(Value::as_str).unwrap_or(&s).to_string();
            let last = backend("read", json!({"session": id, "last": 10})).ok().and_then(|r| sdcli::last_assistant(&r));
            let mut data = end.status.clone();
            if !data.is_object() {
                data = json!({});
            }
            data["timedOut"] = end.timed_out.into();
            data["lastAssistantMessage"] = last.clone().map(Value::String).unwrap_or(Value::Null);
            let mut text = String::new();
            if end.timed_out {
                text.push_str(&format!("Still not done after {secs} s (call again to keep waiting).\n"));
            }
            text.push_str(&status_text(&end.status));
            text.push_str(&format!("\nLast assistant message:\n{}", last.as_deref().unwrap_or("(none)")));
            Ok((text, data))
        }
        "stop_session" => {
            let v = app("stop", json!({"session": session()?}))?;
            Ok((format!("Stopped session {}.", v["id"].as_str().unwrap_or("")), v))
        }
        "open_session" => {
            let v = app("open", json!({"session": session()?}))?;
            Ok((format!("Session {} is open in Session Dashboard.", v["id"].as_str().unwrap_or("")), v))
        }
        _ => Err(format!("Unknown tool: {name}")),
    }
}

fn status_text(v: &Value) -> String {
    let get = |k: &str| v.get(k).filter(|x| !x.is_null());
    let mut t = format!("Status: {}\nSession: {} ({})\n", v["status"].as_str().unwrap_or("unknown"), v["title"].as_str().unwrap_or(""), v["id"].as_str().unwrap_or(""));
    if let Some(o) = get("outcome") {
        t.push_str(&format!("Outcome: {}\n", o.as_str().map(str::to_string).unwrap_or_else(|| o.to_string())));
    }
    if let Some(w) = get("waitingFor") {
        t.push_str(&format!("Waiting for: {}\n", w.as_str().map(str::to_string).unwrap_or_else(|| w.to_string())));
    }
    t
}

#[cfg(test)]
mod tests {
    use super::*;

    fn backend(cmd: &str, args: Value) -> Result<Value, SdError> {
        match cmd {
            "list" => Ok(json!({"sessions": [{"id": "0123456789abcdef", "title": "Fix login", "status": "working", "cwd": "/srv/app", "control": "app", "updatedAt": 1}]})),
            "new" => {
                assert_eq!(args, json!({"dir": "/srv/app", "prompt": "hi", "permissionMode": "plan", "worktree": true}));
                Ok(json!({"id": "newid", "title": "hi"}))
            }
            "status" => Ok(json!({"id": "0123456789abcdef", "title": "Fix login", "status": "idle"})),
            "read" => Ok(json!({"id": "0123456789abcdef", "title": "Fix login", "status": "idle", "messages": [
                {"role": "user", "text": "fix it"}, {"role": "assistant", "text": "Fixed in auth.rs."}]})),
            "send" if args["session"] == "missing" => Err(SdError::App("no session matches missing".into())),
            _ => Ok(json!({"id": "0123456789abcdef"})),
        }
    }

    /// Feeds lines to the server and returns its responses by id (notifications have none).
    fn exchange(lines: &[Value]) -> (Vec<Value>, std::collections::HashMap<String, Value>) {
        let input: String = lines.iter().map(|l| format!("{l}\n")).collect();
        let mut out = Vec::new();
        serve(input.as_bytes(), &mut out, &backend, Duration::ZERO);
        let text = String::from_utf8(out).unwrap();
        let all: Vec<Value> = text.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        let by_id = all.iter().map(|m| (m["id"].to_string(), m.clone())).collect();
        (all, by_id)
    }

    fn call(id: u64, name: &str, args: Value) -> Value {
        json!({"jsonrpc": "2.0", "id": id, "method": "tools/call", "params": {"name": name, "arguments": args}})
    }

    #[test]
    fn lifecycle_and_tools() {
        let (all, r) = exchange(&[
            json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}}),
            json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
            json!({"jsonrpc": "2.0", "id": 3, "method": "ping"}),
            call(4, "list_sessions", json!({})),
            call(5, "new_session", json!({"dir": "/srv/app", "prompt": "hi", "permission_mode": "plan", "worktree": true})),
            call(6, "wait_for_session", json!({"session": "012345", "timeout_seconds": 5})),
            json!({"jsonrpc": "2.0", "id": 7, "method": "resources/list"}),
            call(8, "no_such_tool", json!({})),
            call(9, "send_message", json!({"session": "missing", "text": "hi"})),
            call(10, "read_session", json!({"text": "no session"})),
            json!({"jsonrpc": "2.0", "id": 11, "method": "tools/call", "params": {"name": "list_sessions", "arguments": [1]}}),
        ]);
        // one response per request, none for the notification
        assert_eq!(all.len(), 11);
        assert!(all.iter().all(|m| m["jsonrpc"] == "2.0"));
        let init = &r["1"]["result"];
        assert_eq!(init["protocolVersion"], "2025-06-18");
        assert_eq!(init["capabilities"], json!({"tools": {}}));
        assert_eq!(init["serverInfo"]["name"], "session-dashboard");
        let names: Vec<&str> = r["2"]["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["list_sessions", "new_session", "send_message", "read_session", "session_status", "wait_for_session", "stop_session", "open_session"]);
        assert!(r["2"]["result"]["tools"].as_array().unwrap().iter().all(|t| t["inputSchema"]["type"] == "object" && t["description"].as_str().unwrap().len() > 40));
        assert_eq!(r["3"]["result"], json!({}));
        let list = &r["4"]["result"];
        assert_eq!(list["isError"], false);
        assert!(list["content"][0]["text"].as_str().unwrap().contains("0123456789abcdef  working  Fix login"));
        assert_eq!(list["structuredContent"]["sessions"][0]["id"], "0123456789abcdef");
        assert!(r["5"]["result"]["content"][0]["text"].as_str().unwrap().starts_with("Started session newid"));
        let wait = &r["6"]["result"];
        assert_eq!(wait["structuredContent"]["status"], "idle");
        assert_eq!(wait["structuredContent"]["timedOut"], false);
        assert_eq!(wait["structuredContent"]["lastAssistantMessage"], "Fixed in auth.rs.");
        assert!(wait["content"][0]["text"].as_str().unwrap().contains("Last assistant message:\nFixed in auth.rs."));
        assert_eq!(r["7"]["error"]["code"], -32601);
        assert_eq!(r["8"]["error"]["code"], -32602);
        assert_eq!(r["8"]["error"]["message"], "Unknown tool: no_such_tool");
        assert_eq!(r["9"]["result"]["isError"], true);
        assert_eq!(r["9"]["result"]["content"][0]["text"], "no session matches missing");
        assert_eq!(r["10"]["result"]["isError"], true);
        assert_eq!(r["10"]["result"]["content"][0]["text"], "session is required");
        assert_eq!(r["11"]["error"]["code"], -32602);
    }

    #[test]
    fn version_negotiation_and_bad_input() {
        let (all, r) = exchange(&[json!({"jsonrpc": "2.0", "id": "a", "method": "initialize", "params": {"protocolVersion": "1999-01-01"}})]);
        assert_eq!(all.len(), 1);
        assert_eq!(r["\"a\""]["result"]["protocolVersion"], VERSIONS[0]);
        // old clients get no structuredContent
        let (_, r) = exchange(&[
            json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05"}}),
            call(2, "session_status", json!({"session": "012345"})),
        ]);
        assert_eq!(r["1"]["result"]["protocolVersion"], "2024-11-05");
        assert!(r["2"]["result"].get("structuredContent").is_none());
        assert!(r["2"]["result"]["content"][0]["text"].as_str().unwrap().starts_with("Status: idle"));
        // garbage and batches
        let mut out = Vec::new();
        serve("not json\n[1,2]\n\n".as_bytes(), &mut out, &backend, Duration::ZERO);
        let lines: Vec<Value> = String::from_utf8(out).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(lines[0]["error"]["code"], -32700);
        assert_eq!(lines[1]["error"]["code"], -32600);
        assert_eq!(lines.len(), 2);
    }

    #[test]
    fn cancelled_wait_gets_no_response() {
        // a session that never finishes; the client cancels the wait
        fn busy(_: &str, _: Value) -> Result<Value, SdError> {
            Ok(json!({"id": "x", "status": "working"}))
        }
        let input = format!(
            "{}\n{}\n{}\n",
            call(1, "wait_for_session", json!({"session": "x", "timeout_seconds": 30})),
            json!({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 1, "reason": "user"}}),
            json!({"jsonrpc": "2.0", "id": 2, "method": "ping"}),
        );
        let mut out = Vec::new();
        let t = std::time::Instant::now();
        serve(input.as_bytes(), &mut out, &busy, Duration::from_millis(50));
        assert!(t.elapsed() < Duration::from_secs(5));
        let lines: Vec<Value> = String::from_utf8(out).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(lines, [json!({"jsonrpc": "2.0", "id": 2, "result": {}})]);
    }
}
