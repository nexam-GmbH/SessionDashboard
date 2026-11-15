//! The "always allow" rules Claude Code keeps in its settings files (user, and per project shared and
//! local), read for review and edited one rule at a time. Every other key and the key order are kept;
//! the first edit of a file leaves a `.sd-backup` copy next to it.

use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

use super::discover::claude_dir;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleFile {
    pub path: String,
    /// "user", "project" (shared, in git) or "local" (this computer only)
    pub scope: &'static str,
    /// the project folder, for project files
    pub project: Option<String>,
    pub allow: Vec<String>,
    pub deny: Vec<String>,
}

fn rules(v: &Value, key: &str) -> Vec<String> {
    v.get("permissions").and_then(|p| p.get(key)).and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

fn read(path: &Path, scope: &'static str, project: Option<&str>) -> Option<RuleFile> {
    let text = fs::read_to_string(path).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    let allow = rules(&v, "allow");
    let deny = rules(&v, "deny");
    if allow.is_empty() && deny.is_empty() {
        return None;
    }
    Some(RuleFile { path: path.to_string_lossy().into(), scope, project: project.map(str::to_string), allow, deny })
}

/// The rule files of this computer: the user's, and each given project's shared and local ones.
pub fn list(projects: &[String]) -> Vec<RuleFile> {
    let mut out = Vec::new();
    out.extend(read(&claude_dir().join("settings.json"), "user", None));
    let mut seen: Vec<&String> = Vec::new();
    for p in projects {
        if seen.contains(&p) {
            continue;
        }
        seen.push(p);
        let dir = Path::new(p).join(".claude");
        out.extend(read(&dir.join("settings.json"), "project", Some(p)));
        out.extend(read(&dir.join("settings.local.json"), "local", Some(p)));
    }
    out
}

/// Only Claude Code's own settings files may be edited through this.
fn allowed(path: &Path) -> bool {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let parent = path.parent().and_then(|d| d.file_name()).and_then(|n| n.to_str()).unwrap_or("");
    let user = path == claude_dir().join("settings.json");
    user || (parent == ".claude" && (name == "settings.json" || name == "settings.local.json"))
}

/// Add or remove one rule in a file's `permissions.allow` (or `deny`).
pub fn edit(path: &str, list: &str, rule: &str, add: bool) -> Result<(), String> {
    let p = PathBuf::from(path);
    if !allowed(&p) || (list != "allow" && list != "deny") {
        return Err("not a Claude Code settings file".into());
    }
    let text = fs::read_to_string(&p).unwrap_or_default();
    let mut root: Value = if text.trim().is_empty() { json!({}) } else { serde_json::from_str(&text).map_err(|e| format!("{path} is not valid JSON: {e}"))? };
    let obj = root.as_object_mut().ok_or("settings is not an object")?;
    let perms = obj.entry("permissions").or_insert_with(|| json!({}));
    let perms = perms.as_object_mut().ok_or("\"permissions\" is not an object")?;
    let arr = perms.entry(list).or_insert_with(|| json!([]));
    let arr = arr.as_array_mut().ok_or("permission list is not an array")?;
    let had = arr.iter().any(|x| x.as_str() == Some(rule));
    if add == had {
        return Ok(());
    }
    if add {
        arr.push(Value::String(rule.to_string()));
    } else {
        arr.retain(|x| x.as_str() != Some(rule));
    }
    let backup = PathBuf::from(format!("{path}.sd-backup"));
    if !backup.exists() && !text.is_empty() {
        fs::write(&backup, &text).map_err(|e| e.to_string())?;
    }
    let mut out = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    out.push('\n');
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = PathBuf::from(format!("{path}.sd-tmp"));
    fs::write(&tmp, out).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

/// The few top-level user settings the app may change for you (each on an explicit click).
const USER_KEYS: [&str; 1] = ["cleanupPeriodDays"];

pub fn user_setting(key: &str) -> Value {
    let text = fs::read_to_string(claude_dir().join("settings.json")).unwrap_or_default();
    serde_json::from_str::<Value>(&text).ok().and_then(|v| v.get(key).cloned()).unwrap_or(Value::Null)
}

pub fn set_user_setting(key: &str, value: Value) -> Result<(), String> {
    if !USER_KEYS.contains(&key) {
        return Err(format!("{key} is not a setting the app changes"));
    }
    let p = claude_dir().join("settings.json");
    let text = fs::read_to_string(&p).unwrap_or_default();
    let mut root: Value = if text.trim().is_empty() { json!({}) } else { serde_json::from_str(&text).map_err(|e| format!("settings.json is not valid JSON: {e}"))? };
    root.as_object_mut().ok_or("settings.json is not an object")?.insert(key.to_string(), value);
    let path = p.to_string_lossy().to_string();
    let backup = PathBuf::from(format!("{path}.sd-backup"));
    if !backup.exists() && !text.is_empty() {
        fs::write(&backup, &text).map_err(|e| e.to_string())?;
    }
    let mut out = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    out.push('\n');
    let tmp = PathBuf::from(format!("{path}.sd-tmp"));
    fs::write(&tmp, out).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edit_keeps_other_keys_and_order() {
        let dir = std::env::temp_dir().join(format!("sd-perms-{}", std::process::id())).join(".claude");
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("settings.local.json");
        fs::write(&f, r#"{"model":"x","permissions":{"allow":["Bash(npm test:*)","Bash(rm:*)"],"deny":[]},"z":1}"#).unwrap();
        let path = f.to_string_lossy().to_string();
        edit(&path, "allow", "Bash(rm:*)", false).unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(&f).unwrap()).unwrap();
        assert_eq!(rules(&v, "allow"), vec!["Bash(npm test:*)".to_string()]);
        assert_eq!(v.as_object().unwrap().keys().cloned().collect::<Vec<_>>(), vec!["model", "permissions", "z"]);
        edit(&path, "allow", "Bash(rm:*)", true).unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(&f).unwrap()).unwrap();
        assert_eq!(rules(&v, "allow").len(), 2);
        assert!(PathBuf::from(format!("{path}.sd-backup")).exists());
        assert!(edit("/etc/passwd", "allow", "x", true).is_err());
        // refused before any file is read or written
        assert!(set_user_setting("model", json!("x")).is_err());
        fs::remove_dir_all(dir.parent().unwrap()).ok();
    }
}
