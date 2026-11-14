//! Clipboard history, weather and a tiny JSON key-value store for todos / focus.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub fn data_dir() -> PathBuf {
    let dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("NotchDeck");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/* ----------------------------- KV store ----------------------------- */

fn safe_key(key: &str) -> Option<String> {
    (!key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')).then(|| key.to_string())
}

pub fn store_get(key: &str) -> Value {
    let Some(k) = safe_key(key) else { return Value::Null };
    std::fs::read_to_string(data_dir().join(format!("{k}.json"))).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null)
}

pub fn store_set(key: &str, value: &Value) -> Result<(), String> {
    let k = safe_key(key).ok_or("bad key")?;
    std::fs::write(data_dir().join(format!("{k}.json")), serde_json::to_string(value).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/* ----------------------------- clipboard ---------------------------- */

#[derive(Serialize, Deserialize, Clone)]
pub struct ClipItem {
    pub text: String,
    pub at: i64,
    #[serde(default)]
    pub pinned: bool,
}

pub static CLIPS: Mutex<Vec<ClipItem>> = Mutex::new(Vec::new());
const MAX_CLIPS: usize = 50;

fn save_clips(v: &[ClipItem]) {
    let _ = store_set("clipboard", &serde_json::to_value(v).unwrap_or(Value::Null));
}

pub fn clips() -> Vec<ClipItem> {
    CLIPS.lock().unwrap().clone()
}

pub fn clip_copy(text: &str) -> Result<(), String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_text(text.to_string()).map_err(|e| e.to_string())
}

pub fn clip_update(index: usize, action: &str) {
    let mut v = CLIPS.lock().unwrap();
    if index >= v.len() {
        return;
    }
    match action {
        "pin" => v[index].pinned = !v[index].pinned,
        "delete" => {
            v.remove(index);
        }
        _ => {}
    }
    save_clips(&v);
}

pub fn clip_clear() {
    let mut v = CLIPS.lock().unwrap();
    v.retain(|c| c.pinned);
    save_clips(&v);
}

/// Polls the clipboard for new text (no OS-specific hooks needed on either platform).
pub fn spawn_clipboard_watcher(app: AppHandle, enabled: impl Fn() -> bool + Send + 'static) {
    if let Ok(v) = serde_json::from_value::<Vec<ClipItem>>(store_get("clipboard")) {
        *CLIPS.lock().unwrap() = v;
    }
    std::thread::spawn(move || {
        let mut cb = arboard::Clipboard::new().ok();
        let mut last = cb.as_mut().and_then(|c| c.get_text().ok()).unwrap_or_default();
        loop {
            std::thread::sleep(Duration::from_millis(800));
            if !enabled() {
                continue;
            }
            if cb.is_none() {
                cb = arboard::Clipboard::new().ok();
            }
            let Some(text) = cb.as_mut().and_then(|c| c.get_text().ok()) else { continue };
            if text == last || text.trim().is_empty() || text.len() > 100_000 {
                continue;
            }
            last = text.clone();
            let mut v = CLIPS.lock().unwrap();
            let pinned = v.iter().position(|c| c.text == text).map(|i| v.remove(i).pinned).unwrap_or(false);
            v.insert(0, ClipItem { text, at: chrono::Utc::now().timestamp(), pinned });
            // Keep pinned items, trim the rest.
            let mut kept = 0;
            v.retain(|c| {
                kept += 1;
                c.pinned || kept <= MAX_CLIPS
            });
            save_clips(&v);
            drop(v);
            let _ = app.emit("clipboard-changed", ());
        }
    });
}

/* ------------------------------ weather ----------------------------- */

#[derive(Serialize, Clone, Default)]
pub struct Weather {
    pub city: String,
    pub temp: f64,
    pub feels: f64,
    pub humidity: f64,
    pub wind: f64,
    pub code: i64,
    pub is_day: bool,
    pub sunrise: String,
    pub sunset: String,
    pub daily: Vec<Day>,
    pub updated: i64,
}

#[derive(Serialize, Clone, Default)]
pub struct Day {
    pub date: String,
    pub code: i64,
    pub max: f64,
    pub min: f64,
    pub rain: f64,
}

static WEATHER: Mutex<Option<(String, std::time::Instant, Weather)>> = Mutex::new(None);

fn agent() -> ureq::Agent {
    crate::net::agent(Duration::from_secs(10))
}

fn locate(city: &str) -> Result<(String, f64, f64), String> {
    if city.trim().is_empty() {
        let v: Value = agent().get("https://ipwho.is/").call().map_err(|e| e.to_string())?.into_json().map_err(|e| e.to_string())?;
        let lat = v.get("latitude").and_then(|x| x.as_f64()).ok_or("定位失败")?;
        let lon = v.get("longitude").and_then(|x| x.as_f64()).ok_or("定位失败")?;
        return Ok((v.get("city").and_then(|x| x.as_str()).unwrap_or("").to_string(), lat, lon));
    }
    let v: Value = agent()
        .get("https://geocoding-api.open-meteo.com/v1/search")
        .query("name", city.trim())
        .query("count", "1")
        .query("language", "zh")
        .call()
        .map_err(|e| e.to_string())?
        .into_json()
        .map_err(|e| e.to_string())?;
    let r = v.pointer("/results/0").ok_or("找不到这个城市")?;
    Ok((
        r.get("name").and_then(|x| x.as_str()).unwrap_or(city).to_string(),
        r.get("latitude").and_then(|x| x.as_f64()).ok_or("bad geo")?,
        r.get("longitude").and_then(|x| x.as_f64()).ok_or("bad geo")?,
    ))
}

pub fn weather(city: &str, force: bool) -> Result<Weather, String> {
    {
        let w = WEATHER.lock().unwrap();
        if let Some((c, at, data)) = w.as_ref() {
            let ttl = if force { 30 } else { 15 * 60 };
            if c == city && at.elapsed() < Duration::from_secs(ttl) {
                return Ok(data.clone());
            }
        }
    }
    let (name, lat, lon) = locate(city)?;
    let v: Value = agent()
        .get("https://api.open-meteo.com/v1/forecast")
        .query("latitude", &lat.to_string())
        .query("longitude", &lon.to_string())
        .query("current", "temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code,is_day")
        .query("daily", "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset")
        .query("timezone", "auto")
        .query("forecast_days", "5")
        .call()
        .map_err(|e| e.to_string())?
        .into_json()
        .map_err(|e| e.to_string())?;
    let c = v.get("current").ok_or("天气数据异常")?;
    let f = |o: &Value, k: &str| o.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0);
    let d = v.get("daily").cloned().unwrap_or(Value::Null);
    let arr = |k: &str| d.get(k).and_then(|x| x.as_array()).cloned().unwrap_or_default();
    let (dates, codes, maxs, mins, rains) = (arr("time"), arr("weather_code"), arr("temperature_2m_max"), arr("temperature_2m_min"), arr("precipitation_probability_max"));
    let hm = |k: &str| arr(k).first().and_then(|x| x.as_str()).and_then(|s| s.split('T').nth(1)).unwrap_or("").to_string();
    let w = Weather {
        city: name,
        temp: f(c, "temperature_2m"),
        feels: f(c, "apparent_temperature"),
        humidity: f(c, "relative_humidity_2m"),
        wind: f(c, "wind_speed_10m"),
        code: c.get("weather_code").and_then(|x| x.as_i64()).unwrap_or(0),
        is_day: c.get("is_day").and_then(|x| x.as_i64()).unwrap_or(1) == 1,
        sunrise: hm("sunrise"),
        sunset: hm("sunset"),
        daily: (0..dates.len())
            .map(|i| Day {
                date: dates[i].as_str().unwrap_or("").to_string(),
                code: codes.get(i).and_then(|x| x.as_i64()).unwrap_or(0),
                max: maxs.get(i).and_then(|x| x.as_f64()).unwrap_or(0.0),
                min: mins.get(i).and_then(|x| x.as_f64()).unwrap_or(0.0),
                rain: rains.get(i).and_then(|x| x.as_f64()).unwrap_or(0.0),
            })
            .collect(),
        updated: chrono::Utc::now().timestamp(),
    };
    *WEATHER.lock().unwrap() = Some((city.to_string(), std::time::Instant::now(), w.clone()));
    let _ = store_set("weather-cache", &serde_json::to_value(&w).unwrap_or(Value::Null));
    Ok(w)
}
