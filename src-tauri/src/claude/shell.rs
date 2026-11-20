//! `! command` in a session's prompt box (Claude Code's bash mode): run it once in the session's
//! folder with the user's shell (PowerShell on Windows, as the terminal dock), no stdin, at most a
//! minute, and hand back what it printed (the first and last ~15 KB of each stream). On a machine
//! it runs there over ssh.

use serde::Serialize;
use std::collections::VecDeque;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How long a command may run before it is stopped (with everything it started).
pub const LIMIT: Duration = Duration::from_secs(60);
/// Bytes kept from the start and from the end of each stream.
const KEEP: usize = 15 * 1024;
const CUT: &str = "\n… cut …\n";

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ShellResult {
    pub stdout: String,
    pub stderr: String,
    /// the exit code; none when it was stopped by a signal
    pub code: Option<i32>,
    pub timed_out: bool,
}

/// A stream's first and last `KEEP` bytes, however much it prints.
#[derive(Default)]
struct Cap {
    head: Vec<u8>,
    tail: VecDeque<u8>,
    cut: bool,
}

impl Cap {
    fn push(&mut self, mut b: &[u8]) {
        if self.head.len() < KEEP {
            let n = (KEEP - self.head.len()).min(b.len());
            self.head.extend_from_slice(&b[..n]);
            b = &b[n..];
        }
        if b.len() >= KEEP {
            self.cut |= !self.tail.is_empty() || b.len() > KEEP;
            self.tail.clear();
            self.tail.extend(&b[b.len() - KEEP..]);
            return;
        }
        self.tail.extend(b);
        if self.tail.len() > KEEP {
            self.tail.drain(..self.tail.len() - KEEP);
            self.cut = true;
        }
    }
    fn text(&self) -> String {
        let mut out = String::from_utf8_lossy(&self.head).into_owned();
        if self.cut {
            out.push_str(CUT);
        }
        let (a, b) = self.tail.as_slices();
        out.push_str(&String::from_utf8_lossy(&[a, b].concat()));
        out
    }
}

fn capped(b: &[u8]) -> String {
    let mut c = Cap::default();
    c.push(b);
    c.text()
}

/// The user's shell running `command`: PowerShell on Windows (pwsh when installed), else $SHELL.
fn shell_command(command: &str) -> Command {
    #[cfg(windows)]
    {
        static PS: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();
        let ps = *PS.get_or_init(|| if crate::sys::command("pwsh").arg("-Version").output().is_ok() { "pwsh.exe" } else { "powershell.exe" });
        let mut c = crate::sys::command(ps);
        c.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]);
        c
    }
    #[cfg(not(windows))]
    {
        let sh = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "sh".into());
        let mut c = crate::sys::command(sh);
        c.arg("-c").arg(command);
        c
    }
}

/// Run `command` in `cwd` (on `host` over ssh when given).
pub fn run(cwd: &str, command: &str, host: Option<&str>) -> Result<ShellResult, String> {
    match host.filter(|h| !h.is_empty()) {
        Some(h) => run_remote(h, cwd, command, LIMIT),
        None => run_local(cwd, command, LIMIT),
    }
}

fn reader(mut from: impl Read + Send + 'static, into: Arc<Mutex<Cap>>) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        while let Ok(n) = from.read(&mut buf) {
            if n == 0 {
                break;
            }
            if let Ok(mut c) = into.lock() {
                c.push(&buf[..n]);
            }
        }
    })
}

pub fn run_local(cwd: &str, command: &str, limit: Duration) -> Result<ShellResult, String> {
    let dir = crate::sys::expand(cwd);
    if !std::path::Path::new(&dir).is_dir() {
        return Err(format!("no such folder: {dir}"));
    }
    let mut c = shell_command(command);
    c.current_dir(&dir).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // its own process group: on a timeout everything it started stops with it
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        c.process_group(0);
    }
    let mut child = c.spawn().map_err(|e| format!("cannot start the shell: {e}"))?;
    let out = Arc::new(Mutex::new(Cap::default()));
    let err = Arc::new(Mutex::new(Cap::default()));
    let readers = [reader(child.stdout.take().ok_or("no stdout")?, out.clone()), reader(child.stderr.take().ok_or("no stderr")?, err.clone())];
    let until = Instant::now() + limit;
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) if Instant::now() < until => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                timed_out = true;
                #[cfg(unix)]
                let _ = crate::sys::command("kill").args(["-KILL", "--", &format!("-{}", child.id())]).stderr(Stdio::null()).status();
                crate::sys::kill_tree(&mut child);
                break None;
            }
        }
    };
    // what it left running in the background may hold the pipes open: wait a moment, not for it
    let grace = Instant::now() + Duration::from_millis(800);
    while readers.iter().any(|r| !r.is_finished()) && Instant::now() < grace {
        std::thread::sleep(Duration::from_millis(15));
    }
    let text = |c: &Arc<Mutex<Cap>>| c.lock().map(|c| c.text()).unwrap_or_default();
    Ok(ShellResult { stdout: text(&out), stderr: text(&err), code: status.and_then(|s| s.code()), timed_out })
}

pub fn run_remote(host: &str, cwd: &str, command: &str, limit: Duration) -> Result<ShellResult, String> {
    super::remote::host_ok(host)?;
    let mark = format!("__sd_shell_{}__", uuid::Uuid::new_v4().simple());
    let secs = limit.as_secs().max(1);
    let dir = crate::term::shell_quote(cwd);
    let cmd = super::remote::shell_quote(command);
    // stdout as it is, then a line with the mark and the exit code, then stderr; `timeout` (when
    // the machine has it) stops the command there, the ssh wait below is only the backstop
    let script = format!(
        "e=$(mktemp) || exit 1; if cd {dir} 2>\"$e\"; then t=; command -v timeout >/dev/null 2>&1 && t=\"timeout -k 2 {secs}\"; $t \"${{SHELL:-sh}}\" -c {cmd} </dev/null 2>\"$e\"; c=$?; else c=1; fi; printf '\\n{mark}%s\\n' \"$c\"; cat \"$e\"; rm -f \"$e\"; exit 0"
    );
    let started = Instant::now();
    match super::remote::run(host, &script, None, limit + Duration::from_secs(15)) {
        Ok(bytes) => {
            let mut r = parse_marked(&bytes, &mark).ok_or_else(|| format!("{host}: no answer from the shell"))?;
            r.timed_out = matches!(r.code, Some(124) | Some(137)) && started.elapsed() + Duration::from_secs(1) >= limit;
            Ok(r)
        }
        Err(e) if e.contains("no answer in") => Ok(ShellResult { timed_out: true, ..Default::default() }),
        Err(e) => Err(e),
    }
}

/// stdout, "\n<mark><code>\n", stderr → the result (output capped).
fn parse_marked(bytes: &[u8], mark: &str) -> Option<ShellResult> {
    let needle = format!("\n{mark}");
    let at = bytes.windows(needle.len()).rposition(|w| w == needle.as_bytes())?;
    let rest = &bytes[at + needle.len()..];
    let nl = rest.iter().position(|&b| b == b'\n').unwrap_or(rest.len());
    let code = std::str::from_utf8(&rest[..nl]).ok()?.trim().parse::<i32>().ok();
    let stderr = rest.get(nl + 1..).unwrap_or_default();
    Some(ShellResult { stdout: capped(&bytes[..at]), stderr: capped(stderr), code, timed_out: false })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn run_sh(command: &str, limit: Duration) -> ShellResult {
        run_local(&std::env::temp_dir().to_string_lossy(), command, limit).unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn runs_in_the_folder_and_reports() {
        let dir = std::env::temp_dir().canonicalize().unwrap();
        let r = run_local(&dir.to_string_lossy(), "echo hello; pwd -P", LIMIT).unwrap();
        assert_eq!(r.stdout, format!("hello\n{}\n", dir.display()));
        assert_eq!(r.stderr, "");
        assert_eq!(r.code, Some(0));
        assert!(!r.timed_out);
        // stderr apart, a failing exit code
        let r = run_sh("echo out; echo oops >&2; exit 3", LIMIT);
        assert_eq!(r.stdout, "out\n");
        assert_eq!(r.stderr, "oops\n");
        assert_eq!(r.code, Some(3));
        // no stdin: a command reading it ends at once
        let t = Instant::now();
        let r = run_sh("cat; echo done", LIMIT);
        assert_eq!(r.stdout, "done\n");
        assert!(t.elapsed() < Duration::from_secs(5));
        assert!(run_local("/no/such/folder/here", "true", LIMIT).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn timeout_stops_the_whole_tree() {
        let t = Instant::now();
        let r = run_sh("echo started; sleep 30; echo never", Duration::from_secs(1));
        assert!(r.timed_out);
        assert_eq!(r.code, None);
        assert_eq!(r.stdout, "started\n");
        assert!(t.elapsed() < Duration::from_secs(5), "took {:?}", t.elapsed());
        // something left running in the background does not hold the answer up
        let t = Instant::now();
        let r = run_sh("sleep 30 & echo hi", LIMIT);
        assert_eq!(r.stdout, "hi\n");
        assert!(!r.timed_out);
        assert!(t.elapsed() < Duration::from_secs(5), "took {:?}", t.elapsed());
    }

    #[cfg(unix)]
    #[test]
    fn long_output_keeps_head_and_tail() {
        let r = run_sh("echo first; head -c 200000 /dev/zero | tr '\\0' a; echo; echo last", LIMIT);
        assert!(r.stdout.starts_with("first\naaa"));
        assert!(r.stdout.ends_with("aaa\nlast\n"));
        assert!(r.stdout.contains(CUT));
        assert!(r.stdout.len() <= 2 * KEEP + CUT.len());
    }

    #[test]
    fn cap_keeps_everything_up_to_twice_keep() {
        let all: Vec<u8> = (0..2 * KEEP).map(|i| b'a' + (i % 26) as u8).collect();
        let mut c = Cap::default();
        for ch in all.chunks(1000) {
            c.push(ch);
        }
        assert_eq!(c.text().as_bytes(), &all[..]);
        c.push(b"z");
        let t = c.text();
        assert!(t.contains(CUT));
        assert!(t.ends_with('z'));
        assert_eq!(t.len(), 2 * KEEP + CUT.len());
    }

    #[test]
    fn reads_a_remote_answer() {
        let m = "__sd_shell_x__";
        let r = parse_marked(format!("line\nmore\n\n{m}2\nbad thing\n").as_bytes(), m).unwrap();
        assert_eq!(r.stdout, "line\nmore\n");
        assert_eq!(r.stderr, "bad thing\n");
        assert_eq!(r.code, Some(2));
        let r = parse_marked(format!("\n{m}0\n").as_bytes(), m).unwrap();
        assert_eq!((r.stdout.as_str(), r.stderr.as_str(), r.code), ("", "", Some(0)));
        assert!(parse_marked(b"nothing", m).is_none());
    }
}
