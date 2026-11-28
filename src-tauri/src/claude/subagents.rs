//! The subagents a session started (the Agent tool, background agents, a Workflow's agents), as
//! Claude Code keeps them next to the session's transcript:
//!
//! ```text
//! <session>/subagents/agent-<id>.jsonl               its chat (records like the session's own)
//! <session>/subagents/agent-<id>.meta.json           type, description, the Agent call's id
//! <session>/subagents/workflows/<run>/agent-<id>.*   a Workflow run's agents
//! <session>/workflows/<run>.json                     a finished run: name, phases, totals
//! ```
//!
//! Cheap to poll: a file's summary is read again only when its size or time changed.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Subagent {
    pub id: String,
    /// its transcript (read with claude_transcript / claude_transcript_since)
    pub path: String,
    pub agent_type: String,
    pub description: String,
    /// the Agent call in the session's chat that started it
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_use_id: Option<String>,
    /// the Workflow run it belongs to, and its phase there
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workflow: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    pub background: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub started_ms: u64,
    pub updated_ms: u64,
    pub tool_count: u32,
    /// what it does now ("Reading page.tsx"), from its newest tool call
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity: Option<String>,
    /// its last answer ended the turn: done
    pub done: bool,
    /// tokens its newest call read (input + cache), how full its context is
    pub tokens: u64,
    /// its final answer (done), as it reported back
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Workflow {
    pub run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// the phases its script declared, in order
    pub phases: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Subagents {
    pub agents: Vec<Subagent>,
    pub workflows: Vec<Workflow>,
}

/// One agent file's summary, kept until the file changes.
struct Seen {
    size: u64,
    mtime: u64,
    agent: Subagent,
}

static CACHE: Mutex<Option<HashMap<PathBuf, Seen>>> = Mutex::new(None);

fn mtime_ms(m: &fs::Metadata) -> u64 {
    m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The subagents of the session whose transcript is `transcript` (…/<session>.jsonl).
pub fn list(transcript: &str) -> Subagents {
    let dir = PathBuf::from(transcript.strip_suffix(".jsonl").unwrap_or(transcript));
    let mut out = Subagents::default();
    let sub = dir.join("subagents");
    let mut files: Vec<(PathBuf, Option<String>)> = vec![];
    collect(&sub, None, &mut files);
    if let Ok(runs) = fs::read_dir(sub.join("workflows")) {
        for r in runs.flatten() {
            let run = r.file_name().to_string_lossy().to_string();
            collect(&r.path(), Some(run.clone()), &mut files);
            out.workflows.push(workflow(&dir, &run));
        }
    }
    let mut cache = CACHE.lock().unwrap();
    let cache = cache.get_or_insert_with(HashMap::new);
    for (path, run) in files {
        let Ok(m) = fs::metadata(&path) else { continue };
        let (size, mtime) = (m.len(), mtime_ms(&m));
        if let Some(s) = cache.get(&path) {
            if s.size == size && s.mtime == mtime {
                out.agents.push(s.agent.clone());
                continue;
            }
        }
        let agent = read_agent(&path, run, size, mtime);
        cache.insert(path, Seen { size, mtime, agent: agent.clone() });
        out.agents.push(agent);
    }
    out.agents.sort_by_key(|a| a.started_ms);
    out.workflows.sort_by(|a, b| a.run_id.cmp(&b.run_id));
    out
}

fn collect(dir: &Path, run: Option<String>, out: &mut Vec<(PathBuf, Option<String>)>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with("agent-") && name.ends_with(".jsonl") {
            out.push((p, run.clone()));
        }
    }
}

fn workflow(session_dir: &Path, run: &str) -> Workflow {
    let mut w = Workflow { run_id: run.to_string(), ..Default::default() };
    let Some(v) = fs::read_to_string(session_dir.join("workflows").join(format!("{run}.json"))).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else {
        return w;
    };
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    w.name = s("workflowName");
    w.status = s("status");
    w.total_tokens = v.get("totalTokens").and_then(Value::as_u64);
    w.duration_ms = v.get("durationMs").and_then(Value::as_u64);
    w.phases = v.get("phases").and_then(Value::as_array).map(|a| a.iter().filter_map(|p| p.get("title").and_then(Value::as_str).map(str::to_string)).collect()).unwrap_or_default();
    w
}

fn read_agent(path: &Path, run: Option<String>, size: u64, mtime: u64) -> Subagent {
    let id = path.file_stem().map(|s| s.to_string_lossy().trim_start_matches("agent-").to_string()).unwrap_or_default();
    let meta: Value = fs::read_to_string(path.with_extension("meta.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    let m = |k: &str| meta.get(k).and_then(Value::as_str).map(str::to_string);
    let mut a = Subagent {
        id,
        path: path.to_string_lossy().to_string(),
        agent_type: m("agentType").unwrap_or_else(|| "general-purpose".into()),
        description: m("description").unwrap_or_default(),
        tool_use_id: m("toolUseId"),
        phase: m("workflowPhase"),
        workflow: run,
        background: m("requestShape").as_deref() == Some("background"),
        model: m("model"),
        updated_ms: mtime,
        ..Default::default()
    };
    let Ok(mut f) = fs::File::open(path) else { return a };
    // the first line: when it started
    let mut head = vec![0u8; 4096.min(size as usize)];
    if f.read_exact(&mut head).is_ok() {
        if let Some(line) = head.split(|b| *b == b'\n').next() {
            a.started_ms = serde_json::from_slice::<Value>(line).ok().and_then(|v| v.get("timestamp").and_then(Value::as_str).and_then(parse_ms)).unwrap_or(mtime);
        }
    }
    if a.started_ms == 0 {
        a.started_ms = mtime;
    }
    // the tool calls in the whole file (a byte count, no parsing), what it does from the tail
    let mut all = Vec::with_capacity(size as usize);
    if f.seek(SeekFrom::Start(0)).is_ok() && f.read_to_end(&mut all).is_ok() {
        a.tool_count = count(&all, br#""type":"tool_use""#) as u32;
        let from = all.len().saturating_sub(256 << 10);
        let tail = &all[from..];
        for line in tail.split(|b| *b == b'\n').rev() {
            let Ok(v) = serde_json::from_slice::<Value>(line) else { continue };
            match v.get("type").and_then(Value::as_str) {
                Some("assistant") => {
                    let msg = v.get("message");
                    if a.tokens == 0 {
                        if let Some(u) = msg.and_then(|m| m.get("usage")) {
                            let n = |k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
                            a.tokens = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
                        }
                    }
                    let parts = msg.and_then(|m| m.get("content")).and_then(Value::as_array);
                    if let Some(call) = parts.and_then(|p| p.iter().rev().find(|c| c.get("type").and_then(Value::as_str) == Some("tool_use"))) {
                        let name = call.get("name").and_then(Value::as_str).unwrap_or("");
                        // a workflow's agent ends by handing back its result (StructuredOutput) and
                        // getting the answer to it: done, that result is its report
                        if name == "StructuredOutput" && a.activity.is_some() {
                            a.done = true;
                            let r = call.get("input").map(|i| serde_json::to_string_pretty(i).unwrap_or_default()).unwrap_or_default();
                            a.result = Some(format!("```json\n{}\n```", r.chars().take(20_000).collect::<String>()));
                            break;
                        }
                        a.activity = Some(super::discover::tool_activity(name, call.get("input").unwrap_or(&Value::Null)));
                        break;
                    }
                    // its last word, with no tool call after it: the turn ended
                    if msg.and_then(|m| m.get("stop_reason")).and_then(Value::as_str) == Some("end_turn") && a.activity.is_none() {
                        a.done = true;
                        let text: String = parts.map(|p| p.iter().filter_map(|c| c.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n")).unwrap_or_default();
                        if !text.trim().is_empty() {
                            a.result = Some(text.chars().take(20_000).collect());
                            break;
                        }
                        // the answer's text is in an earlier record of the same message (thinking last)
                        continue;
                    }
                    if a.done {
                        let text: String = parts.map(|p| p.iter().filter_map(|c| c.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n")).unwrap_or_default();
                        if !text.trim().is_empty() {
                            a.result = Some(text.chars().take(20_000).collect());
                        }
                        break;
                    }
                }
                // a tool's result came back: it works on (the next call shows what)
                Some("user") => {
                    if a.activity.is_none() {
                        a.activity = Some("Thinking".into());
                    }
                }
                _ => {}
            }
        }
    }
    if a.done {
        a.activity = None;
    }
    a
}

fn count(hay: &[u8], needle: &[u8]) -> usize {
    if needle.is_empty() || hay.len() < needle.len() {
        return 0;
    }
    hay.windows(needle.len()).filter(|w| *w == needle).count()
}

/// "2026-11-28T14:34:20.388Z" → ms since the epoch.
fn parse_ms(s: &str) -> Option<u64> {
    let (date, time) = s.split_once('T')?;
    let mut d = date.split('-').map(|x| x.parse::<i64>().ok());
    let (y, mo, da) = (d.next()??, d.next()??, d.next()??);
    let time = time.trim_end_matches('Z');
    let (hms, frac) = time.split_once('.').unwrap_or((time, "0"));
    let mut t = hms.split(':').map(|x| x.parse::<i64>().ok());
    let (h, mi, se) = (t.next()??, t.next()??, t.next()??);
    let ms: i64 = format!("{:0<3}", &frac[..frac.len().min(3)]).parse().ok()?;
    // days from civil (Howard Hinnant)
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + da - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some((((days * 24 + h) * 60 + mi) * 60 + se) as u64 * 1000 + ms as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps() {
        assert_eq!(parse_ms("1970-01-01T00:00:01.5Z"), Some(1500));
        assert_eq!(parse_ms("2026-11-28T14:34:20.388Z"), Some(1795876460388));
    }

    #[test]
    fn reads_an_agent_and_a_workflow() {
        let base = std::env::temp_dir().join(format!("sd-subagents-{}", std::process::id()));
        let sess = base.join("s1");
        let sub = sess.join("subagents");
        fs::create_dir_all(sub.join("workflows/wf_1")).unwrap();
        fs::create_dir_all(sess.join("workflows")).unwrap();
        fs::write(sub.join("agent-a1.meta.json"), r#"{"agentType":"Explore","description":"Find the bug","toolUseId":"toolu_1","requestShape":"background"}"#).unwrap();
        fs::write(
            sub.join("agent-a1.jsonl"),
            concat!(
                r#"{"type":"user","isSidechain":true,"timestamp":"2026-11-28T14:00:00.000Z","message":{"role":"user","content":"go"}}"#, "\n",
                r#"{"type":"assistant","isSidechain":true,"message":{"role":"assistant","stop_reason":"tool_use","usage":{"input_tokens":2,"cache_read_input_tokens":100},"content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/x/src/page.tsx"}}]}}"#, "\n",
            ),
        )
        .unwrap();
        fs::write(sub.join("workflows/wf_1/agent-b1.meta.json"), r#"{"agentType":"workflow-subagent","description":"fetch","workflowPhase":"Fetch"}"#).unwrap();
        fs::write(
            sub.join("workflows/wf_1/agent-b1.jsonl"),
            concat!(r#"{"type":"assistant","isSidechain":true,"timestamp":"2026-11-28T14:01:00.000Z","message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"done"}]}}"#, "\n"),
        )
        .unwrap();
        fs::write(sess.join("workflows/wf_1.json"), r#"{"workflowName":"deep-research","status":"completed","phases":[{"title":"Search"},{"title":"Fetch"}],"totalTokens":5}"#).unwrap();
        let l = list(&format!("{}.jsonl", sess.to_string_lossy()));
        assert_eq!(l.agents.len(), 2);
        let a = &l.agents[0];
        assert_eq!((a.id.as_str(), a.agent_type.as_str(), a.tool_use_id.as_deref(), a.background), ("a1", "Explore", Some("toolu_1"), true));
        assert_eq!((a.tool_count, a.done, a.tokens), (1, false, 102));
        assert_eq!(a.activity.as_deref(), Some("Reading page.tsx"));
        let b = &l.agents[1];
        assert_eq!((b.workflow.as_deref(), b.phase.as_deref(), b.done), (Some("wf_1"), Some("Fetch"), true));
        assert_eq!(b.result.as_deref(), Some("done"));
        // a workflow agent that handed back its StructuredOutput is done too
        fs::write(
            sub.join("workflows/wf_1/agent-b2.jsonl"),
            concat!(
                r#"{"type":"assistant","isSidechain":true,"timestamp":"2026-11-28T14:02:00.000Z","message":{"role":"assistant","stop_reason":"tool_use","content":[{"type":"tool_use","id":"t9","name":"StructuredOutput","input":{"ok":true}}]}}"#, "\n",
                r#"{"type":"user","isSidechain":true,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t9","content":"ok"}]}}"#, "\n",
            ),
        )
        .unwrap();
        let l = list(&format!("{}.jsonl", sess.to_string_lossy()));
        let b2 = l.agents.iter().find(|a| a.id == "b2").unwrap();
        assert!(b2.done && b2.activity.is_none() && b2.result.as_deref().unwrap().contains("\"ok\": true"));
        assert_eq!(l.workflows[0].name.as_deref(), Some("deep-research"));
        assert_eq!(l.workflows[0].phases, vec!["Search", "Fetch"]);
        let _ = fs::remove_dir_all(&base);
    }
}

#[cfg(test)]
mod real_data {
    /// `SD_SUBAGENTS=<session>.jsonl cargo test subagents_of_a_real_session -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn subagents_of_a_real_session() {
        let Ok(p) = std::env::var("SD_SUBAGENTS") else { return };
        let t = std::time::Instant::now();
        let l = super::list(&p);
        let ms = t.elapsed().as_millis();
        let t2 = std::time::Instant::now();
        let _ = super::list(&p);
        eprintln!("{} agents, {} workflows, first {ms} ms, again {} ms", l.agents.len(), l.workflows.len(), t2.elapsed().as_millis());
        for a in l.agents.iter().filter(|a| a.workflow.is_none()) {
            eprintln!("{} {} {:?} tools={} done={} tok={} act={:?} res={}", a.id, a.agent_type, a.description, a.tool_count, a.done, a.tokens, a.activity, a.result.as_deref().map(|r| r.len()).unwrap_or(0));
        }
        for w in &l.workflows {
            let n = l.agents.iter().filter(|a| a.workflow.as_deref() == Some(&w.run_id)).count();
            let done = l.agents.iter().filter(|a| a.workflow.as_deref() == Some(&w.run_id) && a.done).count();
            eprintln!("{} {:?} {:?} phases={:?} agents={n} done={done}", w.run_id, w.name, w.status, w.phases);
        }
    }
}
