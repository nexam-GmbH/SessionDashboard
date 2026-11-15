//! Terminal sync: `sd-wrap claude [args]` (also `session-dashboard wrap claude …` on Linux and
//! macOS) runs claude in a pseudo-terminal of its own and passes the terminal through untouched
//! (keys in, screen out, size followed), while the app can type into it too, over a local socket
//! with a secret token. That keeps a session in any terminal (Zed's, GNOME Terminal, iTerm, Windows
//! Terminal, …) in full sync with the app: what you type in either place goes to the same claude.
//! The shell function the app installs (Settings → Sessions) calls this for every `claude`.
//! Its own small crate, so the `sd-wrap` helper links none of the app's GUI libraries.
//!
//! Windows needs its own console handling (ConPTY via portable-pty; raw VT input set by hand,
//! UTF-16 console reads, byte-exact writes), and a console-subsystem exe: sd-wrap.exe, next to the
//! app, because a GUI exe started from a shell gets no console and is not waited for.

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::Duration;

type Writer = Arc<Mutex<Box<dyn Write + Send>>>;

/// The user's home folder (HOME; Windows: USERPROFILE).
pub fn home() -> std::path::PathBuf {
    std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("/"))
}

/// The app's own folder: ~/.config/session-dashboard (XDG_CONFIG_HOME when set; Windows:
/// %APPDATA%\session-dashboard). The app and the wrapper must agree on it.
pub fn config_dir() -> std::path::PathBuf {
    if let Some(x) = std::env::var_os("XDG_CONFIG_HOME").filter(|x| !x.is_empty()) {
        return std::path::PathBuf::from(x).join("session-dashboard");
    }
    #[cfg(windows)]
    if let Some(a) = std::env::var_os("APPDATA") {
        return std::path::PathBuf::from(a).join("session-dashboard");
    }
    home().join(".config").join("session-dashboard")
}

/// Where wrapped sessions register: <config>/sync/<pid of the program>.json.
pub fn registry() -> std::path::PathBuf {
    config_dir().join("sync")
}

/// The `claude` binary: SD_CLAUDE_BIN, the usual install places, else `claude` from PATH.
pub fn claude_bin() -> String {
    if let Ok(p) = std::env::var("SD_CLAUDE_BIN") {
        return p;
    }
    let h = |rel: &str| home().join(rel).to_string_lossy().to_string();
    let candidates: Vec<String> = if cfg!(windows) {
        vec![h(".local\\bin\\claude.exe"), h("AppData\\Roaming\\npm\\claude.exe"), h("AppData\\Roaming\\npm\\claude.cmd"), h(".claude\\local\\claude.exe")]
    } else {
        vec![h(".npm-global/bin/claude"), h(".local/bin/claude"), h(".claude/local/claude"), "/usr/local/bin/claude".into(), "/usr/bin/claude".into(), "/opt/homebrew/bin/claude".into()]
    };
    candidates.into_iter().find(|c| std::path::Path::new(c).exists()).unwrap_or_else(|| "claude".into())
}

// ---------- the host terminal, per platform ----------

#[cfg(unix)]
mod host {
    use std::io::{Read, Write};

    pub struct Raw;
    impl Drop for Raw {
        fn drop(&mut self) {
            let _ = crossterm::terminal::disable_raw_mode();
        }
    }

    /// Raw mode, or None when stdin/stdout is not a terminal (then the program runs directly).
    pub fn enter() -> Option<Raw> {
        use std::io::IsTerminal;
        if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
            return None;
        }
        crossterm::terminal::enable_raw_mode().ok().map(|_| Raw)
    }

    pub fn size() -> (u16, u16) {
        crossterm::terminal::size().unwrap_or((80, 24))
    }

    /// Keys, as bytes, to `sink` until stdin closes.
    pub fn read_input(mut sink: impl FnMut(&[u8]) -> bool) {
        let mut stdin = std::io::stdin();
        let mut buf = [0u8; 4096];
        loop {
            match stdin.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if !sink(&buf[..n]) {
                        break;
                    }
                }
            }
        }
    }

    pub fn write_output(bytes: &[u8]) -> bool {
        let mut out = std::io::stdout();
        out.write_all(bytes).is_ok() && out.flush().is_ok()
    }

    pub fn leave() {}
}

#[cfg(windows)]
mod host {
    use windows_sys::Win32::Foundation::{BOOL, HANDLE};
    use windows_sys::Win32::Storage::FileSystem::WriteFile;
    use windows_sys::Win32::System::Console::*;

    fn h(which: STD_HANDLE) -> HANDLE {
        unsafe { GetStdHandle(which) }
    }

    pub struct Raw {
        in_mode: CONSOLE_MODE,
        out_mode: CONSOLE_MODE,
        in_cp: u32,
        out_cp: u32,
    }
    impl Drop for Raw {
        fn drop(&mut self) {
            // modes the inner program may have switched on (win32-input-mode, focus, paste, alt screen)
            write_output(b"\x1b[?9001l\x1b[?1004l\x1b[?2004l\x1b[?1049l\x1b[?25h\x1b[0m");
            unsafe {
                SetConsoleMode(h(STD_INPUT_HANDLE), self.in_mode);
                SetConsoleMode(h(STD_OUTPUT_HANDLE), self.out_mode);
                SetConsoleCP(self.in_cp);
                SetConsoleOutputCP(self.out_cp);
            }
        }
    }

    unsafe extern "system" fn on_ctrl(kind: u32) -> BOOL {
        // Ctrl+C / Ctrl+Break arrive as input bytes for the program; closing the window ends us
        if kind == CTRL_C_EVENT || kind == CTRL_BREAK_EVENT { 1 } else { 0 }
    }

    pub fn enter() -> Option<Raw> {
        unsafe {
            let (hin, hout) = (h(STD_INPUT_HANDLE), h(STD_OUTPUT_HANDLE));
            let (mut in_mode, mut out_mode): (CONSOLE_MODE, CONSOLE_MODE) = (0, 0);
            // not a console (a pipe, mintty without ConPTY): the program runs directly
            if GetConsoleMode(hin, &mut in_mode) == 0 || GetConsoleMode(hout, &mut out_mode) == 0 {
                return None;
            }
            let raw = Raw { in_mode, out_mode, in_cp: GetConsoleCP(), out_cp: GetConsoleOutputCP() };
            SetConsoleMode(hin, (in_mode | ENABLE_VIRTUAL_TERMINAL_INPUT) & !(ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT | ENABLE_PROCESSED_INPUT));
            SetConsoleMode(hout, out_mode | ENABLE_PROCESSED_OUTPUT | ENABLE_VIRTUAL_TERMINAL_PROCESSING | DISABLE_NEWLINE_AUTO_RETURN);
            SetConsoleCP(65001);
            SetConsoleOutputCP(65001);
            SetConsoleCtrlHandler(Some(on_ctrl), 1);
            Some(raw)
        }
    }

    pub fn size() -> (u16, u16) {
        unsafe {
            let mut info: CONSOLE_SCREEN_BUFFER_INFO = std::mem::zeroed();
            if GetConsoleScreenBufferInfo(h(STD_OUTPUT_HANDLE), &mut info) == 0 {
                return (80, 24);
            }
            let w = info.srWindow;
            (((w.Right - w.Left) + 1).max(1) as u16, ((w.Bottom - w.Top) + 1).max(1) as u16)
        }
    }

    /// Keys as UTF-8 bytes: the console gives UTF-16 (a lone high surrogate waits for its pair).
    /// std's stdin is not used: it takes Ctrl+Z as end of input.
    pub fn read_input(mut sink: impl FnMut(&[u8]) -> bool) {
        let hin = h(STD_INPUT_HANDLE) as usize;
        let mut buf = [0u16; 2048];
        let mut pending: Vec<u16> = Vec::new();
        loop {
            let mut n: u32 = 0;
            let ok = unsafe { ReadConsoleW(hin as HANDLE, buf.as_mut_ptr() as *mut _, buf.len() as u32, &mut n, std::ptr::null()) };
            if ok == 0 {
                break;
            }
            if n == 0 {
                continue;
            }
            pending.extend_from_slice(&buf[..n as usize]);
            // keep a trailing high surrogate for the next read
            let keep = matches!(pending.last(), Some(c) if (0xD800..0xDC00).contains(c));
            let upto = if keep { pending.len() - 1 } else { pending.len() };
            let text = String::from_utf16_lossy(&pending[..upto]);
            pending.drain(..upto);
            if !text.is_empty() && !sink(text.as_bytes()) {
                break;
            }
        }
    }

    /// Bytes as they come (a chunk may end inside a UTF-8 character or an escape sequence).
    pub fn write_output(bytes: &[u8]) -> bool {
        let hout = h(STD_OUTPUT_HANDLE);
        let mut off = 0usize;
        while off < bytes.len() {
            let mut wrote: u32 = 0;
            let ok = unsafe { WriteFile(hout, bytes[off..].as_ptr(), (bytes.len() - off) as u32, &mut wrote, std::ptr::null_mut()) };
            if ok == 0 || wrote == 0 {
                return false;
            }
            off += wrote as usize;
        }
        true
    }

    pub fn leave() {
        unsafe {
            SetConsoleCtrlHandler(Some(on_ctrl), 0);
        }
    }
}

// ---------- running the program ----------

fn pty_size() -> PtySize {
    let (cols, rows) = host::size();
    PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }
}

/// The program to start: `claude` resolves like the app finds it (claude.exe on Windows; an npm
/// claude.cmd goes through cmd.exe, which portable-pty would otherwise start without escaping).
fn command_for(program: &str, args: &[String]) -> CommandBuilder {
    let bin = if program == "claude" { claude_bin() } else { program.to_string() };
    if cfg!(windows) && (bin.to_ascii_lowercase().ends_with(".cmd") || bin.to_ascii_lowercase().ends_with(".bat")) {
        let mut c = CommandBuilder::new("cmd.exe");
        c.args(["/d", "/s", "/c"]);
        c.arg(&bin);
        c.args(args);
        return c;
    }
    let mut c = CommandBuilder::new(&bin);
    c.args(args);
    c
}

fn run_directly(program: &str, args: &[String]) -> i32 {
    let bin = if program == "claude" { claude_bin() } else { program.to_string() };
    std::process::Command::new(&bin).args(args).status().map(|s| s.code().unwrap_or(1)).unwrap_or(127)
}

/// Run `args[0]` with `args[1..]` through the sync wrapper; returns its exit code.
pub fn run(args: &[String]) -> i32 {
    let Some(program) = args.first() else {
        eprintln!("usage: sd-wrap <program> [args…]");
        return 2;
    };
    let rest = &args[1..];
    // already inside a synced session (claude starting claude), or no terminal: nothing to sync
    if std::env::var_os("SD_SYNC").is_some() {
        return run_directly(program, rest);
    }
    let Some(raw) = host::enter() else {
        return run_directly(program, rest);
    };
    let pair = match native_pty_system().openpty(pty_size()) {
        Ok(p) => p,
        Err(e) => {
            drop(raw);
            eprintln!("sd-wrap: no pseudo-terminal ({e}); running it directly");
            return run_directly(program, rest);
        }
    };
    let writer: Writer = Arc::new(Mutex::new(pair.master.take_writer().expect("pty writer")));
    // keys in, from the start (ConPTY waits for the terminal's answer to its cursor query)
    {
        let w = writer.clone();
        std::thread::spawn(move || {
            host::read_input(|bytes| {
                let mut g = w.lock().unwrap();
                g.write_all(bytes).is_ok() && g.flush().is_ok()
            })
        });
    }
    let mut cmd = command_for(program, rest);
    if let Ok(cwd) = std::env::current_dir() {
        cmd.cwd(cwd);
    }
    cmd.env("SD_SYNC", "1");
    let mut child = match pair.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => {
            drop(raw);
            eprintln!("sd-wrap: could not start {program}: {e}");
            return 127;
        }
    };
    drop(pair.slave);
    let pid = child.process_id().unwrap_or(0);
    let mut reader = pair.master.try_clone_reader().expect("pty reader");
    let master = Arc::new(Mutex::new(Some(pair.master)));

    // the app's way in: a local socket and a token, registered by the program's pid
    let token = uuid::Uuid::new_v4().to_string();
    let reg = registry().join(format!("{pid}.json"));
    if let Ok(listener) = TcpListener::bind("127.0.0.1:0") {
        let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
        let _ = std::fs::create_dir_all(registry());
        let _ = std::fs::write(&reg, serde_json::json!({ "port": port, "token": token, "wrapper": std::process::id() }).to_string());
        let w = writer.clone();
        let token = token.clone();
        std::thread::spawn(move || serve(listener, w, token));
    }

    // the size of the terminal, followed
    {
        let m = master.clone();
        std::thread::spawn(move || {
            let mut last = pty_size();
            loop {
                std::thread::sleep(Duration::from_millis(200));
                let now = pty_size();
                if now.rows != last.rows || now.cols != last.cols {
                    match m.lock().unwrap().as_ref() {
                        Some(pty) => {
                            let _ = pty.resize(now);
                        }
                        None => break,
                    }
                    last = now;
                }
            }
        });
    }
    // screen out, until the program closes its side
    let out = std::thread::spawn(move || {
        let mut buf = [0u8; 16384];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if !host::write_output(&buf[..n]) {
                        break;
                    }
                }
            }
        }
    });
    let code = child.wait().map(|s| s.exit_code() as i32).unwrap_or(1);
    let _ = std::fs::remove_file(&reg);
    // closing the pseudo-console ends its output (Windows: only then does the pipe reach its end)
    let closed = std::thread::spawn(move || {
        master.lock().unwrap().take();
    });
    for _ in 0..30 {
        if out.is_finished() {
            break;
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    let _ = closed.is_finished();
    host::leave();
    drop(raw);
    code
}

/// Replies from the app: one JSON line {token, text}; typed in, then Enter.
fn serve(listener: TcpListener, w: Writer, token: String) {
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
}

