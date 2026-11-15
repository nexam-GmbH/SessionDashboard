// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(code) = session_dashboard_lib::cli() {
        std::process::exit(code);
    }
    session_dashboard_lib::run()
}
