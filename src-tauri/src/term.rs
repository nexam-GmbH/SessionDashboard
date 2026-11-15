//! The built-in terminal: a real shell in a pseudo-terminal (portable-pty, MIT, from WezTerm) per
//! folder. Output goes to the UI as raw bytes over a Tauri channel (no JSON, no base64), read in
//! 64 KiB chunks on its own thread; input, resize and close are plain commands.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::{Channel, InvokeResponseBody};

struct Term {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    /// where its output goes now: a window that attaches again (a reload, a second window) takes it over
    out: Arc<Mutex<Option<Channel<InvokeResponseBody>>>>,
    /// the last output, replayed to a window that attaches to a running shell
    scrollback: Arc<Mutex<Vec<u8>>>,
    id: u64,
}

static TERM_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
const SCROLLBACK: usize = 256 * 1024;

/// Open terminals by the UI's key (one per folder).
#[derive(Default, Clone)]
pub struct Terms(Arc<Mutex<HashMap<String, Term>>>);

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 }
}

/// The user's login shell (interactive), like a terminal emulator starts it.
fn shell() -> CommandBuilder {
    #[cfg(windows)]
    {
        // PowerShell 7 when installed, else Windows PowerShell (what Windows Terminal opens)
        let ps = if crate::sys::command("pwsh").arg("-Version").output().is_ok() { "pwsh.exe" } else { "powershell.exe" };
        let mut c = CommandBuilder::new(ps);
        c.arg("-NoLogo");
        c
    }
    #[cfg(not(windows))]
    {
        let sh = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/bash".into());
        let mut c = CommandBuilder::new(sh);
        c.arg("-l");
        c
    }
}

/// Quote for a remote POSIX shell, keeping a leading ~ so it still expands there.
fn shell_quote(p: &str) -> String {
    let (head, rest) = if p == "~" {
        ("~", "")
    } else if let Some(r) = p.strip_prefix("~/") {
        ("~/", r)
    } else {
        ("", p)
    };
    if rest.is_empty() {
        return head.to_string();
    }
    format!("{head}'{}'", rest.replace('\'', "'\\''"))
}

fn expand(p: &str) -> String {
    crate::sys::expand(p)
}

/// Start a shell in `cwd` and stream what it prints to `on_data`. An empty message means it exited.
/// A key that is already open is kept (the UI re-attaches to it).
pub fn open(terms: &Terms, key: String, cwd: String, host: Option<String>, cols: u16, rows: u16, on_data: Channel<InvokeResponseBody>) -> Result<bool, String> {
    {
        let map = terms.0.lock().unwrap();
        if let Some(t) = map.get(&key) {
            // already running: this window takes its output over, starting with what it printed
            let back = t.scrollback.lock().unwrap().clone();
            if !back.is_empty() {
                let _ = on_data.send(InvokeResponseBody::Raw(back));
            }
            *t.out.lock().unwrap() = Some(on_data);
            return Ok(false);
        }
    }
    let pair = native_pty_system().openpty(size(cols, rows)).map_err(|e| e.to_string())?;
    let mut cmd = match host.as_deref().filter(|h| !h.is_empty()) {
        // a session on a VPS: a login shell there, in its folder
        Some(h) => {
            crate::claude::remote::host_ok(h)?;
            let mut c = CommandBuilder::new(std::env::var("SD_SSH").unwrap_or_else(|_| "ssh".into()));
            let dir = if cwd.starts_with('/') || cwd.starts_with('~') { cwd.clone() } else { "~".into() };
            c.args(["-t", "--", h, &format!("cd {} 2>/dev/null; exec \"$SHELL\" -l", shell_quote(&dir))]);
            c
        }
        None => shell(),
    };
    let dir = expand(&cwd);
    if host.is_none() && std::path::Path::new(&dir).is_dir() {
        cmd.cwd(dir);
    } else {
        cmd.cwd(crate::sys::home());
    }
    if let Some(p) = crate::sys::helper_path() {
        cmd.env("PATH", p);
    }
    // the app may itself run under Claude Code (its variables would make `claude` refuse to start
    // here as a "nested session")
    for (k, _) in std::env::vars() {
        if k == "CLAUDECODE" || k.starts_with("CLAUDE_CODE_") || k == "CLAUDE_PID" || k == "CLAUDE_EFFORT" {
            cmd.env_remove(k);
        }
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "session-dashboard");
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let id = TERM_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let out = Arc::new(Mutex::new(Some(on_data)));
    let scrollback = Arc::new(Mutex::new(Vec::new()));
    terms.0.lock().unwrap().insert(key.clone(), Term { master: pair.master, writer, child, out: out.clone(), scrollback: scrollback.clone(), id });
    let all = terms.clone();
    // reader: the pty's bytes as they come
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    // sender: what came within ~5 ms (or 64 KiB) goes to the UI as one message, so a burst of
    // output (a build log, `cat`) is a few messages instead of thousands
    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut chunk = first;
            let until = std::time::Instant::now() + std::time::Duration::from_millis(5);
            while chunk.len() < 64 * 1024 {
                let left = until.saturating_duration_since(std::time::Instant::now());
                match rx.recv_timeout(left) {
                    Ok(more) => chunk.extend_from_slice(&more),
                    Err(_) => break,
                }
            }
            {
                let mut back = scrollback.lock().unwrap();
                back.extend_from_slice(&chunk);
                if back.len() > SCROLLBACK {
                    let cut = back.len() - SCROLLBACK;
                    back.drain(..cut);
                }
            }
            // the window that shows it now (a closed window's channel failing doesn't end the shell)
            let ch = out.lock().unwrap().clone();
            if let Some(ch) = ch {
                let _ = ch.send(InvokeResponseBody::Raw(chunk));
            }
        }
        // the shell ended (exit, or closed): forget this one (not a newer shell under the same key),
        // wait for it outside the lock, and tell the UI
        let mine = {
            let mut map = all.0.lock().unwrap();
            match map.get(&key) {
                Some(t) if t.id == id => map.remove(&key),
                _ => None,
            }
        };
        if let Some(mut t) = mine {
            let _ = t.child.wait();
        }
        let ch = out.lock().unwrap().clone();
        if let Some(ch) = ch {
            let _ = ch.send(InvokeResponseBody::Raw(Vec::new()));
        }
    });
    Ok(true)
}

pub fn write(terms: &Terms, key: &str, data: &str) -> Result<(), String> {
    let mut map = terms.0.lock().unwrap();
    let t = map.get_mut(key).ok_or("terminal is closed")?;
    t.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    t.writer.flush().map_err(|e| e.to_string())
}

#[cfg(test)]
impl Terms {
    pub fn insert_for_test(&self, key: &str, master: Box<dyn portable_pty::MasterPty + Send>, writer: Box<dyn Write + Send>, child: Box<dyn portable_pty::Child + Send + Sync>) {
        self.0.lock().unwrap().insert(key.to_string(), Term { master, writer, child, out: Arc::new(Mutex::new(None)), scrollback: Arc::new(Mutex::new(Vec::new())), id: 0 });
    }
}

/// The app terminal whose shell `pid` runs under (a claude started in the built-in terminal).
pub fn key_of_descendant(terms: &Terms, pid: u32) -> Option<String> {
    let shells: Vec<(String, u32)> = terms.0.lock().unwrap().iter().filter_map(|(k, t)| Some((k.clone(), t.child.process_id()?))).collect();
    let mut cur = pid;
    for _ in 0..64 {
        if let Some((k, _)) = shells.iter().find(|(_, s)| *s == cur) {
            return Some(k.clone());
        }
        cur = crate::sys::parent_of(cur)?;
        if cur <= 1 {
            return None;
        }
    }
    None
}

pub fn resize(terms: &Terms, key: &str, cols: u16, rows: u16) -> Result<(), String> {
    let map = terms.0.lock().unwrap();
    let t = map.get(key).ok_or("terminal is closed")?;
    t.master.resize(size(cols, rows)).map_err(|e| e.to_string())
}

pub fn close(terms: &Terms, key: &str) {
    let t = terms.0.lock().unwrap().remove(key);
    if let Some(mut t) = t {
        let _ = t.child.kill();
    }
}

/// Every shell ends with the app.
pub fn close_all(terms: &Terms) {
    for (_, mut t) in terms.0.lock().unwrap().drain() {
        let _ = t.child.kill();
    }
}

// async: off the main thread, so typing in the terminal never holds up the window
#[tauri::command]
pub async fn term_open(terms: tauri::State<'_, Terms>, key: String, cwd: String, host: Option<String>, cols: u16, rows: u16, on_data: Channel<InvokeResponseBody>) -> Result<bool, String> {
    open(&terms, key, cwd, host, cols, rows, on_data)
}

#[tauri::command]
pub async fn term_write(terms: tauri::State<'_, Terms>, key: String, data: String) -> Result<(), String> {
    write(&terms, &key, &data)
}

#[tauri::command]
pub async fn term_resize(terms: tauri::State<'_, Terms>, key: String, cols: u16, rows: u16) -> Result<(), String> {
    resize(&terms, &key, cols, rows)
}

#[tauri::command]
pub async fn term_close(terms: tauri::State<'_, Terms>, key: String) -> Result<(), String> {
    close(&terms, &key);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    /// A real shell in a pty: what we type runs, its output comes back, close ends it.
    #[test]
    fn quotes_remote_folders() {
        assert_eq!(shell_quote("~"), "~");
        assert_eq!(shell_quote("~/my repo"), "~/'my repo'");
        assert_eq!(shell_quote("/srv/it's"), "'/srv/it'\\''s'");
    }

    #[test]
    fn shell_round_trip() {
        let pair = native_pty_system().openpty(size(80, 24)).unwrap();
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.cwd("/tmp");
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        writer.write_all(b"echo sd-$((40+2)); pwd\n").unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut out = String::new();
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                out.push_str(&String::from_utf8_lossy(&buf[..n]));
                if out.contains("sd-42") && out.contains("/tmp\r\n") {
                    let _ = tx.send(out.clone());
                    break;
                }
            }
        });
        let out = rx.recv_timeout(Duration::from_secs(5)).expect("no output from the shell");
        assert!(out.contains("sd-42"), "{out}");
        pair.master.resize(size(120, 40)).unwrap();
        child.kill().unwrap();
        let t = Instant::now();
        let _ = child.wait();
        assert!(t.elapsed() < Duration::from_secs(5));
    }
}
