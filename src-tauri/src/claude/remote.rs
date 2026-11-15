//! Machines over ssh (a VPS with repos that are not on this computer). Everything goes through the
//! user's own ssh (keys, ~/.ssh/config aliases, agent): `BatchMode` so it never prompts, and a
//! shared master connection so repeated reads stay fast. Per machine the app keeps a reverse
//! tunnel, so the hooks there (hooks.rs) reach this app at 127.0.0.1:<port> on the VPS.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use super::transcript::{parse_bytes, TranscriptChunk};

/// The remote port hooks post to; the tunnel forwards it to this app's hook port.
pub const REMOTE_HOOK_PORT: u16 = 47321;

pub fn ssh_bin() -> String {
    std::env::var("SD_SSH").unwrap_or_else(|_| "ssh".into())
}

fn control_path() -> String {
    let dir = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().trim_end_matches('/').to_string());
    format!("{dir}/sd-ssh-%C")
}

pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Where claude usually lives on a server: non-interactive ssh shells often miss ~/.local/bin etc.
pub const REMOTE_PATH: &str = r#"PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.claude/local:$HOME/.bun/bin:/usr/local/bin:$PATH""#;

/// An ssh command for `host` running `script` in a POSIX shell there.
pub fn ssh_cmd(host: &str, script: &str) -> Command {
    let mut c = crate::sys::command(ssh_bin());
    c.args(["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8"]);
    // one shared connection per host (Windows' OpenSSH has no connection sharing)
    if !cfg!(windows) {
        c.args(["-o", "ControlMaster=auto", "-o", &format!("ControlPath={}", control_path()), "-o", "ControlPersist=120"]);
    }
    c.args([
        host,
        &format!("sh -c {}", shell_quote(&format!("{REMOTE_PATH}; {script}"))),
    ]);
    c
}

/// Run a script on `host`, wait at most `timeout`, return stdout (stderr in the error).
pub fn run(host: &str, script: &str, stdin: Option<&[u8]>, timeout: Duration) -> Result<Vec<u8>, String> {
    let mut c = ssh_cmd(host, script);
    c.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = c.spawn().map_err(|e| format!("cannot run ssh: {e}"))?;
    if let (Some(data), Some(mut w)) = (stdin, child.stdin.take()) {
        use std::io::Write;
        w.write_all(data).map_err(|e| e.to_string())?;
    }
    let mut out = child.stdout.take().ok_or("no stdout")?;
    let mut err = child.stderr.take().ok_or("no stderr")?;
    let reader = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = out.read_to_end(&mut b);
        b
    });
    let err_reader = std::thread::spawn(move || {
        let mut b = String::new();
        let _ = err.read_to_string(&mut b);
        b
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if Instant::now() > deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{host}: no answer in {}s", timeout.as_secs()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(30)),
            Err(e) => return Err(e.to_string()),
        }
    };
    let out = reader.join().unwrap_or_default();
    let err = err_reader.join().unwrap_or_default();
    if !status.success() {
        let msg = err.lines().filter(|l| !l.trim().is_empty()).last().unwrap_or("ssh failed").to_string();
        return Err(format!("{host}: {msg}"));
    }
    Ok(out)
}

/// Can we reach the machine, and does it have claude? {ok, hostname, claude, error}
pub fn probe(host: &str) -> Value {
    match run(host, "hostname; command -v claude || echo -; claude --version 2>/dev/null | head -1", None, Duration::from_secs(12)) {
        Ok(out) => {
            let s = String::from_utf8_lossy(&out);
            let mut l = s.lines();
            let hostname = l.next().unwrap_or("").trim().to_string();
            let bin = l.next().unwrap_or("-").trim().to_string();
            let version = l.next().unwrap_or("").trim().to_string();
            json!({"ok": true, "hostname": hostname, "claude": if bin == "-" { Value::Null } else { json!(bin) }, "version": version})
        }
        Err(e) => json!({"ok": false, "error": e}),
    }
}

/// `claude agents --json` on the machine.
pub fn agents(host: &str) -> Result<Value, String> {
    let out = run(host, "claude agents --json", None, Duration::from_secs(15))?;
    serde_json::from_slice(&out).map_err(|e| format!("{host}: claude agents: {e}"))
}

// the transcript of a session id, wherever its project folder is
fn transcript_glob(session_id: &str) -> Result<String, String> {
    if !session_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("bad session id".into());
    }
    Ok(format!(r#"f=$(ls "${{CLAUDE_CONFIG_DIR:-$HOME/.claude}}"/projects/*/{session_id}.jsonl 2>/dev/null | head -n 1); [ -n "$f" ] || {{ echo "no transcript" >&2; exit 3; }}"#))
}

/// The last ~4 MB of a remote transcript as records (offset = the file size it was read at).
pub fn transcript_window(host: &str, session_id: &str, max: usize) -> Result<TranscriptChunk, String> {
    let script = format!(r#"{}; wc -c < "$f"; tail -c 4000000 "$f""#, transcript_glob(session_id)?);
    let out = run(host, &script, None, Duration::from_secs(30))?;
    let nl = out.iter().position(|b| *b == b'\n').ok_or("bad answer")?;
    let size: u64 = String::from_utf8_lossy(&out[..nl]).trim().parse().map_err(|_| "bad size")?;
    let body = &out[nl + 1..];
    let base = size.saturating_sub(body.len() as u64);
    Ok(parse_bytes(body, base, max, base > 0))
}

/// Records appended to a remote transcript since `offset`.
pub fn transcript_since(host: &str, session_id: &str, offset: u64) -> Result<TranscriptChunk, String> {
    let script = format!(r#"{}; s=$(wc -c < "$f"); echo $s; [ "$s" -ge {offset} ] && tail -c +{} "$f" | head -c 8000000"#, transcript_glob(session_id)?, offset + 1);
    let out = run(host, &script, None, Duration::from_secs(20))?;
    let nl = out.iter().position(|b| *b == b'\n').ok_or("bad answer")?;
    let size: u64 = String::from_utf8_lossy(&out[..nl]).trim().parse().map_err(|_| "bad size")?;
    if size < offset {
        return Err("truncated".into());
    }
    Ok(parse_bytes(&out[nl + 1..], offset, usize::MAX, false))
}

/// Take over a VPS session from its terminal: stop that claude (SIGINT twice, then SIGTERM).
pub fn takeover(host: &str, pid: u32) -> Result<(), String> {
    let script = format!(
        "grep -q claude /proc/{pid}/cmdline 2>/dev/null || {{ echo 'not claude' >&2; exit 3; }}; kill -INT {pid}; sleep 0.3; kill -INT {pid}; for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do kill -0 {pid} 2>/dev/null || exit 0; sleep 0.1; done; kill -TERM {pid}; sleep 2; kill -0 {pid} 2>/dev/null && {{ echo 'it did not stop' >&2; exit 4; }}; exit 0"
    );
    run(host, &script, None, Duration::from_secs(20)).map(|_| ())
}

// ---------- reverse tunnels ----------

#[derive(Default, Clone)]
pub struct Tunnels(Arc<Mutex<HashMap<String, Child>>>);

/// Keep one `ssh -N -R` per machine so hooks there reach this app; drop tunnels for machines that
/// were removed. A watcher restarts tunnels that died (network change, sleep).
pub fn set_tunnels(app: AppHandle, t: Tunnels, hosts: Vec<String>, local_port: u16) {
    let mut map = t.0.lock().unwrap();
    map.retain(|h, c| {
        let keep = hosts.contains(h);
        if !keep {
            let _ = c.kill();
            let _ = c.wait();
        }
        keep
    });
    for h in hosts {
        let alive = map.get_mut(&h).map(|c| matches!(c.try_wait(), Ok(None))).unwrap_or(false);
        if alive {
            continue;
        }
        match open_tunnel(&h, local_port) {
            Ok(c) => {
                map.insert(h.clone(), c);
                let _ = app.emit("remote-status", json!({"host": h, "tunnel": true}));
            }
            Err(e) => {
                map.remove(&h);
                let _ = app.emit("remote-status", json!({"host": h, "tunnel": false, "error": e}));
            }
        }
    }
}

fn open_tunnel(host: &str, local_port: u16) -> Result<Child, String> {
    let mut c = crate::sys::command(ssh_bin());
    c.args([
        "-N",
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=30",
        "-R",
        &format!("{REMOTE_HOOK_PORT}:127.0.0.1:{local_port}"),
        host,
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::piped());
    let mut child = c.spawn().map_err(|e| format!("cannot run ssh: {e}"))?;
    // a tunnel that fails (auth, port taken) exits within a few seconds
    std::thread::sleep(Duration::from_millis(1500));
    if let Ok(Some(_)) = child.try_wait() {
        let mut err = String::new();
        if let Some(mut e) = child.stderr.take() {
            let _ = e.read_to_string(&mut err);
        }
        let msg = err.lines().filter(|l| !l.trim().is_empty()).last().unwrap_or("tunnel closed").to_string();
        return Err(msg);
    }
    Ok(child)
}

pub fn stop_tunnels(t: &Tunnels) {
    for (_, mut c) in t.0.lock().unwrap().drain() {
        let _ = c.kill();
    }
}

#[cfg(test)]
mod tests {
    // SD_SSH points at a fake ssh that runs the command locally
    #[test]
    #[ignore]
    fn over_fake_ssh() {
        let p = super::probe("fake");
        println!("probe: {p}");
        assert_eq!(p["ok"], true);
        let a = super::agents("fake").unwrap();
        println!("agents: {} sessions", a.as_array().map(|x| x.len()).unwrap_or(0));
        let id = std::env::var("SD_TEST_SESSION").unwrap();
        let w = super::transcript_window("fake", &id, 50).unwrap();
        println!("window: {} records, offset {}", w.records.len(), w.offset);
        let s = super::transcript_since("fake", &id, w.offset).unwrap();
        println!("since: {} records, offset {}", s.records.len(), s.offset);
        let g = super::super::git::remote("fake", &["~/projects/session-dashboard".to_string()], false);
        println!("git: repo={} branch={:?} changed={}", g[0].is_repo, g[0].worktrees.first().and_then(|w| w.branch.clone()), g[0].worktrees.first().map(|w| w.changed).unwrap_or(0));
        assert!(g[0].is_repo);
    }
}
