//! One real minute of the app's polling, on a made-up `~/.claude` and git repos of a heavy user's
//! size, timed per call: what the background work costs, the same file built against any version
//! (`cargo test --release --lib polling_minute -- --ignored --nocapture`).
//!
//! The schedule is the app's: pid files every 2 s, the transcript list every 5 s, git of the busy
//! folders every 20 s and a full git read of every repository every 2 minutes (half of one per
//! minute, here one full read reported on its own). Three sessions write to their transcripts all
//! the time, as working sessions do.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const TRANSCRIPTS: usize = 800;
const PROJECTS: usize = 40;
const LIVE: usize = 12;
const STALE: usize = 10;
const REPOS: usize = 6;
const FILES_PER_REPO: usize = 3000;

fn line(i: usize, cwd: &str) -> String {
    let text = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(6 + i % 20);
    match i % 3 {
        0 => format!(r#"{{"type":"user","cwd":"{cwd}","sessionId":"s","uuid":"u{i}","parentUuid":"u{p}","timestamp":"2026-11-20T10:00:00Z","message":{{"role":"user","content":"{text}"}}}}"#, p = i.saturating_sub(1)),
        1 => format!(r#"{{"type":"assistant","cwd":"{cwd}","sessionId":"s","uuid":"u{i}","parentUuid":"u{p}","timestamp":"2026-11-20T10:00:01Z","message":{{"role":"assistant","model":"claude-opus-5-5","content":[{{"type":"text","text":"{text}"}},{{"type":"tool_use","id":"t{i}","name":"Edit","input":{{"file_path":"{cwd}/src/f{i}.rs","old_string":"a","new_string":"b"}}}}],"usage":{{"input_tokens":10,"output_tokens":20}}}}}}"#, p = i.saturating_sub(1)),
        _ => format!(r#"{{"type":"user","cwd":"{cwd}","sessionId":"s","uuid":"u{i}","parentUuid":"u{p}","timestamp":"2026-11-20T10:00:02Z","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"t{i}","content":"{text}{text}"}}]}}}}"#, p = i.saturating_sub(1)),
    }
}

/// Transcripts of 20 KB to ~3 MB (most small, a few large), in 40 project folders.
fn make_claude(root: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for t in 0..TRANSCRIPTS {
        let proj = root.join("projects").join(format!("-work-repo{}", t % PROJECTS));
        std::fs::create_dir_all(&proj).unwrap();
        let p = proj.join(format!("{:08x}-0000-4000-8000-{:012x}.jsonl", t, t));
        let lines = match t % 20 {
            0 => 6000,
            1..=4 => 1500,
            _ => 60,
        };
        let cwd = format!("/work/repo{}", t % PROJECTS);
        let mut s = String::new();
        for i in 0..lines {
            s.push_str(&line(i, &cwd));
            s.push('\n');
        }
        std::fs::write(&p, s).unwrap();
        paths.push(p);
    }
    std::fs::create_dir_all(root.join("sessions")).unwrap();
    paths
}

fn sleeper() -> Child {
    let mut c = if cfg!(windows) {
        let mut c = Command::new("ping");
        c.args(["-n", "600", "127.0.0.1"]);
        c
    } else {
        let mut c = Command::new("sleep");
        c.arg("600");
        c
    };
    c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap()
}

fn pid_file(root: &Path, pid: u32, n: usize) {
    let body = format!(r#"{{"pid":{pid},"sessionId":"{n:08x}-0000-4000-8000-{n:012x}","cwd":"/work/repo{n}","startedAt":1795000000000,"kind":"interactive","entrypoint":"cli","status":"idle","updatedAt":1795000000000,"statusUpdatedAt":1795000000000}}"#);
    std::fs::write(root.join("sessions").join(format!("{pid}.json")), body).unwrap();
}

fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git").arg("-C").arg(dir).args(args).stdout(Stdio::null()).stderr(Stdio::null()).env("GIT_AUTHOR_NAME", "b").env("GIT_AUTHOR_EMAIL", "b@b").env("GIT_COMMITTER_NAME", "b").env("GIT_COMMITTER_EMAIL", "b@b").status().unwrap().success();
    assert!(ok, "git {args:?} in {}", dir.display());
}

/// A repository with 3000 files, a remote, 8 branches (3 with commits on no remote), two more
/// worktrees and a few changed files: the folders the app reads.
fn make_repo(base: &Path, r: usize) -> Vec<String> {
    let remote = base.join(format!("remote{r}.git"));
    let main = base.join(format!("repo{r}"));
    std::fs::create_dir_all(&main).unwrap();
    git(base, &["init", "-q", "--bare", remote.to_str().unwrap()]);
    git(&main, &["init", "-q", "-b", "main"]);
    for f in 0..FILES_PER_REPO {
        let d = main.join(format!("src/m{}", f % 30));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join(format!("f{f}.rs")), format!("fn f{f}() {{}}\n")).unwrap();
    }
    git(&main, &["add", "-A"]);
    git(&main, &["commit", "-qm", "init"]);
    git(&main, &["remote", "add", "origin", remote.to_str().unwrap()]);
    git(&main, &["push", "-q", "origin", "main"]);
    for b in 0..8 {
        git(&main, &["branch", &format!("feature-{b}")]);
    }
    for b in 0..3 {
        git(&main, &["checkout", "-q", &format!("feature-{b}")]);
        for c in 0..4 {
            std::fs::write(main.join(format!("src/m0/new{b}_{c}.rs")), "x").unwrap();
            git(&main, &["add", "-A"]);
            git(&main, &["commit", "-qm", &format!("work {b} {c}")]);
        }
    }
    git(&main, &["checkout", "-q", "main"]);
    let mut folders = vec![main.to_string_lossy().to_string()];
    for w in 3..5 {
        let wt = base.join(format!("repo{r}-wt{w}"));
        git(&main, &["worktree", "add", "-q", wt.to_str().unwrap(), &format!("feature-{w}")]);
        std::fs::write(wt.join("src/m1/f1.rs"), "changed").unwrap();
        folders.push(wt.to_string_lossy().to_string());
    }
    std::fs::write(main.join("src/m2/f2.rs"), "changed").unwrap();
    std::fs::write(main.join("untracked.txt"), "u").unwrap();
    folders
}

#[derive(Default)]
struct Stat {
    calls: u32,
    total: Duration,
}

impl Stat {
    fn time<T>(&mut self, f: impl FnOnce() -> T) -> T {
        let t = Instant::now();
        let v = f();
        self.total += t.elapsed();
        self.calls += 1;
        v
    }
    fn report(&self, name: &str) {
        let ms = self.total.as_secs_f64() * 1000.0;
        println!("BENCH {name:<14} calls={:<3} total_ms={ms:>9.1} mean_ms={:>8.2}", self.calls, if self.calls > 0 { ms / self.calls as f64 } else { 0.0 });
    }
}

#[test]
#[ignore]
fn polling_minute() {
    let base = std::env::temp_dir().join(format!("sd-bench-{}", std::process::id()));
    let claude = base.join("claude");
    std::fs::create_dir_all(&claude).unwrap();
    // SAFETY: set before any other thread of this test reads the environment
    unsafe { std::env::set_var("CLAUDE_CONFIG_DIR", &claude) };
    let t0 = Instant::now();
    let transcripts = make_claude(&claude);
    let mut kids: Vec<Child> = (0..LIVE).map(|_| sleeper()).collect();
    for (n, k) in kids.iter().enumerate() {
        pid_file(&claude, k.id(), n);
    }
    // pid files a crashed claude left behind (their processes are gone)
    for n in 0..STALE {
        pid_file(&claude, 4_000_000 + n as u32 * 4, 100 + n);
    }
    let mut busy = Vec::new();
    for r in 0..REPOS {
        busy.extend(make_repo(&base, r));
    }
    let repos: Vec<String> = (0..REPOS).map(|r| base.join(format!("repo{r}")).to_string_lossy().to_string()).collect();
    println!("BENCH setup {:.1}s: {} transcripts, {} live + {} stale pid files, {} repos ({} folders)", t0.elapsed().as_secs_f64(), TRANSCRIPTS, LIVE, STALE, REPOS, busy.len());

    let cache = crate::claude::discover::ScanCache::default();
    // the first read of everything (once, at start): reported apart
    let mut first = Stat::default();
    first.time(|| crate::claude::discover::scan(&cache));
    first.report("first_scan");
    assert_eq!(crate::claude::discover::pid_sessions().len(), LIVE);
    // the git of every folder, read once at start too (the app's first paint does it)
    let mut first_git = Stat::default();
    for f in &busy {
        first_git.time(|| crate::claude::git::local(f, true));
    }
    first_git.report("first_git");

    let (mut pids, mut scans, mut quick, mut full, mut append) = (Stat::default(), Stat::default(), Stat::default(), Stat::default(), Stat::default());
    let writers: Vec<&PathBuf> = transcripts.iter().skip(1).step_by(97).take(3).collect();
    let start = Instant::now();
    for sec in 0..60u64 {
        let tick = start + Duration::from_secs(sec);
        if let Some(w) = tick.checked_duration_since(Instant::now()) {
            std::thread::sleep(w);
        }
        // three working sessions append a record every second
        append.time(|| {
            use std::io::Write;
            for (i, w) in writers.iter().enumerate() {
                let mut f = std::fs::OpenOptions::new().append(true).open(w).unwrap();
                writeln!(f, "{}", line(sec as usize * 3 + i, "/work/repo1")).unwrap();
            }
        });
        if sec % 2 == 0 {
            let n = pids.time(crate::claude::discover::pid_sessions).len();
            assert_eq!(n, LIVE);
        }
        if sec % 5 == 0 {
            let n = scans.time(|| crate::claude::discover::scan(&cache)).len();
            assert_eq!(n, TRANSCRIPTS);
        }
        if sec % 20 == 0 {
            for f in &busy {
                quick.time(|| crate::claude::git::local(f, true));
            }
        }
        if sec == 30 {
            for r in &repos {
                full.time(|| crate::claude::git::local(r, false));
            }
        }
    }
    let wall = start.elapsed();
    pids.report("pid_files");
    scans.report("scan");
    quick.report("git_quick");
    full.report("git_full");
    let per_min = pids.total + scans.total + quick.total + full.total / 2;
    println!("BENCH busy_ms_per_minute={:.1} (of {:.1}s wall; git_full counted at its real rate, every 2 min)", per_min.as_secs_f64() * 1000.0, wall.as_secs_f64());
    for k in kids.iter_mut() {
        let _ = k.kill();
        let _ = k.wait();
    }
    let _ = std::fs::remove_dir_all(&base);
}
