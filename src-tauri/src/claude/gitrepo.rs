//! Git state per repository, kept between polls and read again only where something changed.
//!
//! A repository with many worktrees (Claude Code puts them in `<repo>/.claude/worktrees/`) was read
//! once per folder: every poll ran `git status` in every worktree, and the folders of the same
//! repository read the same things again (hundreds of git processes a minute). Here a repository is
//! one entry: its worktree list, branches and commits on no remote are read once for all its
//! folders, and each worktree's `git status` only when that worktree changed.
//!
//! What changed comes from a change watch (ReadDirectoryChangesW / FSEvents, as git's own fsmonitor
//! does): an event under a worktree marks that worktree (the deepest one holding the path, so a
//! nested worktree does not mark the main one); under the shared `.git`, `refs`/`packed-refs` mark
//! the branches, `worktrees/<name>/` that worktree's HEAD and index, `objects` and `logs` nothing.
//! Lost events are covered by a full read every 5 minutes. Without a watch (Linux, a network drive)
//! a read is reused within one poll (2 s), so the folders of one repository share it.

use super::git::git;
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Within one poll a thing is read once, whichever folder asks.
const FRESH: Duration = Duration::from_secs(2);
/// Watched: read anyway this often (events can be lost).
const MAX_AGE: Duration = Duration::from_secs(300);

#[derive(Default)]
struct Dirty {
    all: bool,
    refs: bool,
    list: bool,
    /// worktree tops that changed
    tops: HashSet<PathBuf>,
    /// `.git/worktrees/<name>` that changed (a linked worktree's HEAD or index)
    names: HashSet<String>,
}

struct Wt {
    /// as git prints it
    path: String,
    head: String,
    flags: Vec<&'static str>,
    status: Option<Vec<String>>,
    read_at: Option<Instant>,
}

struct Repo {
    common: PathBuf,
    main_top: PathBuf,
    remotes: Vec<(String, String)>,
    /// for-each-ref rows (name, upstream, track, date) and the tip
    branches: Vec<(String, String)>,
    /// commits on no remote → their parents
    graph: HashMap<String, Vec<String>>,
    /// commit → its time (the worktrees' HEADs)
    when: HashMap<String, String>,
    wts: Vec<Wt>,
    /// `.git/worktrees/<name>` → the worktree's top
    names: HashMap<String, PathBuf>,
    list_at: Option<Instant>,
    refs_at: Option<Instant>,
    dirty: Arc<Mutex<Dirty>>,
    /// worktree tops the watch attributes events to
    tops: Arc<Mutex<Vec<PathBuf>>>,
    watched: Vec<PathBuf>,
    watcher: Option<notify::RecommendedWatcher>,
}

static REPOS: Mutex<Option<HashMap<PathBuf, Arc<Mutex<Repo>>>>> = Mutex::new(None);

/// `a/b/../c` → `a/c`, without touching the disk (canonicalize gives `\\?\` paths on Windows).
fn lexical(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            c => out.push(c),
        }
    }
    out
}

/// Paths from git ("C:/x/y") and from the disk ("C:\x\y") name the same folder.
fn same_path(a: &Path, b: &Path) -> bool {
    if cfg!(windows) {
        let n = |p: &Path| p.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_lowercase();
        n(a) == n(b)
    } else {
        a == b
    }
}

/// The repository a folder is in, from the disk alone: (its worktree's top, the shared `.git`).
/// A linked worktree's `.git` file names its own git dir, whose `commondir` names the shared one;
/// a submodule's has no `commondir` (its git dir is its own).
fn locate(path: &Path) -> Option<(PathBuf, PathBuf)> {
    let mut d = Some(path);
    while let Some(dir) = d {
        let dot = dir.join(".git");
        if dot.is_dir() {
            return Some((dir.to_path_buf(), dot));
        }
        if dot.is_file() {
            let t = std::fs::read_to_string(&dot).ok()?;
            let gitdir = PathBuf::from(t.trim().trim_start_matches("gitdir:").trim());
            let gitdir = lexical(&if gitdir.is_absolute() { gitdir } else { dir.join(gitdir) });
            let common = match std::fs::read_to_string(gitdir.join("commondir")) {
                Ok(c) => {
                    let c = PathBuf::from(c.trim());
                    lexical(&if c.is_absolute() { c } else { gitdir.join(c) })
                }
                Err(_) => gitdir,
            };
            return Some((dir.to_path_buf(), common));
        }
        d = dir.parent();
    }
    None
}

fn repo_for(common: &Path, main_top: &Path) -> Arc<Mutex<Repo>> {
    let mut g = REPOS.lock().unwrap();
    g.get_or_insert_with(HashMap::new)
        .entry(common.to_path_buf())
        .or_insert_with(|| {
            Arc::new(Mutex::new(Repo {
                common: common.to_path_buf(),
                main_top: main_top.to_path_buf(),
                remotes: vec![],
                branches: vec![],
                graph: HashMap::new(),
                when: HashMap::new(),
                wts: vec![],
                names: HashMap::new(),
                list_at: None,
                refs_at: None,
                dirty: Arc::new(Mutex::new(Dirty { all: true, ..Default::default() })),
                tops: Arc::new(Mutex::new(vec![])),
                watched: vec![],
                watcher: None,
            }))
        })
        .clone()
}

/// The report `git::parse` reads (the same sections the shell script printed), for a folder.
pub fn read(path: &str, quick: bool) -> String {
    let p = Path::new(path);
    if !p.is_dir() {
        return "@@nodir\n".into();
    }
    let Some((top, common)) = locate(p) else { return "@@norepo\n".into() };
    // the main worktree holds the shared `.git`; a submodule's git dir sits elsewhere
    let main_top = if common.file_name().is_some_and(|n| n == ".git") { common.parent().map(Path::to_path_buf).unwrap_or(top.clone()) } else { top.clone() };
    let repo = repo_for(&common, &main_top);
    let mut r = repo.lock().unwrap();
    if !r.refresh(&top, quick) {
        return "@@norepo\n".into();
    }
    r.report(&top, quick)
}

/// What a change under one of the repository's folders means.
fn classify(common: &Path, main_top: &Path, tops: &Mutex<Vec<PathBuf>>, d: &mut Dirty, p: &Path) {
    if let Ok(rel) = p.strip_prefix(common) {
        let mut parts = rel.components().map(|c| c.as_os_str().to_string_lossy().to_string());
        match parts.next().as_deref() {
            // objects come with a ref or an index change; logs and hooks change nothing shown
            Some("objects") | Some("logs") | Some("hooks") | Some("info") | Some("lfs") => {}
            Some("refs") | Some("packed-refs") | Some("config") | Some("FETCH_HEAD") | Some("ORIG_HEAD") => d.refs = true,
            Some("worktrees") => match parts.next() {
                Some(name) if parts.next().is_some() => {
                    d.names.insert(name);
                }
                // a worktree added or removed
                _ => d.list = true,
            },
            // HEAD, index, MERGE_HEAD…: the main worktree's
            _ => {
                d.tops.insert(main_top.to_path_buf());
            }
        }
        return;
    }
    // a worktree's own files: the deepest worktree holding the path (a nested one is not the main)
    let t = tops.lock().unwrap();
    match t.iter().filter(|top| p.starts_with(top)).max_by_key(|top| top.components().count()) {
        Some(top) => {
            d.tops.insert(top.clone());
        }
        None => d.all = true,
    }
}

impl Repo {
    /// Watch the main worktree (and the shared `.git` and worktrees outside it), recursively; true
    /// while events can be trusted.
    fn ensure_watch(&mut self) -> bool {
        use notify::{RecursiveMode, Watcher};
        if !super::watch::wanted() {
            return false;
        }
        let mut want = vec![self.main_top.clone()];
        for p in std::iter::once(self.common.clone()).chain(self.wts.iter().map(|w| PathBuf::from(&w.path))) {
            if !want.iter().any(|r| p.starts_with(r)) && p.is_dir() {
                want.push(p);
            }
        }
        if self.watcher.is_some() && self.watched == want {
            return true;
        }
        let (dirty, tops, common, main_top) = (self.dirty.clone(), self.tops.clone(), self.common.clone(), self.main_top.clone());
        let started = notify::recommended_watcher(move |ev: notify::Result<notify::Event>| {
            let mut d = dirty.lock().unwrap();
            match ev {
                // a read (ours, git's) changes nothing
                Ok(e) if e.kind.is_access() => {}
                Ok(e) if !e.need_rescan() => {
                    for p in &e.paths {
                        classify(&common, &main_top, &tops, &mut d, p);
                    }
                }
                _ => d.all = true,
            }
        })
        .ok()
        .and_then(|mut w| {
            for r in &want {
                w.watch(r, RecursiveMode::Recursive).ok()?;
            }
            Some(w)
        });
        // what happened before this watch began is not known
        self.dirty.lock().unwrap().all = true;
        self.watched = want;
        self.watcher = started;
        self.watcher.is_some()
    }

    fn read_list(&mut self) -> bool {
        let top = self.main_top.to_string_lossy().to_string();
        let Some(wl) = git(&top, &["worktree", "list", "--porcelain"]) else { return false };
        let mut next: Vec<Wt> = Vec::new();
        for l in wl.lines() {
            if let Some(p) = l.strip_prefix("worktree ") {
                // a worktree already known keeps what was read of it
                let old = self.wts.iter().position(|w| w.path == p).map(|i| self.wts.swap_remove(i));
                next.push(old.map(|o| Wt { head: String::new(), flags: vec![], ..o }).unwrap_or(Wt { path: p.to_string(), head: String::new(), flags: vec![], status: None, read_at: None }));
            } else if let Some(w) = next.last_mut() {
                if let Some(h) = l.strip_prefix("HEAD ") {
                    w.head = h.to_string();
                } else if l.starts_with("locked") {
                    w.flags.push("locked");
                } else if l.starts_with("prunable") {
                    w.flags.push("prunable");
                }
            }
        }
        self.wts = next;
        // `.git/worktrees/<name>/gitdir` says which worktree a name is
        self.names.clear();
        if let Ok(rd) = std::fs::read_dir(self.common.join("worktrees")) {
            for e in rd.flatten() {
                if let Ok(t) = std::fs::read_to_string(e.path().join("gitdir")) {
                    if let Some(top) = PathBuf::from(t.trim()).parent() {
                        self.names.insert(e.file_name().to_string_lossy().to_string(), top.to_path_buf());
                    }
                }
            }
        }
        *self.tops.lock().unwrap() = self.wts.iter().map(|w| PathBuf::from(&w.path)).collect();
        self.list_at = Some(Instant::now());
        true
    }

    fn read_refs(&mut self) {
        let top = self.main_top.to_string_lossy().to_string();
        self.remotes.clear();
        for l in git(&top, &["remote", "-v"]).unwrap_or_default().lines() {
            let mut f = l.split_whitespace();
            if let (Some(n), Some(u)) = (f.next(), f.next()) {
                if !self.remotes.iter().any(|(m, _)| m == n) {
                    self.remotes.push((n.to_string(), u.to_string()));
                }
            }
        }
        let refs = git(&top, &["for-each-ref", "--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)%09%(committerdate:unix)%09%(objectname)", "refs/heads"]).unwrap_or_default();
        self.branches = refs.lines().filter_map(|l| l.rsplit_once('\t')).map(|(row, tip)| (row.to_string(), tip.to_string())).collect();
        let heads: Vec<String> = self.wts.iter().map(|w| w.head.clone()).filter(|h| !h.is_empty() && !h.bytes().all(|b| b == b'0')).collect();
        // every commit on no remote, with its parents: one rev-list for all branches and worktrees
        self.graph.clear();
        if !self.remotes.is_empty() {
            let mut args = vec!["rev-list", "--parents", "--branches"];
            args.extend(heads.iter().map(String::as_str));
            args.extend(["--not", "--remotes"]);
            for l in git(&top, &args).unwrap_or_default().lines() {
                let mut f = l.split_whitespace();
                if let Some(c) = f.next() {
                    self.graph.insert(c.to_string(), f.map(str::to_string).collect());
                }
            }
        }
        self.when.clear();
        if !heads.is_empty() {
            let mut args = vec!["log", "--no-walk=unsorted", "--format=%H %ct"];
            args.extend(heads.iter().map(String::as_str));
            for l in git(&top, &args).unwrap_or_default().lines() {
                if let Some((h, t)) = l.split_once(' ') {
                    self.when.insert(h.to_string(), t.to_string());
                }
            }
        }
        self.refs_at = Some(Instant::now());
    }

    fn count(&self, tip: &str) -> u32 {
        let mut seen = HashSet::new();
        let mut stack = vec![tip];
        while let Some(c) = stack.pop() {
            let Some(parents) = self.graph.get(c) else { continue };
            if seen.insert(c) {
                stack.extend(parents.iter().map(String::as_str));
            }
        }
        seen.len() as u32
    }

    /// Read what changed (watched) or what this poll has not read yet (not watched). False: not a
    /// work tree git can read.
    fn refresh(&mut self, top: &Path, quick: bool) -> bool {
        let watched = self.ensure_watch();
        let mut d = std::mem::take(&mut *self.dirty.lock().unwrap());
        let now = Instant::now();
        let max = if watched { MAX_AGE } else { FRESH };
        let stale = |at: Option<Instant>, age: Duration| at.is_none_or(|t| now.duration_since(t) > age);
        // the list also carries each worktree's HEAD: read it again when refs or a worktree changed
        // (a commit moves HEAD), one cheap process
        let moved = d.refs || !d.tops.is_empty() || !d.names.is_empty();
        if (d.all || d.list || moved || stale(self.list_at, max)) && !self.read_list() {
            return false;
        }
        // the watch follows worktrees added since; what a new watch could not see is read now, in
        // this read (not left for the next one)
        if watched {
            if !self.ensure_watch() {
                self.dirty.lock().unwrap().all = true;
            }
            let more = std::mem::take(&mut *self.dirty.lock().unwrap());
            d.all |= more.all;
            d.refs |= more.refs;
            d.tops.extend(more.tops);
            d.names.extend(more.names);
        }
        let changed: HashSet<PathBuf> = d.tops.iter().cloned().chain(d.names.iter().filter_map(|n| self.names.get(n).cloned())).collect();
        let mut read_any = false;
        for w in self.wts.iter_mut() {
            let wp = PathBuf::from(&w.path);
            let mine = same_path(&wp, top);
            let wanted = mine || !quick;
            let read = if watched {
                // a changed worktree, one not read yet that this read needs, or one not read for long
                d.all || changed.iter().any(|c| same_path(c, &wp)) || (w.status.is_none() && wanted) || (w.status.is_some() && stale(w.read_at, MAX_AGE))
            } else {
                wanted && stale(w.read_at, FRESH)
            };
            if read && wp.is_dir() {
                w.status = Some(git(&w.path, &["status", "--porcelain=v2", "--branch"]).unwrap_or_default().lines().take(2000).map(str::to_string).collect());
                w.read_at = Some(now);
                read_any = true;
            }
        }
        // branches and commits on no remote: when refs moved, a worktree changed (it may have
        // committed), or not read for long
        if d.all || d.refs || d.list || read_any || stale(self.refs_at, max) {
            self.read_refs();
        }
        true
    }

    fn report(&self, top: &Path, quick: bool) -> String {
        use std::fmt::Write;
        let has_remote = !self.remotes.is_empty();
        let url = self.remotes.iter().find(|(n, _)| n == "origin").or(self.remotes.first()).map(|(_, u)| u.as_str()).unwrap_or("");
        let mut out = format!("@@url {url}\n@@remotes\n");
        for (n, _) in &self.remotes {
            let _ = writeln!(out, "{n}");
        }
        if quick {
            out.push_str("@@quick\n");
        }
        out.push_str("@@branches\n");
        if !quick {
            for (row, _) in &self.branches {
                let _ = writeln!(out, "{row}");
            }
        }
        out.push_str("@@unpushed\n");
        if !quick && has_remote {
            for (row, tip) in &self.branches {
                let _ = writeln!(out, "{}\t{}", row.split('\t').next().unwrap_or(""), self.count(tip));
            }
        }
        for w in &self.wts {
            let _ = writeln!(out, "@@worktree {}", w.path);
            // quick: this folder's worktree only, as before (the others' counts come with the full reads)
            let show = !quick || same_path(&PathBuf::from(&w.path), top);
            if let Some(st) = w.status.as_ref().filter(|_| show) {
                for l in st {
                    let _ = writeln!(out, "{l}");
                }
                let _ = writeln!(out, "@@last {}", self.when.get(&w.head).map(String::as_str).unwrap_or(""));
                if has_remote {
                    let _ = writeln!(out, "@@wtunpushed {}", if w.head.is_empty() { 0 } else { self.count(&w.head) });
                }
            }
            for f in &w.flags {
                let _ = writeln!(out, "@@{f}");
            }
        }
        out
    }
}

#[cfg(test)]
thread_local! {
    /// git processes this thread started (the tests count them)
    pub static CALLS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    fn run(dir: &Path, args: &[&str]) {
        let ok = Command::new("git").arg("-C").arg(dir).args(args).stdout(Stdio::null()).stderr(Stdio::null()).env("GIT_AUTHOR_NAME", "t").env("GIT_AUTHOR_EMAIL", "t@t").env("GIT_COMMITTER_NAME", "t").env("GIT_COMMITTER_EMAIL", "t@t").status().unwrap().success();
        assert!(ok, "git {args:?}");
    }
    fn calls() -> usize {
        CALLS.with(|c| c.get())
    }
    /// git processes `f` started on this thread
    fn counted<T>(f: impl FnOnce() -> T) -> (T, usize) {
        let c0 = calls();
        let v = f();
        (v, calls() - c0)
    }

    #[test]
    fn git_runs_only_where_something_changed() {
        let base = std::env::temp_dir().join(format!("sd-gitrepo-{}", std::process::id()));
        let repo = base.join("repo");
        std::fs::create_dir_all(repo.join("src")).unwrap();
        run(&base, &["init", "-q", "--bare", base.join("r.git").to_str().unwrap()]);
        run(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("src/a.ts"), "a").unwrap();
        run(&repo, &["add", "-A"]);
        run(&repo, &["commit", "-qm", "a"]);
        run(&repo, &["remote", "add", "origin", base.join("r.git").to_str().unwrap()]);
        run(&repo, &["push", "-q", "origin", "main"]);
        let wt = |n: usize| repo.join(".claude/worktrees").join(format!("w{n}"));
        for n in 0..12 {
            run(&repo, &["worktree", "add", "-q", wt(n).to_str().unwrap(), "-b", &format!("claude/w{n}")]);
        }
        let s = |p: &Path| p.to_string_lossy().to_string();
        let folders: Vec<String> = std::iter::once(s(&repo)).chain((0..12).map(|n| s(&wt(n)))).collect();

        // the first full read: the list, every worktree's status, the branches
        let (_, first) = counted(|| read(&folders[0], false));
        assert!(first <= 13 + 6, "first read: {first} processes");
        std::thread::sleep(Duration::from_millis(400));
        // nothing changed: every folder of the repository, quick and full, without git
        let (_, again) = counted(|| {
            for f in &folders {
                read(f, true);
            }
            read(&folders[0], false)
        });
        assert_eq!(again, 0, "nothing changed, yet git ran");

        // a file changes in w5: only w5's status (and the list and branches) is read again
        std::fs::write(wt(5).join("src/a.ts"), "changed").unwrap();
        let end = Instant::now() + Duration::from_secs(5);
        let mut spent = 0;
        loop {
            let (r, n) = counted(|| read(&s(&wt(5)), true));
            spent += n;
            if r.contains("\n1 ") {
                break;
            }
            assert!(Instant::now() < end, "w5's change not seen");
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(spent <= 1 + 1 + 4, "a change in one worktree cost {spent} processes");
        // the others are still known without git
        let (_, others) = counted(|| (0..12).filter(|n| *n != 5).for_each(|n| { read(&s(&wt(n)), true); }));
        assert_eq!(others, 0, "unchanged worktrees were read again");

        // a commit in w3: w3 and the branches, and the count of its commits on no remote is right
        std::fs::write(wt(3).join("src/b.ts"), "b").unwrap();
        run(&wt(3), &["add", "-A"]);
        run(&wt(3), &["commit", "-qm", "b"]);
        let end = Instant::now() + Duration::from_secs(5);
        while !read(&s(&wt(3)), true).contains("@@wtunpushed 1") {
            assert!(Instant::now() < end, "w3's commit not seen");
            std::thread::sleep(Duration::from_millis(50));
        }
        let full = read(&folders[0], false);
        assert!(full.contains("claude/w3\t1"), "the branch's commit on no remote: {full}");
        let _ = std::fs::remove_dir_all(&base);
    }
}
