//! Transcript reading for the chat view: the conversational records of a session JSONL (user,
//! assistant, system), slimmed (long strings cut, request blobs dropped), the last N of them on
//! open, then only what was appended since a byte offset (the file is append-only).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};

use super::discover::memfind;

const MAX_STR: usize = 6000;

#[derive(Serialize, Default)]
pub struct TranscriptChunk {
    pub records: Vec<Value>,
    /// byte offset after the last complete line read
    pub offset: u64,
    /// records left out at the start (older than the window)
    pub skipped: u64,
    /// uuid of the last linked line read (the next read checks the chain continues from it)
    pub tip: Option<String>,
    /// the appended lines start a new branch (a prompt edited or rewound): read the window again
    pub branched: bool,
}

/// The chain links of a line. Claude Code writes every message with `parentUuid`; editing or
/// rewinding a prompt starts a sibling branch, and only the branch that leads to the last line is
/// the conversation (what Claude Code itself shows). Compaction restarts the chain with a null
/// parent and `logicalParentUuid`.
#[derive(Deserialize)]
struct Link {
    uuid: Option<String>,
    #[serde(rename = "parentUuid")]
    parent: Option<String>,
    #[serde(rename = "logicalParentUuid")]
    logical: Option<String>,
    #[serde(rename = "isSidechain")]
    side: Option<bool>,
    /// a prompt you typed (a user record that is not a tool result): only these start branches
    #[serde(skip)]
    prompt: bool,
}

fn link_of(line: &[u8]) -> Option<Link> {
    let mut l: Link = serde_json::from_slice(line).ok()?;
    if l.side == Some(true) || l.uuid.is_none() {
        return None;
    }
    // edits and rewinds re-send a prompt; tool calls and results interleave off the chain all the
    // time (parallel calls), so only a typed prompt can start an abandoned branch
    l.prompt = memfind(line, br#""type":"user""#) && !memfind(line, br#""tool_use_id""#) && !memfind(line, br#""isMeta":true"#);
    Some(l)
}

/// Lines of abandoned branches: a prompt that was edited or rewound, and everything that followed
/// it. The conversation is the chain of parents from the last line back; a line off that chain
/// whose parent is on it starts a branch, unless it is a tool result (parallel tool calls answer
/// from the side). Lines whose parent was not read stay.
fn dropped_lines(links: &[(usize, Link)]) -> HashSet<usize> {
    let mut dropped = HashSet::new();
    let Some((_, last)) = links.last() else { return dropped };
    let by_uuid: HashMap<&str, usize> = links.iter().enumerate().map(|(i, (_, l))| (l.uuid.as_deref().unwrap_or(""), i)).collect();
    let parent_of = |i: usize| -> Option<usize> {
        let l = &links[i].1;
        l.parent.as_deref().or(l.logical.as_deref()).and_then(|p| by_uuid.get(p).copied()).filter(|j| *j < i)
    };
    let mut on = vec![false; links.len()];
    let mut cur = by_uuid.get(last.uuid.as_deref().unwrap_or("")).copied();
    while let Some(i) = cur {
        if on[i] {
            break;
        }
        on[i] = true;
        cur = parent_of(i);
    }
    // 0 = kept, 1 = dropped
    let mut gone = vec![false; links.len()];
    for i in 0..links.len() {
        if on[i] {
            continue;
        }
        gone[i] = match parent_of(i) {
            Some(p) if on[p] => links[i].1.prompt,
            Some(p) => gone[p],
            None => false,
        };
        if gone[i] {
            dropped.insert(links[i].0);
        }
    }
    dropped
}

fn cut(v: &mut Value, max: usize) {
    match v {
        Value::String(s) => {
            if s.len() > max {
                let mut end = max;
                while !s.is_char_boundary(end) {
                    end -= 1;
                }
                s.truncate(end);
                s.push_str("\n… (cut)");
            }
        }
        Value::Array(a) => a.iter_mut().for_each(|x| cut(x, max)),
        Value::Object(o) => {
            // a picture (base64 image source) stays whole so the chat can show it; a huge one goes
            if o.get("type").and_then(Value::as_str) == Some("base64") {
                if o.get("data").and_then(Value::as_str).map(|d| d.len() > 3_000_000).unwrap_or(false) {
                    o.remove("data");
                }
                return;
            }
            o.values_mut().for_each(|x| cut(x, max))
        }
        _ => {}
    }
}

/// Keep only what the chat renders.
fn slim(v: Value) -> Option<Value> {
    let ty = v.get("type")?.as_str()?.to_string();
    if !matches!(ty.as_str(), "user" | "assistant" | "system") {
        return None;
    }
    if v.get("isSidechain").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let mut out = Map::new();
    for k in ["type", "uuid", "parentUuid", "timestamp", "isMeta", "isCompactSummary", "subtype", "level", "content", "gitBranch", "cwd", "toolUseResult", "durationMs"] {
        if let Some(x) = v.get(k) {
            out.insert(k.into(), x.clone());
        }
    }
    if let Some(msg) = v.get("message") {
        let mut m = Map::new();
        for k in ["role", "content", "model", "stop_reason", "usage", "id"] {
            if let Some(x) = msg.get(k) {
                m.insert(k.into(), x.clone());
            }
        }
        out.insert("message".into(), Value::Object(m));
    }
    let mut v = Value::Object(out);
    // tool results and patches can be huge; the chat shows the start
    if let Some(tr) = v.get_mut("toolUseResult") {
        // keep structured edit info, drop file snapshots
        if let Some(o) = tr.as_object_mut() {
            o.remove("originalFile");
            o.remove("file");
        }
        cut(tr, MAX_STR);
    }
    if let Some(c) = v.get_mut("message").and_then(|m| m.get_mut("content")) {
        cut(c, MAX_STR * 2);
    }
    Some(v)
}

fn wanted(line: &[u8]) -> bool {
    memfind(line, br#""type":"user""#) || memfind(line, br#""type":"assistant""#) || memfind(line, br#""type":"system""#)
}

/// The last `max` conversational records of a transcript, read from the end. A long session's file
/// can be hundreds of MB; parsing all of it stalled the app. First a cheap byte scan backwards counts
/// conversational lines (no JSON parsing) until it has `max` plus some slack for abandoned branches,
/// then only that tail is parsed, once.
pub fn read_window(path: &str, max: usize) -> Result<TranscriptChunk, String> {
    let mut f = File::open(path).map_err(|e| e.to_string())?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    let want = max + max / 5 + 20;
    const STEP: u64 = 4 << 20;
    // `tail` holds the file from `start` to the end; grow it backwards a step at a time
    let mut start = len;
    let mut tail: Vec<u8> = Vec::new();
    let mut counted_from = 0usize; // bytes of `tail` (from its start) not counted yet
    let mut count = 0usize;
    while start > 0 && count < want {
        let next = start.saturating_sub(STEP);
        f.seek(SeekFrom::Start(next)).map_err(|e| e.to_string())?;
        let mut head = Vec::with_capacity((start - next) as usize);
        (&mut f).take(start - next).read_to_end(&mut head).map_err(|e| e.to_string())?;
        counted_from += head.len();
        head.extend_from_slice(&tail);
        tail = head;
        start = next;
        // count the complete lines in the new bytes (the first line may be partial unless at 0)
        let new_part = &tail[..counted_from];
        let from = if start == 0 { 0 } else { new_part.iter().position(|b| *b == b'\n').map(|i| i + 1).unwrap_or(new_part.len()) };
        let mut pos = from;
        while let Some(rel) = new_part[pos..].iter().position(|b| *b == b'\n') {
            if wanted(&new_part[pos..pos + rel + 1]) {
                count += 1;
            }
            pos += rel + 1;
        }
        // keep the partial first line uncounted for the next round
        counted_from = from;
    }
    let mut chunk = parse_bytes(&tail, start, max, start > 0);
    if start > 0 {
        // older records exist before the window
        chunk.skipped = chunk.skipped.max(1);
    }
    budget_images(&mut chunk.records);
    Ok(chunk)
}

/// Pictures (base64) stay only in the newest records, at most 12 of them and 8 MB in all; older
/// ones keep their place without the data (the chat shows a placeholder). Dozens of screenshots
/// made a window tens of MB of JSON to parse on the UI thread.
fn budget_images(records: &mut [Value]) {
    fn walk(v: &mut Value, left: &mut (usize, usize)) {
        match v {
            Value::Array(a) => a.iter_mut().rev().for_each(|x| walk(x, left)),
            Value::Object(o) => {
                if o.get("type").and_then(Value::as_str) == Some("base64") {
                    let n = o.get("data").and_then(Value::as_str).map(str::len).unwrap_or(0);
                    if n > 0 {
                        if left.0 > 0 && n <= left.1 {
                            left.0 -= 1;
                            left.1 -= n;
                        } else {
                            o.remove("data");
                        }
                    }
                    return;
                }
                o.values_mut().for_each(|x| walk(x, left))
            }
            _ => {}
        }
    }
    let mut left = (12usize, 8_000_000usize);
    for r in records.iter_mut().rev() {
        walk(r, &mut left);
    }
}

/// Drop abandoned branches, then keep the last `max` records.
fn window(kept: Vec<(usize, Value)>, links: &[(usize, Link)], max: usize, offset: u64, tip: Option<String>) -> TranscriptChunk {
    let dropped = dropped_lines(links);
    let mut keep: VecDeque<Value> = VecDeque::new();
    let mut skipped = 0u64;
    for (i, v) in kept {
        if dropped.contains(&i) {
            continue;
        }
        keep.push_back(v);
        if keep.len() > max {
            keep.pop_front();
            skipped += 1;
        }
    }
    TranscriptChunk { records: keep.into_iter().collect(), offset, skipped, tip, branched: false }
}

/// Records in a chunk of transcript bytes read elsewhere (a VPS over ssh). `base` is the file offset
/// of `bytes[0]`; when `partial_head` the chunk starts mid-file, so its first line is dropped.
pub fn parse_bytes(bytes: &[u8], base: u64, max: usize, partial_head: bool) -> TranscriptChunk {
    let mut start = 0usize;
    if partial_head {
        match bytes.iter().position(|b| *b == b'\n') {
            Some(i) => start = i + 1,
            None => return TranscriptChunk { offset: base, ..Default::default() },
        }
    }
    let mut kept: Vec<(usize, Value)> = Vec::new();
    let mut links: Vec<(usize, Link)> = Vec::new();
    let mut pos = start;
    let mut n = 0usize;
    while let Some(rel) = bytes[pos..].iter().position(|b| *b == b'\n') {
        let line = &bytes[pos..pos + rel + 1];
        pos += rel + 1;
        n += 1;
        if memfind(line, br#""parentUuid""#) {
            if let Some(l) = link_of(line) {
                links.push((n, l));
            }
        }
        if !wanted(line) {
            continue;
        }
        if let Ok(v) = serde_json::from_slice::<Value>(line) {
            if let Some(s) = slim(v) {
                kept.push((n, s));
            }
        }
    }
    let tip = links.last().and_then(|(_, l)| l.uuid.clone());
    window(kept, &links, max, base + pos as u64, tip)
}

/// Records appended since `offset` (only complete lines).
pub fn read_since(path: &str, offset: u64, tip: Option<String>) -> Result<TranscriptChunk, String> {
    let mut f = File::open(path).map_err(|e| e.to_string())?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    if len < offset {
        // rewritten (rewind/compaction rewrite): the caller reloads the window
        return Err("truncated".into());
    }
    f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut r = BufReader::new(f);
    let mut buf = Vec::new();
    let mut pos = offset;
    let mut records = Vec::new();
    let mut last = tip;
    let mut branched = false;
    loop {
        buf.clear();
        let n = r.read_until(b'\n', &mut buf).map_err(|e| e.to_string())?;
        if n == 0 || buf.last() != Some(&b'\n') {
            break;
        }
        pos += n as u64;
        if memfind(&buf, br#""parentUuid""#) {
            if let Some(l) = link_of(&buf) {
                // each new message hangs off the one before; a different parent is a new branch
                if let (Some(prev), Some(parent)) = (last.as_deref(), l.parent.as_deref()) {
                    if l.prompt && prev != parent {
                        branched = true;
                    }
                }
                last = l.uuid;
            }
        }
        if !wanted(&buf) {
            continue;
        }
        if let Ok(v) = serde_json::from_slice::<Value>(&buf) {
            if let Some(s) = slim(v) {
                records.push(s);
            }
        }
    }
    Ok(TranscriptChunk { records, offset: pos, skipped: 0, tip: last, branched })
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore]
    fn window_of_real_file() {
        for p in std::env::var("SD_TEST_FILES").unwrap().split(':') {
            let t = std::time::Instant::now();
            let w = super::read_window(p, 3000).unwrap();
            let users: Vec<String> = w
                .records
                .iter()
                .filter(|r| r["type"] == "user" && r.pointer("/message/content/0/type").and_then(|v| v.as_str()) != Some("tool_result"))
                .map(|r| {
                    let c = &r["message"]["content"];
                    let t = c.as_str().map(|s| s.to_string()).or_else(|| c.pointer("/0/text").and_then(|v| v.as_str()).map(|s| s.to_string())).unwrap_or_default();
                    t.chars().take(50).collect()
                })
                .collect();
            let last = w.records.last().map(|r| format!("{} {}", r["type"], r.pointer("/message/content/0/type").and_then(|v| v.as_str()).unwrap_or("-"))).unwrap_or_default();
            println!("{} ms · records {} skipped {} · prompts {} · last: {}", t.elapsed().as_millis(), w.records.len(), w.skipped, users.len(), last);
            for u in users.iter().rev().take(3) {
                println!("   prompt: {u}");
            }
        }
    }

    #[test]
    #[ignore]
    fn verbs_from_installed_claude() {
        let v = super::super::discover::spinner_verbs();
        println!("{} present, past {}", v["present"].as_array().unwrap().len(), v["past"]);
        assert!(v["present"].as_array().unwrap().len() > 50);
    }

    /// The window is read from the end: the last records, the right offset, and only the newest
    /// pictures keep their data.
    #[test]
    fn window_reads_from_the_end() {
        let dir = std::env::temp_dir().join(format!("sd-tw-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.jsonl");
        let mut text = String::new();
        let pad = "x".repeat(2000);
        for i in 0..4000 {
            text.push_str(&format!(r#"{{"type":"user","uuid":"u{i}","parentUuid":{},"message":{{"role":"user","content":"m{i} {pad}"}}}}"#, if i == 0 { "null".to_string() } else { format!("\"u{}\"", i - 1) }));
            text.push('\n');
        }
        for i in 0..20 {
            text.push_str(&format!(r#"{{"type":"user","uuid":"i{i}","parentUuid":"{}","message":{{"role":"user","content":[{{"type":"image","source":{{"type":"base64","media_type":"image/png","data":"AAAA"}}}}]}}}}"#, if i == 0 { "u3999".to_string() } else { format!("i{}", i - 1) }));
            text.push('\n');
        }
        std::fs::write(&path, &text).unwrap();
        let c = super::read_window(path.to_str().unwrap(), 50).unwrap();
        assert_eq!(c.records.len(), 50);
        assert_eq!(c.offset, text.len() as u64);
        assert!(c.skipped > 0);
        assert_eq!(c.records.last().unwrap()["uuid"], "i19");
        let with_data = c.records.iter().filter(|r| r.to_string().contains("AAAA")).count();
        assert_eq!(with_data, 12);
        // a small file is read whole
        let all = super::read_window(path.to_str().unwrap(), 100_000).unwrap();
        assert_eq!(all.records.len(), 4020);
        assert_eq!(all.skipped, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn edited_prompt_hides_the_abandoned_branch() {
        let lines = [
            r#"{"type":"user","uuid":"a","parentUuid":null,"message":{"role":"user","content":"first"}}"#,
            r#"{"type":"assistant","uuid":"b","parentUuid":"a","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}"#,
            r#"{"type":"user","uuid":"c1","parentUuid":"b","message":{"role":"user","content":"draft"}}"#,
            r#"{"type":"user","uuid":"c2","parentUuid":"b","message":{"role":"user","content":"draft, edited"}}"#,
            r#"{"type":"assistant","uuid":"d","parentUuid":"c2","message":{"role":"assistant","content":[{"type":"text","text":"answer"}]}}"#,
        ];
        let bytes = lines.join("\n") + "\n";
        let w = super::parse_bytes(bytes.as_bytes(), 0, 100, false);
        let texts: Vec<String> = w.records.iter().map(|r| r["message"]["content"].as_str().map(|s| s.to_string()).unwrap_or_else(|| r["message"]["content"][0]["text"].as_str().unwrap_or("").to_string())).collect();
        assert_eq!(texts, vec!["first", "ok", "draft, edited", "answer"]);
        assert_eq!(w.tip.as_deref(), Some("d"));
        // a tool result that answers from the side (parallel calls) stays
        let lines = [
            r#"{"type":"user","uuid":"a","parentUuid":null,"message":{"role":"user","content":"go"}}"#,
            r#"{"type":"assistant","uuid":"t1","parentUuid":"a","message":{"role":"assistant","content":[{"type":"tool_use","id":"x1","name":"Read","input":{}}]}}"#,
            r#"{"type":"assistant","uuid":"t2","parentUuid":"t1","message":{"role":"assistant","content":[{"type":"tool_use","id":"x2","name":"Read","input":{}}]}}"#,
            r#"{"type":"user","uuid":"r1","parentUuid":"t1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"x1","content":"one"}]}}"#,
            r#"{"type":"user","uuid":"r2","parentUuid":"t2","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"x2","content":"two"}]}}"#,
        ];
        let bytes = lines.join("\n") + "\n";
        let w = super::parse_bytes(bytes.as_bytes(), 0, 100, false);
        assert_eq!(w.records.len(), 5);
        // a tool call streamed off the chain (its result answers it) stays too
        let lines = [
            r#"{"type":"user","uuid":"a","parentUuid":null,"message":{"role":"user","content":"go"}}"#,
            r#"{"type":"assistant","uuid":"t1","parentUuid":"a","message":{"role":"assistant","content":[{"type":"tool_use","id":"x1","name":"Read","input":{}}]}}"#,
            r#"{"type":"assistant","uuid":"t2","parentUuid":"a","message":{"role":"assistant","content":[{"type":"tool_use","id":"x2","name":"Read","input":{}}]}}"#,
            r#"{"type":"user","uuid":"r2","parentUuid":"t2","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"x2","content":"two"}]}}"#,
            r#"{"type":"user","uuid":"r1","parentUuid":"t1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"x1","content":"one"}]}}"#,
            r#"{"type":"assistant","uuid":"z","parentUuid":"r1","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}"#,
        ];
        let bytes = lines.join("\n") + "\n";
        let w = super::parse_bytes(bytes.as_bytes(), 0, 100, false);
        assert_eq!(w.records.len(), 6);
    }
}
