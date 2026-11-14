//! Calendar sync: ICS subscriptions (iCloud public, Google, Feishu, DingTalk,
//! Outlook…), CalDAV accounts (with discovery) and imported .ics files.
//! Remote calendars are read-only.

use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, NaiveDateTime, TimeZone, Utc, Weekday};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

#[derive(Serialize, Clone, Debug)]
pub struct Event {
    pub id: String,
    pub title: String,
    /// Unix seconds.
    pub start: i64,
    pub end: i64,
    pub all_day: bool,
    pub location: String,
    pub calendar: String,
    pub color: String,
}

#[derive(Serialize, Clone, Default)]
pub struct CalResult {
    pub events: Vec<Event>,
    pub errors: Vec<String>,
    pub updated: i64,
}

/* ------------------------------ ICS parsing ------------------------------ */

fn unfold(text: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for raw in text.split('\n') {
        let line = raw.trim_end_matches('\r');
        if (line.starts_with(' ') || line.starts_with('\t')) && !out.is_empty() {
            out.last_mut().unwrap().push_str(&line[1..]);
        } else {
            out.push(line.to_string());
        }
    }
    out
}

fn unescape(s: &str) -> String {
    s.replace("\\n", " ").replace("\\N", " ").replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\")
}

/// Splits "DTSTART;TZID=Asia/Shanghai:20261116T090000" into (name, params, value).
fn split_prop(line: &str) -> Option<(String, HashMap<String, String>, String)> {
    let colon = line.find(':')?;
    let (head, value) = (&line[..colon], &line[colon + 1..]);
    let mut parts = head.split(';');
    let name = parts.next()?.to_uppercase();
    let params = parts.filter_map(|p| p.split_once('=').map(|(k, v)| (k.to_uppercase(), v.trim_matches('"').to_string()))).collect();
    Some((name, params, value.to_string()))
}

/// Parses an ICS date/date-time. Returns (unix seconds, all-day).
fn parse_dt(value: &str, params: &HashMap<String, String>) -> Option<(i64, bool)> {
    let v = value.trim();
    if params.get("VALUE").map(|s| s.as_str()) == Some("DATE") || (v.len() == 8 && !v.contains('T')) {
        let d = NaiveDate::parse_from_str(v, "%Y%m%d").ok()?;
        return Some((Local.from_local_datetime(&d.and_hms_opt(0, 0, 0)?).earliest()?.timestamp(), true));
    }
    if let Some(utc) = v.strip_suffix('Z') {
        let n = NaiveDateTime::parse_from_str(utc, "%Y%m%dT%H%M%S").ok()?;
        return Some((Utc.from_utc_datetime(&n).timestamp(), false));
    }
    let n = NaiveDateTime::parse_from_str(v, "%Y%m%dT%H%M%S").ok()?;
    if let Some(tz) = params.get("TZID").and_then(|t| t.parse::<chrono_tz::Tz>().ok()) {
        return Some((tz.from_local_datetime(&n).earliest()?.timestamp(), false));
    }
    // Floating time / unknown TZID (e.g. Windows names): treat as local.
    Some((Local.from_local_datetime(&n).earliest()?.timestamp(), false))
}

/// "PT1H30M" / "P1D"
fn parse_duration(v: &str) -> Option<i64> {
    let mut secs = 0i64;
    let mut num = String::new();
    let mut in_time = false;
    for c in v.trim_start_matches(['+', '-']).chars() {
        match c {
            'P' => {}
            'T' => in_time = true,
            '0'..='9' => num.push(c),
            'W' => { secs += num.parse::<i64>().ok()? * 7 * 86400; num.clear(); }
            'D' => { secs += num.parse::<i64>().ok()? * 86400; num.clear(); }
            'H' if in_time => { secs += num.parse::<i64>().ok()? * 3600; num.clear(); }
            'M' if in_time => { secs += num.parse::<i64>().ok()? * 60; num.clear(); }
            'S' if in_time => { secs += num.parse::<i64>().ok()?; num.clear(); }
            _ => return None,
        }
    }
    Some(secs)
}

struct Raw {
    uid: String,
    title: String,
    location: String,
    start: i64,
    end: i64,
    all_day: bool,
    rrule: Option<String>,
    exdates: Vec<i64>,
    recurrence_id: Option<i64>,
    cancelled: bool,
}

fn weekday(s: &str) -> Option<Weekday> {
    Some(match s.trim_start_matches(|c: char| c == '-' || c == '+' || c.is_ascii_digit()) {
        "MO" => Weekday::Mon,
        "TU" => Weekday::Tue,
        "WE" => Weekday::Wed,
        "TH" => Weekday::Thu,
        "FR" => Weekday::Fri,
        "SA" => Weekday::Sat,
        "SU" => Weekday::Sun,
        _ => return None,
    })
}

/// Expands a recurring event into occurrence start times within [from, to).
fn expand(start: i64, rrule: &str, from: i64, to: i64) -> Vec<i64> {
    let rule: HashMap<String, String> = rrule.split(';').filter_map(|p| p.split_once('=').map(|(k, v)| (k.to_uppercase(), v.to_string()))).collect();
    let freq = rule.get("FREQ").map(|s| s.as_str()).unwrap_or("");
    let interval = rule.get("INTERVAL").and_then(|s| s.parse::<i64>().ok()).unwrap_or(1).max(1);
    let count = rule.get("COUNT").and_then(|s| s.parse::<usize>().ok());
    let until = rule.get("UNTIL").and_then(|u| parse_dt(u, &HashMap::new())).map(|(t, _)| t);
    let byday: Vec<Weekday> = rule.get("BYDAY").map(|s| s.split(',').filter_map(weekday).collect()).unwrap_or_default();
    let Some(first) = Local.timestamp_opt(start, 0).single() else { return vec![] };
    let (time, date0) = (first.time(), first.date_naive());
    let at = |d: NaiveDate| Local.from_local_datetime(&d.and_time(time)).earliest().map(|t| t.timestamp());

    let mut out = vec![];
    let mut produced = 0usize;
    let mut push = |t: i64, out: &mut Vec<i64>| -> bool {
        if until.is_some_and(|u| t > u) || count.is_some_and(|c| produced >= c) || t >= to {
            return false;
        }
        produced += 1;
        if t >= from - 86400 * 2 {
            out.push(t);
        }
        true
    };
    match freq {
        "DAILY" => {
            let mut d = date0;
            for _ in 0..3000 {
                let Some(t) = at(d) else { break };
                if !push(t, &mut out) { break; }
                d += Duration::days(interval);
            }
        }
        "WEEKLY" => {
            let days = if byday.is_empty() { vec![date0.weekday()] } else { byday };
            let week0 = date0 - Duration::days(date0.weekday().num_days_from_monday() as i64);
            'w: for w in 0..1000 {
                let monday = week0 + Duration::weeks(w * interval);
                let mut ds: Vec<NaiveDate> = days.iter().map(|wd| monday + Duration::days(wd.num_days_from_monday() as i64)).filter(|d| *d >= date0).collect();
                ds.sort();
                for d in ds {
                    let Some(t) = at(d) else { continue };
                    if !push(t, &mut out) { break 'w; }
                }
            }
        }
        "MONTHLY" => {
            for k in 0..600 {
                let m0 = date0.month0() as i64 + k * interval;
                let (y, m) = (date0.year() + (m0 / 12) as i32, (m0 % 12) as u32 + 1);
                let Some(d) = NaiveDate::from_ymd_opt(y, m, date0.day()) else { continue };
                let Some(t) = at(d) else { continue };
                if !push(t, &mut out) { break; }
            }
        }
        "YEARLY" => {
            for k in 0..100 {
                let Some(d) = NaiveDate::from_ymd_opt(date0.year() + (k * interval) as i32, date0.month(), date0.day()) else { continue };
                let Some(t) = at(d) else { continue };
                if !push(t, &mut out) { break; }
            }
        }
        _ => out.push(start),
    }
    out
}

pub fn parse_ics(text: &str, calendar: &str, color: &str, from: i64, to: i64) -> Vec<Event> {
    let mut raws: Vec<Raw> = vec![];
    let mut cur: Option<Raw> = None;
    let mut dur: Option<i64> = None;
    for line in unfold(text) {
        match line.as_str() {
            "BEGIN:VEVENT" => {
                cur = Some(Raw { uid: String::new(), title: String::new(), location: String::new(), start: 0, end: 0, all_day: false, rrule: None, exdates: vec![], recurrence_id: None, cancelled: false });
                dur = None;
                continue;
            }
            "END:VEVENT" => {
                if let Some(mut r) = cur.take() {
                    if r.end <= r.start {
                        r.end = r.start + dur.unwrap_or(if r.all_day { 86400 } else { 3600 });
                    }
                    if r.start > 0 && !r.cancelled {
                        raws.push(r);
                    }
                }
                continue;
            }
            _ => {}
        }
        let Some(r) = cur.as_mut() else { continue };
        let Some((name, params, value)) = split_prop(&line) else { continue };
        match name.as_str() {
            "UID" => r.uid = value,
            "SUMMARY" => r.title = unescape(&value),
            "LOCATION" => r.location = unescape(&value),
            "DTSTART" => if let Some((t, d)) = parse_dt(&value, &params) { r.start = t; r.all_day = d; },
            "DTEND" => if let Some((t, _)) = parse_dt(&value, &params) { r.end = t; },
            "DURATION" => dur = parse_duration(&value),
            "RRULE" => r.rrule = Some(value),
            "EXDATE" => r.exdates.extend(value.split(',').filter_map(|v| parse_dt(v, &params)).map(|(t, _)| t)),
            "RECURRENCE-ID" => r.recurrence_id = parse_dt(&value, &params).map(|(t, _)| t),
            "STATUS" => r.cancelled = value.eq_ignore_ascii_case("CANCELLED"),
            _ => {}
        }
    }
    // Instances overridden by a RECURRENCE-ID entry replace the generated occurrence.
    let overrides: Vec<(String, i64)> = raws.iter().filter_map(|r| r.recurrence_id.map(|t| (r.uid.clone(), t))).collect();
    let mut out = vec![];
    for r in &raws {
        let len = r.end - r.start;
        let starts = match (&r.rrule, r.recurrence_id) {
            (Some(rule), None) => expand(r.start, rule, from, to),
            _ => vec![r.start],
        };
        for s in starts {
            if r.recurrence_id.is_none() && (r.exdates.contains(&s) || overrides.iter().any(|(u, t)| *u == r.uid && *t == s)) {
                continue;
            }
            if s + len < from || s >= to {
                continue;
            }
            out.push(Event {
                id: format!("{}@{}", r.uid, s),
                title: if r.title.is_empty() { "（无标题）".into() } else { r.title.clone() },
                start: s,
                end: s + len,
                all_day: r.all_day,
                location: r.location.clone(),
                calendar: calendar.to_string(),
                color: color.to_string(),
            });
        }
    }
    out
}

/* --------------------------------- fetch --------------------------------- */

fn get_text(url: &str, auth: Option<(&str, &str)>) -> Result<String, String> {
    let mut req = crate::net::get(url).set("User-Agent", "NotchDeck");
    if let Some((u, p)) = auth {
        use base64::Engine;
        req = req.set("Authorization", &format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{u}:{p}"))));
    }
    req.call().map_err(|e| match e {
        ureq::Error::Status(401, _) => "账号或密码不对（HTTP 401）".to_string(),
        ureq::Error::Status(c, _) => format!("HTTP {c}"),
        e => format!("网络错误：{e}"),
    })?
    .into_string()
    .map_err(|e| e.to_string())
}

fn dav(method: &str, url: &str, depth: &str, body: &str, auth: (&str, &str)) -> Result<String, String> {
    use base64::Engine;
    let r = crate::net::agent(std::time::Duration::from_secs(20))
        .request(method, url)
        .set("Depth", depth)
        .set("Content-Type", "application/xml; charset=utf-8")
        .set("Authorization", &format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", auth.0, auth.1))))
        .send_string(body);
    match r {
        Ok(r) => r.into_string().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(401, _)) => Err("账号或密码不对（iCloud 需使用 App 专用密码）".into()),
        Err(ureq::Error::Status(c, _)) => Err(format!("HTTP {c}")),
        Err(e) => Err(format!("网络错误：{e}")),
    }
}

/// Text contents of every element with this local name (namespace prefixes ignored).
fn tags(xml: &str, local: &str) -> Vec<String> {
    let mut out = vec![];
    let mut rest = xml;
    while let Some(i) = rest.find('<') {
        rest = &rest[i + 1..];
        let end = rest.find('>').unwrap_or(rest.len());
        let head = &rest[..end];
        if head.starts_with('/') || head.ends_with('/') {
            continue;
        }
        let name = head.split_whitespace().next().unwrap_or("");
        let lname = name.rsplit(':').next().unwrap_or(name);
        if lname.eq_ignore_ascii_case(local) {
            let body = &rest[end.min(rest.len())..].trim_start_matches('>');
            if let Some(close) = body.find(&format!("</{name}>")) {
                out.push(body[..close].to_string());
            }
        }
    }
    out
}

fn xml_unescape(s: &str) -> String {
    let s = s.trim();
    let s = s.strip_prefix("<![CDATA[").and_then(|x| x.strip_suffix("]]>")).unwrap_or(s);
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&#13;", "\r").replace("&amp;", "&")
}

fn join_url(base: &str, href: &str) -> String {
    if href.starts_with("http") {
        return href.to_string();
    }
    let origin = base.splitn(4, '/').take(3).collect::<Vec<_>>().join("/");
    format!("{origin}{href}")
}

/// Finds calendar collections starting from any CalDAV URL (server root, principal or calendar).
fn discover(url: &str, auth: (&str, &str)) -> Result<Vec<String>, String> {
    let principal_q = r#"<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>"#;
    let home_q = r#"<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>"#;
    let list_q = r#"<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:resourcetype/><d:displayname/><c:supported-calendar-component-set/></d:prop></d:propfind>"#;

    let mut home = url.to_string();
    if let Ok(x) = dav("PROPFIND", url, "0", principal_q, auth) {
        if let Some(p) = tags(&x, "current-user-principal").first().and_then(|b| tags(b, "href").first().cloned()) {
            let purl = join_url(url, p.trim());
            if let Ok(h) = dav("PROPFIND", &purl, "0", home_q, auth) {
                if let Some(hh) = tags(&h, "calendar-home-set").first().and_then(|b| tags(b, "href").first().cloned()) {
                    home = join_url(&purl, hh.trim());
                }
            }
        }
    }
    let x = dav("PROPFIND", &home, "1", list_q, auth)?;
    let cals: Vec<String> = tags(&x, "response")
        .into_iter()
        .filter(|r| {
            // A calendar collection, and not a reminders-only (VTODO) list.
            let rt = tags(r, "resourcetype").join("");
            let comps = tags(r, "supported-calendar-component-set").join("");
            rt.contains("calendar") && (comps.is_empty() || comps.contains("VEVENT"))
        })
        .filter_map(|r| tags(&r, "href").first().map(|h| join_url(&home, h.trim())))
        .collect();
    if cals.is_empty() {
        Ok(vec![url.to_string()])
    } else {
        Ok(cals)
    }
}

fn caldav_events(url: &str, auth: (&str, &str), name: &str, color: &str, from: i64, to: i64) -> Result<Vec<Event>, String> {
    let fmt = |t: i64| DateTime::<Utc>::from_timestamp(t, 0).unwrap().format("%Y%m%dT%H%M%SZ").to_string();
    let q = format!(
        r#"<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="{}" end="{}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>"#,
        fmt(from),
        fmt(to)
    );
    let mut out = vec![];
    for cal in discover(url, auth)? {
        let Ok(x) = dav("REPORT", &cal, "1", &q, auth) else { continue };
        for data in tags(&x, "calendar-data") {
            out.extend(parse_ics(&xml_unescape(&data), name, color, from, to));
        }
    }
    Ok(out)
}

static CACHE: Mutex<Option<(Instant, String, CalResult)>> = Mutex::new(None);

pub fn events(cfg: &Value, force: bool) -> CalResult {
    let sources = cfg.get("calendars").cloned().unwrap_or(Value::Array(vec![]));
    let sig = sources.to_string();
    if let Some((at, s, r)) = CACHE.lock().unwrap().as_ref() {
        if *s == sig && at.elapsed().as_secs() < if force { 20 } else { 600 } {
            return r.clone();
        }
    }
    let now = Local::now().timestamp();
    let (from, to) = (now - 45 * 86400, now + 90 * 86400);
    let mut res = CalResult { updated: now, ..Default::default() };
    for c in sources.as_array().into_iter().flatten() {
        if !c.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true) {
            continue;
        }
        let s = |k: &str| c.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let (name, color, url) = (s("name"), s("color"), s("url").replace("webcal://", "https://"));
        let r = match s("kind").as_str() {
            "caldav" => {
                let pass = crate::usage::secret_get(&format!("cal-{}", s("id"))).unwrap_or_default();
                caldav_events(&url, (&s("user"), &pass), &name, &color, from, to)
            }
            _ => get_text(&url, None).map(|t| parse_ics(&t, &name, &color, from, to)),
        };
        match r {
            Ok(ev) => res.events.extend(ev),
            Err(e) => res.errors.push(format!("{name}：{e}")),
        }
    }
    // The same meeting often arrives from several calendars (e.g. mail invite + work calendar).
    res.events.sort_by(|a, b| a.start.cmp(&b.start).then(a.title.cmp(&b.title)));
    res.events.dedup_by(|a, b| a.start == b.start && a.title == b.title);
    *CACHE.lock().unwrap() = Some((Instant::now(), sig, res.clone()));
    res
}

pub fn import(text: &str) -> Vec<Event> {
    let now = Local::now().timestamp();
    parse_ics(text, "本机", "#30d158", now - 365 * 86400, now + 365 * 86400)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_weekly_rrule_and_exdate() {
        let ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nSUMMARY:站会\r\nDTSTART:20261102T010000Z\r\nDTEND:20261102T011500Z\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4\r\nEXDATE:20261104T010000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let from = Utc.with_ymd_and_hms(2026, 11, 1, 0, 0, 0).unwrap().timestamp();
        let to = from + 40 * 86400;
        let ev = parse_ics(ics, "c", "#fff", from, to);
        // Mon 2, Wed 4 (excluded), Mon 9, Wed 11 → 3 occurrences.
        assert_eq!(ev.len(), 3, "{ev:?}");
        assert!(ev.iter().all(|e| e.end - e.start == 900));
    }

    #[test]
    fn parses_all_day_and_tzid_and_folding() {
        let ics = "BEGIN:VEVENT\nUID:b\nSUMMARY:长标题\n 续行\nDTSTART;VALUE=DATE:20261120\nEND:VEVENT\nBEGIN:VEVENT\nUID:c\nSUMMARY:会议\nDTSTART;TZID=Asia/Shanghai:20261120T090000\nDURATION:PT1H30M\nEND:VEVENT\n";
        let ev = parse_ics(ics, "c", "", 0, i64::MAX / 2);
        assert_eq!(ev.len(), 2);
        let allday = ev.iter().find(|e| e.all_day).unwrap();
        assert_eq!(allday.title, "长标题续行");
        let m = ev.iter().find(|e| !e.all_day).unwrap();
        assert_eq!(m.start, Utc.with_ymd_and_hms(2026, 11, 20, 1, 0, 0).unwrap().timestamp());
        assert_eq!(m.end - m.start, 5400);
    }

    #[test]
    fn extracts_caldav_tags() {
        let x = r#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>/cal/a/</d:href><cal:calendar-data>BEGIN:VCALENDAR&#13;
END:VCALENDAR</cal:calendar-data></d:response></d:multistatus>"#;
        assert_eq!(tags(x, "href"), vec!["/cal/a/"]);
        assert!(xml_unescape(&tags(x, "calendar-data")[0]).starts_with("BEGIN:VCALENDAR"));
    }
}
