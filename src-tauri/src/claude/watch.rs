//! Change events for Claude Code's folders (ReadDirectoryChangesW on Windows, FSEvents on macOS), so
//! the polls read only what changed instead of listing and stat-ing every transcript and pid file
//! every few seconds. Events can be lost (Windows drops a whole batch when its buffer overflows), so
//! the callers still read everything once a minute, and whenever the watcher asks for a rescan or
//! fails.

use notify::{Event, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// More changed paths than this between two polls: read everything instead.
const MAX_PATHS: usize = 4096;
/// A watch that could not start is tried again after this long.
const RETRY: Duration = Duration::from_secs(60);

/// Off on Linux: /proc and stat are cheap there, and a recursive inotify watch would use up watches
/// other apps need. `SD_WATCH=1` turns it on.
fn wanted() -> bool {
    cfg!(not(target_os = "linux")) || cfg!(test) || std::env::var("SD_WATCH").is_ok_and(|v| v == "1")
}

#[derive(Default)]
struct Pending {
    /// read every transcript (events were lost, or the watch just started)
    all: bool,
    /// paths under `projects` that changed since the last poll
    paths: HashSet<PathBuf>,
    /// bumped on every change in a `sessions` folder (pid files)
    sessions: u64,
}

static PENDING: Mutex<Option<Pending>> = Mutex::new(None);

struct Active {
    dirs: Vec<PathBuf>,
    _watcher: notify::RecommendedWatcher,
}

static ACTIVE: Mutex<Option<Active>> = Mutex::new(None);
static FAILED_AT: Mutex<Option<Instant>> = Mutex::new(None);

fn with<R>(f: impl FnOnce(&mut Pending) -> R) -> R {
    f(PENDING.lock().unwrap().get_or_insert_with(Default::default))
}

fn note(ev: notify::Result<Event>) {
    with(|p| match ev {
        // reads (the scan's own) change nothing
        Ok(ev) if ev.kind.is_access() => {}
        Ok(ev) if !ev.need_rescan() => {
            for path in ev.paths {
                if path.parent().and_then(|d| d.file_name()).is_some_and(|n| n == "sessions") {
                    p.sessions += 1;
                } else if p.paths.len() < MAX_PATHS {
                    p.paths.insert(path);
                } else {
                    p.all = true;
                }
            }
        }
        // lost events, or an error: nothing is known, read everything
        _ => {
            p.all = true;
            p.sessions += 1;
        }
    })
}

/// Watch `dirs` (their `projects`, recursively, and `sessions`); false while events can't be trusted.
fn ensure(dirs: &[PathBuf]) -> bool {
    if !wanted() {
        return false;
    }
    let mut active = ACTIVE.lock().unwrap();
    if active.as_ref().is_some_and(|a| a.dirs == dirs) {
        return true;
    }
    if FAILED_AT.lock().unwrap().is_some_and(|t| t.elapsed() < RETRY) {
        return false;
    }
    *active = None;
    let started = notify::recommended_watcher(note).ok().and_then(|mut w| {
        for d in dirs {
            w.watch(&d.join("projects"), RecursiveMode::Recursive).ok()?;
            w.watch(&d.join("sessions"), RecursiveMode::NonRecursive).ok()?;
        }
        Some(w)
    });
    let Some(w) = started else {
        *FAILED_AT.lock().unwrap() = Some(Instant::now());
        return false;
    };
    // what happened before the watch began is not known
    with(|p| {
        p.all = true;
        p.sessions += 1;
    });
    *active = Some(Active { dirs: dirs.to_vec(), _watcher: w });
    true
}

/// The paths under `projects` that changed since the last call; None: read everything.
pub fn take_transcripts(dirs: &[PathBuf]) -> Option<HashSet<PathBuf>> {
    if !ensure(dirs) {
        return None;
    }
    with(|p| {
        if std::mem::take(&mut p.all) {
            p.paths.clear();
            None
        } else {
            Some(std::mem::take(&mut p.paths))
        }
    })
}

/// A number that changes whenever a pid file may have changed; None: not watching (read them).
pub fn sessions_gen(dirs: &[PathBuf]) -> Option<u64> {
    ensure(dirs).then(|| with(|p| p.sessions))
}

// ---------- git folders ----------

/// More folders than this are not watched (each a recursive watch): the rest are read every time.
const MAX_FOLDERS: usize = 64;

struct FolderWatch {
    roots: Vec<PathBuf>,
    stamp: std::sync::Arc<std::sync::atomic::AtomicU64>,
    used: Instant,
    _watcher: notify::RecommendedWatcher,
}

static FOLDERS: Mutex<Option<std::collections::HashMap<String, FolderWatch>>> = Mutex::new(None);

/// A number that changes whenever anything under a folder (or the other `roots` its git state
/// depends on: the repository's main worktree, where branches and refs live) changed. None: not
/// watched, read it. The first call starts the watch and also says None (what changed before the
/// watch began is not known).
pub fn folder_gen(folder: &str, roots: &[PathBuf]) -> Option<u64> {
    if !wanted() {
        return None;
    }
    let mut g = FOLDERS.lock().unwrap();
    let map = g.get_or_insert_with(Default::default);
    if let Some(w) = map.get_mut(folder) {
        if w.roots == roots {
            w.used = Instant::now();
            return Some(w.stamp.load(std::sync::atomic::Ordering::SeqCst));
        }
    }
    map.remove(folder);
    if map.len() >= MAX_FOLDERS {
        let oldest = map.iter().min_by_key(|(_, w)| w.used).map(|(k, _)| k.clone());
        if let Some(k) = oldest {
            map.remove(&k);
        }
    }
    let stamp = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(1));
    let g2 = stamp.clone();
    let started = notify::recommended_watcher(move |ev: notify::Result<Event>| {
        // a read (git's own, ours) changes nothing; anything else, errors and lost events included,
        // may have changed the folder
        if ev.as_ref().is_ok_and(|e| e.kind.is_access()) {
            return;
        }
        g2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    })
    .ok()
    .and_then(|mut w| {
        for r in roots {
            w.watch(r, RecursiveMode::Recursive).ok()?;
        }
        Some(w)
    })?;
    map.insert(folder.to_string(), FolderWatch { roots: roots.to_vec(), stamp, used: Instant::now(), _watcher: started });
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sees_a_new_transcript_and_a_pid_file() {
        let root = std::env::temp_dir().join(format!("sd-watch-{}", std::process::id()));
        let proj = root.join("projects").join("-home-x");
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::create_dir_all(root.join("sessions")).unwrap();
        let dirs = vec![root.clone()];
        // the first call after the watch starts: everything
        assert!(take_transcripts(&dirs).is_none());
        let g0 = sessions_gen(&dirs).unwrap();
        assert_eq!(take_transcripts(&dirs).map(|s| s.len()), Some(0));
        let t = proj.join("abc.jsonl");
        std::fs::write(&t, "{}\n").unwrap();
        std::fs::write(root.join("sessions").join("1.json"), "{}").unwrap();
        let until = Instant::now() + Duration::from_secs(5);
        let mut seen = HashSet::new();
        while Instant::now() < until && !(seen.contains(&t) && sessions_gen(&dirs) != Some(g0)) {
            std::thread::sleep(Duration::from_millis(50));
            seen.extend(take_transcripts(&dirs).unwrap_or_default());
        }
        assert!(seen.contains(&t), "{seen:?}");
        assert_ne!(sessions_gen(&dirs), Some(g0));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_folder_change_moves_its_number() {
        let root = std::env::temp_dir().join(format!("sd-fwatch-{}", std::process::id()));
        std::fs::create_dir_all(root.join("src")).unwrap();
        let f = root.to_string_lossy().to_string();
        let roots = vec![root.clone()];
        // the first call starts the watch: not known yet
        assert_eq!(folder_gen(&f, &roots), None);
        let g0 = folder_gen(&f, &roots).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(folder_gen(&f, &roots), Some(g0), "nothing changed");
        std::fs::write(root.join("src").join("a.rs"), "x").unwrap();
        let until = Instant::now() + Duration::from_secs(5);
        while folder_gen(&f, &roots) == Some(g0) && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_ne!(folder_gen(&f, &roots), Some(g0), "a file written deep inside moves it");
        let _ = std::fs::remove_dir_all(&root);
    }
}
