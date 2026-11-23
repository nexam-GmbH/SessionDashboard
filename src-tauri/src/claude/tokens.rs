//! Claude accounts beside your normal login: a long-lived token per account (`claude setup-token`),
//! kept in the operating system's credential store (Windows Credential Manager, macOS Keychain,
//! Linux Secret Service), never in the app's settings and never handed to the web view. Every
//! `claude` the app starts for an account gets its token as CLAUDE_CODE_OAUTH_TOKEN; one config
//! folder (~/.claude) holds every session whichever account ran it.

use std::process::Command;

const SERVICE: &str = "session-dashboard";

/// The variable claude reads a token from. It starts with CLAUDE_CODE_, which `clean_env` removes:
/// it must be set after that.
pub const TOKEN_ENV: &str = "CLAUDE_CODE_OAUTH_TOKEN";

pub fn ok_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("not an account id".into());
    }
    Ok(())
}

fn entry(id: &str) -> Result<keyring::Entry, String> {
    ok_id(id)?;
    keyring::Entry::new(SERVICE, &format!("account-{id}")).map_err(|e| format!("credential store: {e}"))
}

/// A token as `claude setup-token` prints it (sk-ant-oat01-…).
pub fn looks_like_token(t: &str) -> bool {
    t.starts_with("sk-ant-") && t.len() >= 40 && t.len() <= 400 && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn save(id: &str, token: &str) -> Result<(), String> {
    let token = token.trim();
    if !looks_like_token(token) {
        return Err("That is not a Claude token (it starts with sk-ant-).".into());
    }
    entry(id)?.set_password(token).map_err(|e| format!("could not save the token: {e}"))
}

pub fn get(id: &str) -> Option<String> {
    entry(id).ok()?.get_password().ok()
}

pub fn has(id: &str) -> bool {
    get(id).is_some()
}

/// Forget an account's token (its sessions stay).
pub fn delete(id: &str) -> Result<(), String> {
    match entry(id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("could not remove the token: {e}")),
    }
}

/// Run `cmd` as an account: its token in the environment (after `clean_env`, which would remove it).
/// "" or None: your normal login, nothing set. An account whose token is gone is an error, so a
/// session never runs on the wrong account without saying so.
pub fn apply(cmd: &mut Command, account: Option<&str>) -> Result<(), String> {
    let Some(id) = account.filter(|a| !a.is_empty()) else { return Ok(()) };
    let token = get(id).ok_or("This account has no token any more: sign in again (Settings → Accounts).")?;
    cmd.env(TOKEN_ENV, token);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: &str = "sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-xyzAA";

    fn mock() {
        keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
    }

    /// The mock store keeps nothing between entries, so a round trip goes through one entry.
    #[test]
    fn stores_reads_and_forgets_a_token() {
        mock();
        let e = entry("acc1").unwrap();
        e.set_password(T).unwrap();
        assert_eq!(e.get_password().unwrap(), T);
        e.delete_credential().unwrap();
        assert!(e.get_password().is_err());
        // what is not a token or not an id is refused before the store is touched
        assert!(save("acc1", "hello").is_err());
        assert!(entry("../x").is_err());
        assert!(entry("").is_err());
        // forgetting a token that is not there is fine
        assert!(delete("nothing-here").is_ok());
    }

    /// The token goes in after clean_env: clean_env removes every CLAUDE_CODE_ variable.
    #[test]
    fn token_is_set_after_clean_env() {
        let mut cmd = Command::new("claude");
        cmd.env(TOKEN_ENV, "from-the-parent");
        super::super::discover::clean_env(&mut cmd);
        cmd.env(TOKEN_ENV, T);
        let got: Vec<_> = cmd.get_envs().filter(|(k, _)| *k == TOKEN_ENV).map(|(_, v)| v.map(|v| v.to_string_lossy().to_string())).collect();
        assert_eq!(got, vec![Some(T.to_string())]);
        // your normal login: nothing set
        let mut plain = Command::new("claude");
        apply(&mut plain, Some("")).unwrap();
        apply(&mut plain, None).unwrap();
        assert!(plain.get_envs().all(|(k, _)| k != TOKEN_ENV));
    }
}
