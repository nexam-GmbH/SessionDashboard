//! Claude Code hooks → this app. A small hook script, installed only when the user asks (Settings),
//! posts every hook event with the machine name and the folder's `git status` to a local HTTP
//! endpoint. That gives exact "waiting for permission: Bash …" for sessions in a terminal, and is
//! the only channel for sessions on a VPS (their hooks post through the ssh tunnel, remote.rs).
//! The hooks run `async`, so Claude never waits for them.

use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use super::discover::claude_dir;

pub const DEFAULT_PORT: u16 = 47321;
const MARK: &str = "session-dashboard/hook.sh";
const EVENTS: [&str; 9] = [
    "SessionStart",
    "UserPromptSubmit",
    "Notification",
    "PreToolUse",
    "Stop",
    "StopFailure",
    "SessionEnd",
    "SubagentStart",
    "SubagentStop",
];

pub const SCRIPT: &str = r#"#!/bin/sh
# Session Dashboard hook, installed from the app's Settings (remove it there). Sends the Claude Code
# hook event, this machine's name and the folder's git status to the dashboard. Runs async, so
# Claude never waits for it; when the dashboard is closed the post just fails.
# "wait" (PermissionRequest of a session in a terminal): offers the prompt to the dashboard too and
# prints its answer. Claude shows its own prompt meanwhile; the first answer wins. With the
# dashboard closed curl fails at once and nothing changes.
port=$(cat "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/session-dashboard/port" 2>/dev/null || echo 47321)
token=$(cat "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/session-dashboard/token" 2>/dev/null)
url="${SD_HOOK_URL:-http://127.0.0.1:$port/hook}"
body=$(cat)
if [ "$1" = wait ]; then
  # only sessions a person runs in a terminal; scripts and SDK hosts answer their own prompts
  [ -z "$CLAUDE_CODE_ENTRYPOINT" ] || [ "$CLAUDE_CODE_ENTRYPOINT" = cli ] || exit 0
  printf '%s' "$body" | curl -s -f -m 3500 -X POST -H 'Content-Type: application/json' \
    -H "X-SD-Host: $(hostname)" -H "X-SD-Token: $token" --data-binary @- "${url%/hook}/permission" 2>/dev/null
  exit 0
fi
case "$body" in
  *'"hook_event_name":"PreToolUse"'*|*'"hook_event_name":"Notification"'*|*'"hook_event_name":"PermissionRequest"'*) git= ;;
  *) git=$(git status --porcelain=v2 --branch 2>/dev/null | head -n 300 | base64 | tr -d '\n') ;;
esac
printf '%s' "$body" | curl -s -m 3 -X POST -H 'Content-Type: application/json' \
  -H "X-SD-Host: $(hostname)" -H "X-SD-Token: $token" -H "X-SD-Git: $git" --data-binary @- "$url" >/dev/null 2>&1
exit 0
"#;

/// A secret the hook sends with every post (~/.config/session-dashboard/hook-token, made once).
pub fn hook_token() -> String {
    static TOKEN: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    TOKEN
        .get_or_init(|| {
            let p = std::path::Path::new(&std::env::var("HOME").unwrap_or_default()).join(".config/session-dashboard/hook-token");
            if let Ok(t) = std::fs::read_to_string(&p) {
                if t.trim().len() >= 32 {
                    return t.trim().to_string();
                }
            }
            let t = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
            let _ = std::fs::create_dir_all(p.parent().unwrap());
            let _ = std::fs::write(&p, &t);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
            }
            t
        })
        .clone()
}

/// Write a file where it really lives (through a symlink, e.g. dotfiles) and keep its mode.
fn write_in_place(path: &std::path::Path, data: &str) -> Result<(), String> {
    let real = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let perms = std::fs::metadata(&real).ok().map(|m| m.permissions());
    let tmp = real.with_extension("json.sd-tmp");
    std::fs::write(&tmp, data).map_err(|e| e.to_string())?;
    if let Some(p) = perms {
        let _ = std::fs::set_permissions(&tmp, p);
    }
    std::fs::rename(&tmp, &real).map_err(|e| e.to_string())
}

fn write_token(dir: &std::path::Path) -> Result<(), String> {
    let f = dir.join("token");
    std::fs::write(&f, hook_token()).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

pub fn local_hostname() -> String {
    std::fs::read_to_string("/proc/sys/kernel/hostname")
        .or_else(|_| std::fs::read_to_string("/etc/hostname"))
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

// ---------- the endpoint ----------

/// Listen on 127.0.0.1 (47321, or the next free port) and emit each post as `hook-event`.
/// Writes the port where the hook script reads it. Returns the port.
pub fn serve(app: AppHandle) -> Option<u16> {
    let (listener, port) = (DEFAULT_PORT..DEFAULT_PORT + 10).find_map(|p| TcpListener::bind(("127.0.0.1", p)).ok().map(|l| (l, p)))?;
    let dir = claude_dir().join("session-dashboard");
    if dir.exists() || port != DEFAULT_PORT {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join("port"), port.to_string());
    }
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            std::thread::spawn(move || {
                handle(
                    |name: &str, v: Value| {
                        let _ = app.emit(name, v);
                    },
                    stream,
                )
            });
        }
    });
    Some(port)
}

/// Permission prompts offered by the `wait` hook, by id: the answer goes back on the channel.
static PENDING: Mutex<Option<HashMap<String, Sender<Value>>>> = Mutex::new(None);

/// The dashboard's answer to an offered prompt (`decision` as the hook prints it).
pub fn answer(id: &str, decision: Value) -> Result<(), String> {
    let tx = PENDING.lock().unwrap().as_mut().and_then(|m| m.remove(id)).ok_or("this prompt was already answered")?;
    tx.send(decision).map_err(|_| "this prompt was already answered".to_string())
}

fn handle(emit: impl Fn(&str, Value), stream: TcpStream) {
    let Some((path, post)) = read_post(&stream) else { return };
    if path == "/hook" {
        reply(&stream, "204 No Content", "");
        emit("hook-event", post);
        return;
    }
    if path != "/permission" {
        reply(&stream, "404 Not Found", "");
        return;
    }
    let event = post["event"].clone();
    // only sessions a person runs in a terminal here (a VPS hook checks this itself)
    if post["local"] == true && !interactive(event["session_id"].as_str().unwrap_or("")) {
        reply(&stream, "204 No Content", "");
        return;
    }
    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = channel::<Value>();
    PENDING.lock().unwrap().get_or_insert_with(HashMap::new).insert(id.clone(), tx);
    emit("hook-permission", json!({"id": id, "host": post["host"], "local": post["local"], "event": event, "at": post["at"]}));
    let started = std::time::Instant::now();
    let decision = loop {
        match rx.recv_timeout(Duration::from_millis(500)) {
            // null: the dashboard drops the offer (answered elsewhere)
            Ok(d) if d.is_null() => break None,
            Ok(d) => break Some(d),
            Err(RecvTimeoutError::Disconnected) => break None,
            Err(RecvTimeoutError::Timeout) => {}
        }
        // answered in the terminal: Claude stops the hook, the connection closes
        if closed(&stream) || started.elapsed() > Duration::from_secs(3500) {
            break None;
        }
    };
    PENDING.lock().unwrap().as_mut().map(|m| m.remove(&id));
    match decision {
        Some(d) => {
            let body = json!({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": d}}).to_string();
            reply(&stream, "200 OK", &body);
            emit("hook-permission-done", json!({"id": id, "by": "app"}));
        }
        None => {
            reply(&stream, "204 No Content", "");
            emit("hook-permission-done", json!({"id": id, "by": "terminal"}));
        }
    }
}

fn reply(mut stream: &TcpStream, status: &str, body: &str) {
    let _ = stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes());
}

/// The peer hung up (a blocking read would return 0 bytes).
fn closed(stream: &TcpStream) -> bool {
    let _ = stream.set_nonblocking(true);
    let mut b = [0u8; 1];
    let gone = matches!(stream.peek(&mut b), Ok(0));
    let _ = stream.set_nonblocking(false);
    gone
}

/// A session in a terminal on this computer (its pid file says interactive, entrypoint cli).
fn interactive(session_id: &str) -> bool {
    super::discover::pid_sessions().iter().any(|v| {
        v["sessionId"] == session_id && v["kind"].as_str().unwrap_or("interactive") == "interactive" && v["entrypoint"].as_str().map(|e| e == "cli").unwrap_or(true)
    })
}

fn read_post(stream: &TcpStream) -> Option<(String, Value)> {
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut r = BufReader::new(stream.try_clone().ok()?);
    let mut first = String::new();
    r.read_line(&mut first).ok()?;
    let path = first.strip_prefix("POST ").and_then(|rest| rest.split_whitespace().next()).unwrap_or("").to_string();
    let mut len = 0usize;
    let mut host = String::new();
    let mut git = String::new();
    let mut token = String::new();
    let mut header_bytes = 0usize;
    loop {
        let mut line = String::new();
        let n = r.read_line(&mut line).ok()?;
        header_bytes += n;
        if n == 0 || line == "\r\n" || line == "\n" || header_bytes > 256 * 1024 {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            let v = v.trim();
            match k.trim().to_ascii_lowercase().as_str() {
                "content-length" => len = v.parse().unwrap_or(0),
                "x-sd-host" => host = v.to_string(),
                "x-sd-git" => git = v.to_string(),
                "x-sd-token" => token = v.to_string(),
                _ => {}
            }
        }
    }
    if path.is_empty() || len == 0 || len >= 4 << 20 {
        reply(stream, "400 Bad Request", "");
        return None;
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).ok()?;
    let event: Value = serde_json::from_slice(&body).ok()?;
    let git = String::from_utf8(b64decode(&git)).unwrap_or_default();
    // only our hook knows the token: a web page or another program can't post fake states
    if token != hook_token() {
        return None;
    }
    Some((path, json!({"host": host, "local": host.is_empty() || host == local_hostname(), "git": git, "event": event, "at": now_ms()})))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn b64decode(s: &str) -> Vec<u8> {
    let val = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    };
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut acc = 0u32;
    let mut bits = 0;
    for c in s.bytes() {
        let Some(v) = val(c) else { continue };
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

// ---------- install / remove ----------

fn hook_entry() -> Value {
    json!({"hooks": [{"type": "command", "command": format!("sh \"${{CLAUDE_CONFIG_DIR:-$HOME/.claude}}/{MARK}\""), "async": true, "timeout": 10}]})
}

/// PermissionRequest: not async, it may answer (up to an hour; the terminal prompt stays usable).
fn wait_entry() -> Value {
    json!({"hooks": [{"type": "command", "command": format!("sh \"${{CLAUDE_CONFIG_DIR:-$HOME/.claude}}/{MARK}\" wait"), "timeout": 3600}]})
}

fn is_ours(entry: &Value) -> bool {
    entry.get("hooks").and_then(Value::as_array).map(|hs| hs.iter().any(|h| h.get("command").and_then(Value::as_str).map(|c| c.contains(MARK)).unwrap_or(false))).unwrap_or(false)
}

/// settings.json with our entries added (install) or removed (uninstall); other keys untouched.
pub fn merge(settings: &str, install: bool) -> Result<String, String> {
    let mut root: Value = if settings.trim().is_empty() { json!({}) } else { serde_json::from_str(settings).map_err(|e| format!("settings.json is not valid JSON: {e}"))? };
    let obj = root.as_object_mut().ok_or("settings.json is not an object")?;
    let hooks = obj.entry("hooks").or_insert_with(|| Value::Object(Map::new()));
    let hooks = hooks.as_object_mut().ok_or("\"hooks\" in settings.json is not an object")?;
    for ev in EVENTS.iter().chain(std::iter::once(&"PermissionRequest")) {
        let list = hooks.entry(*ev).or_insert_with(|| json!([]));
        let arr = list.as_array_mut().ok_or_else(|| format!("hooks.{ev} is not a list"))?;
        arr.retain(|e| !is_ours(e));
        if install {
            arr.push(if *ev == "PermissionRequest" { wait_entry() } else { hook_entry() });
        }
    }
    hooks.retain(|_, v| v.as_array().map(|a| !a.is_empty()).unwrap_or(true));
    if hooks.is_empty() {
        obj.remove("hooks");
    }
    let mut s = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    s.push('\n');
    Ok(s)
}

pub fn installed_in(settings: &str) -> bool {
    serde_json::from_str::<Value>(settings)
        .ok()
        .and_then(|v| v.get("hooks").and_then(|h| h.get("PermissionRequest")).and_then(Value::as_array).map(|a| a.iter().any(is_ours)))
        .unwrap_or(false)
}

fn settings_path() -> PathBuf {
    claude_dir().join("settings.json")
}

pub fn status_local() -> Value {
    let s = std::fs::read_to_string(settings_path()).unwrap_or_default();
    json!({"installed": installed_in(&s) && claude_dir().join(MARK).exists(), "settings": settings_path().to_string_lossy()})
}

/// Install (or remove) the hook on this computer. The first change keeps a backup of settings.json.
pub fn set_local(install: bool, port: u16) -> Result<Value, String> {
    let path = settings_path();
    let before = std::fs::read_to_string(&path).unwrap_or_default();
    let after = merge(&before, install)?;
    let dir = claude_dir().join("session-dashboard");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let backup = claude_dir().join("settings.json.sd-backup");
    if !before.is_empty() && !backup.exists() {
        std::fs::write(&backup, &before).map_err(|e| e.to_string())?;
    }
    if install {
        std::fs::write(dir.join("hook.sh"), SCRIPT).map_err(|e| e.to_string())?;
        std::fs::write(dir.join("port"), port.to_string()).map_err(|e| e.to_string())?;
        write_token(&dir)?;
    }
    write_in_place(&path, &after)?;
    Ok(status_local())
}

const REMOTE_SETTINGS: &str = r#"d="${CLAUDE_CONFIG_DIR:-$HOME/.claude}""#;

pub fn status_remote(host: &str) -> Value {
    match super::remote::run(host, &format!(r#"{REMOTE_SETTINGS}; [ -f "$d/{MARK}" ] && echo yes || echo no; cat "$d/settings.json" 2>/dev/null"#), None, Duration::from_secs(12)) {
        Ok(out) => {
            let s = String::from_utf8_lossy(&out);
            let (script, rest) = s.split_once('\n').unwrap_or((&s, ""));
            json!({"installed": script.trim() == "yes" && installed_in(rest)})
        }
        Err(e) => json!({"installed": false, "error": e}),
    }
}

/// Install (or remove) the hook on a VPS: read its settings.json, merge here, write it back.
pub fn set_remote(host: &str, install: bool) -> Result<Value, String> {
    let out = super::remote::run(host, &format!(r#"{REMOTE_SETTINGS}; cat "$d/settings.json" 2>/dev/null; true"#), None, Duration::from_secs(12))?;
    let before = String::from_utf8_lossy(&out).to_string();
    let after = merge(&before, install)?;
    let script_b64 = b64encode(SCRIPT.as_bytes());
    let write = format!(
        r#"{REMOTE_SETTINGS}; mkdir -p "$d/session-dashboard" && {{ [ -f "$d/settings.json" ] && [ ! -f "$d/settings.json.sd-backup" ] && cp "$d/settings.json" "$d/settings.json.sd-backup"; true; }} && {} t=$(readlink -f "$d/settings.json" 2>/dev/null || echo "$d/settings.json"); cat > "$t.sd-tmp" && {{ chmod --reference="$t" "$t.sd-tmp" 2>/dev/null; true; }} && mv "$t.sd-tmp" "$t""#,
        if install { format!(r#"echo {script_b64} | base64 -d > "$d/{MARK}" && (umask 077; echo {} > "$d/session-dashboard/token") &&"#, hook_token()) } else { String::new() }
    );
    super::remote::run(host, &write, Some(after.as_bytes()), Duration::from_secs(15))?;
    Ok(status_remote(host))
}

fn b64encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn merge_roundtrip_keeps_other_hooks() {
        let before = r#"{"model":"opus","hooks":{"Stop":[{"hooks":[{"type":"command","command":"notify-send done"}]}]}}"#;
        let on = merge(before, true).unwrap();
        assert!(installed_in(&on));
        assert!(on.contains("notify-send done"));
        // installing twice adds nothing
        assert_eq!(merge(&on, true).unwrap(), on);
        let off = merge(&on, false).unwrap();
        assert!(!installed_in(&off));
        assert!(off.contains("notify-send done"));
        assert!(!off.contains("SessionStart"));
        // keys keep their order
        assert!(off.find("model").unwrap() < off.find("hooks").unwrap());
    }
    /// The `wait` hook end to end: the real script and curl against the server; the "app" answers.
    #[test]
    fn permission_offer_roundtrip() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                std::thread::spawn(move || {
                    handle(
                        |name: &str, v: Value| {
                            if name == "hook-permission" {
                                let id = v["id"].as_str().unwrap().to_string();
                                let tool = v["event"]["tool_name"].as_str().unwrap().to_string();
                                std::thread::spawn(move || {
                                    std::thread::sleep(Duration::from_millis(200));
                                    let d = if tool == "Bash" { json!({"behavior": "allow"}) } else { Value::Null };
                                    answer(&id, d).unwrap();
                                });
                            }
                        },
                        stream,
                    )
                });
            }
        });
        let dir = std::env::temp_dir().join(format!("sd-hook-test-{port}"));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("hook.sh");
        std::fs::write(&script, SCRIPT).unwrap();
        // the hook reads its token where the app installs it
        std::fs::create_dir_all(dir.join("session-dashboard")).unwrap();
        std::fs::write(dir.join("session-dashboard/token"), hook_token()).unwrap();
        let run = |body: &str| {
            let mut c = std::process::Command::new("sh");
            c.arg(&script).arg("wait").env("SD_HOOK_URL", format!("http://127.0.0.1:{port}/hook")).env("CLAUDE_CODE_ENTRYPOINT", "cli").env("HOSTNAME", "x").env("CLAUDE_CONFIG_DIR", &dir);
            // a host name that is not this computer's: the server then skips the pid-file check
            c.env("PATH", format!("{}:{}", dir.display(), std::env::var("PATH").unwrap()));
            std::fs::write(dir.join("hostname"), "#!/bin/sh\necho test-vps\n").unwrap();
            std::process::Command::new("chmod").arg("+x").arg(dir.join("hostname")).status().unwrap();
            c.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped());
            let mut child = c.spawn().unwrap();
            child.stdin.take().unwrap().write_all(body.as_bytes()).unwrap();
            String::from_utf8(child.wait_with_output().unwrap().stdout).unwrap()
        };
        let out = run(r#"{"session_id":"s1","hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"ls"}}"#);
        let v: Value = serde_json::from_str(&out).expect("the hook prints the decision");
        assert_eq!(v["hookSpecificOutput"]["decision"]["behavior"], "allow");
        assert_eq!(v["hookSpecificOutput"]["hookEventName"], "PermissionRequest");
        // a post without the token is ignored: nothing printed, nothing offered
        let mut c = std::process::Command::new("curl");
        c.args(["-s", "-m", "3", "-X", "POST", "-H", "X-SD-Host: test-vps", "--data-binary", r#"{"session_id":"s1","tool_name":"Bash","tool_input":{}}"#, &format!("http://127.0.0.1:{port}/permission")]);
        assert_eq!(c.output().unwrap().stdout.len(), 0);
        // withdrawn (answered in the terminal): the hook prints nothing
        let out = run(r#"{"session_id":"s1","hook_event_name":"PermissionRequest","tool_name":"Edit","tool_input":{}}"#);
        assert_eq!(out, "");
        // an SDK host's session: the hook does not even ask
        let mut c = std::process::Command::new("sh");
        c.arg(&script).arg("wait").env("SD_HOOK_URL", format!("http://127.0.0.1:{port}/hook")).env("CLAUDE_CODE_ENTRYPOINT", "sdk-cli");
        c.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped());
        let mut child = c.spawn().unwrap();
        child.stdin.take().unwrap().write_all(b"{}").unwrap();
        assert_eq!(child.wait_with_output().unwrap().stdout.len(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn b64_roundtrip() {
        let s = "# branch.head main\n1 .M N... 100644\n";
        assert_eq!(String::from_utf8(b64decode(&b64encode(s.as_bytes()))).unwrap(), s);
    }
}
