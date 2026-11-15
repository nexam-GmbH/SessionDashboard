//! `session-dashboard wrap claude [args]`: runs claude in a pseudo-terminal of its own and passes the
//! terminal through untouched (keys in, screen out, size followed), while the app can type into it
//! too, over a local socket with a secret token. That keeps a session in any terminal (Zed's, GNOME
//! Terminal, …) in full sync with the app: what you type in either place goes to the same claude.
//! The shell function the app installs (Settings → Sessions) calls this for every `claude`.

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Where wrapped sessions register: <config>/sync/<pid of the program>.json.
pub fn registry() -> std::path::PathBuf {
    crate::sys::config_dir().join("sync")
}

fn size() -> PtySize {
    let (cols, rows) = crossterm::terminal::size().unwrap_or((80, 24));
    PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }
}

/// Raw mode for as long as it lives (restored on drop, also when the program crashes).
struct Raw;
impl Raw {
    fn on() -> Option<Raw> {
        crossterm::terminal::enable_raw_mode().ok().map(|_| Raw)
    }
}
impl Drop for Raw {
    fn drop(&mut self) {
        let _ = crossterm::terminal::disable_raw_mode();
    }
}

/// Run `args[0]` with `args[1..]`; returns its exit code.
pub fn run(args: &[String]) -> i32 {
    let Some(program) = args.first() else {
        eprintln!("usage: session-dashboard wrap <program> [args…]");
        return 2;
    };
    let program = if program == "claude" { crate::claude::discover::claude_bin() } else { program.clone() };
    let pair = match native_pty_system().openpty(size()) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("session-dashboard wrap: no pseudo-terminal ({e}); running it directly");
            return std::process::Command::new(&program).args(&args[1..]).status().map(|s| s.code().unwrap_or(1)).unwrap_or(127);
        }
    };
    let mut cmd = CommandBuilder::new(&program);
    cmd.args(&args[1..]);
    if let Ok(cwd) = std::env::current_dir() {
        cmd.cwd(cwd);
    }
    cmd.env("SD_SYNC", "1");
    let mut child = match pair.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("session-dashboard wrap: could not start {program}: {e}");
            return 127;
        }
    };
    drop(pair.slave);
    let pid = child.process_id().unwrap_or(0);
    let writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(pair.master.take_writer().expect("pty writer")));
    let mut reader = pair.master.try_clone_reader().expect("pty reader");
    let master = Arc::new(Mutex::new(pair.master));

    // the app's way in: a local socket and a token, registered by the program's pid
    let token = uuid::Uuid::new_v4().to_string();
    let reg = registry().join(format!("{pid}.json"));
    if let Ok(listener) = TcpListener::bind("127.0.0.1:0") {
        let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
        let _ = std::fs::create_dir_all(registry());
        let _ = std::fs::write(&reg, serde_json::json!({ "port": port, "token": token, "wrapper": std::process::id() }).to_string());
        let w = writer.clone();
        let token = token.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let mut line = String::new();
                if BufReader::new(&stream).read_line(&mut line).is_err() {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
                if v["token"].as_str() != Some(token.as_str()) {
                    continue;
                }
                let text = v["text"].as_str().unwrap_or("");
                // a new line in Claude Code's prompt is backslash + Enter; Enter alone sends
                let body = text.trim_end().replace("\r\n", "\n").replace('\n', "\\\r");
                {
                    let mut g = w.lock().unwrap();
                    let _ = g.write_all(body.as_bytes());
                    let _ = g.flush();
                }
                // Enter a moment later, so the prompt takes the text as typed, not as a paste
                std::thread::sleep(Duration::from_millis(40));
                {
                    let mut g = w.lock().unwrap();
                    let _ = g.write_all(b"\r");
                    let _ = g.flush();
                }
                let mut s = &stream;
                let _ = s.write_all(b"ok\n");
            }
        });
    }

    let raw = Raw::on();
    // keys in
    {
        let w = writer.clone();
        std::thread::spawn(move || {
            let mut stdin = std::io::stdin();
            let mut buf = [0u8; 4096];
            loop {
                match stdin.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut w = w.lock().unwrap();
                        if w.write_all(&buf[..n]).is_err() {
                            break;
                        }
                        let _ = w.flush();
                    }
                }
            }
        });
    }
    // the size of the terminal, followed
    {
        let m = master.clone();
        std::thread::spawn(move || {
            let mut last = size();
            loop {
                std::thread::sleep(Duration::from_millis(200));
                let now = size();
                if now.rows != last.rows || now.cols != last.cols {
                    let _ = m.lock().unwrap().resize(now);
                    last = now;
                }
            }
        });
    }
    // screen out, until the program closes its side
    let out = std::thread::spawn(move || {
        let mut stdout = std::io::stdout();
        let mut buf = [0u8; 16384];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if stdout.write_all(&buf[..n]).is_err() {
                        break;
                    }
                    let _ = stdout.flush();
                }
            }
        }
    });
    let code = child.wait().map(|s| s.exit_code() as i32).unwrap_or(1);
    let _ = std::fs::remove_file(&reg);
    // the last of its output (a helper it left behind may hold the terminal open: don't wait on it)
    for _ in 0..10 {
        if out.is_finished() {
            break;
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    drop(raw);
    code
}

// ---------- the shell function that routes `claude` through the wrapper ----------

const BEGIN: &str = "# >>> session-dashboard terminal sync >>>";
const END: &str = "# <<< session-dashboard terminal sync <<<";

/// The app binary as a terminal can run it later (an AppImage runs from a temporary mount: its
/// file instead).
fn app_bin() -> String {
    std::env::var("APPIMAGE").ok().filter(|p| !p.is_empty()).unwrap_or_else(|| std::env::current_exe().map(|p| p.to_string_lossy().to_string()).unwrap_or_default())
}

fn rc_files() -> Vec<(std::path::PathBuf, bool)> {
    let home = crate::sys::home();
    let shell = std::env::var("SHELL").unwrap_or_default();
    let zdot = std::env::var("ZDOTDIR").map(std::path::PathBuf::from).unwrap_or_else(|_| home.clone());
    let mut v = vec![(home.join(".bashrc"), false), (zdot.join(".zshrc"), false), (home.join(".config/fish/conf.d/session-dashboard.fish"), true)];
    // the shells you have, and yours even if its file does not exist yet
    v.retain(|(p, fish)| p.exists() || (*fish && shell.ends_with("fish")) || (!*fish && shell.ends_with(p.file_name().and_then(|n| n.to_str()).unwrap_or("").trim_start_matches('.').trim_end_matches("rc"))));
    v
}

fn block(bin: &str, fish: bool) -> String {
    let q = format!("'{}'", bin.replace('\'', "'\\''"));
    if fish {
        format!("{BEGIN}\nfunction claude\n    if test -x {q}; and not set -q SD_SYNC\n        {q} wrap claude $argv\n    else\n        command claude $argv\n    end\nend\n{END}\n")
    } else {
        format!("{BEGIN}\nclaude() {{ if [ -x {q} ] && [ -z \"$SD_SYNC\" ]; then {q} wrap claude \"$@\"; else command claude \"$@\"; fi; }}\n{END}\n")
    }
}

fn strip(text: &str) -> String {
    let mut out = String::new();
    let mut skip = false;
    for line in text.lines() {
        if line.trim() == BEGIN {
            skip = true;
            continue;
        }
        if line.trim() == END {
            skip = false;
            continue;
        }
        if !skip {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

/// Whether `claude` in your shells runs through the wrapper.
pub fn status() -> serde_json::Value {
    let files: Vec<String> = rc_files().iter().filter(|(p, _)| std::fs::read_to_string(p).map(|t| t.contains(BEGIN)).unwrap_or(false)).map(|(p, _)| p.to_string_lossy().to_string()).collect();
    serde_json::json!({ "on": !files.is_empty(), "files": files, "bin": app_bin() })
}

/// Add (or remove) the shell function in your shells' startup files. New terminals pick it up.
pub fn set(on: bool) -> Result<serde_json::Value, String> {
    let bin = app_bin();
    for (p, fish) in rc_files() {
        let text = std::fs::read_to_string(&p).unwrap_or_default();
        let mut next = strip(&text);
        if on {
            if !next.is_empty() && !next.ends_with("\n\n") {
                next.push('\n');
            }
            next.push_str(&block(&bin, fish));
        }
        if next == text {
            continue;
        }
        if let Some(d) = p.parent() {
            std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
        }
        if fish && !on && next.trim().is_empty() {
            let _ = std::fs::remove_file(&p);
            continue;
        }
        std::fs::write(&p, next).map_err(|e| format!("{}: {e}", p.display()))?;
    }
    Ok(status())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn block_round_trip() {
        let rc = "export A=1\nalias ll='ls -l'\n";
        let with = format!("{rc}\n{}", block("/opt/app/bin", false));
        assert!(with.contains("wrap claude \"$@\""));
        assert_eq!(strip(&with).trim_end(), rc.trim_end());
        assert!(block("/x", true).contains("$argv"));
    }
}
