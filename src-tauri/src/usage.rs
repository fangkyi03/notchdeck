//! AI quota + token statistics.
//!
//! Each configured provider becomes one column: plan badge, quota rows
//! (percent used + reset time) and today / 7-day token & cost totals.

use chrono::{DateTime, Local, TimeZone, Utc};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

#[derive(Serialize, Clone, Default)]
pub struct Quota {
    pub title: String,
    pub percent: Option<f64>,
    /// Big text when there is no percent (e.g. a balance).
    pub value: String,
    /// Unix seconds.
    pub reset_at: Option<i64>,
    pub reset_text: String,
}

#[derive(Serialize, Clone, Default)]
pub struct Column {
    pub id: String,
    pub name: String,
    pub color: String,
    pub plan: String,
    pub quotas: Vec<Quota>,
    pub has_stats: bool,
    pub today_tokens: u64,
    pub today_cost: f64,
    pub week_tokens: u64,
    pub week_cost: f64,
    pub models: Vec<ModelStat>,
    pub error: Option<String>,
    /// Quota shown is a cached reading from an earlier successful fetch.
    pub stale_since: Option<i64>,
}

#[derive(Serialize, Clone, Default)]
pub struct ModelStat {
    pub model: String,
    pub today_tokens: u64,
    pub today_cost: f64,
    pub week_tokens: u64,
    pub week_cost: f64,
    pub requests: u64,
}

pub fn fetch_all(cfg: &Value, force: bool) -> Vec<Column> {
    let Some(providers) = cfg.get("providers").and_then(|v| v.as_array()) else { return vec![] };
    providers
        .iter()
        .filter(|p| p.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true))
        .map(|p| {
            let s = |k: &str| p.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let mut col = Column { id: s("id"), name: s("name"), color: s("color"), ..Default::default() };
            match s("kind").as_str() {
                "claude" | "claude_local" => claude(&mut col, force),
                "codex" | "codex_local" => codex(&mut col),
                "command" => custom(&mut col, command(&s("command"))),
                "http" => custom(&mut col, http(p)),
                "deepseek" => custom(&mut col, deepseek(&s("id"))),
                "openrouter" => custom(&mut col, openrouter(&s("id"))),
                "moonshot" => custom(&mut col, moonshot(&s("id"))),
                k => col.error = Some(format!("未知类型 {k}")),
            }
            col
        })
        .collect()
}

/* ------------------------------------------------------------------ */
/* pricing (USD per 1M tokens: input, output, cache write, cache read) */

fn price(model: &str) -> (f64, f64, f64, f64) {
    let m = model.to_lowercase();
    if m.contains("opus") {
        if m.contains("opus-4-0") || m.contains("opus-4-1") || m.contains("opus-4-2") || m.contains("3-opus") {
            (15.0, 75.0, 18.75, 1.5)
        } else {
            (5.0, 25.0, 6.25, 0.5)
        }
    } else if m.contains("haiku") {
        (1.0, 5.0, 1.25, 0.1)
    } else if m.contains("sonnet") || m.contains("claude") || m.contains("fable") {
        (3.0, 15.0, 3.75, 0.3)
    } else if m.contains("mini") {
        (0.25, 2.0, 0.0, 0.025)
    } else if m.contains("gpt") || m.contains("codex") || m.starts_with('o') {
        (1.25, 10.0, 0.0, 0.125)
    } else {
        (0.0, 0.0, 0.0, 0.0)
    }
}

#[derive(Clone)]
struct Rec {
    ts: i64,
    model: String,
    key: String,
    tokens: u64,
    cost: f64,
}

/// Per-file parse cache keyed by (mtime, len) so only changed logs are re-read.
static FILE_CACHE: Mutex<Option<HashMap<PathBuf, (SystemTime, u64, Vec<Rec>)>>> = Mutex::new(None);

fn cached_records(path: &Path, parse: fn(&str) -> Vec<Rec>) -> Vec<Rec> {
    let Ok(meta) = std::fs::metadata(path) else { return vec![] };
    let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    let mut guard = FILE_CACHE.lock().unwrap();
    let cache = guard.get_or_insert_with(HashMap::new);
    if let Some((t, l, recs)) = cache.get(path) {
        if *t == mtime && *l == meta.len() {
            return recs.clone();
        }
    }
    let recs = std::fs::read_to_string(path).map(|s| parse(&s)).unwrap_or_default();
    cache.insert(path.to_path_buf(), (mtime, meta.len(), recs.clone()));
    recs
}

fn walk_jsonl(dir: &Path, newer_than: SystemTime, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk_jsonl(&p, newer_than, out);
        } else if p.extension().is_some_and(|x| x == "jsonl")
            && e.metadata().and_then(|m| m.modified()).is_ok_and(|t| t >= newer_than)
        {
            out.push(p);
        }
    }
}

fn day_start(days_ago: i64) -> i64 {
    let d = Local::now().date_naive() - chrono::Duration::days(days_ago);
    Local.from_local_datetime(&d.and_hms_opt(0, 0, 0).unwrap()).single().map(|t| t.timestamp()).unwrap_or(0)
}

fn fill_stats(col: &mut Column, files: Vec<PathBuf>, parse: fn(&str) -> Vec<Rec>) {
    let today = day_start(0);
    let week = day_start(6);
    let mut seen = HashSet::new();
    let mut models: HashMap<String, ModelStat> = HashMap::new();
    for f in files {
        for r in cached_records(&f, parse) {
            if r.ts < week || (!r.key.is_empty() && !seen.insert(r.key.clone())) {
                continue;
            }
            let name = if r.model.is_empty() || r.model == "<synthetic>" { "未知模型".to_string() } else { r.model.clone() };
            let m = models.entry(name.clone()).or_insert_with(|| ModelStat { model: name, ..Default::default() });
            m.week_tokens += r.tokens;
            m.week_cost += r.cost;
            m.requests += 1;
            col.week_tokens += r.tokens;
            col.week_cost += r.cost;
            if r.ts >= today {
                m.today_tokens += r.tokens;
                m.today_cost += r.cost;
                col.today_tokens += r.tokens;
                col.today_cost += r.cost;
            }
        }
    }
    let mut v: Vec<ModelStat> = models.into_values().filter(|m| m.week_tokens > 0).collect();
    v.sort_by(|a, b| b.week_tokens.cmp(&a.week_tokens));
    col.models = v;
    col.has_stats = true;
}

fn ts_of(v: &Value) -> Option<i64> {
    v.get("timestamp").and_then(|t| t.as_str()).and_then(|t| DateTime::parse_from_rfc3339(t).ok()).map(|t| t.timestamp())
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
}

fn eight_days_ago() -> SystemTime {
    SystemTime::now() - Duration::from_secs(8 * 86400)
}


/// Turns a ureq error into a short, human message (status + server reason).
fn http_error(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, r) => {
            let body: Value = r.into_json().unwrap_or(Value::Null);
            let reason = body
                .pointer("/error/message")
                .or_else(|| body.get("message"))
                .or_else(|| body.get("error").filter(|x| x.is_string()))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .chars()
                .take(80)
                .collect::<String>();
            let hint = match code {
                401 => "密钥或登录无效",
                403 => "没有权限",
                404 => "接口地址不存在",
                429 => "请求太频繁",
                500..=599 => "服务暂时不可用",
                _ => "请求失败",
            };
            if reason.is_empty() { format!("{hint}（HTTP {code}）") } else { format!("{hint}（HTTP {code}）：{reason}") }
        }
        ureq::Error::Transport(t) => format!("网络错误：{}", t.kind()),
    }
}

/* ------------------------------ Claude ------------------------------ */

fn parse_claude(text: &str) -> Vec<Rec> {
    let mut out = vec![];
    for line in text.lines() {
        if !line.contains("\"usage\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let (Some(u), Some(ts)) = (v.pointer("/message/usage"), ts_of(&v)) else { continue };
        let n = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
        let (i, o, cw, cr) = (n("input_tokens"), n("output_tokens"), n("cache_creation_input_tokens"), n("cache_read_input_tokens"));
        let model = v.pointer("/message/model").and_then(|x| x.as_str()).unwrap_or("");
        let (pi, po, pcw, pcr) = price(model);
        let key = format!(
            "{}:{}",
            v.pointer("/message/id").and_then(|x| x.as_str()).unwrap_or(""),
            v.get("requestId").and_then(|x| x.as_str()).unwrap_or("")
        );
        out.push(Rec {
            ts,
            model: model.to_string(),
            key: if key == ":" { String::new() } else { key },
            tokens: i + o + cw + cr,
            cost: (i as f64 * pi + o as f64 * po + cw as f64 * pcw + cr as f64 * pcr) / 1e6,
        });
    }
    out
}

struct ClaudeCache {
    at: Option<Instant>,
    ok: Option<(String, Vec<Quota>, i64)>,
    backoff_until: Option<Instant>,
    backoff_step: u32,
    last_err: Option<String>,
}
static CLAUDE: Mutex<ClaudeCache> = Mutex::new(ClaudeCache { at: None, ok: None, backoff_until: None, backoff_step: 0, last_err: None });

/// Claude Code stores its OAuth login in the macOS keychain or ~/.claude/.credentials.json.
fn claude_credentials() -> Option<Value> {
    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = Command::new("security").args(["find-generic-password", "-s", "Claude Code-credentials", "-w"]).output() {
            if out.status.success() {
                if let Ok(v) = serde_json::from_slice::<Value>(&out.stdout) {
                    return Some(v);
                }
            }
        }
    }
    let s = std::fs::read_to_string(home().join(".claude").join(".credentials.json")).ok()?;
    serde_json::from_str(&s).ok()
}

fn iso_ts(v: Option<&Value>) -> Option<i64> {
    v.and_then(|x| x.as_str()).and_then(|t| DateTime::parse_from_rfc3339(t).ok()).map(|t| t.timestamp())
}

fn claude_fetch() -> Result<(String, Vec<Quota>), (String, Option<u64>)> {
    let cred = claude_credentials().ok_or(("未登录 Claude Code".to_string(), None))?;
    let o = cred.get("claudeAiOauth").unwrap_or(&cred);
    let token = o.get("accessToken").and_then(|x| x.as_str()).ok_or(("未找到登录令牌".to_string(), None))?;
    let plan = o.get("subscriptionType").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let resp = crate::net::get("https://api.anthropic.com/api/oauth/usage")
        .set("Authorization", &format!("Bearer {token}"))
        .set("anthropic-beta", "oauth-2025-04-20")
        .set("User-Agent", "claude-code/2.0.0")
        .timeout(Duration::from_secs(10))
        .call();
    let v: Value = match resp {
        Ok(r) => r.into_json().map_err(|e| (e.to_string(), None))?,
        Err(ureq::Error::Status(429, r)) => {
            let wait = r.header("retry-after").and_then(|s| s.parse::<u64>().ok()).filter(|s| *s < 7 * 86400);
            return Err(("请求频繁，稍后重试".into(), Some(wait.unwrap_or(0))));
        }
        Err(ureq::Error::Status(401, _)) => return Err(("登录已过期，请打开 Claude Code 重新登录".into(), None)),
        Err(e @ ureq::Error::Status(403, _)) => {
            let msg = http_error(e);
            eprintln!("[notchdeck] claude usage 403: {msg}");
            let hint = if msg.contains("scope") || msg.contains("user:profile") {
                "登录令牌缺少 user:profile 权限（setup-token 或代理登录无法读取额度），请用 claude 命令重新 /login".to_string()
            } else {
                format!("{msg}。如使用代理或 setup-token 登录，无法读取官方额度")
            };
            return Err((hint, None));
        }
        Err(e) => {
            let msg = http_error(e);
            eprintln!("[notchdeck] claude usage error: {msg}");
            return Err((msg, None));
        }
    };
    let mut quotas = vec![];
    for (key, title) in [("five_hour", "5 小时"), ("seven_day", "每周"), ("seven_day_opus", "每周 Opus"), ("seven_day_sonnet", "每周 Sonnet")] {
        if let Some(q) = v.get(key).filter(|x| x.is_object()) {
            if let Some(p) = q.get("utilization").and_then(|x| x.as_f64()) {
                quotas.push(Quota { title: title.into(), percent: Some(p), reset_at: iso_ts(q.get("resets_at")), ..Default::default() });
            }
        }
    }
    Ok((plan, quotas))
}

fn claude(col: &mut Column, force: bool) {
    {
        let mut c = CLAUDE.lock().unwrap();
        let fresh = c.at.is_some_and(|t| t.elapsed() < Duration::from_secs(if force { 15 } else { 60 }));
        let blocked = c.backoff_until.is_some_and(|t| Instant::now() < t);
        if !fresh && !blocked {
            c.at = Some(Instant::now());
            match claude_fetch() {
                Ok((plan, q)) => {
                    c.ok = Some((plan, q, Utc::now().timestamp()));
                    c.backoff_step = 0;
                    c.last_err = None;
                }
                Err((e, wait)) => {
                    if let Some(w) = wait {
                        // 2, 4, 8, 16 … minutes, max 30, unless the server says otherwise.
                        let mins = (2u64 << c.backoff_step.min(4)).min(30);
                        let secs = if w > 0 { w } else { mins * 60 };
                        c.backoff_until = Some(Instant::now() + Duration::from_secs(secs));
                        c.backoff_step += 1;
                    }
                    c.last_err = Some(e);
                }
            }
        }
        if let Some((plan, q, at)) = &c.ok {
            col.plan = plan_label(plan);
            col.quotas = q.clone();
            if c.last_err.is_some() {
                col.stale_since = Some(*at);
            }
        }
        if c.ok.is_none() {
            col.error = c.last_err.clone();
        }
    }
    let mut files = vec![];
    walk_jsonl(&home().join(".claude").join("projects"), eight_days_ago(), &mut files);
    fill_stats(col, files, parse_claude);
}

fn plan_label(p: &str) -> String {
    let p = p.trim();
    if p.is_empty() {
        return String::new();
    }
    let mut c = p.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

/* ------------------------------ Codex ------------------------------- */

fn parse_codex(text: &str) -> Vec<Rec> {
    let mut out = vec![];
    let mut model = String::new();
    for line in text.lines() {
        if line.contains("\"turn_context\"") {
            if let Ok(v) = serde_json::from_str::<Value>(line) {
                if let Some(m) = v.pointer("/payload/model").and_then(|x| x.as_str()) {
                    model = m.to_string();
                }
            }
            continue;
        }
        if !line.contains("\"token_count\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let (Some(u), Some(ts)) = (v.pointer("/payload/info/last_token_usage"), ts_of(&v)) else { continue };
        let n = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
        let (input, cached, output) = (n("input_tokens"), n("cached_input_tokens"), n("output_tokens"));
        let (pi, po, _, pcr) = price(&model);
        out.push(Rec {
            ts,
            model: model.clone(),
            key: String::new(),
            tokens: input + output,
            cost: (input.saturating_sub(cached) as f64 * pi + cached as f64 * pcr + output as f64 * po) / 1e6,
        });
    }
    out
}

fn codex(col: &mut Column) {
    let root = home().join(".codex").join("sessions");
    let mut files = vec![];
    walk_jsonl(&root, eight_days_ago(), &mut files);
    files.sort_by_key(|f| std::fs::metadata(f).and_then(|m| m.modified()).ok());

    'outer: for f in files.iter().rev().take(20) {
        let Ok(text) = std::fs::read_to_string(f) else { continue };
        for line in text.lines().rev() {
            if !line.contains("rate_limits") {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
            let Some(rl) = v.pointer("/payload/rate_limits").filter(|x| x.is_object()) else { continue };
            col.plan = plan_label(rl.get("plan_type").and_then(|x| x.as_str()).unwrap_or(""));
            for (k, fallback) in [("primary", "5 小时"), ("secondary", "每周")] {
                let Some(q) = rl.get(k).filter(|x| x.is_object()) else { continue };
                let title = match q.get("window_minutes").and_then(|x| x.as_i64()) {
                    Some(300) => "5 小时".to_string(),
                    Some(10080) => "每周".to_string(),
                    Some(m) if m % 1440 == 0 => format!("{} 天", m / 1440),
                    Some(m) if m % 60 == 0 => format!("{} 小时", m / 60),
                    _ => fallback.to_string(),
                };
                let reset_at = q.get("resets_at").and_then(|x| x.as_i64()).or_else(|| {
                    q.get("resets_in_seconds").and_then(|x| x.as_i64()).and_then(|s| ts_of(&v).map(|t| t + s))
                });
                // A reading whose window already reset means 0% used now.
                let mut percent = q.get("used_percent").and_then(|x| x.as_f64());
                let mut reset_at = reset_at;
                let mut reset_text = String::new();
                if reset_at.is_some_and(|r| r < Utc::now().timestamp()) {
                    percent = Some(0.0);
                    reset_at = None;
                    reset_text = "已重置".into();
                }
                col.quotas.push(Quota { title, percent, reset_at, reset_text, ..Default::default() });
            }
            break 'outer;
        }
    }
    if col.quotas.is_empty() && !root.exists() {
        col.error = Some("未找到 Codex 记录".into());
    }
    fill_stats(col, files, parse_codex);
}

/* ------------------------------ custom ------------------------------ */

type Custom = Result<(String, Vec<Quota>), String>;

fn custom(col: &mut Column, r: Custom) {
    match r {
        Ok((plan, q)) => {
            col.plan = plan;
            col.quotas = q;
        }
        Err(e) => col.error = Some(e),
    }
}

fn value_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Accepts `[{title, percent, value, resetAt}]`, `{plan, quotas:[…]}` or `{percent, label}`.
fn quotas_from_json(v: &Value) -> (String, Vec<Quota>) {
    let one = |q: &Value| Quota {
        title: q.get("title").or_else(|| q.get("label")).map(value_text).unwrap_or_default(),
        percent: q.get("percent").and_then(|x| x.as_f64()),
        value: q.get("value").map(value_text).unwrap_or_default(),
        reset_at: q.get("resetAt").and_then(|x| x.as_i64()),
        reset_text: q.get("resetAt").filter(|x| x.is_string()).map(value_text).unwrap_or_default(),
    };
    match v {
        Value::Array(a) => (String::new(), a.iter().map(one).collect()),
        Value::Object(o) if o.contains_key("quotas") => (
            o.get("plan").map(value_text).unwrap_or_default(),
            o["quotas"].as_array().map(|a| a.iter().map(one).collect()).unwrap_or_default(),
        ),
        other => (String::new(), vec![one(other)]),
    }
}

fn shell(cmd: &str) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("cmd");
        c.args(["/C", cmd]).creation_flags(0x0800_0000);
        c
    }
    #[cfg(not(windows))]
    {
        let mut c = Command::new("/bin/sh");
        c.args(["-lc", cmd]);
        c
    }
}

fn command(cmd: &str) -> Custom {
    if cmd.trim().is_empty() {
        return Err("未配置命令".into());
    }
    let out = shell(cmd).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().chars().take(120).collect());
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    match serde_json::from_str::<Value>(&s) {
        Ok(v) if v.is_object() || v.is_array() => Ok(quotas_from_json(&v)),
        _ => Ok((String::new(), vec![Quota { title: String::new(), value: s.lines().next().unwrap_or("").into(), ..Default::default() }])),
    }
}

fn path_get<'a>(v: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.').filter(|s| !s.is_empty()).try_fold(v, |cur, seg| match seg.parse::<usize>() {
        Ok(i) if cur.is_array() => cur.get(i),
        _ => cur.get(seg),
    })
}

fn http(p: &Value) -> Custom {
    let sp = |k: &str| p.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let url = sp("url");
    if url.is_empty() {
        return Err("未配置 URL".into());
    }
    if !url.starts_with("https://") && !url.starts_with("http://localhost") && !url.starts_with("http://127.0.0.1") {
        return Err("需要 HTTPS".into());
    }
    let mut req = crate::net::get(&url).timeout(Duration::from_secs(10));
    if let Some(h) = p.get("headers").and_then(|x| x.as_object()) {
        for (k, v) in h {
            if let Some(v) = v.as_str() {
                req = req.set(k, v);
            }
        }
    }
    let v: Value = req.call().map_err(http_error)?.into_json().map_err(|_| "返回的不是 JSON".to_string())?;
    let percent = path_get(&v, &sp("percentPath")).and_then(|x| x.as_f64().or_else(|| x.as_str().and_then(|s| s.parse().ok())));
    let lp = sp("labelPath");
    let value = if lp.is_empty() { String::new() } else { path_get(&v, &lp).map(value_text).unwrap_or_default() };
    let title = sp("quotaTitle");
    Ok((String::new(), vec![Quota { title: if title.is_empty() { "额度".into() } else { title }, percent, value, ..Default::default() }]))
}

/* --------------------------- key-based sources --------------------------- */

const KEYRING_SERVICE: &str = "NotchDeck";

/// API keys live in the macOS Keychain / Windows Credential Manager, never in config.json.
pub fn secret_set(id: &str, value: &str) -> Result<(), String> {
    let e = keyring::Entry::new(KEYRING_SERVICE, id).map_err(|e| e.to_string())?;
    if value.is_empty() {
        let _ = e.delete_credential();
        Ok(())
    } else {
        e.set_password(value).map_err(|e| e.to_string())
    }
}

pub fn secret_get(id: &str) -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, id).ok()?.get_password().ok().filter(|s| !s.is_empty())
}

fn get_json(url: &str, key: &str) -> Result<Value, String> {
    crate::net::get(url)
        .set("Authorization", &format!("Bearer {key}"))
        .timeout(Duration::from_secs(10))
        .call()
        .map_err(http_error)?
        .into_json()
        .map_err(|_| "返回的不是 JSON".to_string())
}

fn need_key(id: &str) -> Result<String, String> {
    secret_get(id).ok_or_else(|| "未填写 API Key（设置 › AI 额度）".to_string())
}

fn num(v: Option<&Value>) -> Option<f64> {
    v.and_then(|x| x.as_f64().or_else(|| x.as_str().and_then(|s| s.parse().ok())))
}

fn money(cur: &str, n: f64) -> String {
    let sym = match cur { "CNY" => "¥", "USD" => "$", _ => "" };
    if sym.is_empty() { format!("{n:.2} {cur}") } else { format!("{sym}{n:.2}") }
}

fn deepseek(id: &str) -> Custom {
    let v = get_json("https://api.deepseek.com/user/balance", &need_key(id)?)?;
    let infos = v.get("balance_infos").and_then(|x| x.as_array()).cloned().unwrap_or_default();
    let info = infos.iter().find(|i| i.get("currency").and_then(|c| c.as_str()) == Some("CNY")).or(infos.first()).ok_or("没有余额信息")?;
    let cur = info.get("currency").and_then(|c| c.as_str()).unwrap_or("");
    let mut q = vec![Quota { title: "账户余额".into(), value: money(cur, num(info.get("total_balance")).unwrap_or(0.0)), ..Default::default() }];
    if let Some(g) = num(info.get("granted_balance")).filter(|g| *g > 0.0) {
        q.push(Quota { title: "赠送余额".into(), value: money(cur, g), ..Default::default() });
    }
    let plan = if v.get("is_available").and_then(|x| x.as_bool()) == Some(false) { "余额不足".into() } else { String::new() };
    Ok((plan, q))
}

fn openrouter(id: &str) -> Custom {
    let key = need_key(id)?;
    let k = get_json("https://openrouter.ai/api/v1/key", &key)?;
    let d = k.get("data").ok_or("返回格式不对")?;
    let mut q = vec![];
    if let Ok(c) = get_json("https://openrouter.ai/api/v1/credits", &key) {
        let total = num(c.pointer("/data/total_credits")).unwrap_or(0.0);
        let used = num(c.pointer("/data/total_usage")).unwrap_or(0.0);
        q.push(Quota { title: "账户余额".into(), value: format!("${:.2}", total - used), percent: (total > 0.0).then(|| used / total * 100.0), ..Default::default() });
    }
    if let Some(limit) = num(d.get("limit")).filter(|l| *l > 0.0) {
        let rem = num(d.get("limit_remaining")).unwrap_or(0.0);
        q.push(Quota { title: "密钥额度".into(), value: format!("${rem:.2}"), percent: Some((1.0 - rem / limit) * 100.0), ..Default::default() });
    }
    if let Some(day) = num(d.get("usage_daily")) {
        q.push(Quota { title: "今日扣费".into(), value: format!("${day:.2}"), ..Default::default() });
    }
    Ok((if d.get("is_free_tier").and_then(|x| x.as_bool()) == Some(true) { "Free".into() } else { String::new() }, q))
}

fn moonshot(id: &str) -> Custom {
    let key = need_key(id)?;
    // Try the China endpoint first, then the international one.
    let v = get_json("https://api.moonshot.cn/v1/users/me/balance", &key).or_else(|_| get_json("https://api.moonshot.ai/v1/users/me/balance", &key))?;
    let d = v.get("data").ok_or("返回格式不对")?;
    let mut q = vec![Quota { title: "可用余额".into(), value: format!("¥{:.2}", num(d.get("available_balance")).unwrap_or(0.0)), ..Default::default() }];
    if let Some(v) = num(d.get("voucher_balance")).filter(|x| *x > 0.0) {
        q.push(Quota { title: "代金券".into(), value: format!("¥{v:.2}"), ..Default::default() });
    }
    Ok((String::new(), q))
}
