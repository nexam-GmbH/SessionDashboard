//! Typing into a session that runs in a terminal, so a reply from the app reaches it without stopping
//! it there: the app's own terminal (its pty), tmux, Konsole (D-Bus), kitty (remote control) and
//! WezTerm (cli). Which one is found from the claude process's environment. Other terminals (Zed's,
//! GNOME Terminal) offer no way in; the app continues in a copy there instead.

use std::collections::HashMap;

use crate::sys::command;
use crate::term::{self, Terms};

#[derive(Clone, Debug, PartialEq)]
enum Way {
    /// started through `session-dashboard wrap` (terminal sync): its own socket
    Sync { port: u16, token: String },
    App(String),
    Tmux { socket: String, pane: String },
    Konsole { service: String, session: String },
    Kitty { to: String, window: String },
    Wezterm { pane: String },
    /// macOS, by the session's tty (other processes' environment is hidden there)
    Iterm { tty: String },
    TerminalApp { tty: String },
}

/// The terminal device a process writes to ("/dev/ttys003", "/dev/pts/3"), from `ps`.
fn tty_of(pid: u32) -> Option<String> {
    if cfg!(windows) {
        return None;
    }
    let o = command("ps").args(["-o", "tty=", "-p", &pid.to_string()]).output().ok()?;
    let t = String::from_utf8_lossy(&o.stdout).trim().to_string();
    (!t.is_empty() && t != "?" && t != "??").then(|| if t.starts_with("/dev/") { t } else { format!("/dev/{t}") })
}

/// tmux pane on that tty (when the environment can't be read).
fn tmux_pane_by_tty(tty: &str) -> Option<String> {
    let o = command("tmux").args(["list-panes", "-a", "-F", "#{pane_tty} #{pane_id}"]).output().ok()?;
    String::from_utf8_lossy(&o.stdout).lines().find_map(|l| l.split_once(' ').filter(|(t, _)| *t == tty).map(|(_, p)| p.to_string()))
}

fn osascript(script: &str) -> Option<String> {
    let o = crate::sys::output_timeout(command("osascript").args(["-e", script]), 6)?;
    o.status.success().then(|| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

fn running(app: &str) -> bool {
    command("pgrep").args(["-x", app]).output().map(|o| o.status.success()).unwrap_or(false)
}

/// An AppleScript string literal.
fn as_str(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn env_of(pid: u32) -> HashMap<String, String> {
    crate::sys::env_of(pid)
}

fn qdbus() -> Option<&'static str> {
    ["qdbus", "qdbus6", "qdbus-qt6", "qdbus-qt5"].into_iter().find(|b| command(b).arg("--version").output().is_ok())
}

fn which(bin: &str) -> bool {
    command(bin).arg("--version").output().is_ok()
}

/// A wrapped session registers by the pid of what it started; claude may be that process or a child
/// of it (a launcher script), so look a few levels up.
fn synced(pid: u32) -> Option<Way> {
    let mut cur = pid;
    for _ in 0..4 {
        let file = crate::sys::config_dir().join("sync").join(format!("{cur}.json"));
        if let Ok(t) = std::fs::read_to_string(&file) {
            let v: serde_json::Value = serde_json::from_str(&t).ok()?;
            // only an entry whose wrapper still runs this very process (a closed terminal leaves
            // its file behind, and the pid may be reused since)
            let wrapper = v["wrapper"].as_u64().map(|w| w as u32);
            let current = wrapper.is_some_and(|w| crate::sys::alive(w) && crate::sys::parent_of(cur) == Some(w));
            if current {
                return Some(Way::Sync { port: v["port"].as_u64()? as u16, token: v["token"].as_str()?.to_string() });
            }
            if wrapper.is_some_and(|w| !crate::sys::alive(w)) {
                let _ = std::fs::remove_file(&file);
            }
        }
        cur = crate::sys::parent_of(cur)?;
    }
    None
}

fn way(terms: &Terms, pid: u32) -> Option<Way> {
    if let Some(w) = synced(pid) {
        return Some(w);
    }
    if let Some(k) = term::key_of_descendant(terms, pid) {
        return Some(Way::App(k));
    }
    let env = env_of(pid);
    if let (Some(t), Some(pane)) = (env.get("TMUX"), env.get("TMUX_PANE")) {
        if which("tmux") {
            return Some(Way::Tmux { socket: t.split(',').next().unwrap_or("").to_string(), pane: pane.clone() });
        }
    }
    if let (Some(service), Some(session)) = (env.get("KONSOLE_DBUS_SERVICE"), env.get("KONSOLE_DBUS_SESSION")) {
        if qdbus().is_some() {
            return Some(Way::Konsole { service: service.clone(), session: session.clone() });
        }
    }
    if let (Some(to), Some(window)) = (env.get("KITTY_LISTEN_ON"), env.get("KITTY_WINDOW_ID")) {
        if which("kitty") {
            return Some(Way::Kitty { to: to.clone(), window: window.clone() });
        }
    }
    if let Some(pane) = env.get("WEZTERM_PANE") {
        if which("wezterm") {
            return Some(Way::Wezterm { pane: pane.clone() });
        }
    }
    // no environment to read (macOS hides it): find the terminal by the session's tty
    let tty = tty_of(pid)?;
    if which("tmux") {
        if let Some(pane) = tmux_pane_by_tty(&tty) {
            return Some(Way::Tmux { socket: String::new(), pane });
        }
    }
    if cfg!(target_os = "macos") {
        let t = as_str(&tty);
        if running("iTerm2") && osascript(&format!("tell application \"iTerm2\" to repeat with w in windows\nrepeat with tb in tabs of w\nrepeat with s in sessions of tb\nif tty of s is {t} then return \"yes\"\nend repeat\nend repeat\nend repeat")).as_deref() == Some("yes") {
            return Some(Way::Iterm { tty });
        }
        if running("Terminal") && osascript(&format!("tell application \"Terminal\" to repeat with w in windows\nrepeat with tb in tabs of w\nif tty of tb is {t} then return \"yes\"\nend repeat\nend repeat")).as_deref() == Some("yes") {
            return Some(Way::TerminalApp { tty });
        }
    }
    None
}

fn name(w: &Way) -> &'static str {
    match w {
        Way::Sync { .. } => "synced",
        Way::App(_) => "the app's terminal",
        Way::Tmux { .. } => "tmux",
        Way::Konsole { .. } => "Konsole",
        Way::Kitty { .. } => "kitty",
        Way::Wezterm { .. } => "WezTerm",
        Way::Iterm { .. } => "iTerm2",
        Way::TerminalApp { .. } => "Terminal",
    }
}

/// How a reply would reach this terminal session ("Konsole", "tmux", …), or None. "headless": a
/// `claude -p` with no terminal at all (one the app started before it restarted): it can only be
/// taken over, which loses nothing.
pub fn check(terms: &Terms, pid: u32) -> Option<String> {
    if let Some(w) = way(terms, pid) {
        return Some(name(&w).to_string());
    }
    // print mode (`claude -p …`: the app's own sessions, or a run another session started) has no
    // terminal to type into: replies wait until it is done, then continue here
    let cmd = crate::sys::cmdline(pid);
    cmd.split_whitespace().any(|a| a == "-p" || a == "--print").then(|| "headless".to_string())
}

fn ok(st: std::io::Result<std::process::ExitStatus>, what: &str) -> Result<(), String> {
    match st {
        Ok(s) if s.success() => Ok(()),
        Ok(s) => Err(format!("{what} refused ({s})")),
        Err(e) => Err(format!("{what}: {e}")),
    }
}

/// Type `text` into the session's terminal and press Enter. Claude Code's prompt takes a new line as
/// backslash + Enter, so a multi-line message stays one message.
pub fn send(terms: &Terms, pid: u32, text: &str) -> Result<String, String> {
    let w = way(terms, pid).ok_or("this terminal offers no way to type into it")?;
    let body = text.trim_end().replace("\r\n", "\n").replace('\n', "\\\r");
    match &w {
        Way::Sync { port, token } => {
            use std::io::{BufRead, Write};
            let mut s = std::net::TcpStream::connect_timeout(&std::net::SocketAddr::from(([127, 0, 0, 1], *port)), std::time::Duration::from_secs(2)).map_err(|e| format!("the synced terminal did not answer: {e}"))?;
            let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(3)));
            s.write_all(format!("{}\n", serde_json::json!({ "token": token, "text": text })).as_bytes()).map_err(|e| e.to_string())?;
            let mut ok = String::new();
            std::io::BufReader::new(&s).read_line(&mut ok).map_err(|e| e.to_string())?;
            if ok.trim() != "ok" {
                return Err("the synced terminal refused the reply".into());
            }
        }
        Way::App(k) => term::write(terms, k, &format!("{body}\r"))?,
        Way::Tmux { socket, pane } => {
            let base = |c: &mut std::process::Command| {
                if !socket.is_empty() {
                    c.args(["-S", socket]);
                }
            };
            let mut c = command("tmux");
            base(&mut c);
            ok(c.args(["send-keys", "-t", pane, "-l", "--", &body]).status(), "tmux")?;
            let mut c = command("tmux");
            base(&mut c);
            ok(c.args(["send-keys", "-t", pane, "Enter"]).status(), "tmux")?;
        }
        Way::Konsole { service, session } => {
            let q = qdbus().ok_or("qdbus is missing")?;
            ok(command(q).args([service.as_str(), session.as_str(), "org.kde.konsole.Session.sendText", &body]).status(), "Konsole")?;
            std::thread::sleep(std::time::Duration::from_millis(60));
            ok(command(q).args([service.as_str(), session.as_str(), "org.kde.konsole.Session.sendText", "\r"]).status(), "Konsole")?;
        }
        Way::Kitty { to, window } => {
            ok(command("kitty").args(["@", "--to", to, "send-text", "--match", &format!("id:{window}"), "--", &format!("{body}\r")]).status(), "kitty")?;
        }
        Way::Iterm { tty } => {
            // iTerm2 presses Enter after `write text`; a new line in the prompt is backslash + Enter
            let line = as_str(&text.trim_end().replace("\r\n", "\n").replace('\n', " "));
            osascript(&format!("tell application \"iTerm2\" to repeat with w in windows\nrepeat with tb in tabs of w\nrepeat with s in sessions of tb\nif tty of s is {} then\ntell s to write text {line}\nreturn \"ok\"\nend if\nend repeat\nend repeat\nend repeat", as_str(tty))).filter(|r| r == "ok").ok_or("iTerm2 did not take it (allow the app to control iTerm2 in System Settings → Privacy & Security → Automation)")?;
        }
        Way::TerminalApp { tty } => {
            // `do script … in` a tab types the text and Enter into what runs there
            let line = as_str(&text.trim_end().replace("\r\n", "\n").replace('\n', " "));
            osascript(&format!("tell application \"Terminal\" to repeat with w in windows\nrepeat with tb in tabs of w\nif tty of tb is {} then\ndo script {line} in tb\nreturn \"ok\"\nend if\nend repeat\nend repeat", as_str(tty))).filter(|r| r == "ok").ok_or("Terminal did not take it (allow the app to control Terminal in System Settings → Privacy & Security → Automation)")?;
        }
        Way::Wezterm { pane } => {
            ok(command("wezterm").args(["cli", "send-text", "--pane-id", pane, "--no-paste", "--", &format!("{body}\r")]).status(), "WezTerm")?;
        }
    }
    Ok(name(&w).to_string())
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::io::Read;
    use std::time::Duration;

    /// A program waiting for input in an app terminal gets the reply typed into it.
    #[test]
    fn types_into_the_app_terminal() {
        let terms = Terms::default();
        let pair = native_pty_system().openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", "sh -c 'read line; echo got:$line; sleep 1'"]);
        let child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let writer = pair.master.take_writer().unwrap();
        let shell = child.process_id().unwrap();
        terms.insert_for_test("t1", pair.master, writer, child);
        // the inner sh is a child of the terminal's shell: find it, as a claude would be found
        std::thread::sleep(Duration::from_millis(300));
        let inner = std::fs::read_dir("/proc")
            .unwrap()
            .flatten()
            .filter_map(|e| e.file_name().to_str()?.parse::<u32>().ok())
            .find(|p| std::fs::read_to_string(format!("/proc/{p}/stat")).ok().and_then(|s| s.rsplit_once(')').map(|(_, r)| r.split_whitespace().nth(1) == Some(&shell.to_string()))).unwrap_or(false))
            .unwrap_or(shell);
        assert_eq!(check(&terms, inner).as_deref(), Some("the app's terminal"));
        send(&terms, inner, "hello there").unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut out = String::new();
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                out.push_str(&String::from_utf8_lossy(&buf[..n]));
                if out.contains("got:hello there") {
                    let _ = tx.send(());
                    break;
                }
            }
        });
        rx.recv_timeout(Duration::from_secs(5)).expect("the reply did not arrive");
        term::close(&terms, "t1");
    }
}
