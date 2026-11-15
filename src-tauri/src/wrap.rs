//! Terminal sync, the app's side: the shell functions that route `claude` through the wrapper
//! (sd-wrap, crates/sdwrap), and `session-dashboard wrap …` on Linux and macOS.

pub use sdwrap::{registry, run};

// ---------- the shell functions that route `claude` through the wrapper ----------

const BEGIN: &str = "# >>> session-dashboard terminal sync >>>";
const END: &str = "# <<< session-dashboard terminal sync <<<";

/// What a shell runs for synced `claude`: sd-wrap next to the app; an AppImage (whose files live in a
/// temporary mount) runs itself with `wrap`.
fn wrapper_cmd() -> Vec<String> {
    if let Some(img) = std::env::var("APPIMAGE").ok().filter(|p| !p.is_empty()) {
        return vec![img, "wrap".into()];
    }
    let exe = std::env::current_exe().unwrap_or_default();
    let dir = exe.parent().map(|d| d.to_path_buf()).unwrap_or_default();
    let side = dir.join(if cfg!(windows) { "sd-wrap.exe" } else { "sd-wrap" });
    if side.exists() {
        return vec![side.to_string_lossy().to_string()];
    }
    // a build without the helper (Linux/macOS): the app binary itself
    if cfg!(windows) { vec![side.to_string_lossy().to_string()] } else { vec![exe.to_string_lossy().to_string(), "wrap".into()] }
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Posix,
    Fish,
    PowerShell,
}

fn rc_files() -> Vec<(std::path::PathBuf, Kind)> {
    let home = crate::sys::home();
    let mut v: Vec<(std::path::PathBuf, Kind)> = Vec::new();
    if cfg!(windows) {
        // each PowerShell (5.1 and 7) says where its profile is (Documents may be in OneDrive)
        for ps in ["powershell.exe", "pwsh.exe"] {
            if let Some(o) = crate::sys::output_timeout(crate::sys::command(ps).args(["-NoProfile", "-NonInteractive", "-Command", "$PROFILE.CurrentUserAllHosts"]), 8) {
                let p = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if o.status.success() && !p.is_empty() {
                    v.push((std::path::PathBuf::from(p), Kind::PowerShell));
                }
            }
        }
        // Git Bash
        v.push((home.join(".bashrc"), Kind::Posix));
        v.retain(|(p, k)| *k == Kind::PowerShell || p.exists());
        return v;
    }
    let shell = std::env::var("SHELL").unwrap_or_default();
    let zdot = std::env::var("ZDOTDIR").map(std::path::PathBuf::from).unwrap_or_else(|_| home.clone());
    v.push((home.join(".bashrc"), Kind::Posix));
    // macOS terminals open login shells: bash reads ~/.bash_profile there
    if cfg!(target_os = "macos") {
        v.push((home.join(".bash_profile"), Kind::Posix));
    }
    v.push((zdot.join(".zshrc"), Kind::Posix));
    v.push((home.join(".config/fish/conf.d/session-dashboard.fish"), Kind::Fish));
    // the shells you have, and yours even if its file does not exist yet
    v.retain(|(p, k)| {
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        p.exists() || (*k == Kind::Fish && shell.ends_with("fish")) || (name.starts_with(".zsh") && shell.ends_with("zsh")) || (name == ".bashrc" && shell.ends_with("bash") && !cfg!(target_os = "macos")) || (name == ".bash_profile" && shell.ends_with("bash"))
    });
    v
}

fn block(cmd: &[String], kind: Kind) -> String {
    match kind {
        Kind::PowerShell => {
            let q = |s: &str| format!("'{}'", s.replace('\'', "''"));
            let exe = q(&cmd[0]);
            let pre = cmd[1..].iter().map(|a| q(a)).collect::<Vec<_>>().join(" ");
            format!(
                "{BEGIN}\nfunction claude {{\n    $real = Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1\n    if ((Test-Path {exe}) -and -not $env:SD_SYNC) {{ & {exe} {pre} claude @args }}\n    elseif ($real) {{ & $real @args }}\n    else {{ Write-Error 'claude was not found' }}\n}}\n{END}\n"
            )
        }
        Kind::Fish => {
            let q = |s: &str| format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'"));
            let all = cmd.iter().map(|a| q(a)).collect::<Vec<_>>().join(" ");
            format!("{BEGIN}\nfunction claude\n    if test -x {}; and not set -q SD_SYNC\n        {all} claude $argv\n    else\n        command claude $argv\n    end\nend\n{END}\n", q(&cmd[0]))
        }
        Kind::Posix => {
            // Git Bash takes C:/x paths
            let q = |s: &str| format!("'{}'", s.replace('\\', "/").replace('\'', "'\\''"));
            let all = cmd.iter().map(|a| q(a)).collect::<Vec<_>>().join(" ");
            format!("{BEGIN}\nclaude() {{ if [ -x {} ] && [ -z \"$SD_SYNC\" ]; then {all} claude \"$@\"; else command claude \"$@\"; fi; }}\n{END}\n", q(&cmd[0]))
        }
    }
}

fn strip(text: &str) -> String {
    let mut out = String::new();
    let mut skip = false;
    for line in text.lines() {
        if line.trim() == BEGIN {
            skip = true;
            continue;
        }
        if line.trim() == END {
            skip = false;
            continue;
        }
        if !skip {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

/// Windows PowerShell's default policy (Restricted) skips profiles: say what to run.
fn policy_note() -> Option<String> {
    if !cfg!(windows) {
        return None;
    }
    let o = crate::sys::output_timeout(crate::sys::command("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", "Get-ExecutionPolicy"]), 8)?;
    let p = String::from_utf8_lossy(&o.stdout).trim().to_string();
    (p.eq_ignore_ascii_case("Restricted") || p.eq_ignore_ascii_case("AllSigned"))
        .then(|| "PowerShell runs no profile scripts with its current execution policy. Run once in PowerShell: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned".to_string())
}

/// Whether `claude` in your shells runs through the wrapper.
pub fn status() -> serde_json::Value {
    let files: Vec<String> = rc_files().iter().filter(|(p, _)| std::fs::read_to_string(p).map(|t| t.contains(BEGIN)).unwrap_or(false)).map(|(p, _)| p.to_string_lossy().to_string()).collect();
    serde_json::json!({ "on": !files.is_empty(), "files": files, "wrapper": wrapper_cmd(), "note": policy_note() })
}

/// Add (or remove) the shell functions in your shells' startup files. New terminals pick them up.
pub fn set(on: bool) -> Result<serde_json::Value, String> {
    let cmd = wrapper_cmd();
    for (p, kind) in rc_files() {
        let text = std::fs::read_to_string(&p).unwrap_or_default();
        let mut next = strip(&text);
        if on {
            if !next.is_empty() && !next.ends_with("\n\n") {
                next.push('\n');
            }
            next.push_str(&block(&cmd, kind));
        }
        if next == text {
            continue;
        }
        if let Some(d) = p.parent() {
            std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
        }
        if kind == Kind::Fish && !on && next.trim().is_empty() {
            let _ = std::fs::remove_file(&p);
            continue;
        }
        std::fs::write(&p, next).map_err(|e| format!("{}: {e}", p.display()))?;
    }
    Ok(status())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_round_trip() {
        let rc = "export A=1\nalias ll='ls -l'\n";
        let cmd = vec!["/opt/app/sd-wrap".to_string()];
        let with = format!("{rc}\n{}", block(&cmd, Kind::Posix));
        assert!(with.contains("'/opt/app/sd-wrap' claude \"$@\""));
        assert_eq!(strip(&with).trim_end(), rc.trim_end());
        assert!(block(&cmd, Kind::Fish).contains("$argv"));
        let ps = block(&["C:\\Program Files\\SD\\sd-wrap.exe".to_string()], Kind::PowerShell);
        assert!(ps.contains("& 'C:\\Program Files\\SD\\sd-wrap.exe'  claude @args") || ps.contains("& 'C:\\Program Files\\SD\\sd-wrap.exe' claude @args"));
        let img = block(&["/x/App.AppImage".to_string(), "wrap".to_string()], Kind::Posix);
        assert!(img.contains("'/x/App.AppImage' 'wrap' claude"));
    }
}
