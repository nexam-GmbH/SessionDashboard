//! What differs between Linux, macOS and Windows: whether a process is alive, stopping one, running a
//! command with a time limit, finding `sh`, and (Windows) starting helpers without a console window.

use std::collections::HashSet;
use std::io::Read;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

/// A command for a background helper (git, gh, claude, ssh): on Windows without a console window
/// flashing up for every call.
pub fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut c = Command::new(program);
    if let Some(p) = helper_path() {
        c.env("PATH", p);
    }
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
        // the sysinfo paths (macOS, Windows) work: parents, environment, command line
        let me = std::process::id();
        assert!(parents().contains_key(&me));
        assert!(parent_of(me).is_some());
        assert!(env_of(me).contains_key("PATH"));
        assert!(!cmdline(me).is_empty());
        assert_eq!(norm("c:\\Users\\x"), "C:/Users/x");
    }
}

// ---------- folders and paths ----------

/// The user's home folder (HOME; Windows: USERPROFILE).
pub fn home() -> std::path::PathBuf {
    sdwrap::home()
}

/// Where the app keeps its own files (usage ledger, hook token, prefs): ~/.config/session-dashboard
/// (XDG_CONFIG_HOME when set; Windows: %APPDATA%\session-dashboard).
pub fn config_dir() -> std::path::PathBuf {
    // shared with the sync wrapper, which must find the same folder
    sdwrap::config_dir()
}

/// A path as the UI keeps it: forward slashes and an upper-case drive letter on Windows (Claude Code
/// writes `C:\x`, git `C:/x`; both must be the same folder), unchanged elsewhere.
pub fn norm(p: &str) -> String {
    if cfg!(windows) || p.contains('\\') && p.as_bytes().get(1) == Some(&b':') {
        let mut s = p.replace('\\', "/");
        if s.as_bytes().get(1) == Some(&b':') {
            s.replace_range(0..1, &s[0..1].to_ascii_uppercase());
        }
        s
    } else {
        p.to_string()
    }
}

/// `~/x` → the home folder's x.
pub fn expand(p: &str) -> String {
    match p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        Some(rest) => home().join(rest).to_string_lossy().to_string(),
        None if p == "~" => home().to_string_lossy().to_string(),
        None => p.to_string(),
    }
}

// ---------- processes ----------

fn sysinfo_of(pids: Option<&[u32]>, environ: bool, cmd: bool) -> sysinfo::System {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let mut s = System::new();
    let mut kind = ProcessRefreshKind::nothing();
    if environ {
        kind = kind.with_environ(UpdateKind::Always);
    }
    if cmd {
        kind = kind.with_cmd(UpdateKind::Always);
    }
    let list: Vec<Pid> = pids.unwrap_or(&[]).iter().map(|p| Pid::from_u32(*p)).collect();
    let which = if pids.is_some() { ProcessesToUpdate::Some(&list) } else { ProcessesToUpdate::All };
    s.refresh_processes_specifics(which, true, kind);
    s
}

/// Parent of every process: pid → ppid.
pub fn parents() -> std::collections::HashMap<u32, u32> {
    let mut out = std::collections::HashMap::new();
    #[cfg(all(target_os = "linux", not(test)))]
    {
        if let Ok(dir) = std::fs::read_dir("/proc") {
            for e in dir.flatten() {
                let Some(pid) = e.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else { continue };
                if let Some(pp) = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok().and_then(|st| st.rsplit_once(')').and_then(|(_, r)| r.split_whitespace().nth(1)?.parse::<u32>().ok())) {
                    out.insert(pid, pp);
                }
            }
            return out;
        }
    }
    let s = sysinfo_of(None, false, false);
    for (pid, p) in s.processes() {
        if let Some(pp) = p.parent() {
            out.insert(pid.as_u32(), pp.as_u32());
        }
    }
    out
}

/// The parent of one process.
pub fn parent_of(pid: u32) -> Option<u32> {
    #[cfg(target_os = "linux")]
    {
        let st = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        return st.rsplit_once(')')?.1.split_whitespace().nth(1)?.parse().ok();
    }
    #[allow(unreachable_code)]
    sysinfo_of(Some(&[pid]), false, false).process(sysinfo::Pid::from_u32(pid))?.parent().map(|p| p.as_u32())
}

/// A process's environment (only the user's own processes can be read).
pub fn env_of(pid: u32) -> std::collections::HashMap<String, String> {
    let pairs: Vec<String> = {
        #[cfg(all(target_os = "linux", not(test)))]
        {
            std::fs::read(format!("/proc/{pid}/environ")).unwrap_or_default().split(|b| *b == 0).map(|kv| String::from_utf8_lossy(kv).to_string()).collect()
        }
        #[cfg(any(not(target_os = "linux"), test))]
        {
            sysinfo_of(Some(&[pid]), true, false).process(sysinfo::Pid::from_u32(pid)).map(|p| p.environ().iter().map(|e| e.to_string_lossy().to_string()).collect()).unwrap_or_default()
        }
    };
    pairs.into_iter().filter_map(|kv| kv.split_once('=').map(|(k, v)| (k.to_string(), v.to_string()))).collect()
}

/// A process's command line.
pub fn cmdline(pid: u32) -> String {
    #[cfg(target_os = "linux")]
    {
        return String::from_utf8_lossy(&std::fs::read(format!("/proc/{pid}/cmdline")).unwrap_or_default()).replace('\0', " ");
    }
    #[allow(unreachable_code)]
    sysinfo_of(Some(&[pid]), false, true).process(sysinfo::Pid::from_u32(pid)).map(|p| p.cmd().iter().map(|c| c.to_string_lossy().to_string()).collect::<Vec<_>>().join(" ")).unwrap_or_default()
}

/// This computer's name.
pub fn hostname() -> String {
    std::fs::read_to_string("/proc/sys/kernel/hostname")
        .ok()
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .or_else(|| std::env::var("HOSTNAME").ok())
        .or_else(|| command("hostname").output().ok().map(|o| String::from_utf8_lossy(&o.stdout).to_string()))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "localhost".into())
}

/// The PATH a login shell has, once known (fix_path): every helper the app starts gets it.
static SHELL_PATH: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// An app opened from the Dock or Finder (macOS), or some Linux launchers, gets a bare PATH without
/// the folders where `claude`, `gh` and `git` live. Ask the user's shell once, in the background
/// (login + interactive: .zprofile for Homebrew, .zshrc for nvm/asdf; a 6 s limit; banners printed by
/// rc files are cut away by markers), and give that PATH to every helper the app starts.
pub fn fix_path() {
    #[cfg(unix)]
    std::thread::spawn(|| {
        let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| if cfg!(target_os = "macos") { "/bin/zsh".into() } else { "/bin/sh".into() });
        let mut c = command(&shell);
        c.args(["-ilc", "printf '__SDPATH__%s__SDPATH__' \"$PATH\""]).env("DISABLE_AUTO_UPDATE", "true").env("ZSH_DISABLE_COMPFIX", "true");
        let found = output_timeout(&mut c, 6).and_then(|o| {
            let t = String::from_utf8_lossy(&o.stdout).to_string();
            let parts: Vec<&str> = t.split("__SDPATH__").collect();
            (parts.len() >= 3).then(|| parts[parts.len() - 2].trim().to_string())
        });
        let cur = std::env::var("PATH").unwrap_or_default();
        let home = home().to_string_lossy().to_string();
        let mut parts: Vec<String> = found.as_deref().unwrap_or("").split(':').map(str::to_string).collect();
        // where claude, Homebrew and npm usually are, in case the shell said nothing useful
        for extra in [format!("{home}/.local/bin"), "/opt/homebrew/bin".into(), "/usr/local/bin".into(), format!("{home}/.npm-global/bin"), format!("{home}/.bun/bin")] {
            if std::path::Path::new(&extra).is_dir() {
                parts.push(extra);
            }
        }
        parts.extend(cur.split(':').map(str::to_string));
        let mut seen = std::collections::HashSet::new();
        let merged = parts.into_iter().filter(|p| !p.is_empty() && seen.insert(p.clone())).collect::<Vec<_>>().join(":");
        let _ = SHELL_PATH.set(merged);
    });
}

/// The PATH helpers get: the shell's, once known.
pub fn helper_path() -> Option<&'static str> {
    SHELL_PATH.get().map(String::as_str)
}

/// Files you attach to a message (dropped or picked in the prompt box): kept here, and every session
/// the app runs may read this folder (`--add-dir`), so Claude opens them without asking.
pub fn attachments_dir() -> std::path::PathBuf {
    config_dir().join("attachments")
}
