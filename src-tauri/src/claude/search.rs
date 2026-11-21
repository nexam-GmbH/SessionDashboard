//! Full-text search over every session's conversation: what you typed and what Claude answered
//! (tool output, thinking and pictures left out, as the chat's own Find does). A transcript is
//! hundreds of MB of tool results and request blobs around a few hundred KB of conversation, so the
//! text is pulled out once into an index on disk (~/.config/session-dashboard/search.db, SQLite);
//! after that only what was appended to a file since the last look is read.
//!
//! The index is an FTS5 table of trigrams (every three characters of the lowercase text, any script
//! alike: Cyrillic, umlauts, CJK). A query word's trigrams find the messages that may have it, and
//! the text itself decides, so matching stays what it always was: every word of the query a
//! lowercase substring of one message (also in the middle of a word). A two-letter word (what you
//! have typed when the search starts) is every trigram that begins with it; a single letter is
//! checked on the text alone. Nothing is kept in memory but the list of files read and SQLite's
//! small page cache; opening the index is a few milliseconds.

use rusqlite::{Connection, ErrorCode, params};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, UNIX_EPOCH};

use super::discover::{claude_dirs, memfind, user_text};

/// The index's layout (SQLite `user_version`); another number: built again from the transcripts.
const SCHEMA: i32 = 2;
/// a message longer than this is indexed by its start (a huge paste)
const MAX_TEXT: usize = 6000;
/// a long word asks the index for this many of its trigrams at most (the text decides anyway)
const MAX_GRAMS: usize = 8;
/// a two-letter word with more trigrams than this is checked on the text alone
const MAX_TERMS: usize = 2000;
/// how long a search waits for the index to catch up; more than that goes on in the background
const QUERY_BUDGET: Duration = Duration::from_millis(800);

const CREATE: &str = "
CREATE TABLE files(id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, session TEXT NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL, offset INTEGER NOT NULL);
CREATE TABLE entries(id INTEGER PRIMARY KEY, file INTEGER NOT NULL, u TEXT NOT NULL, r INTEGER NOT NULL, t TEXT NOT NULL, x TEXT NOT NULL);
CREATE INDEX entries_file ON entries(file);
CREATE VIRTUAL TABLE grams USING fts5(l, content='', contentless_delete=1, detail=none, tokenize='trigram case_sensitive 1');
CREATE VIRTUAL TABLE grams_terms USING fts5vocab(grams, row);
";

struct Entry {
    /// record uuid (the chat's item id: a user message's id, an answer's `uuid:i`)
    u: String,
    /// 0 = you, 1 = Claude
    r: u8,
    /// timestamp (ISO)
    t: String,
    x: String,
}

#[derive(Clone)]
struct FileState {
    id: i64,
    session: String,
    size: u64,
    mtime: u64,
    /// bytes read so far (complete lines only)
    offset: u64,
}

/// A transcript as it is on disk now.
struct OnDisk {
    key: String,
    path: PathBuf,
    session: String,
    size: u64,
    mtime: u64,
}

/// A transcript to read: from `start`, over what the index had (`prev`: its offset then).
struct Todo {
    file: OnDisk,
    start: u64,
    prev: Option<u64>,
}

struct Index {
    path: PathBuf,
    /// the JSON index of earlier versions, deleted once this one is open
    legacy: Option<PathBuf>,
    db: Option<Connection>,
    /// every transcript read so far, by path (a few hundred small records)
    files: HashMap<String, FileState>,
}

#[derive(Clone)]
pub struct Search {
    idx: Arc<Mutex<Index>>,
    /// the whole index being brought up to date in the background (searches don't wait for it)
    building: Arc<AtomicBool>,
    /// the config folders to look in (None: Claude's, as discover finds them)
    dirs: Option<Arc<Vec<PathBuf>>>,
}

impl Default for Search {
    fn default() -> Self {
        let dir = crate::sys::config_dir();
        Search::new(dir.join("search.db"), Some(dir.join("search-index.json")), None)
    }
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
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
    let mut out = String::new();
    lower_into(s, &mut out);
    out
}

/// `lower` into a buffer used again: a search lowercases every message the index proposes, so
/// plain ASCII (most of it) is lowercased as bytes.
fn lower_into(s: &str, out: &mut String) {
    out.clear();
    if s.is_ascii() {
        out.push_str(s);
        out.make_ascii_lowercase();
        return;
    }
    out.reserve(s.len());
    for c in s.chars() {
        out.push(if c.is_ascii() { c.to_ascii_lowercase() } else { c.to_lowercase().next().unwrap_or(c) });
    }
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
    Some(Entry { u: id, r, t: at, x: cap(&text) })
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

/// Every transcript in the config folders' projects.
fn walk(dirs: &[PathBuf]) -> Vec<OnDisk> {
    let mut out = Vec::new();
    for dir in dirs {
        let Ok(projects) = std::fs::read_dir(dir.join("projects")) else { continue };
        for p in projects.flatten() {
            let Ok(files) = std::fs::read_dir(p.path()) else { continue };
            for f in files.flatten() {
                let path = f.path();
                // a transcript copied to another account for a move is not a session of its own (yet)
                if path.extension().and_then(|e| e.to_str()) != Some("jsonl") || super::accounts::is_copy(&path) {
                    continue;
                }
                let Ok(md) = f.metadata() else { continue };
                let key = path.to_string_lossy().to_string();
                let session = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
                out.push(OnDisk { key, path, session, size: md.len(), mtime: mtime_of(&md) });
            }
        }
    }
    out
}

fn open_db(path: &Path) -> rusqlite::Result<Connection> {
    let c = Connection::open(path)?;
    c.busy_timeout(Duration::from_secs(5))?;
    c.query_row("PRAGMA journal_mode=WAL", [], |_| Ok(()))?;
    // the page cache is all the memory the index takes: 2 MB
    c.execute_batch("PRAGMA synchronous=NORMAL; PRAGMA cache_size=-2000;")?;
    let v: i32 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if v != SCHEMA {
        c.execute_batch(&format!("BEGIN; DROP TABLE IF EXISTS grams_terms; DROP TABLE IF EXISTS grams; DROP TABLE IF EXISTS entries; DROP TABLE IF EXISTS files; {CREATE} PRAGMA user_version={SCHEMA}; COMMIT;"))?;
    }
    Ok(c)
}

fn load_files(c: &Connection) -> rusqlite::Result<HashMap<String, FileState>> {
    let mut st = c.prepare("SELECT id, path, session, size, mtime, offset FROM files")?;
    let rows = st.query_map([], |r| Ok((r.get::<_, String>(1)?, FileState { id: r.get(0)?, session: r.get(2)?, size: r.get::<_, i64>(3)? as u64, mtime: r.get::<_, i64>(4)? as u64, offset: r.get::<_, i64>(5)? as u64 })))?;
    rows.collect()
}

/// Take a transcript's messages out of the index.
fn clear_file(c: &Connection, id: i64) -> rusqlite::Result<()> {
    c.execute("DELETE FROM grams WHERE rowid IN (SELECT id FROM entries WHERE file = ?1)", [id])?;
    c.execute("DELETE FROM entries WHERE file = ?1", [id])?;
    Ok(())
}

fn remove_files(db: &mut Connection, ids: &[i64]) -> rusqlite::Result<()> {
    let tx = db.transaction()?;
    for id in ids {
        clear_file(&tx, *id)?;
        tx.execute("DELETE FROM files WHERE id = ?1", [id])?;
    }
    tx.commit()
}

/// Add what was read of a transcript, in one transaction with its new offset.
fn write_file(db: &mut Connection, cur: Option<&FileState>, todo: &Todo, entries: &[Entry], end: u64) -> rusqlite::Result<FileState> {
    let f = &todo.file;
    let tx = db.transaction()?;
    let id = match cur {
        Some(c) => {
            // rewritten (shorter than what was read): read again from the start
            if todo.start == 0 && c.offset > 0 {
                clear_file(&tx, c.id)?;
            }
            c.id
        }
        None => {
            tx.execute("INSERT INTO files(path, session, size, mtime, offset) VALUES (?1, ?2, 0, 0, 0)", params![f.key, f.session])?;
            tx.last_insert_rowid()
        }
    };
    {
        let mut ins = tx.prepare_cached("INSERT INTO entries(file, u, r, t, x) VALUES (?1, ?2, ?3, ?4, ?5)")?;
        let mut gram = tx.prepare_cached("INSERT INTO grams(rowid, l) VALUES (?1, ?2)")?;
        for e in entries {
            let row = ins.insert(params![id, e.u, e.r, e.t, e.x])?;
            // a newline after the text: a two-letter word at its very end starts a trigram too
            let mut l = lower(&e.x);
            l.push('\n');
            gram.execute(params![row, l])?;
        }
    }
    tx.execute("UPDATE files SET size = ?2, mtime = ?3, offset = ?4 WHERE id = ?1", params![id, f.size as i64, f.mtime as i64, end as i64])?;
    tx.commit()?;
    Ok(FileState { id, session: f.session.clone(), size: f.size, mtime: f.mtime, offset: end })
}

/// How a search finds its messages.
enum Plan {
    /// a word is in no message
    Nothing,
    /// no word the index can narrow down (single letters): every message
    Scan,
    /// the messages that match this index query; `exact`: all of them have every word
    Match { expr: String, exact: bool },
}

/// The index query for messages that may have every word: a long word's trigrams (some of them), a
/// three-letter word's one, any trigram a two-letter word begins.
fn query_plan(db: &Connection, words: &[&str]) -> rusqlite::Result<Plan> {
    let quote = |g: &str| format!("\"{}\"", g.replace('"', "\"\""));
    let mut parts: Vec<String> = Vec::new();
    let mut exact = true;
    for w in words {
        let c: Vec<char> = w.chars().collect();
        match c.len() {
            0 | 1 => exact = false,
            2 => {
                let mut st = db.prepare_cached("SELECT term FROM grams_terms WHERE term >= ?1 AND term <= ?2")?;
                let terms = st.query_map(params![w, format!("{w}\u{10FFFF}")], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
                if terms.is_empty() {
                    return Ok(Plan::Nothing);
                }
                if terms.len() > MAX_TERMS {
                    exact = false;
                    continue;
                }
                parts.push(format!("({})", terms.iter().map(|t| quote(t)).collect::<Vec<_>>().join(" OR ")));
            }
            len => {
                let n = len - 2;
                // a longer word: messages with these trigrams may still not have it in one piece
                exact &= n == 1;
                let take = n.min(MAX_GRAMS);
                for k in 0..take {
                    let i = if take == 1 { 0 } else { k * (n - 1) / (take - 1) };
                    let g = quote(&c[i..i + 3].iter().collect::<String>());
                    if !parts.contains(&g) {
                        parts.push(g);
                    }
                }
            }
        }
    }
    Ok(if parts.is_empty() { Plan::Scan } else { Plan::Match { expr: parts.join(" AND "), exact } })
}

/// The newest matching message of a transcript, and how many match.
#[derive(Default)]
struct Best {
    count: usize,
    id: i64,
    t: String,
}

impl Index {
    fn open(&mut self) {
        if self.db.is_some() {
            return;
        }
        if let Some(d) = self.path.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let c = match open_db(&self.path).and_then(|c| load_files(&c).map(|f| (c, f))) {
            Ok(x) => Some(x),
            Err(e) => {
                log::warn!("search index {}: {e}; starting a new one", self.path.display());
                self.delete_files();
                match open_db(&self.path).and_then(|c| load_files(&c).map(|f| (c, f))) {
                    Ok(x) => Some(x),
                    Err(e) => {
                        log::warn!("search index {}: {e}; kept in memory this time", self.path.display());
                        open_db(Path::new(":memory:")).ok().map(|c| (c, HashMap::new()))
                    }
                }
            }
        };
        if let Some((c, files)) = c {
            self.db = Some(c);
            self.files = files;
        }
        // the whole-index JSON of earlier versions: this one is built from the transcripts instead
        if let Some(old) = self.legacy.take() {
            let _ = std::fs::remove_file(old.with_extension("json.tmp"));
            let _ = std::fs::remove_file(old);
        }
    }

    fn delete_files(&self) {
        for ext in ["", "-wal", "-shm"] {
            let mut p = self.path.clone().into_os_string();
            p.push(ext);
            let _ = std::fs::remove_file(p);
        }
    }

    /// A write or read failed: a damaged index is started again (the transcripts have it all).
    fn failed(&mut self, e: rusqlite::Error) {
        log::warn!("search index: {e}");
        if let rusqlite::Error::SqliteFailure(f, _) = &e {
            if matches!(f.code, ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase) {
                self.db = None;
                self.files.clear();
                self.delete_files();
            }
        }
    }

    /// What to read to be up to date with `disk`; transcripts no longer there are taken out now.
    fn to_read(&mut self, disk: Vec<OnDisk>) -> Vec<Todo> {
        self.open();
        let Some(db) = self.db.as_mut() else { return Vec::new() };
        let present: HashSet<&str> = disk.iter().map(|d| d.key.as_str()).collect();
        let gone: Vec<(String, i64)> = self.files.iter().filter(|(k, _)| !present.contains(k.as_str())).map(|(k, f)| (k.clone(), f.id)).collect();
        if !gone.is_empty() {
            match remove_files(db, &gone.iter().map(|g| g.1).collect::<Vec<_>>()) {
                Ok(()) => gone.iter().for_each(|(k, _)| drop(self.files.remove(k))),
                Err(e) => {
                    self.failed(e);
                    return Vec::new();
                }
            }
        }
        let mut todo: Vec<Todo> = disk
            .into_iter()
            .filter_map(|d| {
                let cur = self.files.get(&d.key);
                if cur.is_some_and(|c| c.size == d.size && c.mtime == d.mtime) {
                    return None;
                }
                // grown: read only what was appended; shorter (rewritten): read it again
                let (start, prev) = match cur {
                    Some(c) if d.size >= c.offset => (c.offset, Some(c.offset)),
                    Some(c) => (0, Some(c.offset)),
                    None => (0, None),
                };
                Some(Todo { file: d, start, prev })
            })
            .collect();
        // the newest first: while the index is built, the sessions you last worked in are found first
        todo.sort_by(|a, b| b.file.mtime.cmp(&a.file.mtime));
        todo
    }

    /// Put what was read into the index, unless another refresh got there first.
    fn apply(&mut self, todo: &Todo, entries: &[Entry], end: u64) {
        let cur = self.files.get(&todo.file.key).cloned();
        if cur.as_ref().map(|c| c.offset) != todo.prev {
            return;
        }
        let Some(db) = self.db.as_mut() else { return };
        match write_file(db, cur.as_ref(), todo, entries, end) {
            Ok(st) => {
                self.files.insert(todo.file.key.clone(), st);
            }
            Err(e) => self.failed(e),
        }
    }

    fn search(&mut self, query: &str, limit: usize) -> Vec<Hit> {
        let q = lower(query.trim());
        let words: Vec<&str> = q.split_whitespace().collect();
        if words.is_empty() {
            return Vec::new();
        }
        self.open();
        let Some(db) = self.db.as_ref() else { return Vec::new() };
        let sessions: HashMap<i64, &str> = self.files.values().map(|f| (f.id, f.session.as_str())).collect();
        let run = || -> rusqlite::Result<Vec<Hit>> {
            let mut best: HashMap<i64, Best> = HashMap::new();
            let (sql, expr, exact) = match query_plan(db, &words)? {
                Plan::Nothing => return Ok(Vec::new()),
                Plan::Scan => ("SELECT id, file, t, x FROM entries ORDER BY id", None, false),
                // the index alone answers: the text is read only for the snippets
                Plan::Match { expr, exact: true } => ("SELECT e.id, e.file, e.t FROM grams JOIN entries e ON e.id = grams.rowid WHERE grams MATCH ?1 ORDER BY grams.rowid", Some(expr), true),
                Plan::Match { expr, exact: false } => ("SELECT e.id, e.file, e.t, e.x FROM grams JOIN entries e ON e.id = grams.rowid WHERE grams MATCH ?1 ORDER BY grams.rowid", Some(expr), false),
            };
            let mut st = db.prepare_cached(sql)?;
            let mut rows = match &expr {
                Some(q) => st.query([q])?,
                None => st.query([])?,
            };
            let mut l = String::new();
            while let Some(row) = rows.next()? {
                if !exact {
                    lower_into(row.get_ref(3)?.as_str()?, &mut l);
                    if !words.iter().all(|w| l.contains(w)) {
                        continue;
                    }
                }
                let t = row.get_ref(2)?.as_str()?;
                let b = best.entry(row.get(1)?).or_default();
                b.count += 1;
                // the newest match stands for the session
                if b.count == 1 || t >= b.t.as_str() {
                    b.id = row.get(0)?;
                    b.t = t.to_string();
                }
            }
            let mut best: Vec<(i64, Best)> = best.into_iter().filter(|(file, _)| sessions.contains_key(file)).collect();
            best.sort_by(|a, b| b.1.t.cmp(&a.1.t));
            best.truncate(limit);
            let mut one = db.prepare_cached("SELECT u, r, x FROM entries WHERE id = ?1")?;
            best.into_iter()
                .map(|(file, b)| {
                    let (u, r, x) = one.query_row([b.id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, u8>(1)?, row.get::<_, String>(2)?)))?;
                    let (before, matched, after) = snippet(&lower(&x), &x, words[0]);
                    Ok(Hit { session_id: sessions[&file].to_string(), uuid: u, role: if r == 0 { "user" } else { "assistant" }, at: b.t, before, matched, after, count: b.count })
                })
                .collect()
        };
        match run() {
            Ok(h) => h,
            Err(e) => {
                self.failed(e);
                Vec::new()
            }
        }
    }

    /// Every matching message of one session, oldest first (the chat's Find steps through them).
    fn in_session(&mut self, session: &str, query: &str) -> Vec<String> {
        let q = lower(query.trim());
        let words: Vec<&str> = q.split_whitespace().collect();
        if words.is_empty() {
            return Vec::new();
        }
        self.open();
        let Some(db) = self.db.as_ref() else { return Vec::new() };
        let scan = || -> rusqlite::Result<Vec<String>> {
            let mut st = db.prepare_cached("SELECT e.u, e.x FROM entries e JOIN files f ON f.id = e.file WHERE f.session = ?1 ORDER BY e.id")?;
            let mut rows = st.query([session])?;
            let mut out = Vec::new();
            let mut l = String::new();
            while let Some(row) = rows.next()? {
                lower_into(row.get_ref(1)?.as_str()?, &mut l);
                if words.iter().all(|w| l.contains(w)) {
                    out.push(row.get(0)?);
                }
            }
            Ok(out)
        };
        match scan() {
            Ok(v) => v,
            Err(e) => {
                self.failed(e);
                Vec::new()
            }
        }
    }
}

/// About 60 characters before the match and 120 after it, on one line.
fn snippet(l: &str, x: &str, word: &str) -> (String, String, String) {
    let flat = |s: String| s.chars().map(|c| if c.is_whitespace() { ' ' } else { c }).collect::<String>();
    let Some(byte) = l.find(word) else { return (String::new(), String::new(), flat(x.chars().take(160).collect())) };
    let start = l[..byte].chars().count();
    let len = word.chars().count();
    let chars: Vec<char> = x.chars().collect();
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
    fn new(path: PathBuf, legacy: Option<PathBuf>, dirs: Option<Vec<PathBuf>>) -> Self {
        Search { idx: Arc::new(Mutex::new(Index { path, legacy, db: None, files: HashMap::new() })), building: Arc::default(), dirs: dirs.map(Arc::new) }
    }

    fn lock(&self) -> MutexGuard<'_, Index> {
        self.idx.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Bring the index up to date with the transcripts on disk (new, grown, rewritten, deleted),
    /// one transcript at a time: searches go on between them. `budget`: stop after about that long
    /// (the rest is read the next time). True when everything was read.
    fn refresh(&self, budget: Option<Duration>) -> bool {
        let began = Instant::now();
        let disk = match &self.dirs {
            Some(d) => walk(d),
            None => walk(&claude_dirs()),
        };
        let todo = self.lock().to_read(disk);
        for t in &todo {
            if budget.is_some_and(|b| began.elapsed() > b) {
                return false;
            }
            // read without holding the index: a big transcript takes a while
            let mut entries = Vec::new();
            let Ok(end) = read_from(&t.file.path, t.start, &mut entries) else { continue };
            self.lock().apply(t, &entries, end);
        }
        true
    }

    /// Build or update the index (the first time reads every transcript once: seconds).
    pub fn warm(&self) {
        if self.building.swap(true, Ordering::SeqCst) {
            return;
        }
        self.refresh(None);
        self.building.store(false, Ordering::SeqCst);
    }

    /// Before a search: what was appended since the last look. While the whole index is being
    /// built the search takes what is there so far; a long catch-up goes on in the background.
    fn catch_up(&self) {
        if self.building.load(Ordering::SeqCst) {
            return;
        }
        if !self.refresh(Some(QUERY_BUDGET)) {
            let s = self.clone();
            std::thread::spawn(move || s.warm());
        }
    }

    pub fn query(&self, query: &str, limit: usize) -> Vec<Hit> {
        self.catch_up();
        self.lock().search(query, limit)
    }

    pub fn in_session(&self, session: &str, query: &str) -> Vec<String> {
        self.catch_up();
        self.lock().in_session(session, query)
    }
}

/// The search before the SQLite index (every message in memory, every word a lowercase
/// substring), kept to check that the index finds the same.
#[cfg(test)]
mod legacy {
    use super::*;

    pub struct Transcript {
        pub session: String,
        pub entries: Vec<(Entry, String)>,
    }

    /// The lowercase it used, one char at a time.
    pub fn lower(s: &str) -> String {
        s.chars().map(|c| c.to_lowercase().next().unwrap_or(c)).collect()
    }

    /// A transcript's messages in its first `upto` bytes (all of it: None).
    pub fn read(path: &Path, session: &str, upto: Option<u64>) -> Transcript {
        let mut es = Vec::new();
        if let Ok(f) = File::open(path) {
            let mut r = BufReader::new(std::io::Read::take(f, upto.unwrap_or(u64::MAX)));
            let mut buf = Vec::new();
            while r.read_until(b'\n', &mut buf).is_ok_and(|n| n > 0) && buf.last() == Some(&b'\n') {
                es.extend(entry_of(&buf));
                buf.clear();
            }
        }
        Transcript { session: session.to_string(), entries: es.into_iter().map(|e| { let l = lower(&e.x); (e, l) }).collect() }
    }

    pub fn search(files: &[Transcript], query: &str, limit: usize) -> Vec<Hit> {
        let q = lower(query.trim());
        let words: Vec<&str> = q.split_whitespace().collect();
        if words.is_empty() {
            return Vec::new();
        }
        let mut hits: Vec<Hit> = Vec::new();
        for fi in files {
            let mut count = 0usize;
            let mut best: Option<&(Entry, String)> = None;
            for e in &fi.entries {
                if words.iter().all(|w| e.1.contains(w)) {
                    count += 1;
                    if best.is_none_or(|b| e.0.t >= b.0.t) {
                        best = Some(e);
                    }
                }
            }
            if let Some((e, l)) = best {
                let (before, matched, after) = snippet(l, &e.x, words[0]);
                hits.push(Hit { session_id: fi.session.clone(), uuid: e.u.clone(), role: if e.r == 0 { "user" } else { "assistant" }, at: e.t.clone(), before, matched, after, count });
            }
        }
        hits.sort_by(|a, b| b.at.cmp(&a.at));
        hits.truncate(limit);
        hits
    }

    pub fn in_session(files: &[Transcript], session: &str, query: &str) -> Vec<String> {
        let q = lower(query.trim());
        let words: Vec<&str> = q.split_whitespace().collect();
        if words.is_empty() {
            return Vec::new();
        }
        files.iter().filter(|f| f.session == session).flat_map(|f| f.entries.iter()).filter(|e| words.iter().all(|w| e.1.contains(w))).map(|e| e.0.u.clone()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sd-search-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("claude/projects/p1")).unwrap();
        d
    }

    fn user(uuid: &str, ts: &str, text: &str) -> String {
        serde_json::json!({"type": "user", "uuid": uuid, "timestamp": ts, "message": {"role": "user", "content": text}}).to_string()
    }

    fn answer(uuid: &str, ts: &str, text: &str) -> String {
        serde_json::json!({"type": "assistant", "uuid": uuid, "timestamp": ts, "message": {"role": "assistant", "model": "claude-opus-5-5", "content": [{"type": "text", "text": text}]}}).to_string()
    }

    fn append(path: &Path, lines: &[String]) {
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
    }

    fn search_at(root: &Path) -> Search {
        Search::new(root.join("search.db"), Some(root.join("search-index.json")), Some(vec![root.join("claude")]))
    }

    /// Hits in a fixed order (sessions with the same newest time come in any order).
    fn sorted(mut h: Vec<Hit>) -> Vec<Hit> {
        h.sort();
        h
    }

    #[test]
    fn indexes_the_conversation_only() {
        let root = tmp("conv");
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
        append(&root.join("claude/projects/p1/s1.jsonl"), &lines.map(String::from));
        let s = search_at(&root);
        let h = s.query("ПОИСК сесс", 10);
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].matched, "поиск");
        assert_eq!(h[0].session_id, "s1");
        assert!(s.query("old sessions", 10)[0].uuid == "a1:1");
        assert!(s.query("секрет", 10).is_empty(), "tool output is not indexed");
        assert_eq!(s.in_session("s1", "fast"), vec!["q1".to_string()]);
        let _ = std::fs::remove_dir_all(root);
    }

    /// A made-up corpus in Russian, German and English: the index finds exactly what the old
    /// in-memory search found, snippets and counts included.
    #[test]
    fn finds_what_the_old_search_found() {
        let root = tmp("corpus");
        let words = [
            "поиск", "Поиск", "ПОИСКОВЫЙ", "сессия", "сессии", "Сессий", "ёлка", "Ёж", "работает", "быстро", "индекс", "файл", "починить", "Straße", "STRASSE", "über", "Übersicht", "Größe", "Prüfung", "Suche", "schnell", "Maße", "Übersichtlichkeitsprüfung", "session", "Session", "SESSIONS", "search", "tauri", "build", "Tauri-build", "rebuild", "index", "dashboard", "terminal", "ok", "a", "go", "🙂", "\"quoted\"", "`code`", "x", "is", "the",
        ];
        let seps = [" ", " ", " ", ", ", ". ", "\n", "! ", " — "];
        let mut seed = 0x2545F4914F6CDD1Du64;
        let mut rnd = move |n: usize| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed % n as u64) as usize
        };
        for s in 0..12 {
            let mut lines = Vec::new();
            for m in 0..60 {
                let len = 1 + rnd(30);
                let mut text = String::new();
                for _ in 0..len {
                    text.push_str(words[rnd(words.len())]);
                    text.push_str(seps[rnd(seps.len())]);
                }
                // some messages at the same second, so the newest-match rule is tested on ties
                let ts = format!("2026-11-{:02}T10:{:02}:{:02}Z", 1 + s, m / 2, rnd(3));
                let id = format!("m{s}-{m}");
                lines.push(if m % 2 == 0 { user(&id, &ts, &text) } else { answer(&id, &ts, &text) });
            }
            append(&root.join(format!("claude/projects/p1/s{s}.jsonl")), &lines);
        }
        let new = search_at(&root);
        new.warm();
        let old: Vec<legacy::Transcript> = (0..12).map(|s| legacy::read(&root.join(format!("claude/projects/p1/s{s}.jsonl")), &format!("s{s}"), None)).collect();
        let queries = [
            "поиск", "ПОИСК сесс", "сессии", "сесс", "оиск", "ёлка", "ЁЖ", "ёж быстро", "straße", "STRASSE", "über", "ÜBER", "größe", "prüf", "übersichtlichkeitsprüfung", "session", "Session", "sessions", "tauri build", "tauri-build", "uild", "ash", "board", "ok", "a", "go ok", "x is", "🙂", "\"quoted\"", "`code`", "xyzzy", "поиск xyzzy", "ss", "e", "s, t", "the session поиск über", "по", "üb", "ße", "ok go", "a ok", "-b", "ё", "zq", "ok zq", "is the",
        ];
        for q in queries {
            let a = sorted(legacy::search(&old, q, 1000));
            let b = sorted(new.query(q, 1000));
            assert_eq!(a, b, "query {q:?}");
            // the first 5 by time: same times (equal ones may swap)
            let at = |h: Vec<Hit>| h.into_iter().map(|h| h.at).collect::<Vec<_>>();
            assert_eq!(at(legacy::search(&old, q, 5)), at(new.query(q, 5)), "query {q:?}, limit 5");
            for s in ["s0", "s7"] {
                assert_eq!(legacy::in_session(&old, s, q), new.in_session(s, q), "in {s}: {q:?}");
            }
        }
        assert!(!new.query("поиск", 100).is_empty() && !new.query("über", 100).is_empty() && !new.query("tauri build", 100).is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    /// A running session's new lines are found on the next search without reading the rest again;
    /// a rewritten transcript is read again, a deleted one leaves the results; a restart opens the
    /// index as it was and the old JSON index is gone.
    #[test]
    fn follows_the_transcripts() {
        let root = tmp("follow");
        std::fs::write(root.join("search-index.json"), "{}").unwrap();
        let a = root.join("claude/projects/p1/a.jsonl");
        let b = root.join("claude/projects/p1/b.jsonl");
        append(&a, &[user("a1", "2026-11-01T10:00:00Z", "Почини поиск"), answer("a2", "2026-11-01T10:00:01Z", "Ich repariere die Suche")]);
        append(&b, &[user("b1", "2026-11-02T10:00:00Z", "tauri build fails")]);
        let s = search_at(&root);
        assert_eq!(s.query("поиск", 10).len(), 1);
        assert!(!root.join("search-index.json").exists(), "the old index is deleted");

        // a half-written line waits for its end
        append(&a, &[answer("a3", "2026-11-01T10:00:02Z", "Готово: поиск работает")]);
        std::fs::OpenOptions::new().append(true).open(&a).unwrap().write_all(br#"{"type":"user","uuid":"a4","#).unwrap();
        let before = s.lock().files[&a.to_string_lossy().to_string()].offset;
        let h = s.query("поиск", 10);
        assert_eq!((h[0].uuid.as_str(), h[0].count), ("a3:0", 2), "the appended line is found");
        let after = s.lock().files[&a.to_string_lossy().to_string()].offset;
        assert!(after > before && after < std::fs::metadata(&a).unwrap().len(), "only complete lines are read");
        std::fs::OpenOptions::new().append(true).open(&a).unwrap().write_all(format!("{}\n", r#""timestamp":"2026-11-01T10:00:03Z","message":{"role":"user","content":"noch ein Suchtest"}}"#).as_bytes()).unwrap();
        assert_eq!(s.query("suchtest", 10)[0].uuid, "a4");
        assert_eq!(s.in_session("a", "such"), vec!["a2:0".to_string(), "a4".to_string()]);

        // rewritten shorter: read again, the old messages are gone from the index
        std::fs::write(&b, format!("{}\n", user("b9", "2026-11-03T10:00:00Z", "neu"))).unwrap();
        assert!(s.query("tauri", 10).is_empty());
        assert_eq!(s.query("neu", 10)[0].uuid, "b9");

        // a restart: nothing is read again
        drop(s);
        let s = search_at(&root);
        s.lock().open();
        let disk = walk(&[root.join("claude")]);
        assert!(s.lock().to_read(disk).is_empty(), "nothing to read after a restart");
        assert_eq!(s.query("поиск", 10)[0].count, 2);

        // deleted: its session leaves the results
        std::fs::remove_file(&a).unwrap();
        assert!(s.query("поиск", 10).is_empty());
        assert!(s.in_session("a", "such").is_empty());
        let n: i64 = s.lock().db.as_ref().unwrap().query_row("SELECT count(*) FROM entries", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn lowercase_is_the_same_as_before() {
        for t in ["Plain ASCII, With CAPS 123", "Поиск ПО СЕССИЯМ, Ёлка", "Straße ÜBER Größe", "İstanbul ΣΑΣ ǅ ﬁ 🙂", "MiXeD Ünïcödé and ASCII"] {
            assert_eq!(lower(t), legacy::lower(t), "{t}");
            assert_eq!(lower(t).chars().count(), t.chars().count());
        }
    }

    /// A damaged index file is started again from the transcripts.
    #[test]
    fn a_damaged_index_is_rebuilt() {
        let root = tmp("damaged");
        append(&root.join("claude/projects/p1/a.jsonl"), &[user("a1", "2026-11-01T10:00:00Z", "Größe prüfen")]);
        std::fs::write(root.join("search.db"), vec![7u8; 8192]).unwrap();
        let s = search_at(&root);
        assert_eq!(s.query("größe", 10).len(), 1);
        let _ = std::fs::remove_dir_all(root);
    }
}

#[cfg(test)]
mod bench {
    use super::*;

    fn rss_mb() -> f64 {
        let s = std::fs::read_to_string("/proc/self/statm").unwrap_or_default();
        let pages: f64 = s.split_whitespace().nth(1).and_then(|x| x.parse().ok()).unwrap_or(0.0);
        pages * 4096.0 / 1e6
    }

    fn size_mb(p: &Path) -> f64 {
        ["", "-wal"].iter().map(|e| std::fs::metadata(format!("{}{e}", p.display())).map(|m| m.len()).unwrap_or(0)).sum::<u64>() as f64 / 1e6
    }

    const QUERIES: [&str; 10] = ["session", "поиск", "tauri build", "xyzzy-nothing", "ok", "по", "сессии", "über", "dashboard", "uild"];

    /// Where the benches keep the index they build (the app's own index is not touched).
    fn bench_db() -> PathBuf {
        std::env::temp_dir().join("sd-search-bench").join("search.db")
    }

    /// Each of these in its own process, so RSS is the bench's alone:
    /// `cargo test --release --lib claude::search::bench::real_index -- --ignored --exact --nocapture`
    /// builds the index over this computer's transcripts and checks the old in-memory search finds
    /// the same; `…::real_index_open` then opens it as the app does at start and times searches;
    /// `…::real_index_old` builds the old in-memory index for comparison.
    #[test]
    #[ignore]
    fn real_index() {
        let db = bench_db();
        let _ = std::fs::remove_dir_all(db.parent().unwrap());
        let r0 = rss_mb();
        let t = Instant::now();
        let s = Search::new(db.clone(), None, None);
        s.warm();
        let n: i64 = s.lock().db.as_ref().unwrap().query_row("SELECT count(*) FROM entries", [], |r| r.get(0)).unwrap();
        println!("built: files {} entries {n} in {:?}; RSS +{:.1} MB; on disk {:.1} MB", s.lock().files.len(), t.elapsed(), rss_mb() - r0, size_mb(&db));
        {
            let idx = s.lock();
            let c = idx.db.as_ref().unwrap();
            c.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(())).unwrap();
            let mut st = c.prepare("SELECT name, sum(pgsize) FROM dbstat GROUP BY name ORDER BY 2 DESC").unwrap();
            let parts: Vec<String> = st.query_map([], |r| Ok(format!("{} {:.1} MB", r.get::<_, String>(0)?, r.get::<_, i64>(1)? as f64 / 1e6))).unwrap().flatten().collect();
            println!("on disk after checkpoint {:.1} MB: {}", size_mb(&db), parts.join(", "));
        }
        let t = Instant::now();
        s.refresh(None);
        println!("refresh (nothing changed, or a running session's new lines) {:?}", t.elapsed());

        // the old search over exactly what the index read (transcripts grow while this runs)
        let read: Vec<(PathBuf, String, u64)> = s.lock().files.iter().map(|(k, f)| (PathBuf::from(k), f.session.clone(), f.offset)).collect();
        let old: Vec<legacy::Transcript> = read.iter().map(|(p, sess, upto)| legacy::read(p, sess, Some(*upto))).collect();
        let mut idx = s.lock();
        for q in QUERIES {
            let mut a = legacy::search(&old, q, 100_000);
            a.sort();
            let mut b = idx.search(q, 100_000);
            b.sort();
            println!("{q:?}: old {} sessions, new {}; same: {}", a.len(), b.len(), a == b);
            assert_eq!(a, b, "{q:?}");
        }
    }

    #[test]
    #[ignore]
    fn real_index_open() {
        let r0 = rss_mb();
        let t = Instant::now();
        let s = Search::new(bench_db(), None, None);
        s.lock().open();
        println!("startup: open {:?}, RSS +{:.2} MB (process {:.1} MB)", t.elapsed(), rss_mb() - r0, rss_mb());
        let t = Instant::now();
        s.refresh(None);
        println!("refresh {:?}", t.elapsed());
        for q in QUERIES {
            let t = Instant::now();
            let h = s.lock().search(q, 40);
            let first = t.elapsed();
            let t = Instant::now();
            let _ = s.lock().search(q, 40);
            println!("{q:?}: {} sessions in {first:?} (again {:?}); first: {:?}", h.len(), t.elapsed(), h.first().map(|h| format!("{}|{}|{}", h.before, h.matched, h.after)));
        }
        println!("RSS after open, refresh and searches +{:.1} MB (process {:.1} MB)", rss_mb() - r0, rss_mb());
    }

    #[test]
    #[ignore]
    fn real_index_old() {
        let r0 = rss_mb();
        let t = Instant::now();
        let old: Vec<legacy::Transcript> = walk(&claude_dirs()).iter().map(|d| legacy::read(&d.path, &d.session, None)).collect();
        println!("old in-memory index: read in {:?}, RSS +{:.1} MB (process {:.1} MB)", t.elapsed(), rss_mb() - r0, rss_mb());
        for q in QUERIES {
            let t = Instant::now();
            let h = legacy::search(&old, q, 40);
            println!("old {q:?}: {} sessions in {:?}", h.len(), t.elapsed());
        }
    }
}
