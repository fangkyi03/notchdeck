//! Task status, read-only and without any local server:
//! - Claude Code / Codex: parse the session logs they already write
//!   (`~/.claude/projects/**.jsonl`, `~/.codex/sessions/**.jsonl`).
//! - Jenkins: poll its REST API (`/job/<name>/lastBuild/api/json`).

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct AgentTask {
    pub id: String,
    /// "claude" | "codex"
    pub tool: String,
    pub title: String,
    pub cwd: String,
    pub prompt: String,
    /// "running" | "done" | "idle" (stopped mid-turn: waiting for you, or interrupted)
    pub state: String,
    pub started: i64,
    pub updated: i64,
    pub result: String,
}

#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct Build {
    pub job: String,
    pub number: i64,
    pub name: String,
    /// "building" | "success" | "failure" | "unstable" | "aborted" | "notbuilt" | "error"
    pub state: String,
    pub started: i64,
    pub duration: i64,
    pub estimated: i64,
    pub url: String,
    pub error: String,
}

static AGENTS: Mutex<Vec<AgentTask>> = Mutex::new(Vec::new());
static BUILDS: Mutex<Vec<Build>> = Mutex::new(Vec::new());

pub fn agents() -> Vec<AgentTask> { AGENTS.lock().unwrap().clone() }
pub fn builds() -> Vec<Build> { BUILDS.lock().unwrap().clone() }

fn now() -> i64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0) }
fn mtime(p: &Path) -> i64 {
    std::fs::metadata(p).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(0)
}
fn ts(v: &Value) -> i64 {
    v.get("timestamp").and_then(|t| t.as_str()).and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()).map(|d| d.timestamp()).unwrap_or(0)
}
fn clip(s: &str, n: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= n { s.to_string() } else { format!("{}…", s.chars().take(n).collect::<String>()) }
}

/// Last `max` bytes of a file as lines (the first, possibly partial, line is dropped).
fn tail_lines(p: &Path, max: u64) -> Vec<String> {
    let Ok(mut f) = std::fs::File::open(p) else { return vec![] };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(max);
    let _ = f.seek(SeekFrom::Start(start));
    let mut buf = Vec::new();
    let _ = f.read_to_end(&mut buf);
    let s = String::from_utf8_lossy(&buf);
    let mut lines: Vec<String> = s.lines().map(String::from).collect();
    if start > 0 && !lines.is_empty() { lines.remove(0); }
    lines
}

fn recent_files(root: &Path, depth: usize, since: i64, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(root) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            if depth > 0 { recent_files(&p, depth - 1, since, out); }
        } else if p.extension().is_some_and(|x| x == "jsonl") && mtime(&p) >= since {
            out.push(p);
        }
    }
}

/// How long a session can go without writing before a mid-turn one counts as idle.
const QUIET: i64 = 120;

fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().filter(|x| x.get("type").and_then(|t| t.as_str()) == Some("text")).filter_map(|x| x.get("text")?.as_str()).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

fn parse_claude(p: &Path) -> Option<AgentTask> {
    let lines = tail_lines(p, 512 * 1024);
    let (mut title, mut prompt, mut cwd) = (String::new(), String::new(), String::new());
    let mut last: Option<Value> = None;
    let mut started = 0;
    for l in &lines {
        let Ok(v) = serde_json::from_str::<Value>(l) else { continue };
        match v.get("type").and_then(|t| t.as_str()) {
            Some("ai-title") => title = v.get("aiTitle").and_then(|x| x.as_str()).unwrap_or("").into(),
            Some("last-prompt") => prompt = v.get("lastPrompt").and_then(|x| x.as_str()).unwrap_or("").into(),
            Some(k @ ("user" | "assistant")) => {
                if v.get("isSidechain").and_then(|x| x.as_bool()) == Some(true) { continue; }
                if let Some(c) = v.get("cwd").and_then(|x| x.as_str()) { cwd = c.into(); }
                // A real prompt (not a tool result) starts a turn.
                if k == "user" {
                    let c = v.pointer("/message/content");
                    let is_result = c.and_then(|c| c.as_array()).is_some_and(|a| a.iter().any(|x| x.get("type").and_then(|t| t.as_str()) == Some("tool_result")));
                    if !is_result { started = ts(&v); }
                }
                last = Some(v);
            }
            _ => {}
        }
    }
    let last = last?;
    let updated = ts(&last).max(mtime(p).min(now()));
    let done = last.get("type").and_then(|t| t.as_str()) == Some("assistant") && last.pointer("/message/stop_reason").and_then(|x| x.as_str()) == Some("end_turn");
    let state = if done { "done" } else if now() - mtime(p) < QUIET { "running" } else { "idle" };
    let result = if done { text_of(last.pointer("/message/content").unwrap_or(&Value::Null)) } else { String::new() };
    Some(AgentTask {
        id: format!("claude:{}", p.file_stem()?.to_string_lossy()),
        tool: "claude".into(),
        title: if title.is_empty() { clip(&prompt, 40) } else { title },
        cwd,
        prompt: clip(&prompt, 300),
        state: state.into(),
        started,
        updated,
        result: clip(&result, 4000),
    })
}

fn parse_codex(p: &Path) -> Option<AgentTask> {
    // cwd lives in the first line (session_meta).
    let mut cwd = String::new();
    if let Ok(f) = std::fs::File::open(p) {
        let mut first = String::new();
        let _ = std::io::BufRead::read_line(&mut std::io::BufReader::new(f), &mut first);
        if let Ok(v) = serde_json::from_str::<Value>(&first) {
            cwd = v.pointer("/payload/cwd").and_then(|x| x.as_str()).unwrap_or("").into();
        }
    }
    let (mut prompt, mut result) = (String::new(), String::new());
    let (mut started, mut finished, mut seen) = (0i64, 0i64, false);
    for l in tail_lines(p, 512 * 1024) {
        let Ok(v) = serde_json::from_str::<Value>(&l) else { continue };
        if v.get("type").and_then(|t| t.as_str()) != Some("event_msg") { continue; }
        match v.pointer("/payload/type").and_then(|t| t.as_str()) {
            Some("task_started") => { started = ts(&v); seen = true; }
            Some("task_complete") => {
                finished = ts(&v);
                seen = true;
                result = v.pointer("/payload/last_agent_message").and_then(|x| x.as_str()).unwrap_or("").into();
            }
            Some("user_message") => prompt = v.pointer("/payload/message").and_then(|x| x.as_str()).unwrap_or("").into(),
            _ => {}
        }
    }
    if !seen { return None; }
    let done = finished >= started;
    let state = if done { "done" } else if now() - mtime(p) < 10 * 60 { "running" } else { "idle" };
    Some(AgentTask {
        id: format!("codex:{}", p.file_stem()?.to_string_lossy()),
        tool: "codex".into(),
        title: clip(prompt.lines().find(|l| !l.trim().is_empty()).unwrap_or(""), 40),
        cwd,
        prompt: clip(&prompt, 300),
        state: state.into(),
        started,
        updated: if done { finished } else { mtime(p) },
        result: if done { clip(&result, 4000) } else { String::new() },
    })
}

fn scan_agents(cache: &mut HashMap<PathBuf, (i64, Option<AgentTask>)>) -> Vec<AgentTask> {
    let Some(home) = dirs::home_dir() else { return vec![] };
    let since = now() - 24 * 3600;
    let mut files = Vec::new();
    recent_files(&home.join(".claude/projects"), 1, since, &mut files);
    recent_files(&home.join(".codex/sessions"), 3, since, &mut files);
    let mut out = Vec::new();
    for p in &files {
        let m = mtime(p);
        let codex = p.starts_with(home.join(".codex"));
        // Re-parse changed files; re-check unchanged ones only so running → idle can flip.
        let entry = cache.entry(p.clone()).or_insert((-1, None));
        if entry.0 != m {
            *entry = (m, if codex { parse_codex(p) } else { parse_claude(p) });
        } else if let Some(t) = entry.1.as_mut() {
            if t.state == "running" && now() - m >= if codex { 600 } else { QUIET } { t.state = "idle".into(); }
        }
        if let Some(t) = &entry.1 { out.push(t.clone()); }
    }
    cache.retain(|p, _| files.contains(p));
    out.sort_by_key(|t| (t.state != "running", -t.updated));
    out.truncate(30);
    out
}

/* ---------------- Jenkins ---------------- */

fn job_path(job: &str) -> String {
    job.trim_matches('/').split('/').filter(|s| !s.is_empty()).map(|s| format!("job/{}", urlencode(s))).collect::<Vec<_>>().join("/")
}
fn urlencode(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

fn fetch_build(base: &str, auth: &Option<String>, job: &str) -> Build {
    let url = format!("{}/{}/lastBuild/api/json?tree=number,fullDisplayName,result,building,timestamp,duration,estimatedDuration,url", base.trim_end_matches('/'), job_path(job));
    let mut req = crate::net::agent(Duration::from_secs(10)).get(&url);
    if let Some(a) = auth { req = req.set("Authorization", a); }
    let mut b = Build { job: job.into(), number: 0, name: job.into(), state: "error".into(), started: 0, duration: 0, estimated: 0, url: String::new(), error: String::new() };
    match req.call() {
        Ok(r) => match r.into_json::<Value>() {
            Ok(v) => {
                b.number = v["number"].as_i64().unwrap_or(0);
                b.name = v["fullDisplayName"].as_str().unwrap_or(job).into();
                b.started = v["timestamp"].as_i64().unwrap_or(0) / 1000;
                b.duration = v["duration"].as_i64().unwrap_or(0) / 1000;
                b.estimated = v["estimatedDuration"].as_i64().unwrap_or(0) / 1000;
                b.url = v["url"].as_str().unwrap_or("").into();
                b.state = if v["building"].as_bool() == Some(true) { "building".into() } else { v["result"].as_str().unwrap_or("notbuilt").to_lowercase().replace("not_built", "notbuilt") };
            }
            Err(_) => b.error = "返回的不是 JSON".into(),
        },
        Err(ureq::Error::Status(401 | 403, _)) => b.error = "账号或 API Token 不对".into(),
        Err(ureq::Error::Status(404, _)) => b.error = "找不到这个任务（还没有构建过？）".into(),
        Err(ureq::Error::Status(c, _)) => b.error = format!("HTTP {c}"),
        Err(e) => b.error = format!("网络错误：{}", clip(&e.to_string(), 80)),
    }
    b
}

fn poll_jenkins(cfg: &Value) -> Vec<Build> {
    let j = &cfg["jenkins"];
    let base = j["url"].as_str().unwrap_or("").trim();
    if j["enabled"].as_bool() != Some(true) || base.is_empty() { return vec![]; }
    let user = j["user"].as_str().unwrap_or("");
    let auth = crate::usage::secret_get("jenkins").filter(|_| !user.is_empty()).map(|tok| {
        use base64::Engine;
        format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{user}:{tok}")))
    });
    j["jobs"].as_array().into_iter().flatten().filter_map(|x| x.as_str()).filter(|s| !s.trim().is_empty()).map(|job| fetch_build(base, &auth, job.trim())).collect()
}

pub fn refresh_jenkins(app: &AppHandle) {
    let cfg = app.state::<crate::AppState>().config.lock().unwrap().clone();
    let list = poll_jenkins(&cfg);
    *BUILDS.lock().unwrap() = list.clone();
    let _ = app.emit("builds-changed", list);
}

pub fn spawn(app: AppHandle) {
    let a = app.clone();
    std::thread::spawn(move || {
        let mut cache = HashMap::new();
        loop {
            let list = scan_agents(&mut cache);
            let changed = *AGENTS.lock().unwrap() != list;
            if changed {
                *AGENTS.lock().unwrap() = list.clone();
                let _ = a.emit("agents-changed", list);
            }
            std::thread::sleep(Duration::from_secs(3));
        }
    });
    std::thread::spawn(move || loop {
        let cfg = app.state::<crate::AppState>().config.lock().unwrap().clone();
        let list = poll_jenkins(&cfg);
        let changed = *BUILDS.lock().unwrap() != list;
        if changed {
            *BUILDS.lock().unwrap() = list.clone();
            let _ = app.emit("builds-changed", list);
        }
        let secs = cfg["jenkins"]["interval"].as_u64().unwrap_or(30).clamp(10, 600);
        let any_building = BUILDS.lock().unwrap().iter().any(|b| b.state == "building");
        std::thread::sleep(Duration::from_secs(if any_building { secs.min(15) } else { secs }));
    });
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore]
    fn scan_local() {
        for t in super::scan_agents(&mut Default::default()).iter().take(6) {
            println!("{} {} [{}] {} | {} | {}", t.tool, t.state, t.updated, t.title, t.cwd, t.result.chars().take(60).collect::<String>().replace('\n', " "));
        }
    }
}
