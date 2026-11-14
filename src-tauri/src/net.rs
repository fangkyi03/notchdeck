//! Shared HTTP agent that honours the user's proxy.
//!
//! Order: the `proxy` setting → HTTPS_PROXY / ALL_PROXY env → system proxy
//! (macOS `scutil --proxy`, Windows Internet Settings). Many services (e.g. the
//! Claude usage API) reject direct connections from some regions, while the user's
//! CLI tools already go through a local proxy.

use std::sync::Mutex;
use std::time::{Duration, Instant};

static OVERRIDE: Mutex<String> = Mutex::new(String::new());
static CACHE: Mutex<Option<(Instant, Option<String>)>> = Mutex::new(None);

/// Called whenever the config changes.
pub fn set_override(proxy: &str) {
    *OVERRIDE.lock().unwrap() = proxy.trim().to_string();
    *CACHE.lock().unwrap() = None;
}

fn env_proxy() -> Option<String> {
    ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy"]
        .iter()
        .find_map(|k| std::env::var(k).ok().filter(|v| !v.trim().is_empty()))
}

#[cfg(target_os = "macos")]
fn system_proxy() -> Option<String> {
    let out = std::process::Command::new("scutil").arg("--proxy").output().ok()?;
    let s = String::from_utf8_lossy(&out.stdout);
    let get = |k: &str| s.lines().find_map(|l| l.trim().strip_prefix(&format!("{k} : ")).map(|v| v.trim().to_string()));
    for (en, host, port, scheme) in [("HTTPSEnable", "HTTPSProxy", "HTTPSPort", "http"), ("HTTPEnable", "HTTPProxy", "HTTPPort", "http"), ("SOCKSEnable", "SOCKSProxy", "SOCKSPort", "socks5")] {
        if get(en).as_deref() == Some("1") {
            if let (Some(h), Some(p)) = (get(host), get(port)) {
                return Some(format!("{scheme}://{h}:{p}"));
            }
        }
    }
    None
}

#[cfg(windows)]
fn system_proxy() -> Option<String> {
    use std::os::windows::process::CommandExt;
    let q = |v: &str| {
        std::process::Command::new("reg")
            .args(["query", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings", "/v", v])
            .creation_flags(0x0800_0000)
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
    };
    if !q("ProxyEnable")?.contains("0x1") {
        return None;
    }
    let server = q("ProxyServer")?;
    let val = server.lines().find(|l| l.contains("ProxyServer"))?.split_whitespace().last()?.to_string();
    // "host:port" or "http=host:port;https=host:port"
    let pick = val.split(';').find(|p| p.starts_with("https=")).or_else(|| val.split(';').find(|p| p.starts_with("http="))).unwrap_or(&val);
    let hp = pick.split('=').last()?;
    Some(format!("http://{hp}"))
}

#[cfg(not(any(target_os = "macos", windows)))]
fn system_proxy() -> Option<String> {
    None
}

pub fn proxy_url() -> Option<String> {
    let o = OVERRIDE.lock().unwrap().clone();
    if o == "direct" {
        return None;
    }
    if !o.is_empty() {
        return Some(o);
    }
    let mut c = CACHE.lock().unwrap();
    if let Some((at, v)) = c.as_ref() {
        if at.elapsed() < Duration::from_secs(60) {
            return v.clone();
        }
    }
    let v = env_proxy().or_else(system_proxy);
    *c = Some((Instant::now(), v.clone()));
    v
}

pub fn agent(timeout: Duration) -> ureq::Agent {
    let mut b = ureq::AgentBuilder::new().timeout(timeout);
    if let Some(p) = proxy_url().and_then(|u| ureq::Proxy::new(u).ok()) {
        b = b.proxy(p);
    }
    b.build()
}

pub fn get(url: &str) -> ureq::Request {
    agent(Duration::from_secs(10)).get(url)
}
