//! Claude Code backend (Phase 2): discovery, transcripts, owned sessions. The UI calls these
//! commands and listens to `claude-event` (see src/backend/real.ts).

pub mod control;
pub mod discover;
pub mod git;
pub mod hooks;
pub mod inject;
pub mod perms;
pub mod ports;
pub mod remote;
pub mod search;
pub mod transcript;
pub mod watch;

use serde_json::Value;
use tauri::{AppHandle, State};

use control::{Procs, StartOpts};
use tauri::Manager;

/// Run slow work (ssh, the cloud helper, big files, git) off the async workers, so a slow VPS
/// never holds up the quick calls (a permission answer, a send).
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}
use discover::{ScanCache, SessionMeta};
use transcript::TranscriptChunk;

#[tauri::command]
pub async fn claude_live() -> Result<Value, String> {
    blocking(discover::live_sessions).await
}

#[tauri::command]
pub async fn claude_pids() -> Result<Vec<Value>, String> {
    // off the async workers: a slow process listing must not hold up every other call
    blocking(|| Ok(discover::pid_sessions())).await
}

#[tauri::command]
pub async fn claude_scan(app: AppHandle) -> Result<Vec<SessionMeta>, String> {
    blocking(move || Ok(discover::scan(&app.state::<ScanCache>()))).await
}

/// The list's changes since the version the page has (`since` 0: all of it).
#[tauri::command]
pub async fn claude_scan_since(app: AppHandle, since: u64) -> Result<discover::ScanDelta, String> {
    blocking(move || Ok(discover::scan_since(&app.state::<ScanCache>(), since))).await
}

#[tauri::command]
pub async fn claude_transcript(path: String, max: Option<usize>) -> Result<TranscriptChunk, String> {
    blocking(move || transcript::read_window(&path, max.unwrap_or(3000))).await
}

/// The transcript from the message `uuid` on (or the last `max` records, if that is more): a
/// search hit or a link opens an old chat at that message, further back than the usual window.
#[tauri::command]
pub async fn claude_transcript_to(path: String, uuid: String, max: Option<usize>) -> Result<TranscriptChunk, String> {
    blocking(move || transcript::read_window_to(&path, &uuid, max.unwrap_or(1500))).await
}

/// Sessions whose conversation contains every word of `query` (newest match first).
#[tauri::command]
pub async fn search_sessions(search: State<'_, search::Search>, query: String, limit: Option<usize>) -> Result<Vec<search::Hit>, String> {
    let s = search.inner().clone();
    blocking(move || Ok(s.query(&query, limit.unwrap_or(40)))).await
}

/// The ids of a session's messages that contain every word of `query` (the chat's Find, also in
/// the part of a long chat not loaded).
#[tauri::command]
pub async fn search_in_session(search: State<'_, search::Search>, session_id: String, query: String) -> Result<Vec<String>, String> {
    let s = search.inner().clone();
    blocking(move || Ok(s.in_session(&session_id, &query))).await
}

#[tauri::command]
pub async fn claude_transcript_since(path: String, offset: u64, tip: Option<String>) -> Result<TranscriptChunk, String> {
    blocking(move || transcript::read_since(&path, offset, tip)).await
}

#[tauri::command]
pub async fn claude_start(app: AppHandle, procs: State<'_, Procs>, opts: StartOpts) -> Result<(), String> {
    // starting claude (and git for a worktree) is slow on Windows: off the async workers
    let procs = procs.inner().clone();
    blocking(move || control::start(app, procs, opts)).await
}

#[tauri::command]
pub async fn claude_send(procs: State<'_, Procs>, key: String, text: String, images: Option<Vec<String>>, uuid: Option<String>, priority: Option<String>) -> Result<(), String> {
    control::send_full(&procs, &key, &text, &images.unwrap_or_default(), uuid.as_deref(), priority.as_deref())
}

/// A file attached in the prompt box, kept where the session can read it (its path).
#[tauri::command]
pub async fn save_attachment(name: String, data: String) -> Result<String, String> {
    blocking(move || control::save_attachment(&name, &data)).await
}

/// Files back to how they were before a prompt (Claude Code's file snapshots).
#[tauri::command]
pub async fn claude_rewind_files(cwd: String, session_id: String, uuid: String, config_dir: Option<String>) -> Result<String, String> {
    blocking(move || control::rewind_files(&cwd, &session_id, &uuid, config_dir.as_deref())).await
}

#[tauri::command]
pub async fn claude_respond(procs: State<'_, Procs>, key: String, request_id: String, response: Value) -> Result<(), String> {
    control::respond(&procs, &key, &request_id, response)
}

#[tauri::command]
pub async fn claude_control(procs: State<'_, Procs>, key: String, request: Value, request_id: Option<String>) -> Result<(), String> {
    control::control(&procs, &key, request, request_id)
}

#[tauri::command]
pub async fn claude_capabilities() -> Result<Value, String> {
    blocking(discover::capabilities).await
}

/// Stop a session's claude in its terminal (here or on a VPS) so the app can resume it.
#[tauri::command]
pub async fn claude_takeover(pid: u32, host: Option<String>) -> Result<(), String> {
    blocking(move || match host {
        Some(h) => remote::takeover(&h, pid),
        None => control::takeover(pid),
    })
    .await
}

#[tauri::command]
pub async fn claude_stop(procs: State<'_, Procs>, key: String) -> Result<(), String> {
    control::stop(&procs, &key)
}

#[tauri::command]
pub async fn claude_running(procs: State<'_, Procs>) -> Result<Vec<String>, String> {
    Ok(control::running(&procs))
}

#[tauri::command]
pub async fn claude_info(hook_port: State<'_, HookPort>) -> Result<Value, String> {
    Ok(serde_json::json!({
        "dir": discover::claude_dir().to_string_lossy(),
        "bin": discover::claude_bin(),
        "home": crate::sys::norm(&crate::sys::home().to_string_lossy()),
        "hostname": hooks::local_hostname(),
        "hookPort": hook_port.0,
    }))
}

/// The port the hook endpoint listens on (0 when none could be opened).
pub struct HookPort(pub u16);

// ---------- preferences that both builds share (~/.config/session-dashboard/<name>.json) ----------

fn prefs_path(name: &str) -> Result<std::path::PathBuf, String> {
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("bad name".into());
    }
    Ok(crate::sys::config_dir().join(format!("{name}.json")))
}

#[tauri::command]
pub async fn prefs_read(name: String) -> Result<Option<Value>, String> {
    let p = prefs_path(&name)?;
    match std::fs::read_to_string(&p) {
        Ok(s) => serde_json::from_str(&s).map(Some).map_err(|e| format!("{}: {e}", p.display())),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
pub async fn prefs_write(name: String, value: Value) -> Result<(), String> {
    let p = prefs_path(&name)?;
    std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&value).map_err(|e| e.to_string())? + "\n").map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn claude_verbs() -> Result<Value, String> {
    blocking(|| Ok(discover::spinner_verbs())).await
}

// ---------- cloud sessions ----------

#[tauri::command]
pub async fn cloud_list(app: AppHandle) -> Result<Value, String> {
    blocking(move || discover::cloud_list(&app.state::<discover::HostHelper>())).await
}

#[tauri::command]
pub async fn cloud_transcript(app: AppHandle, session_id: String, cursor: Option<String>) -> Result<Value, String> {
    blocking(move || discover::cloud_transcript(&app.state::<discover::HostHelper>(), &session_id, cursor)).await
}

#[tauri::command]
pub async fn cloud_send(session_id: String, text: String) -> Result<Value, String> {
    blocking(move || discover::cloud_send(&session_id, &text)).await
}

// ---------- git ----------

#[tauri::command]
pub async fn git_state(paths: Vec<String>, host: Option<String>, quick: Option<bool>) -> Result<Vec<git::GitState>, String> {
    let quick = quick.unwrap_or(false);
    blocking(move || {
        Ok(match host {
            Some(h) => git::remote(&h, &paths, quick),
            // 8 folders at a time: one slow repo does not hold up the rest
            None => {
                let n = paths.len().div_ceil(8).max(1);
                std::thread::scope(|s| {
                    let parts: Vec<_> = paths.chunks(n).map(|c| (c, s.spawn(move || c.iter().map(|p| git::local(p, quick)).collect::<Vec<_>>()))).collect();
                    // one result per folder, in order, even if a reader failed
                    parts
                        .into_iter()
                        .flat_map(|(c, h)| h.join().unwrap_or_else(|_| c.iter().map(|p| git::GitState { path: p.clone(), error: Some("git read failed".into()), ..Default::default() }).collect()))
                        .collect()
                })
            }
        })
    })
    .await
}

#[tauri::command]
pub async fn pr_status(cwd: String) -> Result<Value, String> {
    blocking(move || Ok(git::pr_status(&cwd))).await
}

/// The failing GitHub Actions log lines of these runs, for sending to the session.
#[tauri::command]
pub async fn ci_failure_log(cwd: String, runs: Vec<u64>) -> Result<String, String> {
    blocking(move || git::ci_failure_log(&cwd, &runs)).await
}

#[tauri::command]
pub async fn workspace_repos(roots: Vec<String>) -> Result<Vec<String>, String> {
    blocking(move || Ok(roots.iter().flat_map(|r| git::find_repos(r)).collect())).await
}

// ---------- hooks ----------

#[tauri::command]
pub async fn hooks_status(host: Option<String>) -> Result<Value, String> {
    blocking(move || {
        Ok(match host {
            Some(h) => hooks::status_remote(&h),
            None => hooks::status_local(),
        })
    })
    .await
}

#[tauri::command]
pub async fn hooks_set(hook_port: State<'_, HookPort>, install: bool, host: Option<String>) -> Result<Value, String> {
    let port = hook_port.0;
    blocking(move || match host {
        Some(h) => hooks::set_remote(&h, install),
        None => hooks::set_local(install, port),
    })
    .await
}

/// Answer a permission prompt the hook offered (a session in a terminal): `decision` is
/// {behavior: "allow", updatedInput?, updatedPermissions?} or {behavior: "deny", message}.
#[tauri::command]
pub async fn hooks_answer(id: String, decision: Value) -> Result<(), String> {
    hooks::answer(&id, decision)
}

// ---------- machines over ssh ----------

#[tauri::command]
pub async fn remote_probe(host: String) -> Result<Value, String> {
    blocking(move || Ok(remote::probe(&host))).await
}

#[tauri::command]
pub async fn remote_agents(host: String) -> Result<Value, String> {
    blocking(move || remote::agents(&host)).await
}

#[tauri::command]
pub async fn remote_transcript(host: String, session_id: String, max: Option<usize>) -> Result<TranscriptChunk, String> {
    blocking(move || remote::transcript_window(&host, &session_id, max.unwrap_or(3000))).await
}

#[tauri::command]
pub async fn remote_transcript_since(host: String, session_id: String, offset: u64) -> Result<TranscriptChunk, String> {
    blocking(move || remote::transcript_since(&host, &session_id, offset)).await
}

#[tauri::command]
pub async fn remote_tunnels(app: AppHandle, tunnels: State<'_, remote::Tunnels>, hook_port: State<'_, HookPort>, hosts: Vec<String>) -> Result<(), String> {
    if hook_port.0 == 0 {
        return Err("the hook endpoint is not running".into());
    }
    let (t, port) = (tunnels.inner().clone(), hook_port.0);
    blocking(move || {
        remote::set_tunnels(app, t, hosts, port);
        Ok(())
    })
    .await
}

/// Claude Code's "always allow" / "deny" rules: the user's file and each project's (for review).
#[tauri::command]
pub async fn claude_permission_rules(projects: Vec<String>) -> Result<Vec<perms::RuleFile>, String> {
    blocking(move || Ok(perms::list(&projects))).await
}

/// Add or remove one permission rule in one of those files.
#[tauri::command]
pub async fn claude_permission_rule(path: String, list: String, rule: String, add: bool) -> Result<(), String> {
    blocking(move || perms::edit(&path, &list, &rule, add)).await
}

/// Ports each live local session's processes listen on (its dev servers): session id → ports.
#[tauri::command]
pub async fn session_ports(app: AppHandle) -> Result<std::collections::HashMap<String, Vec<u16>>, String> {
    blocking(move || {
        let mut roots: Vec<(String, u32)> = discover::pid_sessions()
            .iter()
            .filter_map(|v| Some((v.get("sessionId")?.as_str()?.to_string(), v.get("pid")?.as_u64()? as u32)))
            .collect();
        roots.extend(app.state::<Procs>().local_pids());
        Ok(ports::ports_of(&roots))
    })
    .await
}

/// One top-level value of Claude Code's user settings (null when unset).
#[tauri::command]
pub async fn claude_user_setting(key: String) -> Result<Value, String> {
    blocking(move || Ok(perms::user_setting(&key))).await
}

/// Change one of the few user settings the app offers to change (cleanupPeriodDays).
#[tauri::command]
pub async fn claude_set_user_setting(key: String, value: Value) -> Result<(), String> {
    blocking(move || perms::set_user_setting(&key, value)).await
}

/// Other Claude Code config folders (accounts) to read sessions and usage from.
#[tauri::command]
pub async fn claude_set_config_dirs(dirs: Vec<String>) -> Result<(), String> {
    discover::set_extra_dirs(&dirs);
    Ok(())
}

/// How a reply would reach a terminal session without stopping it ("Konsole", "tmux", …), or null.
#[tauri::command]
pub async fn claude_inject_check(terms: State<'_, crate::term::Terms>, pid: u32) -> Result<Option<String>, String> {
    let terms = terms.inner().clone();
    blocking(move || Ok(inject::check(&terms, pid))).await
}

/// Type a reply into the terminal a session runs in (it keeps running there).
#[tauri::command]
pub async fn claude_inject(terms: State<'_, crate::term::Terms>, pid: u32, text: String) -> Result<String, String> {
    let terms = terms.inner().clone();
    blocking(move || inject::send(&terms, pid, &text)).await
}

/// Terminal sync: whether `claude` in your shells runs through the app's wrapper.
#[tauri::command]
pub async fn sync_status() -> Result<Value, String> {
    blocking(|| Ok(crate::wrap::status())).await
}

/// Turn terminal sync on or off (the shell function in your shells' startup files).
#[tauri::command]
pub async fn sync_set(on: bool) -> Result<Value, String> {
    blocking(move || crate::wrap::set(on)).await
}
