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
}

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
    recent: HashMap<u64, (String, String, Tokens)>,
    recent_order: std::collections::VecDeque<u64>,
}

static INDEX: Mutex<Option<Index>> = Mutex::new(None);
static SCANNING: Mutex<()> = Mutex::new(());

fn dir() -> PathBuf {
    let base = std::env::var("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|_| Path::new(&std::env::var("HOME").unwrap_or_default()).join(".config"));
    base.join("session-dashboard")
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
            let Some((hour, m, counted)) = self.recent.get_mut(&key) else { return };
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
            let (hour, m) = (hour.clone(), m.clone());
            if let Some(t) = self.ledger.hours.get_mut(&hour).and_then(|h| h.m.get_mut(&m)) {
                t.i += grow.i;
                t.o += grow.o;
                t.w5 += grow.w5;
                t.w1 += grow.w1;
                t.r += grow.r;
            }
            return;
        }
        if let Some(sid) = l.session_id {
            self.mark_session(ts, sid);
        }
        let Some(hk) = ts.get(..13).map(str::to_string) else { return };
        let Some(h) = self.hour(ts) else { return };
        let t = h.m.entry(model.to_string()).or_default();
        t.i += now.i;
        t.o += now.o;
        t.w5 += now.w5;
        t.w1 += now.w1;
        t.r += now.r;
        t.n += 1;
        self.recent.insert(key, (hk, model.to_string(), now));
        self.recent_order.push_back(key);
        if self.recent_order.len() > 4096 {
            if let Some(old) = self.recent_order.pop_front() {
                self.recent.remove(&old);
            }
        }
    }

    /// Read what a file gained since last time (all of it the first time).
    fn file(&mut self, path: &Path) {
        let key = path.to_string_lossy().to_string();
        let Ok(mut f) = File::open(path) else { return };
        let Ok(meta) = f.metadata() else { return };
        let len = meta.len();
        let st = self.files.entry(key.clone()).or_default();
        // rewritten (compaction, rewind): read again from the start, the seen set skips repeats
        if len < st.offset {
            st.offset = 0;
        }
        if len == st.offset {
            return;
        }
        let start = st.offset;
        if f.seek(SeekFrom::Start(start)).is_err() {
            return;
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

fn transcripts(root: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(root) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
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
    transcripts(&crate::claude::discover::claude_dir().join("projects"), &mut files);
    for f in &files {
        ix.file(f);
    }
    ix.save()?;
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
