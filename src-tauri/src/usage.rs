//! Usage history: tokens, requests, prompts, tool calls and sessions per hour and model, from every
//! Claude Code transcript on this computer, kept in a permanent ledger
//! (~/.config/session-dashboard/usage-ledger.json) that only grows: when Claude Code deletes old
//! transcripts (cleanupPeriodDays), what the app already counted stays. Each file is read once and
//! then only from where it was left; a request is counted once even when a resumed session copies
//! it into another file (message id + request id, like ccusage). Plus the plan's limits (5-hour and
//! weekly, shared with claude.ai), sampled into usage-limits.jsonl for the usage-over-time chart.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::File;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
pub struct Tokens {
    /// uncached input
    pub i: u64,
    /// output
    pub o: u64,
    /// cache writes (5-minute)
    pub w5: u64,
    /// cache writes (1-hour)
    pub w1: u64,
    /// cache reads
    pub r: u64,
    /// API requests
    pub n: u64,
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct Hour {
    /// per model (claude-opus-5-5, …)
    pub m: BTreeMap<String, Tokens>,
    /// prompts you typed
    pub p: u64,
    /// tool calls
    pub t: u64,
    /// sessions active this hour (indexes into Ledger::sessions)
    pub s: Vec<u32>,
    /// tokens per session and model (session index as text → model → tokens), for which session uses
    /// the plan's 5-hour window; kept for the last days only (DETAIL_DAYS)
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub sm: BTreeMap<String, BTreeMap<String, Tokens>>,
}

/// How long the per-session detail stays in the ledger.
const DETAIL_DAYS: i64 = 8;

/// Ledger format: a ledger written by an older counting is read again from the transcripts.
/// 2: a message's usage is its largest values (streamed lines repeat it with growing output).
const LEDGER_VERSION: u32 = 2;

#[derive(Serialize, Deserialize, Default)]
pub struct Ledger {
    #[serde(default)]
    pub v: u32,
    /// "YYYY-MM-DDTHH" (UTC) → that hour
    pub hours: BTreeMap<String, Hour>,
    /// session ids in the order first seen
    pub sessions: Vec<String>,
    /// 1 once the per-session detail of the last days was filled in from the transcripts
    #[serde(default)]
    pub d: u32,
}

#[derive(Serialize, Deserialize, Default)]
struct FileState {
    offset: u64,
}

#[derive(Default)]
struct Index {
    loaded: bool,
    ledger: Ledger,
    session_ix: HashMap<String, u32>,
    seen: HashSet<u64>,
    files: HashMap<String, FileState>,
    /// usage counted for recent messages: a later line of the same message (a reply is written as
    /// several lines while it streams, its output growing) adds only what grew
    recent: HashMap<u64, (String, String, Tokens, Option<u32>)>,
    recent_order: std::collections::VecDeque<u64>,
}

static INDEX: Mutex<Option<Index>> = Mutex::new(None);
static SCANNING: Mutex<()> = Mutex::new(());

fn dir() -> PathBuf {
    crate::sys::config_dir()
}

fn h64(parts: &[&str]) -> u64 {
    let mut h = DefaultHasher::new();
    for p in parts {
        p.hash(&mut h);
    }
    h.finish()
}

// ---------- what a transcript line holds (only the fields we count) ----------
#[derive(Deserialize)]
struct Usage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
    #[serde(default)]
    cache_creation: Option<CacheCreation>,
}
#[derive(Deserialize)]
struct CacheCreation {
    #[serde(default)]
    ephemeral_5m_input_tokens: u64,
    #[serde(default)]
    ephemeral_1h_input_tokens: u64,
}
#[derive(Deserialize)]
struct Msg<'a> {
    #[serde(borrow)]
    id: Option<&'a str>,
    #[serde(borrow)]
    model: Option<&'a str>,
    usage: Option<Usage>,
}
#[derive(Deserialize)]
struct Line<'a> {
    #[serde(borrow)]
    timestamp: Option<&'a str>,
    #[serde(rename = "requestId", borrow)]
    request_id: Option<&'a str>,
    #[serde(rename = "sessionId", borrow)]
    session_id: Option<&'a str>,
    #[serde(borrow)]
    uuid: Option<&'a str>,
    #[serde(rename = "isSidechain")]
    #[allow(dead_code)]
    side: Option<bool>,
    message: Option<Msg<'a>>,
}

fn find(hay: &[u8], needle: &[u8]) -> bool {
    crate::claude::discover::memfind(hay, needle)
}
fn count(hay: &[u8], needle: &[u8]) -> u64 {
    hay.windows(needle.len()).filter(|w| *w == needle).count() as u64
}

/// The string value right after `key` (`"timestamp":"…"`), without parsing the whole line (user
/// lines can be megabytes of tool output).
fn field<'a>(line: &'a [u8], key: &[u8]) -> Option<&'a str> {
    let at = line.windows(key.len()).position(|w| w == key)? + key.len();
    let end = line[at..].iter().position(|b| *b == b'"')? + at;
    std::str::from_utf8(&line[at..end]).ok()
}

impl Index {
    fn session(&mut self, id: &str) -> u32 {
        if let Some(i) = self.session_ix.get(id) {
            return *i;
        }
        let i = self.ledger.sessions.len() as u32;
        self.ledger.sessions.push(id.to_string());
        self.session_ix.insert(id.to_string(), i);
        i
    }

    fn hour(&mut self, ts: &str) -> Option<&mut Hour> {
        // "2026-11-15T13:04:05.123Z" → "2026-11-15T13"
        let key = ts.get(..13)?;
        if !key.as_bytes().get(10).is_some_and(|b| *b == b'T') {
            return None;
        }
        Some(self.ledger.hours.entry(key.to_string()).or_default())
    }

    fn mark_session(&mut self, ts: &str, sid: &str) {
        let six = self.session(sid);
        if let Some(h) = self.hour(ts) {
            if !h.s.contains(&six) {
                h.s.push(six);
            }
        }
    }

    fn line(&mut self, line: &[u8]) {
        let assistant = find(line, br#""type":"assistant""#);
        let user = !assistant && find(line, br#""type":"user""#);
        if !assistant && !user {
            return;
        }
        if user {
            // a prompt you typed: not a tool result, not a meta/command echo
            if find(line, br#""tool_use_id""#) || find(line, br#""isMeta":true"#) || find(line, br#""isSidechain":true"#) {
                return;
            }
            let (Some(ts), Some(uuid)) = (field(line, br#""timestamp":""#), field(line, br#""uuid":""#)) else { return };
            if !self.seen.insert(h64(&["p", uuid])) {
                return;
            }
            if let Some(sid) = field(line, br#""sessionId":""#) {
                self.mark_session(ts, sid);
            }
            if let Some(h) = self.hour(ts) {
                h.p += 1;
            }
            return;
        }
        let Ok(l) = serde_json::from_slice::<Line>(line) else { return };
        let Some(ts) = l.timestamp else { return };
        // tool calls: each content line once (a message's blocks come as separate lines)
        let tools = count(line, br#""type":"tool_use""#);
        if tools > 0 {
            if let Some(uuid) = l.uuid {
                if self.seen.insert(h64(&["t", uuid])) {
                    if let Some(h) = self.hour(ts) {
                        h.t += tools;
                    }
                }
            }
        }
        let Some(msg) = l.message else { return };
        let Some(u) = msg.usage else { return };
        let model = msg.model.unwrap_or("unknown");
        if model == "<synthetic>" {
            return;
        }
        let (w5, w1) = match &u.cache_creation {
            Some(c) if c.ephemeral_5m_input_tokens + c.ephemeral_1h_input_tokens > 0 => (c.ephemeral_5m_input_tokens, c.ephemeral_1h_input_tokens),
            // no split recorded: Claude Code writes its prompt cache for an hour
            _ => (0, u.cache_creation_input_tokens),
        };
        let now = Tokens { i: u.input_tokens, o: u.output_tokens, w5, w1, r: u.cache_read_input_tokens, n: 1 };
        // one message, one request: its blocks come as separate lines that repeat the usage, the
        // output growing while it streams; count the largest values once
        let key = h64(&["u", msg.id.unwrap_or(""), l.request_id.unwrap_or(l.uuid.unwrap_or(""))]);
        if !self.seen.insert(key) {
            let Some((hour, m, counted, six)) = self.recent.get_mut(&key) else { return };
            // cache writes grow by their total (a line may lack the 5-minute/1-hour split)
            let w_grow = (now.w5 + now.w1).saturating_sub(counted.w5 + counted.w1);
            let grow = Tokens {
                i: now.i.saturating_sub(counted.i),
                o: now.o.saturating_sub(counted.o),
                w5: 0,
                w1: w_grow,
                r: now.r.saturating_sub(counted.r),
                n: 0,
            };
            if grow == Tokens::default() {
                return;
            }
            counted.i = counted.i.max(now.i);
            counted.o = counted.o.max(now.o);
            counted.w1 += w_grow;
            counted.r = counted.r.max(now.r);
            let (hour, m, six) = (hour.clone(), m.clone(), *six);
            if let Some(h) = self.ledger.hours.get_mut(&hour) {
                if let Some(t) = h.m.get_mut(&m) {
                    add(t, &grow);
                }
                if let Some(t) = six.and_then(|i| h.sm.get_mut(&i.to_string())).and_then(|x| x.get_mut(&m)) {
                    add(t, &grow);
                }
            }
            return;
        }
        let six = l.session_id.map(|sid| {
            self.mark_session(ts, sid);
            self.session(sid)
        });
        let Some(hk) = ts.get(..13).map(str::to_string) else { return };
        let Some(h) = self.hour(ts) else { return };
        add(h.m.entry(model.to_string()).or_default(), &now);
        if let Some(i) = six {
            add(h.sm.entry(i.to_string()).or_default().entry(model.to_string()).or_default(), &now);
        }
        self.recent.insert(key, (hk, model.to_string(), now, six));
        self.recent_order.push_back(key);
        if self.recent_order.len() > 4096 {
            if let Some(old) = self.recent_order.pop_front() {
                self.recent.remove(&old);
            }
        }
    }

    /// Read what a file gained since last time (all of it the first time).
    /// Read what a transcript gained; true when there was something.
    fn file(&mut self, path: &Path) -> bool {
        let key = path.to_string_lossy().to_string();
        // size first: an unchanged transcript is not opened (on Windows each open can mean a scan)
        let Ok(meta) = std::fs::metadata(path) else { return false };
        let len = meta.len();
        if self.files.get(&key).is_some_and(|st| st.offset == len) {
            return false;
        }
        let Ok(mut f) = File::open(path) else { return false };
        let st = self.files.entry(key.clone()).or_default();
        // rewritten (compaction, rewind): read again from the start, the seen set skips repeats
        if len < st.offset {
            st.offset = 0;
        }
        if len == st.offset {
            return false;
        }
        let start = st.offset;
        if f.seek(SeekFrom::Start(start)).is_err() {
            return false;
        }
        let mut r = BufReader::with_capacity(1 << 20, f.take(len - start));
        let mut buf = Vec::new();
        let mut pos = start;
        loop {
            buf.clear();
            match r.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    // only complete lines; a line being written is read next time
                    if buf.last() != Some(&b'\n') {
                        break;
                    }
                    pos += n as u64;
                    self.line(&buf);
                }
            }
        }
        if let Some(st) = self.files.get_mut(&key) {
            st.offset = pos;
        }
        pos != start
    }

    fn load() -> Index {
        let d = dir();
        let mut ix = Index { loaded: true, ..Default::default() };
        if let Ok(s) = std::fs::read_to_string(d.join("usage-ledger.json")) {
            if let Ok(l) = serde_json::from_str::<Ledger>(&s) {
                if l.v != LEDGER_VERSION {
                    // counted the old way: read every transcript again (the files and seen-set
                    // below belong to it, so they go too)
                    ix.ledger.v = LEDGER_VERSION;
                    return ix;
                }
                ix.ledger = l;
            }
        } else {
            ix.ledger.v = LEDGER_VERSION;
        }
        ix.session_ix = ix.ledger.sessions.iter().enumerate().map(|(i, s)| (s.clone(), i as u32)).collect();
        if let Ok(s) = std::fs::read_to_string(d.join("usage-files.json")) {
            if let Ok(f) = serde_json::from_str::<HashMap<String, FileState>>(&s) {
                ix.files = f;
            }
        }
        if let Ok(b) = std::fs::read(d.join("usage-seen.bin")) {
            ix.seen = b.chunks_exact(8).map(|c| u64::from_le_bytes(c.try_into().unwrap())).collect();
        }
        ix
    }

    /// Once: fill the per-session detail of the last DETAIL_DAYS from the transcripts still there
    /// (the ledger kept only totals before). A message counts once, with its largest values.
    fn backfill_detail(&mut self, files: &[PathBuf]) {
        let since_ms = now_ms() as i64 - DETAIL_DAYS * 24 * 3600 * 1000;
        let cutoff = chrono_hour(since_ms);
        let mut best: HashMap<u64, (String, u32, String, Tokens)> = HashMap::new();
        for f in files {
            let recent = std::fs::metadata(f).ok().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64 >= since_ms).unwrap_or(false);
            if !recent {
                continue;
            }
            let Ok(text) = std::fs::read(f) else { continue };
            for line in text.split(|b| *b == b'\n') {
                if !find(line, br#""type":"assistant""#) || !find(line, br#""usage""#) {
                    continue;
                }
                let Ok(l) = serde_json::from_slice::<Line>(line) else { continue };
                let (Some(ts), Some(sid), Some(msg)) = (l.timestamp, l.session_id, l.message) else { continue };
                let Some(hk) = ts.get(..13) else { continue };
                if hk < cutoff.as_str() {
                    continue;
                }
                let (Some(u), model) = (msg.usage, msg.model.unwrap_or("unknown")) else { continue };
                if model == "<synthetic>" {
                    continue;
                }
                let (w5, w1) = match &u.cache_creation {
                    Some(c) if c.ephemeral_5m_input_tokens + c.ephemeral_1h_input_tokens > 0 => (c.ephemeral_5m_input_tokens, c.ephemeral_1h_input_tokens),
                    _ => (0, u.cache_creation_input_tokens),
                };
                let now = Tokens { i: u.input_tokens, o: u.output_tokens, w5, w1, r: u.cache_read_input_tokens, n: 1 };
                let key = h64(&["u", msg.id.unwrap_or(""), l.request_id.unwrap_or(l.uuid.unwrap_or(""))]);
                let six = self.session(sid);
                let e = best.entry(key).or_insert_with(|| (hk.to_string(), six, model.to_string(), Tokens::default()));
                let t = &mut e.3;
                t.i = t.i.max(now.i);
                t.o = t.o.max(now.o);
                t.w5 = t.w5.max(now.w5);
                t.w1 = t.w1.max(now.w1);
                t.r = t.r.max(now.r);
                t.n = 1;
            }
        }
        for h in self.ledger.hours.values_mut() {
            h.sm.clear();
        }
        for (hk, six, model, t) in best.into_values() {
            let h = self.ledger.hours.entry(hk).or_default();
            add(h.sm.entry(six.to_string()).or_default().entry(model).or_default(), &t);
        }
        self.ledger.d = 1;
    }

    /// Drop the per-session detail of hours older than DETAIL_DAYS.
    fn prune_detail(&mut self) {
        let cutoff = chrono_hour(now_ms() as i64 - DETAIL_DAYS * 24 * 3600 * 1000);
        for (k, h) in self.ledger.hours.iter_mut() {
            if k.as_str() >= cutoff.as_str() {
                break;
            }
            h.sm.clear();
        }
    }

    fn save(&self) -> Result<(), String> {
        let d = dir();
        std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
        let write = |name: &str, bytes: &[u8]| -> Result<(), String> {
            let tmp = d.join(format!("{name}.tmp"));
            std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
            std::fs::rename(&tmp, d.join(name)).map_err(|e| e.to_string())
        };
        write("usage-ledger.json", serde_json::to_string(&self.ledger).map_err(|e| e.to_string())?.as_bytes())?;
        write("usage-files.json", serde_json::to_string(&self.files).map_err(|e| e.to_string())?.as_bytes())?;
        let mut seen = Vec::with_capacity(self.seen.len() * 8);
        for v in &self.seen {
            seen.extend_from_slice(&v.to_le_bytes());
        }
        write("usage-seen.bin", &seen)
    }
}

fn add(t: &mut Tokens, x: &Tokens) {
    t.i += x.i;
    t.o += x.o;
    t.w5 += x.w5;
    t.w1 += x.w1;
    t.r += x.r;
    t.n += x.n;
}

/// "YYYY-MM-DDTHH" (UTC) of a unix time in ms, the ledger's hour key.
fn chrono_hour(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86400);
    let hour = secs.rem_euclid(86400) / 3600;
    // civil date from days since 1970-01-01 (Howard Hinnant's algorithm)
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    format!("{:04}-{:02}-{:02}T{:02}", if m <= 2 { y + 1 } else { y }, m, d, hour)
}

fn transcripts(root: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(root) else { return };
    for e in rd.flatten() {
        let p = e.path();
        // the listing's own type (no extra call per entry on Windows)
        if e.file_type().is_ok_and(|t| t.is_dir()) {
            transcripts(&p, out);
        } else if p.extension().and_then(|x| x.to_str()) == Some("jsonl") {
            out.push(p);
        }
    }
}

/// Bring the ledger up to date with every transcript (first time: all of them; then only what was
/// appended) and return it.
pub fn scan() -> Result<Value, String> {
    let _one = SCANNING.lock().map_err(|e| e.to_string())?;
    let mut guard = INDEX.lock().map_err(|e| e.to_string())?;
    if guard.as_ref().is_none_or(|i| !i.loaded) {
        *guard = Some(Index::load());
    }
    let ix = guard.as_mut().unwrap();
    let mut files = Vec::new();
    for dir in crate::claude::discover::claude_dirs() {
        transcripts(&dir.join("projects"), &mut files);
    }
    // written out only when a transcript grew (three files, the seen-set megabytes)
    let mut grew = false;
    for f in &files {
        grew |= ix.file(f);
    }
    if ix.ledger.d < 1 {
        ix.backfill_detail(&files);
        grew = true;
    }
    ix.prune_detail();
    if grew {
        ix.save()?;
    }
    serde_json::to_value(&ix.ledger).map_err(|e| e.to_string())
}

// ---------- plan limits (5-hour, weekly), sampled over time ----------
#[derive(Serialize, Deserialize, Clone)]
pub struct Sample {
    /// unix ms
    pub t: u64,
    /// 5-hour window, % used
    pub s: Option<f64>,
    /// 7-day window, % used
    pub w: Option<f64>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Ask claude for the plan's limits (no model call), keep a sample, and return the answer with the
/// samples of the last 35 days.
pub fn limits() -> Result<Value, String> {
    let got = crate::claude::discover::host_requests(vec![("usage", serde_json::json!({"subtype": "get_usage", "skip_behaviors": true}))], Duration::from_secs(25))?;
    let usage = got.get("usage").cloned().unwrap_or(Value::Null);
    let rl = usage.get("rate_limits");
    let util = |k: &str| rl.and_then(|r| r.get(k)).and_then(|w| w.get("utilization")).and_then(Value::as_f64);
    let sample = Sample { t: now_ms(), s: util("five_hour"), w: util("seven_day") };
    let path = dir().join("usage-limits.jsonl");
    if sample.s.is_some() || sample.w.is_some() {
        std::fs::create_dir_all(dir()).map_err(|e| e.to_string())?;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(f, "{}", serde_json::to_string(&sample).unwrap_or_default());
        }
    }
    let since = now_ms().saturating_sub(35 * 24 * 3600 * 1000);
    let samples: Vec<Sample> = std::fs::read_to_string(&path)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str::<Sample>(l).ok())
        .filter(|s| s.t >= since)
        .collect();
    Ok(serde_json::json!({ "usage": usage, "samples": samples }))
}

#[tauri::command]
pub async fn usage_scan() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(scan).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn usage_limits() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(limits).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A message's usage counts once (its blocks repeat it), across files too; prompts and tool
    /// calls are counted; tool results and meta lines are not prompts.
    #[test]
    fn hour_keys() {
        assert_eq!(chrono_hour(0), "1970-01-01T00");
        assert_eq!(chrono_hour(1_794_757_254_058), "2026-11-15T15");
        assert_eq!(chrono_hour(951_782_400_000), "2000-02-29T00");
    }

    #[test]
    fn counts_once() {
        let mut ix = Index::default();
        let a1 = r#"{"type":"assistant","timestamp":"2026-11-15T13:04:05.000Z","requestId":"req1","sessionId":"s1","uuid":"a1","message":{"id":"msg1","model":"claude-opus-5-5","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":3,"output_tokens":10,"cache_creation_input_tokens":100,"cache_read_input_tokens":1000,"cache_creation":{"ephemeral_5m_input_tokens":40,"ephemeral_1h_input_tokens":60}}}}"#;
        let a2 = r#"{"type":"assistant","timestamp":"2026-11-15T13:04:06.000Z","requestId":"req1","sessionId":"s1","uuid":"a2","message":{"id":"msg1","model":"claude-opus-5-5","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{}}],"usage":{"input_tokens":3,"output_tokens":10,"cache_creation_input_tokens":100,"cache_read_input_tokens":1000}}}"#;
        let p = r#"{"type":"user","timestamp":"2026-11-15T13:04:00.000Z","sessionId":"s1","uuid":"u1","message":{"role":"user","content":"do it"}}"#;
        let tr = r#"{"type":"user","timestamp":"2026-11-15T13:04:07.000Z","sessionId":"s1","uuid":"u2","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}"#;
        // the same message once more, later in the stream: output grew to 25
        let a3 = a2.replace(r#""uuid":"a2""#, r#""uuid":"a3""#).replace(r#""output_tokens":10"#, r#""output_tokens":25"#);
        for l in [p, a1, a2, tr, a3.as_str(), a1, p] {
            ix.line(l.as_bytes());
        }
        let h = &ix.ledger.hours["2026-11-15T13"];
        let t = &h.m["claude-opus-5-5"];
        assert_eq!((t.i, t.o, t.w5, t.w1, t.r, t.n), (3, 25, 40, 60, 1000, 1));
        assert_eq!(h.p, 1);
        assert_eq!(h.t, 2);
        assert_eq!(h.s.len(), 1);
    }
}

#[cfg(test)]
mod real {
    /// Run over the real transcripts (XDG_CONFIG_HOME should point somewhere disposable).
    #[test]
    #[ignore]
    fn scan_real() {
        let t = std::time::Instant::now();
        let v = super::scan().unwrap();
        let first = t.elapsed();
        let hours = v["hours"].as_object().unwrap();
        let (mut tok, mut req, mut p, mut tools) = (0u64, 0u64, 0u64, 0u64);
        let mut by_model = std::collections::BTreeMap::<String, u64>::new();
        for h in hours.values() {
            p += h["p"].as_u64().unwrap_or(0);
            tools += h["t"].as_u64().unwrap_or(0);
            for (m, x) in h["m"].as_object().unwrap() {
                let s: u64 = ["i", "o", "w5", "w1", "r"].iter().map(|k| x[*k].as_u64().unwrap_or(0)).sum();
                tok += s;
                req += x["n"].as_u64().unwrap_or(0);
                *by_model.entry(m.clone()).or_default() += s;
            }
        }
        let t2 = std::time::Instant::now();
        super::scan().unwrap();
        println!("first scan {first:?}, second {:?}", t2.elapsed());
        println!("hours {} first {:?} last {:?}", hours.len(), hours.keys().next(), hours.keys().last());
        println!("tokens {tok} requests {req} prompts {p} tools {tools} sessions {}", v["sessions"].as_array().unwrap().len());
        for (m, s) in by_model {
            println!("  {m}: {s}");
        }
    }
}
