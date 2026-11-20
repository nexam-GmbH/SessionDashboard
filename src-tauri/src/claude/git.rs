//! Git state per project, for "loose ends": uncommitted changes, commits that are on no remote,
//! branches without an upstream and worktrees nobody went back to. Plain `git` commands, run
//! locally or over ssh on a VPS (one script, one round trip).

use serde::Serialize;
use std::process::Stdio;
use std::time::Duration;

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    pub branch: Option<String>,
    pub main: bool,
    pub changed: u32,
    pub untracked: u32,
    /// commits on this worktree's HEAD that are on no remote
    pub unpushed: u32,
    pub ahead: u32,
    pub behind: u32,
    pub upstream: Option<String>,
    pub last_commit_ms: u64,
    pub locked: bool,
    pub prunable: bool,
}

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub name: String,
    pub upstream: Option<String>,
    /// commits on no remote
    pub unpushed: u32,
    /// the upstream branch was deleted
    pub gone: bool,
    pub last_commit_ms: u64,
}

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitState {
    pub path: String,
    pub is_repo: bool,
    pub has_remote: bool,
    /// origin's URL (or the first remote's): who this repository is, whatever folder it is in
    pub remote_url: Option<String>,
    pub worktrees: Vec<Worktree>,
    pub branches: Vec<Branch>,
    pub error: Option<String>,
}

// One POSIX script for both local and ssh: sections separated by marker lines. `$2 = quick`: only
// the folder's own worktree (status, last commit, unpushed), no per-branch counts and no other
// worktrees: a handful of git processes instead of hundreds in a repo with many worktrees.
const SCRIPT: &str = r#"
cd "$1" 2>/dev/null || { echo "@@nodir"; exit 0; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "@@norepo"; exit 0; }
quick="$2"
top="$(git rev-parse --show-toplevel 2>/dev/null)"
echo "@@url $(git remote get-url origin 2>/dev/null || git remote get-url "$(git remote 2>/dev/null | head -n 1)" 2>/dev/null)"
echo "@@remotes"; git remote 2>/dev/null
[ "$quick" = quick ] && echo "@@quick"
echo "@@branches"; [ "$quick" = quick ] || git for-each-ref --format='%(refname:short)%09%(upstream:short)%09%(upstream:track)%09%(committerdate:unix)' refs/heads 2>/dev/null
echo "@@unpushed"
if [ "$quick" != quick ] && [ -n "$(git remote 2>/dev/null)" ]; then
  git for-each-ref --format='%(refname:short)' refs/heads 2>/dev/null | while read -r b; do
    printf '%s\t%s\n' "$b" "$(git rev-list --count "refs/heads/$b" --not --remotes 2>/dev/null || echo 0)"
  done
fi
git worktree list --porcelain 2>/dev/null | while IFS= read -r line; do
  case "$line" in
    "worktree "*)
      wt="${line#worktree }"
      echo "@@worktree $wt"
      if [ -d "$wt" ] && { [ "$quick" != quick ] || [ "$wt" = "$top" ]; }; then
        git -C "$wt" status --porcelain=v2 --branch 2>/dev/null | head -n 2000
        echo "@@last $(git -C "$wt" log -1 --format=%ct 2>/dev/null)"
        if [ -n "$(git remote 2>/dev/null)" ]; then echo "@@wtunpushed $(git -C "$wt" rev-list --count HEAD --not --remotes 2>/dev/null)"; fi
      fi ;;
    locked*) echo "@@locked" ;;
    prunable*) echo "@@prunable" ;;
  esac
done
"#;

fn parse(path: &str, out: &str) -> GitState {
    let mut st = GitState { path: path.to_string(), ..Default::default() };
    if out.starts_with("@@nodir") {
        st.error = Some("folder not found".into());
        return st;
    }
    if out.starts_with("@@norepo") {
        return st;
    }
    st.is_repo = true;
    let mut section = "";
    let mut unpushed: Vec<(String, u32)> = vec![];
    let mut first = true;
    for line in out.lines() {
        if let Some(rest) = line.strip_prefix("@@") {
            if let Some(wt) = rest.strip_prefix("worktree ") {
                st.worktrees.push(Worktree { path: wt.to_string(), main: first, ..Default::default() });
                first = false;
                section = "worktree";
                continue;
            }
            if let Some(v) = rest.strip_prefix("last ") {
                if let Some(w) = st.worktrees.last_mut() {
                    w.last_commit_ms = v.trim().parse::<u64>().unwrap_or(0) * 1000;
                }
                continue;
            }
            if let Some(v) = rest.strip_prefix("url ") {
                st.remote_url = Some(v.trim().to_string()).filter(|u| !u.is_empty());
                continue;
            }
            if rest == "url" {
                continue;
            }
            if let Some(v) = rest.strip_prefix("wtunpushed ") {
                if let Some(w) = st.worktrees.last_mut() {
                    w.unpushed = v.trim().parse().unwrap_or(0);
                }
                continue;
            }
            match rest {
                "locked" => {
                    if let Some(w) = st.worktrees.last_mut() {
                        w.locked = true
                    }
                }
                "prunable" => {
                    if let Some(w) = st.worktrees.last_mut() {
                        w.prunable = true
                    }
                }
                s => section = if s == "remotes" { "remotes" } else if s == "branches" { "branches" } else if s == "unpushed" { "unpushed" } else { section },
            }
            continue;
        }
        match section {
            "remotes" => {
                if !line.trim().is_empty() {
                    st.has_remote = true
                }
            }
            "branches" => {
                let f: Vec<&str> = line.split('\t').collect();
                if f.len() >= 4 {
                    st.branches.push(Branch {
                        name: f[0].to_string(),
                        upstream: Some(f[1].to_string()).filter(|s| !s.is_empty()),
                        gone: f[2].contains("gone"),
                        last_commit_ms: f[3].trim().parse::<u64>().unwrap_or(0) * 1000,
                        unpushed: 0,
                    });
                }
            }
            "unpushed" => {
                if let Some((b, n)) = line.split_once('\t') {
                    unpushed.push((b.to_string(), n.trim().parse().unwrap_or(0)));
                }
            }
            "worktree" => {
                let Some(w) = st.worktrees.last_mut() else { continue };
                if let Some(h) = line.strip_prefix("# branch.head ") {
                    w.branch = Some(h.to_string()).filter(|b| b != "(detached)");
                } else if let Some(u) = line.strip_prefix("# branch.upstream ") {
                    w.upstream = Some(u.to_string());
                } else if let Some(ab) = line.strip_prefix("# branch.ab ") {
                    for p in ab.split_whitespace() {
                        if let Some(a) = p.strip_prefix('+') {
                            w.ahead = a.parse().unwrap_or(0);
                        } else if let Some(b) = p.strip_prefix('-') {
                            w.behind = b.parse().unwrap_or(0);
                        }
                    }
                } else if line.starts_with("1 ") || line.starts_with("2 ") || line.starts_with("u ") {
                    w.changed += 1;
                } else if line.starts_with("? ") {
                    w.untracked += 1;
                }
            }
            _ => {}
        }
    }
    for b in st.branches.iter_mut() {
        if let Some((_, n)) = unpushed.iter().find(|(name, _)| *name == b.name) {
            b.unpushed = *n;
        }
    }
    st
}

/// Git state of a folder on this computer (`quick`: only its own worktree's status): per
/// repository, read again only where something changed (claude/gitrepo.rs).
pub fn local(path: &str, quick: bool) -> GitState {
    parse(path, &super::gitrepo::read(path, quick))
}

/// One git command in `dir`; its stdout, or None when it failed.
pub(super) fn git(dir: &str, args: &[&str]) -> Option<String> {
    #[cfg(test)]
    super::gitrepo::CALLS.with(|c| c.set(c.get() + 1));
    let mut c = crate::sys::command("git");
    c.arg("-C").arg(dir).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    // never let git ask for anything, and never take the index lock from your own git
    c.env("GIT_TERMINAL_PROMPT", "0").env("GIT_OPTIONAL_LOCKS", "0");
    let o = c.output().ok()?;
    o.status.success().then(|| String::from_utf8_lossy(&o.stdout).into_owned())
}

/// The old shell way, kept to check the per-repository reads against it.
#[cfg(test)]
fn local_script(path: &str, quick: bool) -> String {
    let mut c = std::process::Command::new("sh");
    c.args(["-c", SCRIPT, "sd-git", path, if quick { "quick" } else { "full" }]).stdin(Stdio::null()).stderr(Stdio::null());
    c.env("GIT_TERMINAL_PROMPT", "0").env("GIT_OPTIONAL_LOCKS", "0");
    String::from_utf8_lossy(&c.output().unwrap().stdout).into_owned()
}

/// Git state of folders on a VPS, one ssh round trip.
pub fn remote(host: &str, paths: &[String], quick: bool) -> Vec<GitState> {
    let mut script = String::from("export GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0\n");
    for p in paths {
        let dir = p.strip_prefix("~/").map(|r| format!("\"$HOME\"/{}", super::remote::shell_quote(r))).unwrap_or_else(|| super::remote::shell_quote(p));
        script.push_str(&format!("echo '@@@repo'; sh -c {} sd-git {dir} {}\n", super::remote::shell_quote(SCRIPT), if quick { "quick" } else { "full" }));
    }
    match super::remote::run(host, &script, None, Duration::from_secs(25)) {
        Ok(out) => {
            let s = String::from_utf8_lossy(&out);
            let parts: Vec<&str> = s.split("@@@repo\n").skip(1).collect();
            paths.iter().enumerate().map(|(i, p)| parse(p, parts.get(i).copied().unwrap_or(""))).collect()
        }
        Err(e) => paths.iter().map(|p| GitState { path: p.clone(), error: Some(e.clone()), ..Default::default() }).collect(),
    }
}

/// Git repositories in a workspace folder: the folder itself, its children and grandchildren
/// (hidden folders and node_modules skipped).
pub fn find_repos(root: &str) -> Vec<String> {
    let root = crate::sys::expand(root);
    let mut out = Vec::new();
    fn walk(dir: &std::path::Path, depth: u8, out: &mut Vec<String>) {
        if dir.join(".git").exists() {
            out.push(crate::sys::norm(&dir.to_string_lossy()));
            return;
        }
        if depth == 0 {
            return;
        }
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        let mut kids: Vec<_> = rd.flatten().filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false)).map(|e| e.path()).collect();
        kids.sort();
        for k in kids {
            let name = k.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if name.starts_with('.') || name == "node_modules" || name == "target" {
                continue;
            }
            walk(&k, depth - 1, out);
        }
    }
    walk(std::path::Path::new(&root), 2, &mut out);
    out
}

/// The pull request of the branch checked out in `cwd` (GitHub CLI): number, title, state, review
/// decision, mergeable, checks. Null when there is none, `gh` is missing or not signed in.
pub fn pr_status(cwd: &str) -> serde_json::Value {
    let dir = crate::sys::expand(cwd);
    let fields = "number,url,title,state,isDraft,reviewDecision,mergeable,statusCheckRollup";
    // never let gh hang the panel on a slow network
    let mut c = crate::sys::command("gh");
    c.args(["pr", "view", "--json", fields]);
    c.current_dir(&dir);
    c.env("GH_PROMPT_DISABLED", "1").env("GIT_TERMINAL_PROMPT", "0");
    match crate::sys::output_timeout(&mut c, 12) {
        Some(o) if o.status.success() => serde_json::from_slice(&o.stdout).unwrap_or(serde_json::Value::Null),
        _ => serde_json::Value::Null,
    }
}

/// The failing part of GitHub Actions runs (`gh run view --log-failed`), the last lines of each run,
/// at most ~12k characters in all: what a session needs to fix a red check.
pub fn ci_failure_log(cwd: &str, runs: &[u64]) -> Result<String, String> {
    let mut out = String::new();
    for id in runs.iter().take(3) {
        let mut c = crate::sys::command("gh");
        c.args(["run", "view", &id.to_string(), "--log-failed"]);
        c.current_dir(cwd);
        c.env("GH_PROMPT_DISABLED", "1").env("GIT_TERMINAL_PROMPT", "0").env("NO_COLOR", "1");
        let o = crate::sys::output_timeout(&mut c, 30).ok_or("gh did not answer in 30 s")?;
        if !o.status.success() {
            return Err(String::from_utf8_lossy(&o.stderr).trim().chars().take(300).collect());
        }
        let text = String::from_utf8_lossy(&o.stdout);
        let lines: Vec<&str> = text.lines().collect();
        let tail = &lines[lines.len().saturating_sub(120)..];
        out.push_str(&format!("--- run {id} ---\n"));
        for l in tail {
            // gh prefixes each line with "job<TAB>step<TAB>"; the timestamp after it is noise too
            let l = l.splitn(3, '\t').last().unwrap_or(l);
            let l = l.split_once(' ').filter(|(t, _)| t.len() > 20 && t.ends_with('Z')).map(|(_, r)| r).unwrap_or(l);
            out.push_str(l);
            out.push('\n');
        }
        if out.len() > 12_000 {
            break;
        }
    }
    if out.len() > 12_000 {
        let cut = out.len() - 12_000;
        let start = out.char_indices().find(|(i, _)| *i >= cut).map(|(i, _)| i).unwrap_or(0);
        out = format!("…\n{}", &out[start..]);
    }
    Ok(out)
}

#[cfg(test)]
mod direct_tests {
    use super::*;

    /// The direct git calls give what the script gave, on real repositories
    /// (`SD_GIT_REPOS=a:b cargo test same_as_the_script -- --ignored`).
    #[test]
    #[ignore]
    fn same_as_the_script() {
        let repos = std::env::var("SD_GIT_REPOS").unwrap();
        for r in repos.split(':').filter(|r| !r.is_empty()) {
            for quick in [false, true] {
                let a = serde_json::to_string(&parse(r, &local_script(r, quick))).unwrap();
                let b = serde_json::to_string(&parse(r, &super::super::gitrepo::read(r, quick))).unwrap();
                assert_eq!(a, b, "{r} quick={quick}");
            }
        }
    }
}

#[cfg(test)]
mod watch_tests {
    use super::*;
    use std::path::Path;
    use std::time::{Duration, Instant};

    fn run(dir: &Path, args: &[&str]) {
        let ok = std::process::Command::new("git").arg("-C").arg(dir).args(args).stdout(Stdio::null()).stderr(Stdio::null()).env("GIT_AUTHOR_NAME", "t").env("GIT_AUTHOR_EMAIL", "t@t").env("GIT_COMMITTER_NAME", "t").env("GIT_COMMITTER_EMAIL", "t@t").status().unwrap().success();
        assert!(ok, "git {args:?}");
    }

    /// Polls `local` (as the app does) until `ok` holds; panics after 5 s.
    fn until(path: &str, quick: bool, ok: impl Fn(&GitState) -> bool, what: &str) {
        let end = Instant::now() + Duration::from_secs(5);
        while !ok(&local(path, quick)) {
            assert!(Instant::now() < end, "{what}: not seen");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn reads_again_only_after_a_change() {
        let base = std::env::temp_dir().join(format!("sd-gitwatch-{}", std::process::id()));
        let main = base.join("main");
        let wt = base.join("wt");
        std::fs::create_dir_all(&main).unwrap();
        run(&base, &["init", "-q", "--bare", base.join("remote.git").to_str().unwrap()]);
        run(&main, &["init", "-q", "-b", "main"]);
        std::fs::write(main.join("a.txt"), "a").unwrap();
        run(&main, &["add", "-A"]);
        run(&main, &["commit", "-qm", "a"]);
        run(&main, &["remote", "add", "origin", base.join("remote.git").to_str().unwrap()]);
        run(&main, &["push", "-q", "origin", "main"]);
        run(&main, &["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "feat"]);
        let (m, w) = (main.to_string_lossy().to_string(), wt.to_string_lossy().to_string());

        // first read, then an untouched repository costs no git
        let first = local(&m, true);
        assert_eq!(first.worktrees[0].untracked, 0);
        std::thread::sleep(Duration::from_millis(300));
        let t = Instant::now();
        let again = local(&m, true);
        assert!(t.elapsed() < Duration::from_millis(15), "cached read took {:?}", t.elapsed());
        assert_eq!(again.worktrees[0].untracked, 0);

        // a new file in the folder shows
        std::fs::write(main.join("new.txt"), "n").unwrap();
        until(&m, true, |s| s.worktrees[0].untracked == 1, "new untracked file");

        // a commit made in the worktree (refs in the main repository) shows in the main folder's full read
        local(&m, false);
        std::fs::write(wt.join("b.txt"), "b").unwrap();
        run(&wt, &["add", "-A"]);
        run(&wt, &["commit", "-qm", "b"]);
        until(&m, false, |s| s.branches.iter().any(|b| b.name == "feat" && b.unpushed == 1), "worktree commit");
        // and in the worktree's own read
        until(&w, true, |s| s.worktrees.iter().find(|x| x.path.ends_with("wt")).is_some_and(|x| x.unpushed == 1), "worktree's own commit");

        // a branch made in the main repository shows in the worktree folder's full read
        local(&w, false);
        run(&main, &["branch", "other"]);
        until(&w, false, |s| s.branches.iter().any(|b| b.name == "other"), "new branch");
        let _ = std::fs::remove_dir_all(&base);
    }
}
