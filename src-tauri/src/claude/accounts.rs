//! Continuing a session on another account (another Claude Code config folder): its transcript is
//! copied into the same project folder of the other account, where `claude --resume <id>
//! --fork-session` finds it and carries the conversation on under a new id. The fork writes the
//! whole conversation into its own transcript, so the copy is only needed until then: the app
//! removes it once the fork's transcript is there. Until then the copy (same session id as the
//! original) is left out of the session list and the search, so the session never shows twice.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Copies made here and not removed yet (absolute paths: the transcript and its folder).
static COPIES: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);

fn registry_file() -> PathBuf {
    crate::sys::config_dir().join("transcript-copies.json")
}

fn with_copies<T>(f: impl FnOnce(&mut HashSet<PathBuf>) -> T) -> T {
    let mut guard = COPIES.lock().unwrap_or_else(|e| e.into_inner());
    let set = guard.get_or_insert_with(|| fs::read_to_string(registry_file()).ok().and_then(|t| serde_json::from_str::<Vec<PathBuf>>(&t).ok()).unwrap_or_default().into_iter().collect());
    f(set)
}

fn save(set: &HashSet<PathBuf>) {
    let list: Vec<&PathBuf> = set.iter().collect();
    if let Ok(text) = serde_json::to_string(&list) {
        let _ = fs::create_dir_all(crate::sys::config_dir());
        let _ = fs::write(registry_file(), text);
    }
}

/// A transcript copied for a fork on another account: not a session of its own.
pub fn is_copy(path: &Path) -> bool {
    with_copies(|set| !set.is_empty() && set.contains(path))
}

/// The config folder of an account: the main one for None or "".
pub fn root_of(dir: Option<&str>) -> PathBuf {
    match dir.map(str::trim).filter(|d| !d.is_empty()) {
        Some(d) => PathBuf::from(crate::sys::expand(d)),
        None => super::discover::claude_dir(),
    }
}

/// `<root>/projects/*/<id>.jsonl`, the first one found.
fn find_transcript(root: &Path, session_id: &str) -> Option<PathBuf> {
    let file = format!("{session_id}.jsonl");
    fs::read_dir(root.join("projects")).ok()?.flatten().map(|d| d.path().join(&file)).find(|p| p.is_file())
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for e in fs::read_dir(from)?.flatten() {
        let (src, dst) = (e.path(), to.join(e.file_name()));
        if e.file_type()?.is_dir() {
            copy_dir(&src, &dst)?;
        } else {
            fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

/// What a copy made: the transcript in the other account, and the paths that are new copies (empty
/// when the other account already had this transcript of its own).
#[derive(Debug, PartialEq)]
pub struct Copied {
    pub transcript: PathBuf,
    pub made: Vec<PathBuf>,
}

/// Copy a session's transcript (and the folder beside it: subagents, tool results kept apart)
/// from one config folder into the same project folder of another.
pub fn copy_between(from_root: &Path, to_root: &Path, session_id: &str) -> Result<Copied, String> {
    if session_id.is_empty() || session_id.contains(|c: char| c == '/' || c == '\\') || session_id.contains("..") {
        return Err("not a session id".into());
    }
    if from_root == to_root {
        return Err("the session already belongs to that account".into());
    }
    let src = find_transcript(from_root, session_id).ok_or_else(|| format!("no transcript of {session_id} in {}", from_root.display()))?;
    let project = src.parent().and_then(Path::file_name).ok_or("transcript outside a project folder")?;
    let dest_dir = to_root.join("projects").join(project);
    let dest = dest_dir.join(format!("{session_id}.jsonl"));
    let mut made = Vec::new();
    // there already (copied for an earlier fork, or the session came from there): it resumes as is
    if !dest.is_file() {
        fs::create_dir_all(&dest_dir).map_err(|e| format!("cannot create {}: {e}", dest_dir.display()))?;
        fs::copy(&src, &dest).map_err(|e| format!("cannot copy the transcript: {e}"))?;
        made.push(dest.clone());
    }
    let side = src.with_extension("");
    let side_dest = dest_dir.join(session_id);
    if side.is_dir() && !side_dest.exists() {
        copy_dir(&side, &side_dest).map_err(|e| format!("cannot copy {}: {e}", side.display()))?;
        made.push(side_dest);
    }
    Ok(Copied { transcript: dest, made })
}

/// Copy a session's transcript to another account (None/"" = the main one); returns its path there.
pub fn copy_transcript(session_id: &str, from_dir: Option<&str>, to_dir: Option<&str>) -> Result<String, String> {
    let (from, to) = (root_of(from_dir), root_of(to_dir));
    // known as copies before they exist: the session list (watching the folders) never sees them
    // as sessions, not even for a moment
    let ahead: Vec<PathBuf> = find_transcript(&from, session_id)
        .and_then(|src| src.parent().and_then(Path::file_name).map(|p| to.join("projects").join(p)))
        .map(|d| vec![d.join(format!("{session_id}.jsonl")), d.join(session_id)])
        .unwrap_or_default()
        .into_iter()
        .filter(|p| !p.exists())
        .collect();
    with_copies(|set| set.extend(ahead.iter().cloned()));
    let got = copy_between(&from, &to, session_id);
    with_copies(|set| {
        let made: &[PathBuf] = got.as_ref().map(|c| c.made.as_slice()).unwrap_or(&[]);
        for p in ahead.iter().filter(|p| !made.contains(p)) {
            set.remove(p);
        }
        save(set);
    });
    got.map(|c| c.transcript.to_string_lossy().to_string())
}

/// Remove the copies made of a session in an account (once its fork has a transcript of its own).
/// Only what this app copied goes; a transcript of the account's own is never touched.
pub fn remove_copy(session_id: &str, to_dir: Option<&str>) -> Result<(), String> {
    let root = root_of(to_dir).join("projects");
    let file = format!("{session_id}.jsonl");
    with_copies(|set| {
        let mine: Vec<PathBuf> = set.iter().filter(|p| p.starts_with(&root) && (p.file_name().is_some_and(|n| n == file.as_str() || n == session_id))).cloned().collect();
        for p in &mine {
            let _ = if p.is_dir() { fs::remove_dir_all(p) } else { fs::remove_file(p) };
            set.remove(p);
        }
        if !mine.is_empty() {
            save(set);
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sd-accounts-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn copies_the_transcript_and_its_folder() {
        let base = tmp("copy");
        let (from, to) = (base.join(".claude"), base.join(".claude-work"));
        let project = from.join("projects").join("-home-me-api");
        fs::create_dir_all(project.join("s1").join("subagents")).unwrap();
        fs::write(project.join("s1.jsonl"), "{\"sessionId\":\"s1\"}\n").unwrap();
        fs::write(project.join("s1").join("subagents").join("agent-a.jsonl"), "{}\n").unwrap();
        // another session in the same folder stays where it is
        fs::write(project.join("s2.jsonl"), "{}\n").unwrap();

        let c = copy_between(&from, &to, "s1").unwrap();
        let dest = to.join("projects").join("-home-me-api");
        assert_eq!(c.transcript, dest.join("s1.jsonl"));
        assert_eq!(fs::read_to_string(&c.transcript).unwrap(), "{\"sessionId\":\"s1\"}\n");
        assert!(dest.join("s1").join("subagents").join("agent-a.jsonl").is_file());
        assert!(!dest.join("s2.jsonl").exists());
        assert_eq!(c.made, vec![dest.join("s1.jsonl"), dest.join("s1")]);
        // the original stays readable as history
        assert!(project.join("s1.jsonl").is_file());

        // a second copy finds it there and makes nothing new
        let again = copy_between(&from, &to, "s1").unwrap();
        assert!(again.made.is_empty());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_missing_transcript_is_an_error() {
        let base = tmp("missing");
        let (from, to) = (base.join(".claude"), base.join(".claude-work"));
        fs::create_dir_all(from.join("projects").join("-x")).unwrap();
        assert!(copy_between(&from, &to, "nope").unwrap_err().contains("no transcript"));
        assert!(!to.join("projects").exists());
        // same account, or a path for an id: refused
        assert!(copy_between(&from, &from, "nope").is_err());
        assert!(copy_between(&from, &to, "../x").is_err());
        let _ = fs::remove_dir_all(&base);
    }
}
