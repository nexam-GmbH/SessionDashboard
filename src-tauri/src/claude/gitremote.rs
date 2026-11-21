//! Git state of folders on a machine over ssh, kept between polls and read again only where
//! something changed: the remote counterpart of claude/gitrepo.rs.
//!
//! There are no change events from a machine, so each poll asks, in one ssh round trip for all
//! its folders, "did anything change since the last read?" and reads git only where the answer is
//! yes. The question is one `find` per repository (no git): is any file or folder newer (ctime)
//! than the time of the last read, in the shared `.git` (refs, packed-refs, HEADs, indexes,
//! config, the worktree list; not objects or logs) or in the worktrees the report shows (an edited
//! file has a new ctime, a new or deleted file changes its folder's). Folders git ignores whole
//! (node_modules, target) are left out of the walk, as git leaves them out of `git status`, and so
//! are other worktrees inside a worktree. A worktree that appears or goes changes the shared
//! `.git`; one that is deleted by hand fails an existence check. Global git settings are not
//! watched: a full read every 5 minutes covers them, and anything a check could miss.
//!
//! The reference time is the machine's own clock at the start of the read, one second early, so a
//! file changed while git was reading (or in the same clock tick, git's "racy" case) still counts
//! as changed next time. Where find has no `-newerct` (busybox), every poll reads, as before.
//!
//! A read itself is per repository too: the folders of one repository share it (all its folders
//! for a full read, the folders of one worktree for a quick one), and it runs one git process per
//! kind of thing (remotes, worktree list, branches, commits on no remote, commit times) plus
//! `git status` per shown worktree, instead of a few processes per worktree and one per branch.
//! The report is the same one `git::parse` reads (gitrepo::Refs::render).

use super::git::{parse, GitState};
use super::gitrepo::{Refs, WtRow};
use super::remote::shell_quote;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// A full read at least this often, whatever the checks say.
const MAX_AGE: Duration = Duration::from_secs(300);
/// Repositories nobody asked about for this long are forgotten.
const FORGET: Duration = Duration::from_secs(3600);

/// The shell side, defined once per poll. `sd_loc DIR MODE` goes into a folder and finds its
/// repository from the disk alone (no git): prints `@@nodir`, or `@@key MODE<TAB>COMMON<TAB>TOP`
/// (TOP only for a quick read) and then `@@dup` when this poll already answered that key.
/// `sd_read MODE` reads the repository (the sections `parse_read` takes apart).
const FUNCS: &str = r#"export GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0
NL='
'
TAB=$(printf '\t')
seen=$NL; now=; F=; k=
sd_probe() { [ -n "$(find / -maxdepth 0 -newerct @0 -print 2>/dev/null)" ] && F=find; }
sd_loc() {
  cd -P "$1" 2>/dev/null || { echo "@@nodir"; return 1; }
  d=$PWD; C=; W=
  while :; do
    if [ -d "$d/.git" ]; then W=$d; C=$d/.git; break; fi
    if [ -f "$d/.git" ]; then
      W=$d; g=; IFS= read -r g < "$d/.git"; g=${g#gitdir: }
      case $g in /*) ;; *) g=$d/$g ;; esac
      if [ -f "$g/commondir" ]; then c=; IFS= read -r c < "$g/commondir"; case $c in /*) C=$c ;; *) C=$g/$c ;; esac; else C=$g; fi
      break
    fi
    [ -n "$d" ] || break
    d=${d%/*}
  done
  if [ -z "$W" ]; then sd_read "$2"; return 1; fi
  if cd -P "$C" 2>/dev/null; then C=$PWD; fi
  cd -P "$1" 2>/dev/null
  if [ "$2" = quick ]; then k=$2$TAB$C$TAB$W; else k=$2$TAB$C$TAB; fi
  echo "@@key $k"
  case $seen in *"$NL$k$NL"*) echo "@@dup"; return 1 ;; esac
  seen=$seen$k$NL
  return 0
}
sd_same() { [ -n "$F" ] && [ "$k" = "$1" ]; }
sd_read() {
  t=$(git rev-parse --is-inside-work-tree --show-toplevel 2>/dev/null) || { echo "@@norepo"; return; }
  top=${t#*"$NL"}
  [ -n "$now" ] || now=$(( $(date +%s) - 1 ))
  echo "@@read $now"
  rv=$(git remote -v 2>/dev/null)
  echo "@@remotes"; [ -n "$rv" ] && printf '%s\n' "$rv"
  wl=$(git worktree list --porcelain 2>/dev/null)
  heads=; cur=
  while IFS= read -r l; do
    case $l in
      "worktree "*) cur=${l#worktree } ;;
      "HEAD "*) h=${l#HEAD }
        case $h in *[!0]*) if [ "$1" != quick ] || [ "$cur" = "$top" ]; then heads="$heads $h"; fi ;; esac ;;
    esac
  done <<EOF
$wl
EOF
  if [ "$1" != quick ]; then echo "@@refs"; git for-each-ref --format='%(refname:short)%09%(upstream:short)%09%(upstream:track)%09%(committerdate:unix)%09%(objectname)' refs/heads 2>/dev/null; fi
  if [ -n "$rv" ]; then
    echo "@@graph"
    if [ "$1" != quick ]; then git rev-list --parents --branches $heads --not --remotes 2>/dev/null
    elif [ -n "$heads" ]; then git rev-list --parents $heads --not --remotes 2>/dev/null; fi
  fi
  if [ -n "$heads" ]; then echo "@@when"; git log --no-walk=unsorted --format='%H %ct' $heads 2>/dev/null; fi
  while IFS= read -r l; do
    case $l in
      "worktree "*) wt=${l#worktree }; echo "@@worktree $wt"
        if [ -d "$wt" ] && { [ "$1" != quick ] || [ "$wt" = "$top" ]; }; then
          echo "@@status"; git -C "$wt" status --porcelain=v2 --branch 2>/dev/null | head -n 2000
          git -C "$wt" ls-files -o -i --exclude-standard --directory 2>/dev/null | awk '/^[^"].*\/$/ { if (n++ < 300) print "@@ign " $0 }'
        fi ;;
      "HEAD "*) echo "@@head ${l#HEAD }" ;;
      locked*) echo "@@locked" ;;
      prunable*) echo "@@prunable" ;;
    esac
  done <<EOF
$wl
EOF
}
"#;

struct Entry {
    report: String,
    /// the shell test that says nothing changed since the read (None: read every time)
    check: Option<String>,
    at: Instant,
    used: Instant,
}

#[derive(Default)]
struct HostCache {
    /// "MODE<TAB>folder" → the key its repository answered with
    keys: HashMap<String, String>,
    entries: HashMap<String, Entry>,
}

static CACHE: Mutex<Option<HashMap<String, HostCache>>> = Mutex::new(None);

fn mode(quick: bool) -> &'static str {
    if quick { "quick" } else { "full" }
}

/// A folder as a shell word: `~/x` stays relative to the machine's home.
fn dir_arg(p: &str) -> String {
    p.strip_prefix("~/").map(|r| format!("\"$HOME\"/{}", shell_quote(r))).unwrap_or_else(|| shell_quote(p))
}

/// A literal path in a `find -path` pattern.
fn glob_esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '\\' | '*' | '?' | '[') {
            o.push('\\');
        }
        o.push(c);
    }
    o
}

/// The poll's script: the functions, then one line per folder.
fn build(hc: &HostCache, paths: &[String], quick: bool) -> String {
    let m = mode(quick);
    let mut lines = Vec::with_capacity(paths.len());
    let mut any_check = false;
    for p in paths {
        let cached = hc.keys.get(&format!("{m}\t{p}")).and_then(|k| hc.entries.get(k).map(|e| (k, e))).filter(|(_, e)| e.at.elapsed() < MAX_AGE).and_then(|(k, e)| e.check.as_ref().map(|c| (k, c)));
        let d = dir_arg(p);
        lines.push(match cached {
            Some((k, check)) => {
                any_check = true;
                format!("echo '@@@repo'; if sd_loc {d} {m}; then if sd_same {} && {check}; then echo '@@same'; else sd_read {m}; fi; fi", shell_quote(k))
            }
            None => format!("echo '@@@repo'; if sd_loc {d} {m}; then sd_read {m}; fi"),
        });
    }
    let mut s = String::from(FUNCS);
    if any_check {
        s.push_str("sd_probe\n");
    }
    for l in lines {
        s.push_str(&l);
        s.push('\n');
    }
    s
}

#[derive(Default)]
struct RWt {
    path: String,
    head: String,
    flags: Vec<&'static str>,
    status: Option<Vec<String>>,
    ign: Vec<String>,
}

/// One `sd_read` answer: (the reference time, the report, the worktrees).
fn parse_read(out: &str, quick: bool) -> Option<(i64, String, Vec<RWt>)> {
    let mut lines = out.lines();
    let t: i64 = lines.next()?.strip_prefix("@@read ")?.trim().parse().ok()?;
    let (mut remotes, mut refs, mut graph, mut when) = (String::new(), String::new(), String::new(), String::new());
    let mut wts: Vec<RWt> = vec![];
    let mut section = "";
    for l in lines {
        if let Some(rest) = l.strip_prefix("@@") {
            if let Some(p) = rest.strip_prefix("worktree ") {
                wts.push(RWt { path: p.to_string(), ..Default::default() });
                section = "";
            } else if let Some(h) = rest.strip_prefix("head ") {
                if let Some(w) = wts.last_mut() {
                    w.head = h.to_string();
                }
            } else if let Some(i) = rest.strip_prefix("ign ") {
                if let Some(w) = wts.last_mut() {
                    w.ign.push(i.trim_end_matches('/').to_string());
                }
            } else {
                match rest {
                    "locked" | "prunable" => {
                        if let Some(w) = wts.last_mut() {
                            w.flags.push(if rest == "locked" { "locked" } else { "prunable" });
                        }
                    }
                    "status" => {
                        if let Some(w) = wts.last_mut() {
                            w.status = Some(vec![]);
                        }
                        section = "status";
                    }
                    s => section = s,
                }
            }
            continue;
        }
        let buf = match section {
            "remotes" => &mut remotes,
            "refs" => &mut refs,
            "graph" => &mut graph,
            "when" => &mut when,
            "status" => {
                if let Some(st) = wts.last_mut().and_then(|w| w.status.as_mut()) {
                    st.push(l.to_string());
                }
                continue;
            }
            _ => continue,
        };
        buf.push_str(l);
        buf.push('\n');
    }
    let r = Refs { remotes: Refs::remotes_from(&remotes), branches: Refs::branches_from(&refs), graph: Refs::graph_from(&graph), when: Refs::when_from(&when) };
    let report = r.render(wts.iter().map(|w| WtRow { path: &w.path, head: &w.head, flags: &w.flags, status: w.status.as_deref() }), quick);
    Some((t, report, wts))
}

/// The shell test that holds while nothing the report shows changed since `t` (None: no test is
/// possible, read every time).
fn check_for(common: &str, t: i64, wts: &[RWt]) -> Option<String> {
    let scanned: Vec<&RWt> = wts.iter().filter(|w| w.status.is_some()).collect();
    if scanned.is_empty() || common.is_empty() || t <= 0 {
        return None;
    }
    // find says nothing of a start it cannot read: the shared .git must still be there
    let mut parts: Vec<String> = vec![format!("[ -d {} ]", shell_quote(common))];
    // a worktree deleted (or put back) by hand: git's "prunable" follows its .git file
    for w in wts {
        let g = shell_quote(&format!("{}/.git", w.path));
        parts.push(if w.flags.contains(&"prunable") { format!("[ ! -e {g} ]") } else { format!("[ -e {g} ]") });
    }
    let c = glob_esc(common);
    let mut starts = vec![shell_quote(&format!("{common}/."))];
    let mut prune = vec!["-name .git".to_string()];
    for sub in ["objects", "logs", "hooks", "lfs", "modules/*/objects", "modules/*/logs", "worktrees/*/logs"] {
        prune.push(format!("-path {}", shell_quote(&format!("{c}/./{sub}"))));
    }
    for s in &scanned {
        starts.push(shell_quote(&format!("{}/.", s.path)));
        let base = glob_esc(&s.path);
        let rel = |r: &str| format!("-path {}", shell_quote(&format!("{base}/./{}", glob_esc(r))));
        for i in &s.ign {
            prune.push(rel(i));
        }
        // other worktrees inside this one are their own (git shows them as one untracked folder)
        for o in wts {
            if let Some(r) = o.path.strip_prefix(&format!("{}/", s.path)) {
                prune.push(rel(r));
            }
        }
    }
    parts.push(format!("[ -z \"$($F {} '(' {} ')' -prune -o -newerct @{t} -print -quit 2>/dev/null)\" ]", starts.join(" "), prune.join(" -o ")));
    Some(parts.join(" && "))
}

/// Git state of folders on a machine, one ssh round trip, git only where something changed.
pub fn read(host: &str, paths: &[String], quick: bool) -> Vec<GitState> {
    let script = {
        let mut g = CACHE.lock().unwrap();
        let hc = g.get_or_insert_with(HashMap::new).entry(host.to_string()).or_default();
        hc.entries.retain(|_, e| e.used.elapsed() < FORGET);
        build(hc, paths, quick)
    };
    let out = match super::remote::run(host, "eval \"$(cat)\"", Some(script.as_bytes()), Duration::from_secs(25)) {
        Ok(o) => String::from_utf8_lossy(&o).into_owned(),
        Err(e) => return paths.iter().map(|p| GitState { path: p.clone(), error: Some(e.clone()), ..Default::default() }).collect(),
    };
    let mut g = CACHE.lock().unwrap();
    let hc = g.get_or_insert_with(HashMap::new).entry(host.to_string()).or_default();
    answer(hc, paths, quick, &out)
}

/// The poll's output, folder by folder, with the cache: what came back read, and what did not
/// change from before.
fn answer(hc: &mut HostCache, paths: &[String], quick: bool, out: &str) -> Vec<GitState> {
    let m = mode(quick);
    let parts: Vec<&str> = out.split("@@@repo\n").skip(1).collect();
    let now = Instant::now();
    paths
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let part = parts.get(i).copied().unwrap_or("");
            let fkey = format!("{m}\t{p}");
            let Some(rest) = part.strip_prefix("@@key ") else {
                // gone, no repository, or (rarely) one only git itself finds: as it is, not kept
                hc.keys.remove(&fkey);
                let report = if part.starts_with("@@read ") { parse_read(part, quick).map(|(_, r, _)| r).unwrap_or_default() } else { part.to_string() };
                return parse(p, &report);
            };
            let (key, body) = rest.split_once('\n').unwrap_or((rest, ""));
            hc.keys.insert(fkey.clone(), key.to_string());
            if body.starts_with("@@same") || body.starts_with("@@dup") {
                if let Some(e) = hc.entries.get_mut(key) {
                    e.used = now;
                    return parse(p, &e.report);
                }
                hc.keys.remove(&fkey);
                return GitState { path: p.clone(), error: Some("git state not read yet".into()), ..Default::default() };
            }
            match parse_read(body, quick) {
                Some((t, report, wts)) => {
                    let common = key.split('\t').nth(1).unwrap_or("");
                    let check = check_for(common, t, &wts);
                    let st = parse(p, &report);
                    hc.entries.insert(key.to_string(), Entry { report, check, at: now, used: now });
                    st
                }
                // git says no repository after all (e.g. not a safe directory): as it is, asked again next poll
                None => {
                    let st = parse(p, body);
                    hc.entries.insert(key.to_string(), Entry { report: body.to_string(), check: None, at: now, used: now });
                    st
                }
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};

    fn run(dir: &Path, args: &[&str]) {
        let ok = Command::new("git").arg("-C").arg(dir).args(args).stdout(Stdio::null()).stderr(Stdio::null()).env("GIT_AUTHOR_NAME", "t").env("GIT_AUTHOR_EMAIL", "t@t").env("GIT_COMMITTER_NAME", "t").env("GIT_COMMITTER_EMAIL", "t@t").status().unwrap().success();
        assert!(ok, "git {args:?}");
    }
    fn s(p: &Path) -> String {
        p.to_string_lossy().to_string()
    }

    #[test]
    fn find_patterns_are_literal() {
        assert_eq!(glob_esc("/a/[x]*?\\b"), "/a/\\[x]\\*\\?\\\\b");
    }

    /// A machine whose ssh is the fake one from SD_SSH, with a home of its own: `git` there (the
    /// first in the PATH the remote script sets up) logs each run to `<home>/git.log`.
    struct Machine {
        home: PathBuf,
        host: String,
    }

    impl Machine {
        fn new(name: &str) -> Machine {
            let fake = std::env::var("SD_SSH").expect("SD_SSH: a fake ssh that runs the command here");
            let home = std::env::temp_dir().join(format!("sd-gitremote-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&home);
            std::fs::create_dir_all(home.join(".local/bin")).unwrap();
            let real = String::from_utf8(Command::new("sh").args(["-c", "command -v git"]).output().unwrap().stdout).unwrap();
            let wrap = home.join(".local/bin/git");
            std::fs::write(&wrap, format!("#!/bin/sh\necho \"$*\" >> {}\nexec {} \"$@\"\n", shell_quote(&s(&home.join("git.log"))), real.trim())).unwrap();
            let ssh = home.join("ssh");
            std::fs::write(&ssh, format!("#!/bin/sh\nHOME={} exec {} \"$@\"\n", shell_quote(&s(&home)), shell_quote(&fake))).unwrap();
            for f in [&wrap, &ssh] {
                Command::new("chmod").arg("+x").arg(f).status().unwrap();
            }
            // each machine its own host name, so the tests do not share a cache
            Machine { host: format!("fake-{name}"), home }
        }
        fn read(&self, paths: &[String], quick: bool) -> (Vec<GitState>, Vec<String>) {
            let log = self.home.join("git.log");
            let _ = std::fs::remove_file(&log);
            let r = super::super::remote::with_ssh(&s(&self.home.join("ssh")), || read(&self.host, paths, quick));
            (r, std::fs::read_to_string(&log).unwrap_or_default().lines().map(str::to_string).collect())
        }
    }

    fn json(g: &GitState) -> String {
        serde_json::to_string(g).unwrap()
    }

    /// A repository with a remote, a pushed main, a few branches, and two worktrees (one inside
    /// the main folder, one beside it), an ignored node_modules and a change.
    fn fixture(base: &Path) -> (PathBuf, PathBuf, PathBuf) {
        let main = base.join("repo");
        std::fs::create_dir_all(main.join("src")).unwrap();
        std::fs::create_dir_all(main.join("node_modules/p")).unwrap();
        run(base, &["init", "-q", "--bare", &s(&base.join("remote.git"))]);
        run(&main, &["init", "-q", "-b", "main"]);
        std::fs::write(main.join(".gitignore"), "node_modules/\n.claude/\n").unwrap();
        std::fs::write(main.join("src/a.ts"), "a").unwrap();
        std::fs::write(main.join("node_modules/p/x.js"), "x").unwrap();
        run(&main, &["add", "-A"]);
        run(&main, &["commit", "-qm", "a"]);
        run(&main, &["remote", "add", "origin", &s(&base.join("remote.git"))]);
        run(&main, &["push", "-q", "-u", "origin", "main"]);
        run(&main, &["branch", "old"]);
        let inner = main.join(".claude/worktrees/w1");
        run(&main, &["worktree", "add", "-q", &s(&inner), "-b", "claude/w1"]);
        let beside = base.join("repo-w2");
        run(&main, &["worktree", "add", "-q", &s(&beside), "-b", "claude/w2"]);
        std::fs::write(beside.join("src/b.ts"), "b").unwrap();
        run(&beside, &["add", "-A"]);
        run(&beside, &["commit", "-qm", "b"]);
        std::fs::write(inner.join("src/a.ts"), "changed").unwrap();
        (main, inner, beside)
    }

    /// The old script's report, run here, for the same folders.
    fn old(paths: &[String], quick: bool) -> Vec<String> {
        paths.iter().map(|p| json(&parse(p, &super::super::git::local_script(p, quick)))).collect()
    }

    /// Over the fake ssh (`SD_SSH=… cargo test --lib gitremote -- --ignored`): the same answers as
    /// the old script, then no git for what did not change, and every kind of change seen at once.
    #[test]
    #[ignore]
    fn reads_only_what_changed_over_fake_ssh() {
        let mach = Machine::new("changes");
        let base = mach.home.join("srv");
        std::fs::create_dir_all(&base).unwrap();
        let (main, inner, beside) = fixture(&base);
        let plain = base.join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        let folders: Vec<String> = vec![s(&main), s(&main.join("src")), s(&inner), s(&beside), s(&plain), s(&base.join("gone"))];
        // a read counts what changed since a second before it began: let the setup settle
        let settle = || std::thread::sleep(Duration::from_millis(2100));
        settle();
        for quick in [false, true] {
            let (first, log) = mach.read(&folders, quick);
            let got: Vec<String> = first.iter().map(json).collect();
            assert_eq!(got, old(&folders, quick), "first read, quick={quick}");
            // one read per repository (full) or worktree (quick); a folder of a worktree already read shares it
            let statuses = log.iter().filter(|l| l.contains(" status ")).count();
            assert_eq!(statuses, 3, "quick={quick}: {log:#?}");
        }
        for quick in [false, true] {
            let (again, log) = mach.read(&folders, quick);
            // the folder without a repository still asks git (as before), nothing else does
            assert!(log.iter().all(|l| l.starts_with("rev-parse")), "nothing changed, quick={quick}, yet: {log:#?}");
            assert!(log.len() <= 1, "{log:#?}");
            assert_eq!(again.iter().map(json).collect::<Vec<_>>(), old(&folders, quick), "cached, quick={quick}");
        }
        let gone = mach.read(&folders, false).0;
        assert_eq!(gone[5].error.as_deref(), Some("folder not found"));

        let full = |m: &Machine| m.read(&folders, false);
        let quick = |m: &Machine| m.read(&folders, true);
        // an edited tracked file (in place: its folder does not change)
        std::fs::write(main.join("src/a.ts"), "edited").unwrap();
        let (r, log) = full(&mach);
        assert_eq!(r[0].worktrees[0].changed, 1, "edited file: {log:#?}");
        let (r, _) = quick(&mach);
        assert_eq!(r[0].worktrees[0].changed, 1);
        // a new untracked file
        std::fs::write(beside.join("new.txt"), "n").unwrap();
        let (r, _) = quick(&mach);
        assert_eq!(r[3].worktrees.iter().find(|w| w.path == s(&beside)).unwrap().untracked, 1, "new file");
        // a new commit
        std::fs::write(inner.join("src/c.ts"), "c").unwrap();
        run(&inner, &["add", "-A"]);
        run(&inner, &["commit", "-qm", "c"]);
        let (r, _) = full(&mach);
        assert_eq!(r[0].branches.iter().find(|b| b.name == "claude/w1").unwrap().unpushed, 1, "new commit");
        let (r, _) = quick(&mach);
        assert_eq!(r[2].worktrees.iter().find(|w| w.path == s(&inner)).unwrap().unpushed, 1, "new commit, quick");
        // a new branch
        run(&main, &["branch", "fresh"]);
        let (r, _) = full(&mach);
        assert!(r[3].branches.iter().any(|b| b.name == "fresh"), "new branch");
        // a new worktree, then one deleted by hand
        let w3 = base.join("repo-w3");
        run(&main, &["worktree", "add", "-q", &s(&w3), "-b", "w3"]);
        let (r, _) = quick(&mach);
        assert!(r[0].worktrees.iter().any(|w| w.path == s(&w3)), "new worktree");
        std::fs::remove_dir_all(&w3).unwrap();
        let (r, _) = quick(&mach);
        assert!(r[0].worktrees.iter().find(|w| w.path == s(&w3)).is_some_and(|w| w.prunable), "deleted worktree");
        // a change inside an ignored folder costs no read
        settle();
        full(&mach);
        std::fs::write(main.join("node_modules/p/z.js"), "z").unwrap();
        std::fs::create_dir_all(main.join("node_modules/q")).unwrap();
        let (_, log) = full(&mach);
        assert!(log.iter().all(|l| l.starts_with("rev-parse")), "a change in node_modules made a read: {log:#?}");
        // nor does one inside a worktree to the main folder's quick read (only w1's own)
        settle();
        quick(&mach);
        std::fs::write(inner.join("src/a.ts"), "again").unwrap();
        let (_, log) = quick(&mach);
        assert_eq!(log.iter().filter(|l| l.contains(" status ")).count(), 1, "{log:#?}");
        // and all of it is what the old script says
        for q in [false, true] {
            let (r, _) = mach.read(&folders, q);
            assert_eq!(r.iter().map(json).collect::<Vec<_>>(), old(&folders, q), "at the end, quick={q}");
        }
        let _ = std::fs::remove_dir_all(&mach.home);
    }

    /// The same answers as the old script on real repositories, full and quick
    /// (`SD_SSH=… SD_GIT_REPOS=a:b cargo test --lib same_as_the_old_script -- --ignored`).
    #[test]
    #[ignore]
    fn same_as_the_old_script_over_fake_ssh() {
        let repos: Vec<String> = std::env::var("SD_GIT_REPOS").expect("SD_GIT_REPOS: repositories to compare, a:b:c").split(':').filter(|r| !r.is_empty()).map(str::to_string).collect();
        let mach = Machine::new("same");
        for quick in [false, true] {
            let (got, _) = mach.read(&repos, quick);
            assert_eq!(got.iter().map(json).collect::<Vec<_>>(), old(&repos, quick), "quick={quick}");
            let (again, _) = mach.read(&repos, quick);
            assert_eq!(again.iter().map(json).collect::<Vec<_>>(), old(&repos, quick), "cached, quick={quick}");
        }
        let _ = std::fs::remove_dir_all(&mach.home);
    }

    /// One poll of 20 folders (5 repositories, each with 3 worktrees; the main folders twice):
    /// the old script, the new first read, and the new read when nothing changed
    /// (`SD_SSH=… cargo test --lib poll_time -- --ignored --nocapture`).
    #[test]
    #[ignore]
    fn poll_time_over_fake_ssh() {
        let mach = Machine::new("time");
        let base = mach.home.join("srv");
        let mut folders = vec![];
        for r in 0..5 {
            let b = base.join(format!("r{r}"));
            std::fs::create_dir_all(&b).unwrap();
            let (main, inner, beside) = fixture(&b);
            for i in 0..200 {
                std::fs::create_dir_all(main.join(format!("src/d{}", i % 20))).unwrap();
                std::fs::write(main.join(format!("src/d{}/f{i}.ts", i % 20)), "x").unwrap();
            }
            run(&main, &["add", "-A"]);
            run(&main, &["commit", "-qm", "files"]);
            for n in 0..6 {
                run(&main, &["branch", &format!("b{n}")]);
            }
            folders.extend([s(&main), s(&inner), s(&beside), s(&main.join("src"))]);
        }
        assert_eq!(folders.len(), 20);
        std::thread::sleep(Duration::from_millis(2100));
        let time = |f: &dyn Fn()| {
            let t = Instant::now();
            f();
            t.elapsed()
        };
        for quick in [false, true] {
            let _ = std::fs::remove_file(mach.home.join("git.log"));
            let old_t = time(&|| {
                super::super::remote::with_ssh(&s(&mach.home.join("ssh")), || super::super::git::remote_old(&mach.host, &folders, quick));
            });
            let old_n = std::fs::read_to_string(mach.home.join("git.log")).unwrap_or_default().lines().count();
            let _ = std::fs::remove_file(mach.home.join("git.log"));
            let t0 = Instant::now();
            let (_, first) = mach.read(&folders, quick);
            let first_t = t0.elapsed();
            let t1 = Instant::now();
            let (_, again) = mach.read(&folders, quick);
            let again_t = t1.elapsed();
            println!("quick={quick}: old script {old_t:?} ({old_n} git), new first read {first_t:?} ({} git), new unchanged {again_t:?} ({} git)", first.len(), again.len());
        }
        let _ = std::fs::remove_dir_all(&mach.home);
    }
}
