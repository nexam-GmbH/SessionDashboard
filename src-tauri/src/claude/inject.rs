//! Typing into a session that runs in a terminal, so a reply from the app reaches it without stopping
//! it there: the app's own terminal (its pty), tmux, Konsole (D-Bus), kitty (remote control) and
//! WezTerm (cli). Which one is found from the claude process's environment. Other terminals (Zed's,
//! GNOME Terminal) offer no way in; the app continues in a copy there instead.

use std::collections::HashMap;

use crate::sys::command;
use crate::term::{self, Terms};

#[derive(Clone, Debug, PartialEq)]
enum Way {
    App(String),
    Tmux { socket: String, pane: String },
    Konsole { service: String, session: String },
    Kitty { to: String, window: String },
    Wezterm { pane: String },
}

fn env_of(pid: u32) -> HashMap<String, String> {
    let raw = std::fs::read(format!("/proc/{pid}/environ")).unwrap_or_default();
    raw.split(|b| *b == 0)
        .filter_map(|kv| {
            let s = String::from_utf8_lossy(kv);
            let (k, v) = s.split_once('=')?;
            Some((k.to_string(), v.to_string()))
        })
        .collect()
}

fn qdbus() -> Option<&'static str> {
    ["qdbus", "qdbus6", "qdbus-qt6", "qdbus-qt5"].into_iter().find(|b| command(b).arg("--version").output().is_ok())
}

fn which(bin: &str) -> bool {
    command(bin).arg("--version").output().is_ok()
}

fn way(terms: &Terms, pid: u32) -> Option<Way> {
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
    None
}

fn name(w: &Way) -> &'static str {
    match w {
        Way::App(_) => "the app's terminal",
        Way::Tmux { .. } => "tmux",
        Way::Konsole { .. } => "Konsole",
        Way::Kitty { .. } => "kitty",
        Way::Wezterm { .. } => "WezTerm",
    }
}

/// How a reply would reach this terminal session ("Konsole", "tmux", …), or None.
pub fn check(terms: &Terms, pid: u32) -> Option<String> {
    way(terms, pid).map(|w| name(&w).to_string())
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
        Way::App(k) => term::write(terms, k, &format!("{body}\r"))?,
        Way::Tmux { socket, pane } => {
            let base = |c: &mut std::process::Command| {
                if !socket.is_empty() {
                    c.args(["-S", socket]);
                }
            };
            let mut c = command("tmux");
            base(&mut c);
            ok(c.args(["send-keys", "-t", pane, "-l", &body]).status(), "tmux")?;
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
            ok(command("kitty").args(["@", "--to", to, "send-text", "--match", &format!("id:{window}"), &format!("{body}\r")]).status(), "kitty")?;
        }
        Way::Wezterm { pane } => {
            ok(command("wezterm").args(["cli", "send-text", "--pane-id", pane, "--no-paste", &format!("{body}\r")]).status(), "WezTerm")?;
        }
    }
    Ok(name(&w).to_string())
}

#[cfg(test)]
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
