//! Signing a Claude account in (Settings → Accounts → Add / Sign in again): `claude setup-token` in
//! a pseudo-terminal of its own, fresh for every sign-in and 400 columns wide from the start (never
//! resized, so nothing old is ever drawn again, and the token is not wrapped). Its output is read
//! here: the dialog gets it as plain text with the token masked, the token itself is checked against
//! the API (a 401 means it is not valid) and only then saved to the credential store. The terminal
//! is closed afterwards; nothing of it stays.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::sync::Mutex;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};
use tauri::ipc::Channel;

use super::tokens;

const COLS: u16 = 400;
/// what the reader keeps of the output (the token comes near the end)
const KEEP: usize = 64 * 1024;

struct Run {
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    _master: Box<dyn MasterPty + Send>,
    id: u64,
}

static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

static RUNS: Mutex<Option<HashMap<String, Run>>> = Mutex::new(None);

fn runs<T>(f: impl FnOnce(&mut HashMap<String, Run>) -> T) -> T {
    f(RUNS.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new))
}

/// End a sign-in: its claude stops, its terminal is gone.
pub fn cancel(account: &str) {
    if let Some(mut r) = runs(|m| m.remove(account)) {
        let _ = r.child.kill();
    }
}

/// Type into the sign-in's terminal (a code the browser shows, Enter).
pub fn input(account: &str, text: &str) -> Result<(), String> {
    runs(|m| {
        let r = m.get_mut(account).ok_or("the sign-in is not running")?;
        r.writer.write_all(text.as_bytes()).and_then(|_| r.writer.write_all(b"\r")).and_then(|_| r.writer.flush()).map_err(|e| e.to_string())
    })
}

/// Start `claude setup-token` for `account`. `on` gets `{type: "output", text}` (plain, masked),
/// `{type: "checking"}`, `{type: "invalid", message}`, then `{type: "saved"}` or `{type: "exit"}`.
pub fn start(account: &str, on: Channel<Value>) -> Result<(), String> {
    tokens::ok_id(account)?;
    cancel(account);
    let pair = native_pty_system().openpty(PtySize { rows: 40, cols: COLS, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())?;
    let mut cmd = CommandBuilder::new(super::discover::claude_bin());
    cmd.arg("setup-token");
    cmd.cwd(crate::sys::home());
    if let Some(p) = crate::sys::helper_path() {
        cmd.env("PATH", p);
    }
    for (k, _) in std::env::vars() {
        if k == "CLAUDECODE" || k.starts_with("CLAUDE_CODE_") || k == "CLAUDE_PID" || k == "CLAUDE_EFFORT" || k == "CLAUDE_CONFIG_DIR" {
            cmd.env_remove(k);
        }
    }
    cmd.env("TERM", "xterm-256color");
    let child = pair.slave.spawn_command(cmd).map_err(|e| format!("cannot run claude: {e}"))?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    runs(|m| m.insert(account.to_string(), Run { writer, child, _master: pair.master, id }));
    let account = account.to_string();
    std::thread::spawn(move || {
        let mut raw: Vec<u8> = Vec::new();
        let mut buf = vec![0u8; 16 * 1024];
        let mut tried: HashSet<String> = HashSet::new();
        let mut saved = false;
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            raw.extend_from_slice(&buf[..n]);
            if raw.len() > KEEP {
                raw.drain(..raw.len() - KEEP);
            }
            let text = plain(&raw);
            let _ = on.send(json!({ "type": "output", "text": tail(&mask_all(&text), 2000) }));
            let cands: Vec<String> = extract(&text).into_iter().filter(|c| !tried.contains(c)).collect();
            if cands.is_empty() {
                continue;
            }
            let _ = on.send(json!({ "type": "checking" }));
            let mut last = String::new();
            for c in cands {
                tried.insert(c.clone());
                match super::discover::check_token(&c).and_then(|()| tokens::save(&account, &c)) {
                    Ok(()) => {
                        saved = true;
                        break;
                    }
                    Err(e) => last = e,
                }
            }
            if saved {
                break;
            }
            let _ = on.send(json!({ "type": "invalid", "message": last }));
        }
        // this sign-in's terminal goes (not a newer one for the same account)
        if let Some(mut r) = runs(|m| if m.get(&account).is_some_and(|r| r.id == id) { m.remove(&account) } else { None }) {
            let _ = r.child.kill();
        }
        let _ = on.send(json!({ "type": if saved { "saved" } else { "exit" } }));
    });
    Ok(())
}

/// A pasted token: checked against the API first, saved only when it works.
pub fn save_checked(account: &str, token: &str, check: impl Fn(&str) -> Result<(), String>, store: impl FnOnce(&str, &str) -> Result<(), String>) -> Result<(), String> {
    let token = token.trim();
    if !tokens::looks_like_token(token) {
        return Err("That is not a Claude token (it starts with sk-ant-).".into());
    }
    check(token)?;
    store(account, token)
}

// ---------- reading the output ----------

/// The terminal's output as plain text: escape sequences out; the ones that move the cursor to
/// another line become a line break (so a screen drawn by position still reads line by line).
pub fn plain(raw: &[u8]) -> String {
    let s = String::from_utf8_lossy(raw);
    let b: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c == '\x1b' {
            match b.get(i + 1) {
                Some('[') => {
                    // CSI: parameters, then one final byte @..~
                    let mut j = i + 2;
                    while j < b.len() && !('@'..='~').contains(&b[j]) {
                        j += 1;
                    }
                    match b.get(j) {
                        Some('H' | 'f' | 'E' | 'F' | 'B' | 'd') => out.push('\n'),
                        Some('C') => out.push(' '),
                        _ => {}
                    }
                    i = j + 1;
                }
                Some(']') => {
                    // OSC: up to BEL or ESC \
                    let mut j = i + 2;
                    while j < b.len() && b[j] != '\x07' && !(b[j] == '\x1b' && b.get(j + 1) == Some(&'\\')) {
                        j += 1;
                    }
                    i = if b.get(j) == Some(&'\x07') { j + 1 } else { j + 2 };
                }
                Some(_) => i += 2,
                None => i += 1,
            }
            continue;
        }
        if c == '\r' {
            // a lone CR (redraw of the line) or CRLF: a line break either way
            if b.get(i + 1) != Some(&'\n') {
                out.push('\n');
            }
        } else if c != '\x07' && (c >= ' ' || c == '\n' || c == '\t') {
            out.push(c);
        }
        i += 1;
    }
    out
}

fn tok(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || c == '_'
}

/// The token `claude setup-token` printed, once it is printed in full: only after it says the token
/// was created (an older run drawn again does not count), and only once a blank line or "Store this
/// token" follows it. A line break inside it is skipped when the next line goes straight on with
/// token characters. Candidates, the likeliest first (the check against the API decides).
pub fn extract(text: &str) -> Vec<String> {
    let lower = text.to_ascii_lowercase();
    let Some(at) = lower.rfind("token created") else { return vec![] };
    let after = &text[at..];
    let Some(s) = after.find("sk-ant-oat") else { return vec![] };
    let rest: Vec<char> = after[s..].chars().collect();
    let mut i = 0;
    while i < rest.len() && tok(rest[i]) {
        i += 1;
    }
    let first: String = rest[..i].iter().collect();
    let mut joined = first.clone();
    let mut j = i;
    loop {
        // one line break (plain() made every CR, LF or CRLF one), then straight on with the token
        let k = j + 1;
        if j >= rest.len() || rest[j] != '\n' || k >= rest.len() || !tok(rest[k]) {
            break;
        }
        let mut e = k;
        while e < rest.len() && tok(rest[e]) {
            e += 1;
        }
        joined.extend(&rest[k..e]);
        j = e;
    }
    // printed in full: something after it says so
    let tail: String = rest[j..].iter().collect::<String>().replace('\r', "");
    let tail_l = tail.to_ascii_lowercase();
    // a blank line: a line break, nothing (or spaces), another line break
    let parts: Vec<&str> = tail.split('\n').collect();
    let blank = parts.len() >= 3 && parts[1..parts.len() - 1].iter().any(|l| l.trim().is_empty());
    if !(blank || tail_l.contains("store this token")) {
        return vec![];
    }
    let mut out = Vec::new();
    for c in [joined.clone(), first, joined.chars().take(108).collect()] {
        if tokens::looks_like_token(&c) && !out.contains(&c) {
            out.push(c);
        }
    }
    out
}

/// Every token in the text shown as `sk-ant-oat01-****`.
pub fn mask_all(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(p) = rest.find("sk-ant-") {
        out.push_str(&rest[..p]);
        let after = &rest[p..];
        let n = after.char_indices().find(|(_, c)| !tok(*c)).map(|(i, _)| i).unwrap_or(after.len());
        out.push_str(&after[..n.min(13)]);
        if n > 13 {
            out.push_str("****");
        }
        rest = &after[n..];
    }
    out.push_str(rest);
    out
}

fn tail(s: &str, n: usize) -> String {
    let c: Vec<char> = s.chars().collect();
    c[c.len().saturating_sub(n)..].iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: &str = "sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-xyzAAbbccdd";

    fn done(token_part: &str) -> String {
        format!("\x1b[32m✓\x1b[0m Long-lived authentication token created successfully!\r\n\r\nYour OAuth token (valid for 1 year):\r\n\r\n{token_part}\r\n\r\nStore this token securely. You won't be able to see it again.\r\n")
    }

    #[test]
    fn reads_a_token_split_over_two_pieces_of_output() {
        let all = done(T);
        let cut = all.find("sk-ant").unwrap() + 30;
        let (a, b) = all.as_bytes().split_at(cut);
        // the first piece alone: the token is not complete yet
        assert!(extract(&plain(a)).is_empty());
        let mut raw = a.to_vec();
        raw.extend_from_slice(b);
        assert_eq!(extract(&plain(&raw))[0], T);
    }

    #[test]
    fn reads_through_escape_sequences_and_a_line_break_inside_the_token() {
        let wrapped = format!("{}\x1b[0m\r\n{}", &T[..60], &T[60..]);
        assert_eq!(extract(&plain(done(&wrapped).as_bytes()))[0], T);
        // colours around it, a cursor move before it
        let coloured = format!("\x1b[1m\x1b[36m{T}\x1b[39m\x1b[22m");
        assert_eq!(extract(&plain(done(&coloured).as_bytes()))[0], T);
    }

    #[test]
    fn an_older_token_drawn_again_does_not_count() {
        // a token printed before "token created" is not the one
        let before = plain(b"sk-ant-oat01-OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLD\r\n\r\nLong-lived authentication token created\r\n\r\n");
        assert!(extract(&before).is_empty());
        // a redraw of an earlier run: its token, then a new run that has not created one yet
        let old = done("sk-ant-oat01-OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLD");
        let text = plain(format!("{old}\r\nOpening browser to sign in…\r\n").as_bytes());
        let c = extract(&text);
        assert!(c.iter().all(|x| x.contains("OLD")), "only the old one could be found here: {c:?}");
        // the old run's token is never the one found once the new one is printed
        let text = plain(format!("{old}\r\nOpening browser…\r\n{}", done(T)).as_bytes());
        assert_eq!(extract(&text)[0], T);
    }

    #[test]
    fn a_token_at_the_end_of_the_output_waits_for_what_follows() {
        let head = "Long-lived authentication token created successfully!\r\n\r\n";
        assert!(extract(&plain(format!("{head}{T}").as_bytes())).is_empty());
        assert!(extract(&plain(format!("{head}{T}\r\n").as_bytes())).is_empty());
        assert_eq!(extract(&plain(format!("{head}{T}\r\n\r\n").as_bytes()))[0], T);
    }

    #[test]
    fn masks_every_token_shown() {
        let shown = mask_all(&plain(done(T).as_bytes()));
        assert!(!shown.contains(&T[20..]));
        assert!(shown.contains("sk-ant-oat01-****"));
        // a token still being printed is masked too
        assert_eq!(mask_all("x sk-ant-oat01-Ab"), "x sk-ant-oat01-****");
    }

    #[test]
    fn an_invalid_token_is_not_saved() {
        let stored = std::cell::Cell::new(false);
        let r = save_checked("acc1", T, |_| Err("This token is not valid (401).".into()), |_, _| {
            stored.set(true);
            Ok(())
        });
        assert!(r.unwrap_err().contains("401"));
        assert!(!stored.get());
        // a cut one is refused before it is checked
        assert!(save_checked("acc1", "sk-ant-oat01-short", |_| Ok(()), |_, _| Ok(())).is_err());
        // a valid one is stored
        let r = save_checked("acc1", T, |_| Ok(()), |_, t| {
            assert_eq!(t, T);
            stored.set(true);
            Ok(())
        });
        assert!(r.is_ok() && stored.get());
    }
}
