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
    /// its one spelling (canon)
    top: PathBuf,
    head: String,
    flags: Vec<&'static str>,
    status: Option<Vec<String>>,
    read_at: Option<Instant>,
}

struct Repo {
    common: PathBuf,
    main_top: PathBuf,
    refs: Refs,
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

/// One spelling per folder. Windows names a folder many ways: short 8.3 names (RUNNER~1), any letter
/// case ("c:" from one tool, "C:" from git) and both slashes; a watch reports paths in the spelling
/// it was given. So every path here is canonicalized where it exists (without the `\\?\` prefix)
/// and compared case-blind on Windows, and the watches are set on these spellings.
fn canon(p: &Path) -> PathBuf {
    match std::fs::canonicalize(p) {
        Ok(c) => {
            let s = c.to_string_lossy().to_string();
            match s.strip_prefix(r"\\?\") {
                Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
                _ => c,
            }
        }
        Err(_) => p.to_path_buf(),
    }
}

/// The comparable form of a path: forward slashes, no trailing one, case-blind on Windows.
fn key(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    let s = s.trim_end_matches('/');
    if cfg!(windows) { s.to_lowercase() } else { s.to_string() }
}

/// `p` inside `root` (or the same): the rest of its path after root ("" for the same).
fn under(p: &Path, root: &Path) -> Option<String> {
    let (a, b) = (key(p), key(root));
    if a == b {
        return Some(String::new());
    }
    a.strip_prefix(&format!("{b}/")).map(str::to_string)
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
                refs: Refs::default(),
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
    let (top, common) = (canon(&top), canon(&common));
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
    if let Some(rel) = under(p, common) {
        let mut parts = rel.split('/').filter(|x| !x.is_empty()).map(str::to_string);
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
    match t.iter().filter(|top| under(p, top).is_some()).max_by_key(|top| key(top).len()) {
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
        for p in std::iter::once(self.common.clone()).chain(self.wts.iter().map(|w| w.top.clone())) {
            if !want.iter().any(|r| under(&p, r).is_some()) && p.is_dir() {
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
                next.push(old.map(|o| Wt { head: String::new(), flags: vec![], ..o }).unwrap_or_else(|| Wt { path: p.to_string(), top: canon(Path::new(p)), head: String::new(), flags: vec![], status: None, read_at: None }));
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
                        self.names.insert(e.file_name().to_string_lossy().to_string(), canon(top));
                    }
                }
            }
        }
        *self.tops.lock().unwrap() = self.wts.iter().map(|w| w.top.clone()).collect();
        self.list_at = Some(Instant::now());
        true
    }

    fn read_refs(&mut self) {
        let top = self.main_top.to_string_lossy().to_string();
        let r = &mut self.refs;
        r.remotes = Refs::remotes_from(&git(&top, &["remote", "-v"]).unwrap_or_default());
        r.branches = Refs::branches_from(&git(&top, &["for-each-ref", &format!("--format={REF_FORMAT}"), "refs/heads"]).unwrap_or_default());
        let heads: Vec<String> = self.wts.iter().map(|w| w.head.clone()).filter(|h| !h.is_empty() && !h.bytes().all(|b| b == b'0')).collect();
        // every commit on no remote, with its parents: one rev-list for all branches and worktrees
        r.graph = HashMap::new();
        if !r.remotes.is_empty() {
            let mut args = vec!["rev-list", "--parents", "--branches"];
            args.extend(heads.iter().map(String::as_str));
            args.extend(["--not", "--remotes"]);
            r.graph = Refs::graph_from(&git(&top, &args).unwrap_or_default());
        }
        r.when = HashMap::new();
        if !heads.is_empty() {
            let mut args = vec!["log", "--no-walk=unsorted", "--format=%H %ct"];
            args.extend(heads.iter().map(String::as_str));
            r.when = Refs::when_from(&git(&top, &args).unwrap_or_default());
        }
        self.refs_at = Some(Instant::now());
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
        let changed: HashSet<String> = d.tops.iter().map(|t| key(t)).chain(d.names.iter().filter_map(|n| self.names.get(n).map(|t| key(t)))).collect();
        let mut read_any = false;
        for w in self.wts.iter_mut() {
            let wp = w.top.clone();
            let mine = key(&wp) == key(top);
            let wanted = mine || !quick;
            let read = if watched {
                // a changed worktree, one not read yet that this read needs, or one not read for long
                d.all || changed.contains(&key(&wp)) || (w.status.is_none() && wanted) || (w.status.is_some() && stale(w.read_at, MAX_AGE))
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
        // quick: this folder's worktree only, as before (the others' counts come with the full reads)
        self.refs.render(self.wts.iter().map(|w| WtRow { path: &w.path, head: &w.head, flags: &w.flags, status: w.status.as_deref().filter(|_| !quick || key(&w.top) == key(top)) }), quick)
    }
}

/// The for-each-ref format the branches are read with: the rows `git::parse` reads, and the tip.
pub(super) const REF_FORMAT: &str = "%(refname:short)%09%(upstream:short)%09%(upstream:track)%09%(committerdate:unix)%09%(objectname)";

/// What one repository's refs say, read here or on a machine over ssh (claude/gitremote.rs).
#[derive(Default)]
pub(super) struct Refs {
    pub remotes: Vec<(String, String)>,
    /// for-each-ref rows (name, upstream, track, date) and the tip
    pub branches: Vec<(String, String)>,
    /// commits on no remote → their parents
    pub graph: HashMap<String, Vec<String>>,
    /// commit → its time (the worktrees' HEADs)
    pub when: HashMap<String, String>,
}

/// A worktree as the report shows it; `status` only where it is shown.
pub(super) struct WtRow<'a> {
    pub path: &'a str,
    pub head: &'a str,
    pub flags: &'a [&'static str],
    pub status: Option<&'a [String]>,
}

impl Refs {
    /// `git remote -v`: (name, url), the first url of each name
    pub fn remotes_from(text: &str) -> Vec<(String, String)> {
        let mut out: Vec<(String, String)> = vec![];
        for l in text.lines() {
            let mut f = l.split_whitespace();
            if let (Some(n), Some(u)) = (f.next(), f.next()) {
                if !out.iter().any(|(m, _)| m == n) {
                    out.push((n.to_string(), u.to_string()));
                }
            }
        }
        out
    }

    /// for-each-ref with REF_FORMAT: (row, tip)
    pub fn branches_from(text: &str) -> Vec<(String, String)> {
        text.lines().filter_map(|l| l.rsplit_once('\t')).map(|(row, tip)| (row.to_string(), tip.to_string())).collect()
    }

    /// `rev-list --parents`: commit → parents
    pub fn graph_from(text: &str) -> HashMap<String, Vec<String>> {
        let mut g = HashMap::new();
        for l in text.lines() {
            let mut f = l.split_whitespace();
            if let Some(c) = f.next() {
                g.insert(c.to_string(), f.map(str::to_string).collect());
            }
        }
        g
    }

    /// `log --format=%H %ct`: commit → time
    pub fn when_from(text: &str) -> HashMap<String, String> {
        text.lines().filter_map(|l| l.split_once(' ')).map(|(h, t)| (h.to_string(), t.to_string())).collect()
    }

    /// Commits reachable from `tip` that are on no remote.
    pub fn count(&self, tip: &str) -> u32 {
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

    /// The report `git::parse` reads (the sections the shell script printed).
    pub fn render<'a>(&self, wts: impl Iterator<Item = WtRow<'a>>, quick: bool) -> String {
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
        for w in wts {
            let _ = writeln!(out, "@@worktree {}", w.path);
            if let Some(st) = w.status {
                for l in st {
                    let _ = writeln!(out, "{l}");
                }
                let _ = writeln!(out, "@@last {}", self.when.get(w.head).map(String::as_str).unwrap_or(""));
                if has_remote {
                    let _ = writeln!(out, "@@wtunpushed {}", if w.head.is_empty() { 0 } else { self.count(w.head) });
                }
            }
            for f in w.flags {
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

    /// A folder asked for in another spelling than git prints (here a symlink; on Windows a short
    /// 8.3 name or another letter case) is still cached: one canonical spelling for everything.
    #[cfg(unix)]
    #[test]
    fn another_spelling_of_the_same_folder() {
        let base = std::env::temp_dir().join(format!("sd-gitspell-{}", std::process::id()));
        let real = base.join("real");
        let repo = real.join("repo");
        std::fs::create_dir_all(repo.join("src")).unwrap();
        run(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("src/a.ts"), "a").unwrap();
        run(&repo, &["add", "-A"]);
        run(&repo, &["commit", "-qm", "a"]);
        let wt = repo.join(".claude/worktrees/w1");
        run(&repo, &["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "w1"]);
        std::os::unix::fs::symlink(&real, base.join("link")).unwrap();
        let via = |p: &Path| base.join("link").join(p.strip_prefix(&real).unwrap()).to_string_lossy().to_string();
        read(&via(&repo), false);
        std::thread::sleep(Duration::from_millis(400));
        let (_, n) = counted(|| {
            read(&via(&repo), true);
            read(&via(&wt), true)
        });
        assert_eq!(n, 0, "the same folders in another spelling ran git again");
        // and a change still reaches the right worktree
        std::fs::write(wt.join("src/a.ts"), "changed").unwrap();
        let end = Instant::now() + Duration::from_secs(5);
        while !read(&via(&wt), true).contains("\n1 ") {
            assert!(Instant::now() < end, "the change in the worktree was not seen");
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = std::fs::remove_dir_all(&base);
    }
}
