//! Which TCP ports each session's processes listen on (its dev servers): the session's process tree
//! from /proc, matched to listening sockets in /proc/net/tcp{,6} by socket inode. Linux only; cheap
//! enough to run every few seconds (one pass over /proc, fds read only for the sessions' trees).

use std::collections::{HashMap, HashSet};
use std::fs;

/// Listening sockets: inode → port.
fn listening() -> HashMap<u64, u16> {
    let mut out = HashMap::new();
    for f in ["/proc/net/tcp", "/proc/net/tcp6"] {
        let Ok(text) = fs::read_to_string(f) else { continue };
        for line in text.lines().skip(1) {
            let cols: Vec<&str> = line.split_whitespace().collect();
            // local_address is col 1 ("0100007F:1F90"), st col 3 (0A = LISTEN), inode col 9
            if cols.len() < 10 || cols[3] != "0A" {
                continue;
            }
            let Some(port) = cols[1].rsplit(':').next().and_then(|p| u16::from_str_radix(p, 16).ok()) else { continue };
            if let Ok(inode) = cols[9].parse::<u64>() {
                if inode != 0 {
                    out.insert(inode, port);
                }
            }
        }
    }
    out
}

/// Parent of every process: pid → ppid.
fn parents() -> HashMap<u32, u32> {
    let mut out = HashMap::new();
    let Ok(dir) = fs::read_dir("/proc") else { return out };
    for e in dir.flatten() {
        let Some(pid) = e.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else { continue };
        let Ok(stat) = fs::read_to_string(format!("/proc/{pid}/stat")) else { continue };
        // field 4 (ppid) comes after the parenthesised command name
        if let Some(ppid) = stat.rsplit_once(')').and_then(|(_, rest)| rest.split_whitespace().nth(1)).and_then(|p| p.parse::<u32>().ok()) {
            out.insert(pid, ppid);
        }
    }
    out
}

/// For each root (session key → pid): the ports its process tree listens on, sorted.
pub fn ports_of(roots: &[(String, u32)]) -> HashMap<String, Vec<u16>> {
    let mut result = HashMap::new();
    if roots.is_empty() {
        return result;
    }
    let socks = listening();
    if socks.is_empty() {
        return result;
    }
    let parent = parents();
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (&pid, &ppid) in &parent {
        children.entry(ppid).or_default().push(pid);
    }
    // the app itself (its hook server), when it was started from inside a session's terminal
    let me = std::process::id();
    for (key, root) in roots {
        let mut ports: HashSet<u16> = HashSet::new();
        let mut stack = vec![*root];
        let mut seen = HashSet::new();
        while let Some(pid) = stack.pop() {
            if !seen.insert(pid) || seen.len() > 400 || (pid == me && pid != *root) {
                continue;
            }
            if let Ok(fds) = fs::read_dir(format!("/proc/{pid}/fd")) {
                for fd in fds.flatten() {
                    let Ok(link) = fs::read_link(fd.path()) else { continue };
                    let l = link.to_string_lossy();
                    if let Some(inode) = l.strip_prefix("socket:[").and_then(|x| x.strip_suffix(']')).and_then(|x| x.parse::<u64>().ok()) {
                        if let Some(&port) = socks.get(&inode) {
                            ports.insert(port);
                        }
                    }
                }
            }
            if let Some(c) = children.get(&pid) {
                stack.extend(c);
            }
        }
        if !ports.is_empty() {
            let mut v: Vec<u16> = ports.into_iter().collect();
            v.sort_unstable();
            result.insert(key.clone(), v);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_a_listening_child() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let me = std::process::id();
        let got = ports_of(&[("me".into(), me)]);
        assert!(got.get("me").map(|p| p.contains(&port)).unwrap_or(false), "{got:?} should hold {port}");
    }
}
