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
    // a Unix socket path holds at most 104 bytes (macOS) and ssh adds ".<16 chars>" while it binds:
    // macOS' long $TMPDIR would not fit, so a short folder there
    let dir = std::env::var("XDG_RUNTIME_DIR").ok().filter(|d| d.len() < 40).unwrap_or_else(|| if cfg!(unix) { "/tmp".into() } else { std::env::temp_dir().to_string_lossy().trim_end_matches('/').to_string() });
    format!("{dir}/sd-%C")
}

/// A host name the app passes to ssh: an alias or user@host, never something ssh reads as an
/// option ("-oProxyCommand=…") or that splits into more arguments.
pub fn host_ok(host: &str) -> Result<(), String> {
    if host.is_empty() || host.starts_with('-') || host.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(format!("not a valid ssh host: {host:?}"));
    }
    Ok(())
}

pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Where claude usually lives on a server: non-interactive ssh shells often miss ~/.local/bin etc.
/// Where claude is on a machine: a non-interactive ssh shell loads no profile, so the usual install
/// places are added (the native installer, npm, bun, and node managers: nvm, volta, asdf, mise, pnpm,
/// Linuxbrew).
pub const REMOTE_PATH: &str = r#"PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.claude/local:$HOME/.bun/bin:/usr/local/bin:$PATH"; for d in "$HOME"/.nvm/versions/node/*/bin "$HOME/.volta/bin" "$HOME/.asdf/shims" "$HOME/.local/share/mise/shims" "$HOME/.local/share/pnpm" "$HOME/.yarn/bin" /home/linuxbrew/.linuxbrew/bin; do [ -d "$d" ] && PATH="$PATH:$d"; done"#;

/// An ssh command for `host` running `script` in a POSIX shell there.
pub fn ssh_cmd(host: &str, script: &str) -> Command {
    let mut c = crate::sys::command(ssh_bin());
    // a dead link is noticed within ~45 s instead of hanging a write for many minutes
    c.args(["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"]);
    // one shared connection per host (Windows' OpenSSH has no connection sharing)
    if !cfg!(windows) {
        c.args(["-o", "ControlMaster=auto", "-o", &format!("ControlPath={}", control_path()), "-o", "ControlPersist=120"]);
    }
    // a bad host goes nowhere ("--" ends the options; the check refuses option-like names)
    let host = if host_ok(host).is_ok() { host } else { "invalid.host.invalid" };
    c.args([
        "--",
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
    probe_answer(run(host, PROBE, None, Duration::from_secs(25)))
}

const PROBE: &str = r#"echo "@@host $(hostname)"; b=$(command -v claude 2>/dev/null); echo "@@bin ${b:--}"; [ -n "$b" ] && echo "@@ver $("$b" --version 2>/dev/null | head -n 1)""#;

fn probe_answer(r: Result<Vec<u8>, String>) -> Value {
    // marked lines: whatever a profile prints on the way does not shift the answers; a cold claude
    // (first start, an update check) may take a while to say its version
    match r {
        Ok(out) => {
            let s = String::from_utf8_lossy(&out);
            let field = |k: &str| s.lines().find_map(|l| l.strip_prefix(k)).map(|v| v.trim().to_string()).unwrap_or_default();
            let bin = field("@@bin ");
            json!({"ok": true, "hostname": field("@@host "), "claude": if bin.is_empty() || bin == "-" { Value::Null } else { json!(bin) }, "version": field("@@ver ")})
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
    // exits 0 also when the file got shorter (the "truncated" answer below needs the size)
    let script = format!(r#"{}; s=$(wc -c < "$f"); echo $s; if [ "$s" -ge {offset} ]; then tail -c +{} "$f" | head -c 8000000; fi; true"#, transcript_glob(session_id)?, offset + 1);
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
    host_ok(host)?;
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
        "--",
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

#[cfg(test)]
mod probe_tests {
    use super::*;

    /// The PATH line and the probe run in a real sh (what ssh runs there), and a profile's chatter
    /// before them does not shift the answers.
    #[test]
    fn probe_reads_marked_lines() {
        let script = format!("echo 'Welcome to the server!'; {REMOTE_PATH}; {PROBE}");
        let out = std::process::Command::new("sh").args(["-c", &script]).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let v = probe_answer(Ok(out.stdout));
        assert_eq!(v["ok"], true);
        assert!(!v["hostname"].as_str().unwrap().is_empty() && v["hostname"] != "Welcome to the server!");
        // where claude is installed here, it is found, with its version
        if let Some(bin) = v["claude"].as_str() {
            assert!(bin.ends_with("claude"), "{v}");
            assert!(!v["version"].as_str().unwrap().is_empty(), "{v}");
        }
        let gone = probe_answer(Ok(b"motd\n@@host box\n@@bin -\n".to_vec()));
        assert_eq!(gone["claude"], Value::Null);
        assert_eq!(gone["hostname"], "box");
    }
}

// ---------- past sessions on a machine ----------

/// What was read of a machine's transcripts, by path: (size, mtime, summary). Kept on disk, so after a
/// restart the past sessions show at once, also while the machine cannot be reached.
#[derive(Default, serde::Serialize, serde::Deserialize)]
struct HistoryCache(HashMap<String, HashMap<String, (u64, u64, super::discover::SessionMeta)>>);

static HISTORY: Mutex<Option<HistoryCache>> = Mutex::new(None);

fn history_path() -> std::path::PathBuf {
    crate::sys::config_dir().join("remote-history.json")
}

const HISTORY_DAYS: u32 = 30;
const HISTORY_MAX: usize = 80;
/// Of a big transcript: its start (first prompt, folder) and its end (title, last answer, state).
const HEAD: u64 = 64 * 1024;
const TAIL: u64 = 256 * 1024;

/// A machine's past sessions: its transcripts of the last 30 days (the newest 80), summarised like
/// the local ones. One ssh call lists them; only new or grown files are fetched (their head and
/// tail), in batches. Unreachable: what was read before.
pub fn history(host: &str) -> Vec<super::discover::SessionMeta> {
    let mut g = HISTORY.lock().unwrap();
    let cache = g.get_or_insert_with(|| std::fs::read(history_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default());
    let list = format!(
        r#"d="${{CLAUDE_CONFIG_DIR:-$HOME/.claude}}/projects"; find "$d" -mindepth 2 -maxdepth 2 -name '*.jsonl' -mtime -{HISTORY_DAYS} -printf '%T@ %s %p\n' 2>/dev/null | sort -rn | head -n {HISTORY_MAX}"#
    );
    let known = cache.0.entry(host.to_string()).or_default();
    let Ok(out) = run(host, &list, None, Duration::from_secs(20)) else {
        return known.values().map(|(_, _, m)| m.clone()).collect();
    };
    let mut files: Vec<(String, u64, u64)> = Vec::new();
    for l in String::from_utf8_lossy(&out).lines() {
        let mut f = l.splitn(3, ' ');
        let (Some(t), Some(sz), Some(p)) = (f.next(), f.next(), f.next()) else { continue };
        let (Ok(t), Ok(sz)) = (t.parse::<f64>(), sz.parse::<u64>()) else { continue };
        files.push((p.to_string(), sz, (t * 1000.0) as u64));
    }
    let changed: Vec<&(String, u64, u64)> = files.iter().filter(|(p, sz, t)| known.get(p).is_none_or(|(s0, t0, _)| s0 != sz || t0 != t)).collect();
    // 8 files an ssh call: a few MB at most each
    for batch in changed.chunks(8) {
        let mut script = String::new();
        for (p, sz, _) in batch {
            let q = shell_quote(p);
            if *sz <= HEAD + TAIL {
                script.push_str(&format!("echo '@@whole'; cat {q}; echo; echo '@@end'\n"));
            } else {
                script.push_str(&format!("echo '@@head'; head -c {HEAD} {q}; echo; echo '@@tail'; tail -c {TAIL} {q}; echo; echo '@@end'\n"));
            }
        }
        let Ok(out) = run(host, &script, None, Duration::from_secs(60)) else { break };
        for ((p, sz, t), part) in batch.iter().zip(split_parts(&out)) {
            let meta = match part {
                Part::Whole(b) => super::discover::meta_from_parts(p, *sz, *t, b, None),
                Part::HeadTail(h, tl) => super::discover::meta_from_parts(p, *sz, *t, h, Some(tl)),
            };
            known.insert(p.clone(), (*sz, *t, meta));
        }
    }
    // gone from the list (older than 30 days, deleted): forgotten
    known.retain(|p, _| files.iter().any(|(q, _, _)| q == p));
    let result: Vec<_> = files.iter().filter_map(|(p, _, _)| known.get(p).map(|(_, _, m)| m.clone())).collect();
    if let Ok(b) = serde_json::to_vec(&*cache) {
        let tmp = history_path().with_extension("json.tmp");
        if std::fs::write(&tmp, b).is_ok() {
            let _ = std::fs::rename(&tmp, history_path());
        }
    }
    result
}

enum Part<'a> {
    Whole(&'a [u8]),
    HeadTail(&'a [u8], &'a [u8]),
}

/// The marked sections of a fetch, in order. A record line starts with "{", so a marker line is
/// never a transcript's.
fn split_parts(out: &[u8]) -> Vec<Part<'_>> {
    let mut parts = Vec::new();
    let mut lines: Vec<(usize, &[u8])> = Vec::new();
    let mut pos = 0;
    for l in out.split(|b| *b == b'\n') {
        lines.push((pos, l));
        pos += l.len() + 1;
    }
    let at = |i: usize| lines[i].0;
    let mut i = 0;
    while i < lines.len() {
        match lines[i].1 {
            b"@@whole" => {
                let start = at(i) + 8;
                let Some(e) = (i + 1..lines.len()).find(|j| lines[*j].1 == b"@@end") else { break };
                parts.push(Part::Whole(&out[start..at(e).saturating_sub(1).max(start)]));
                i = e + 1;
            }
            b"@@head" => {
                let start = at(i) + 7;
                let Some(t) = (i + 1..lines.len()).find(|j| lines[*j].1 == b"@@tail") else { break };
                let Some(e) = (t + 1..lines.len()).find(|j| lines[*j].1 == b"@@end") else { break };
                let tstart = at(t) + 7;
                parts.push(Part::HeadTail(&out[start..at(t).saturating_sub(1).max(start)], &out[tstart..at(e).saturating_sub(1).max(tstart)]));
                i = e + 1;
            }
            _ => i += 1,
        }
    }
    parts
}

#[cfg(test)]
mod history_tests {
    use super::*;

    #[test]
    fn splits_fetched_transcripts() {
        let out = b"motd line\n@@whole\n{\"a\":1}\n{\"b\":2}\n\n@@end\n@@head\n{\"h\":1}\n{\"part\n@@tail\nial\":2}\n{\"t\":3}\n\n@@end\n";
        let parts = split_parts(out);
        assert_eq!(parts.len(), 2);
        match &parts[0] {
            Part::Whole(b) => assert_eq!(*b, &b"{\"a\":1}\n{\"b\":2}\n"[..]),
            _ => panic!("whole"),
        }
        match &parts[1] {
            Part::HeadTail(h, t) => {
                assert!(h.starts_with(b"{\"h\":1}"));
                assert!(t.ends_with(b"{\"t\":3}\n"));
            }
            _ => panic!("head/tail"),
        }
    }

    /// The whole path over a fake ssh that runs the script here: a transcript in a made-up
    /// ~/.claude is listed, fetched and summarised, and a second call fetches nothing.
    #[test]
    #[ignore]
    fn history_over_fake_ssh() {
        let home = std::env::temp_dir().join(format!("sd-rhist-{}", std::process::id()));
        let proj = home.join(".claude/projects/-srv-app");
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::write(proj.join("11111111-2222-3333-4444-555555555555.jsonl"), r#"{"type":"user","cwd":"/srv/app","timestamp":"2026-11-20T10:00:00Z","message":{"role":"user","content":"deploy the api"}}
{"type":"assistant","cwd":"/srv/app","timestamp":"2026-11-20T10:01:00Z","message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"Deployed."}]}}
"#).unwrap();
        // SAFETY: test-only
        unsafe { std::env::set_var("HOME", &home) };
        let got = history("fake");
        assert_eq!(got.len(), 1, "listed and read");
        assert_eq!(got[0].first_prompt.as_deref(), Some("deploy the api"));
        assert_eq!(got[0].last_text.as_deref(), Some("Deployed."));
        assert_eq!(got[0].cwd.as_deref(), Some("/srv/app"));
        let _ = std::fs::remove_dir_all(&home);
    }
}
