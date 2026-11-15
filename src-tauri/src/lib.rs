mod claude;
mod term;
pub mod sys;
pub mod wrap;
mod usage;

use tauri::webview::PageLoadEvent;
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_log::{Target, TargetKind};
/// The built-in self-test runs when the app is started with SD_SELFTEST=1 (a test copy, never the
/// installed app): it exercises the real paths (terminal, usage, discovery, transcripts) and logs.
#[tauri::command]
fn sd_selftest() -> bool {
    std::env::var("SD_SELFTEST").is_ok_and(|v| v == "1")
}

fn external_navigation_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::<R>::new("external-navigation")
        .on_navigation(|webview, url| {
            let is_internal_host = matches!(
                url.host_str(),
                Some("localhost") | Some("127.0.0.1") | Some("tauri.localhost") | Some("::1")
            );

            let is_internal = url.scheme() == "tauri" || is_internal_host;

            if is_internal {
                return true;
            }

            let is_external_link = matches!(url.scheme(), "http" | "https" | "mailto" | "tel");

            if is_external_link {
                log::info!("opening external link in system browser: {}", url);
                let _ = webview.opener().open_url(url.as_str(), None::<&str>);
                return false;
            }

            true
        })
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// `session-dashboard wrap claude …` (the terminal sync wrapper): handled before the app starts.
/// Returns the exit code when this run was one.
pub fn cli() -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // `session-dashboard sync on|off|status`: the terminal sync shell functions, from a terminal
    if args.first().map(String::as_str) == Some("sync") {
        let r = match args.get(1).map(String::as_str) {
            Some("on") => wrap::set(true),
            Some("off") => wrap::set(false),
            _ => Ok(wrap::status()),
        };
        return Some(match r {
            Ok(v) => {
                println!("{v}");
                0
            }
            Err(e) => {
                eprintln!("{e}");
                1
            }
        });
    }
    // `session-dashboard hooks on|off`: exact states and answering terminal sessions' prompts from the
    // app (the running app keeps its port in ~/.claude/session-dashboard/port)
    if args.first().map(String::as_str) == Some("hooks") {
        let on = args.get(1).map(String::as_str) == Some("on");
        let port = std::fs::read_to_string(claude::discover::claude_dir().join("session-dashboard").join("port")).ok().and_then(|p| p.trim().parse().ok()).unwrap_or(0);
        return Some(match claude::hooks::set_local(on, port) {
            Ok(v) => {
                println!("{v}");
                0
            }
            Err(e) => {
                eprintln!("{e}");
                1
            }
        });
    }
    if args.first().map(String::as_str) != Some("wrap") {
        return None;
    }
    Some(wrap::run(&args[1..]))
}

pub fn run() {
    // started from the Dock, Finder or a launcher: the shell's PATH, so claude, gh and git are found
    sys::fix_path();
    let mut builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        // single-instance must be registered first
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
                use tauri::Manager;
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }))
            // exclude VISIBLE (conflicts with hidden-until-painted) and DECORATIONS (custom titlebar)
            .plugin(
                tauri_plugin_window_state::Builder::new()
                    .with_state_flags(
                        tauri_plugin_window_state::StateFlags::SIZE
                            | tauri_plugin_window_state::StateFlags::POSITION
                            | tauri_plugin_window_state::StateFlags::MAXIMIZED
                            | tauri_plugin_window_state::StateFlags::FULLSCREEN,
                    )
                    .build(),
            );
    }
    builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir { file_name: None }),
                    Target::new(TargetKind::Webview),
                ])
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(external_navigation_plugin())
        .manage(claude::discover::ScanCache::default())
        .manage(claude::control::Procs::default())
        .manage(claude::remote::Tunnels::default())
        .manage(claude::discover::HostHelper::default())
        .manage(term::Terms::default())
        .invoke_handler(tauri::generate_handler![
            sd_selftest,
            claude::claude_live,
            claude::claude_pids,
            claude::claude_scan,
            claude::claude_transcript,
            claude::claude_transcript_since,
            claude::claude_start,
            claude::claude_send,
            claude::claude_respond,
            claude::claude_control,
            claude::claude_stop,
            claude::claude_takeover,
            claude::claude_running,
            claude::claude_info,
            claude::claude_capabilities,
            claude::claude_verbs,
            claude::prefs_read,
            claude::prefs_write,
            claude::cloud_list,
            claude::cloud_transcript,
            claude::cloud_send,
            claude::git_state,
            claude::workspace_repos,
            claude::pr_status,
            claude::claude_permission_rules,
            claude::claude_permission_rule,
            claude::session_ports,
            claude::ci_failure_log,
            claude::claude_user_setting,
            claude::claude_set_user_setting,
            claude::claude_set_config_dirs,
            claude::claude_inject_check,
            claude::claude_inject,
            claude::sync_status,
            claude::sync_set,
            claude::hooks_status,
            claude::hooks_set,
            claude::hooks_answer,
            claude::remote_probe,
            claude::remote_agents,
            claude::remote_transcript,
            claude::remote_transcript_since,
            claude::remote_tunnels,
            term::term_open,
            term::term_write,
            term::term_resize,
            term::term_close,
            usage::usage_scan,
            usage::usage_limits,
        ])
        .setup(|app| {
            // hook posts from Claude Code (this computer, and VPS machines through their tunnels)
            let port = claude::hooks::serve(app.handle().clone()).unwrap_or(0);
            app.manage(claude::HookPort(port));
            Ok(())
        })
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                log::info!("main webview finished loading");
                // the page shows the window itself after its first paint (no blank or half-styled
                // frame); this is the safety net if that never comes
                let win = webview.window();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(2500));
                    if !win.is_visible().unwrap_or(true) {
                        let _ = win.show();
                    }
                });
            }
        })
        // the main window closing quits the app, session windows included
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::Destroyed = event {
                    window.app_handle().exit(0);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // sessions the app started stop with it (their conversations stay resumable)
            if let tauri::RunEvent::Exit = event {
                claude::control::stop_all(&app.state::<claude::control::Procs>());
                claude::remote::stop_tunnels(&app.state::<claude::remote::Tunnels>());
                app.state::<claude::discover::HostHelper>().stop();
                term::close_all(&app.state::<term::Terms>());
            }
        });
}
