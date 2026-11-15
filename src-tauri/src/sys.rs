//! What differs between Linux, macOS and Windows: whether a process is alive, stopping one, running a
//! command with a time limit, finding `sh`, and (Windows) starting helpers without a console window.

use std::collections::HashSet;
use std::io::Read;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

/// A command for a background helper (git, gh, claude, ssh): on Windows without a console window
/// flashing up for every call.
pub fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

/// Every running process id, for systems without /proc (one listing per poll, not one per pid).
#[cfg(not(target_os = "linux"))]
pub fn live_pids() -> Option<HashSet<u32>> {
    #[cfg(windows)]
    let out = command("tasklist").args(["/FO", "CSV", "/NH"]).stderr(Stdio::null()).output().ok()?;
    #[cfg(not(windows))]
    let out = command("ps").args(["-A", "-o", "pid="]).stderr(Stdio::null()).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    #[cfg(windows)]
    let set = text.lines().filter_map(|l| l.split(',').nth(1)).filter_map(|p| p.trim_matches('"').parse().ok()).collect();
    #[cfg(not(windows))]
    let set = text.split_whitespace().filter_map(|p| p.parse().ok()).collect();
    Some(set)
}

#[cfg(target_os = "linux")]
pub fn live_pids() -> Option<HashSet<u32>> {
    None
}

/// Whether a process runs (Linux: /proc; elsewhere: the process listing).
pub fn alive(pid: u32) -> bool {
    #[cfg(target_os = "linux")]
    {
        std::path::Path::new(&format!("/proc/{pid}")).exists()
    }
    #[cfg(not(target_os = "linux"))]
    {
        live_pids().map(|s| s.contains(&pid)).unwrap_or(false)
    }
}

/// Ask a process to stop (SIGTERM; Windows: end it and its children).
pub fn terminate(pid: u32) {
    #[cfg(windows)]
    let _ = command("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).stdout(Stdio::null()).stderr(Stdio::null()).status();
    #[cfg(not(windows))]
    let _ = command("kill").args(["-TERM", &pid.to_string()]).status();
}

/// Interrupt a process the way Ctrl+C does (SIGINT; Windows has no such signal for another console:
/// it is ended).
pub fn interrupt(pid: u32) {
    #[cfg(windows)]
    terminate(pid);
    #[cfg(not(windows))]
    let _ = command("kill").args(["-INT", &pid.to_string()]).status();
}

/// Run a command and collect its output, killing it after `secs` (the `timeout` tool is Linux only).
pub fn output_timeout(cmd: &mut Command, secs: u64) -> Option<Output> {
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().ok()?;
    // read both pipes while it runs: a full pipe would stall a chatty command
    let mut out = child.stdout.take()?;
    let mut err = child.stderr.take()?;
    let t_out = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = out.read_to_end(&mut b);
        b
    });
    let t_err = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = err.read_to_end(&mut b);
        b
    });
    let until = Instant::now() + Duration::from_secs(secs);
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if Instant::now() < until => std::thread::sleep(Duration::from_millis(40)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    Some(Output { status, stdout: t_out.join().unwrap_or_default(), stderr: t_err.join().unwrap_or_default() })
}

/// The POSIX shell: `sh` (on Windows the one Git for Windows brings, when `sh` is not on PATH).
pub fn sh() -> String {
    #[cfg(windows)]
    {
        if command("sh").arg("-c").arg("exit 0").status().is_err() {
            for p in [r"C:\Program Files\Git\bin\sh.exe", r"C:\Program Files (x86)\Git\bin\sh.exe"] {
                if std::path::Path::new(p).exists() {
                    return p.to_string();
                }
            }
        }
    }
    "sh".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeout_kills_and_collects() {
        let out = output_timeout(Command::new("sh").args(["-c", "echo hi"]), 5).unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "hi");
        let t = Instant::now();
        assert!(output_timeout(Command::new("sh").args(["-c", "sleep 5"]), 1).is_none());
        assert!(t.elapsed() < Duration::from_secs(3));
        assert!(alive(std::process::id()));
    }
}
