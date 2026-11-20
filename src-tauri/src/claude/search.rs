//! Full-text search over every session's conversation: what you typed and what Claude answered
//! (tool output, thinking and pictures left out, as the chat's own Find does). A transcript is
//! hundreds of MB of tool results and request blobs around a few hundred KB of conversation, so the
//! text is pulled out once into an index kept in memory and on disk
//! (~/.config/session-dashboard/search-index.json); after that only what was appended to a file
//! since the last look is read. Matching is plain lowercase substring search, all words in one
//! message, any script (Cyrillic, CJK) alike.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use super::discover::{claude_dirs, memfind, user_text};

const VERSION: u32 = 1;
/// a message longer than this is indexed by its start (a huge paste)
const MAX_TEXT: usize = 6000;

#[derive(Serialize, Deserialize, Clone)]
struct Entry {
    /// record uuid (the chat's item id: a user message's id, an answer's `uuid:i`)
    u: String,
    /// 0 = you, 1 = Claude
    r: u8,
    /// timestamp (ISO)
    t: String,
    x: String,
    #[serde(skip)]
    l: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct FileIdx {
    session: String,
    size: u64,
    mtime: u64,
    /// bytes read so far (complete lines only)
    offset: u64,
    entries: Vec<Entry>,
}

#[derive(Serialize, Deserialize, Default)]
struct Index {
    version: u32,
    files: HashMap<String, FileIdx>,
    #[serde(skip)]
    loaded: bool,
    #[serde(skip)]
    dirty: bool,
    /// when it was last written out (the whole index: megabytes of JSON)
    #[serde(skip)]
    saved_at: Option<std::time::Instant>,
}

#[derive(Default, Clone)]
pub struct Search(Arc<Mutex<Index>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub session_id: String,
    /// the newest matching message
    pub uuid: String,
    pub role: &'static str,
    pub at: String,
    /// the text around the match: before, the match itself, after
    pub before: String,
    pub matched: String,
    pub after: String,
    /// how many messages of this session match
    pub count: usize,
}

/// One char of lowercase per char, so positions in the lowercase text are positions in the text.
fn lower(s: &str) -> String {
    s.chars().map(|c| c.to_lowercase().next().unwrap_or(c)).collect()
}

fn index_path() -> PathBuf {
    crate::sys::config_dir().join("search-index.json")
}

fn mtime_of(md: &std::fs::Metadata) -> u64 {
    md.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn cap(s: &str) -> String {
    if s.len() <= MAX_TEXT {
        return s.to_string();
    }
    let mut end = MAX_TEXT;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

/// The searchable text of one transcript line, if it is a message of the conversation.
fn entry_of(line: &[u8]) -> Option<Entry> {
    let user = memfind(line, br#""type":"user""#);
    let assistant = !user && memfind(line, br#""type":"assistant""#);
    let queued = !user && !assistant && memfind(line, br#""type":"queued_command""#);
    if !user && !assistant && !queued {
        return None;
    }
    // tool results are most of the bytes and none of the conversation
    if user && memfind(line, br#""tool_use_id""#) {
        return None;
    }
    if assistant && !memfind(line, br#""type":"text""#) {
        return None;
    }
    let v: Value = serde_json::from_slice(line).ok()?;
    if v.get("isSidechain").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let uuid = v.get("uuid").and_then(Value::as_str)?.to_string();
    let at = v.get("timestamp").and_then(Value::as_str).unwrap_or("").to_string();
    let (r, text, id) = if queued {
        let a = v.get("attachment")?;
        if a.get("origin").and_then(|o| o.get("kind")).and_then(Value::as_str).is_some_and(|k| k != "human") {
            return None;
        }
        (0u8, a.get("prompt").and_then(Value::as_str)?.trim().to_string(), uuid)
    } else if user {
        (0u8, full_user_text(&v)?, uuid)
    } else {
        let msg = v.get("message")?;
        if msg.get("model").and_then(Value::as_str) == Some("<synthetic>") {
            return None;
        }
        let parts = msg.get("content")?.as_array()?;
        // the chat's item id of the first text block (`uuid:index`)
        let (i, _) = parts.iter().enumerate().find(|(_, p)| p.get("type").and_then(Value::as_str) == Some("text"))?;
        let text: String = parts.iter().filter(|p| p.get("type").and_then(Value::as_str) == Some("text")).filter_map(|p| p.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n");
        (1u8, text.trim().to_string(), format!("{uuid}:{i}"))
    };
    if text.is_empty() {
        return None;
    }
    let x = cap(&text);
    Some(Entry { u: id, r, t: at, l: lower(&x), x })
}

/// What you typed (the whole message, not the 400 characters the session list keeps).
fn full_user_text(v: &Value) -> Option<String> {
    // the same rules as the list's first prompt (wrappers out, slash commands as "/name args")
    let short = user_text(v)?;
    if short.chars().count() < 400 {
        return Some(short);
    }
    let c = v.get("message")?.get("content")?;
    let text = match c {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts.iter().filter(|p| p.get("type").and_then(Value::as_str) == Some("text")).filter_map(|p| p.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join(""),
        _ => return Some(short),
    };
    Some(super::discover::after_bash(text.trim()).to_string())
}

/// Read a transcript from `from` to its last complete line.
fn read_from(path: &Path, from: u64, into: &mut Vec<Entry>) -> std::io::Result<u64> {
    let mut f = File::open(path)?;
    f.seek(SeekFrom::Start(from))?;
    let mut r = BufReader::with_capacity(1 << 20, f);
    let mut buf = Vec::new();
    let mut pos = from;
    loop {
        buf.clear();
        let n = r.read_until(b'\n', &mut buf)?;
        if n == 0 || buf.last() != Some(&b'\n') {
            break;
        }
        pos += n as u64;
        if let Some(e) = entry_of(&buf) {
            into.push(e);
        }
    }
    Ok(pos)
}

impl Index {
    fn load(&mut self) {
        if self.loaded {
            return;
        }
        self.loaded = true;
        if let Ok(f) = File::open(index_path()) {
            if let Ok(mut idx) = serde_json::from_reader::<_, Index>(BufReader::new(f)) {
                if idx.version == VERSION {
                    for fi in idx.files.values_mut() {
                        for e in &mut fi.entries {
                            e.l = lower(&e.x);
                        }
                    }
                    self.files = idx.files;
                }
            }
        }
        self.version = VERSION;
    }

    /// Bring the index up to date with the transcripts on disk (new, grown, rewritten, deleted).
    fn refresh(&mut self) {
        self.load();
        let mut present = std::collections::HashSet::new();
        for dir in claude_dirs() {
            let Ok(projects) = std::fs::read_dir(dir.join("projects")) else { continue };
            for p in projects.flatten() {
                let Ok(files) = std::fs::read_dir(p.path()) else { continue };
                for f in files.flatten() {
                    let path = f.path();
                    if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                        continue;
                    }
                    let Ok(md) = f.metadata() else { continue };
                    let key = path.to_string_lossy().to_string();
                    present.insert(key.clone());
                    let (size, mtime) = (md.len(), mtime_of(&md));
                    let session = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
                    let cur = self.files.get(&key);
                    if cur.is_some_and(|c| c.size == size && c.mtime == mtime) {
                        continue;
                    }
                    // grown: read only what was appended; shorter (rewritten): read it again
                    let mut fi = match cur {
                        Some(c) if size >= c.offset => c.clone(),
                        _ => FileIdx { session, ..Default::default() },
                    };
                    if let Ok(end) = read_from(&path, fi.offset, &mut fi.entries) {
                        fi.offset = end;
                        fi.size = size;
                        fi.mtime = mtime;
                        self.files.insert(key, fi);
                        self.dirty = true;
                    }
                }
            }
        }
        let before = self.files.len();
        self.files.retain(|k, _| present.contains(k));
        if self.files.len() != before {
            self.dirty = true;
        }
    }

    /// Write the index out, at most every 2 minutes: while a session runs its transcript grows all
    /// the time, and every search wrote the whole index again. What is not written yet is read
    /// again from the transcripts after a restart (only the part after the saved offsets).
    fn save(&mut self) {
        if !self.dirty || self.saved_at.is_some_and(|t| t.elapsed() < std::time::Duration::from_secs(120)) {
            return;
        }
        self.saved_at = Some(std::time::Instant::now());
        let path = index_path();
        if let Some(d) = path.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let tmp = path.with_extension("json.tmp");
        let ok = File::create(&tmp).map_err(|e| e.to_string()).and_then(|f| serde_json::to_writer(std::io::BufWriter::new(f), self).map_err(|e| e.to_string()));
        if ok.is_ok() && std::fs::rename(&tmp, &path).is_ok() {
            self.dirty = false;
        }
    }

    fn search(&self, query: &str, limit: usize) -> Vec<Hit> {
        let q = lower(query.trim());
        let words: Vec<&str> = q.split_whitespace().collect();
        if words.is_empty() {
            return Vec::new();
        }
        let mut hits: Vec<Hit> = Vec::new();
        for fi in self.files.values() {
            let mut count = 0usize;
            let mut best: Option<&Entry> = None;
            for e in &fi.entries {
                if words.iter().all(|w| e.l.contains(w)) {
                    count += 1;
                    // the newest match stands for the session
                    if best.is_none_or(|b| e.t >= b.t) {
                        best = Some(e);
                    }
                }
            }
            if let Some(e) = best {
                let (before, matched, after) = snippet(e, words[0]);
                hits.push(Hit { session_id: fi.session.clone(), uuid: e.u.clone(), role: if e.r == 0 { "user" } else { "assistant" }, at: e.t.clone(), before, matched, after, count });
            }
        }
        hits.sort_by(|a, b| b.at.cmp(&a.at));
        hits.truncate(limit);
        hits
    }

    /// Every matching message of one session, oldest first (the chat's Find steps through them).
    fn in_session(&self, session: &str, query: &str) -> Vec<String> {
        let q = lower(query.trim());
        let words: Vec<&str> = q.split_whitespace().collect();
        if words.is_empty() {
            return Vec::new();
        }
        self.files.values().filter(|f| f.session == session).flat_map(|f| f.entries.iter()).filter(|e| words.iter().all(|w| e.l.contains(w))).map(|e| e.u.clone()).collect()
    }
}

/// About 60 characters before the match and 120 after it, on one line.
fn snippet(e: &Entry, word: &str) -> (String, String, String) {
    let flat = |s: String| s.chars().map(|c| if c.is_whitespace() { ' ' } else { c }).collect::<String>();
    let Some(byte) = e.l.find(word) else { return (String::new(), String::new(), flat(e.x.chars().take(160).collect())) };
    let start = e.l[..byte].chars().count();
    let len = word.chars().count();
    let chars: Vec<char> = e.x.chars().collect();
    let from = start.saturating_sub(60);
    let to = (start + len + 120).min(chars.len());
    let mut before: String = chars[from..start.min(chars.len())].iter().collect();
    if from > 0 {
        before = format!("…{}", before.trim_start());
    }
    let matched: String = chars[start.min(chars.len())..(start + len).min(chars.len())].iter().collect();
    let mut after: String = chars[(start + len).min(chars.len())..to].iter().collect();
    if to < chars.len() {
        after.push('…');
    }
    (flat(before), flat(matched), flat(after))
}

impl Search {
    /// Build or update the index (the first time reads every transcript once: seconds).
    pub fn warm(&self) {
        let mut idx = self.0.lock().unwrap();
        idx.refresh();
        idx.save();
    }

    pub fn query(&self, query: &str, limit: usize) -> Vec<Hit> {
        let mut idx = self.0.lock().unwrap();
        idx.refresh();
        let hits = idx.search(query, limit);
        idx.save();
        hits
    }

    pub fn in_session(&self, session: &str, query: &str) -> Vec<String> {
        let mut idx = self.0.lock().unwrap();
        idx.refresh();
        idx.in_session(session, query)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn indexes_the_conversation_only() {
        let lines = [
            r#"{"type":"user","uuid":"u1","timestamp":"2026-11-01T10:00:00Z","message":{"role":"user","content":"Почини поиск сессий"}}"#,
            r#"{"type":"user","uuid":"u2","timestamp":"2026-11-01T10:00:01Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"секрет вывода"}]}}"#,
            r#"{"type":"assistant","uuid":"a1","timestamp":"2026-11-01T10:00:02Z","message":{"role":"assistant","model":"claude-opus-5-5","content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"Search now finds OLD sessions."}]}}"#,
            r#"{"type":"assistant","uuid":"a2","timestamp":"2026-11-01T10:00:03Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{}}]}}"#,
            r#"{"type":"attachment","uuid":"q1","timestamp":"2026-11-01T10:00:04Z","attachment":{"type":"queued_command","prompt":"and keep it fast","origin":{"kind":"human"}}}"#,
        ];
        let es: Vec<Entry> = lines.iter().filter_map(|l| entry_of(format!("{l}\n").as_bytes())).collect();
        assert_eq!(es.len(), 3, "user prompt, answer text, queued message");
        assert_eq!(es[1].u, "a1:1");
        let idx = Index { version: VERSION, files: HashMap::from([("f".into(), FileIdx { session: "s1".into(), entries: es, ..Default::default() })]), ..Default::default() };
        let h = idx.search("ПОИСК сесс", 10);
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].matched, "поиск");
        assert!(idx.search("old sessions", 10)[0].uuid == "a1:1");
        assert!(idx.search("секрет", 10).is_empty(), "tool output is not indexed");
        assert_eq!(idx.in_session("s1", "fast"), vec!["q1".to_string()]);
    }
}

#[cfg(test)]
mod bench {
    use super::*;
    /// `cargo test --lib real_index -- --ignored --nocapture`: builds the index over this computer's
    /// transcripts (read only, nothing saved) and times a few searches.
    #[test]
    #[ignore]
    fn real_index() {
        let mut idx = Index { loaded: true, version: VERSION, ..Default::default() };
        let t = std::time::Instant::now();
        idx.refresh();
        let n: usize = idx.files.values().map(|f| f.entries.len()).sum();
        let bytes: usize = idx.files.values().flat_map(|f| f.entries.iter()).map(|e| e.x.len() * 2).sum();
        println!("files {} entries {} ~{} MB in memory, built in {:?}", idx.files.len(), n, bytes / 1_000_000, t.elapsed());
        for q in ["session", "поиск", "tauri build", "xyzzy-nothing"] {
            let t = std::time::Instant::now();
            let h = idx.search(q, 40);
            println!("{q:?}: {} sessions in {:?}; first: {:?}", h.len(), t.elapsed(), h.first().map(|h| format!("{}|{}|{}", h.before, h.matched, h.after)));
        }
        let t = std::time::Instant::now();
        idx.refresh();
        println!("second refresh (nothing changed) {:?}", t.elapsed());
    }
}
