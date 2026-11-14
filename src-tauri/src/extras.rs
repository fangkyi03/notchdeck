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
    /// Text content; for images a short description ("图片 1280×720").
    pub text: String,
    pub at: i64,
    #[serde(default)]
    pub pinned: bool,
    /// "text" | "image"
    #[serde(default = "kind_text")]
    pub kind: String,
    /// Full-size PNG on disk (images only).
    #[serde(default)]
    pub image: String,
    /// Small data: URL preview (images only).
    #[serde(default)]
    pub thumb: String,
}

fn kind_text() -> String {
    "text".into()
}

pub static CLIPS: Mutex<Vec<ClipItem>> = Mutex::new(Vec::new());
const MAX_CLIPS: usize = 60;
const MAX_IMAGE_BYTES: usize = 40 * 1024 * 1024;

fn clip_dir() -> PathBuf {
    let d = data_dir().join("clips");
    let _ = std::fs::create_dir_all(&d);
    d
}

fn save_clips(v: &[ClipItem]) {
    let _ = store_set("clipboard", &serde_json::to_value(v).unwrap_or(Value::Null));
}

fn remove_files(item: &ClipItem) {
    if !item.image.is_empty() {
        let _ = std::fs::remove_file(&item.image);
    }
}

pub fn clips() -> Vec<ClipItem> {
    CLIPS.lock().unwrap().clone()
}

pub fn clip_copy(text: &str) -> Result<(), String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_text(text.to_string()).map_err(|e| e.to_string())
}

/// Put a recorded item back on the clipboard (text or image).
pub fn clip_restore(index: usize) -> Result<(), String> {
    let item = CLIPS.lock().unwrap().get(index).cloned().ok_or("记录不存在")?;
    if item.kind != "image" {
        return clip_copy(&item.text);
    }
    let img = image::open(&item.image).map_err(|e| format!("图片读取失败：{e}"))?.to_rgba8();
    let (w, h) = img.dimensions();
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_image(arboard::ImageData { width: w as usize, height: h as usize, bytes: img.into_raw().into() }).map_err(|e| e.to_string())
}

pub fn clip_update(index: usize, action: &str) {
    let mut v = CLIPS.lock().unwrap();
    if index >= v.len() {
        return;
    }
    match action {
        "pin" => v[index].pinned = !v[index].pinned,
        "delete" => remove_files(&v.remove(index)),
        _ => {}
    }
    save_clips(&v);
}

pub fn clip_clear() {
    let mut v = CLIPS.lock().unwrap();
    v.iter().filter(|c| !c.pinned).for_each(remove_files);
    v.retain(|c| c.pinned);
    save_clips(&v);
}

/// Cheap fingerprint so an unchanged clipboard image isn't re-encoded every poll.
fn fingerprint(bytes: &[u8], w: usize, h: usize) -> u64 {
    let mut x: u64 = (w as u64) << 32 ^ h as u64 ^ bytes.len() as u64;
    let step = (bytes.len() / 4096).max(1);
    for (i, b) in bytes.iter().step_by(step).enumerate() {
        x = x.rotate_left(5) ^ (*b as u64) ^ i as u64;
    }
    x
}

fn store_image(w: usize, h: usize, rgba: &[u8], fp: u64) -> Option<ClipItem> {
    let img = image::RgbaImage::from_raw(w as u32, h as u32, rgba.to_vec())?;
    let path = clip_dir().join(format!("{fp:016x}.png"));
    img.save(&path).ok()?;
    // 160px-wide preview as a data URL.
    let scale = (160.0 / w.max(h) as f32).min(1.0);
    let thumb = image::imageops::thumbnail(&img, ((w as f32 * scale) as u32).max(1), ((h as f32 * scale) as u32).max(1));
    let mut png = std::io::Cursor::new(Vec::new());
    thumb.write_to(&mut png, image::ImageFormat::Png).ok()?;
    use base64::Engine;
    Some(ClipItem {
        text: format!("图片 {w}×{h}"),
        at: chrono::Utc::now().timestamp(),
        pinned: false,
        kind: "image".into(),
        image: path.to_string_lossy().to_string(),
        thumb: format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png.into_inner())),
    })
}

fn push_item(app: &AppHandle, item: ClipItem) {
    let mut v = CLIPS.lock().unwrap();
    let key = if item.kind == "image" { item.image.clone() } else { item.text.clone() };
    let pinned = v
        .iter()
        .position(|c| (if c.kind == "image" { &c.image } else { &c.text }) == &key)
        .map(|i| v.remove(i).pinned)
        .unwrap_or(false);
    v.insert(0, ClipItem { pinned, ..item });
    // Keep pinned items, trim the rest (and their image files).
    let mut kept = 0;
    let mut dropped = vec![];
    v.retain(|c| {
        kept += 1;
        let keep = c.pinned || kept <= MAX_CLIPS;
        if !keep {
            dropped.push(c.clone());
        }
        keep
    });
    dropped.iter().for_each(remove_files);
    save_clips(&v);
    drop(v);
    let _ = app.emit("clipboard-changed", ());
}

/// Polls the clipboard for new text and images (works the same on macOS and Windows).
pub fn spawn_clipboard_watcher(app: AppHandle, enabled: impl Fn() -> (bool, bool) + Send + 'static) {
    if let Ok(v) = serde_json::from_value::<Vec<ClipItem>>(store_get("clipboard")) {
        *CLIPS.lock().unwrap() = v;
    }
    std::thread::spawn(move || {
        let mut cb = arboard::Clipboard::new().ok();
        let mut last_text = cb.as_mut().and_then(|c| c.get_text().ok()).unwrap_or_default();
        let mut last_img = cb.as_mut().and_then(|c| c.get_image().ok()).map(|i| fingerprint(&i.bytes, i.width, i.height)).unwrap_or(0);
        loop {
            std::thread::sleep(Duration::from_millis(800));
            let (on, images) = enabled();
            if !on {
                continue;
            }
            if cb.is_none() {
                cb = arboard::Clipboard::new().ok();
            }
            let Some(c) = cb.as_mut() else { continue };
            if let Ok(text) = c.get_text() {
                if text != last_text && !text.trim().is_empty() && text.len() <= 100_000 {
                    last_text = text.clone();
                    push_item(&app, ClipItem { text, at: chrono::Utc::now().timestamp(), pinned: false, kind: "text".into(), image: String::new(), thumb: String::new() });
                }
                continue;
            }
            if !images {
                continue;
            }
            if let Ok(img) = c.get_image() {
                if img.bytes.len() > MAX_IMAGE_BYTES {
                    continue;
                }
                let fp = fingerprint(&img.bytes, img.width, img.height);
                if fp != last_img {
                    last_img = fp;
                    if let Some(item) = store_image(img.width, img.height, &img.bytes, fp) {
                        push_item(&app, item);
                    }
                }
            }
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
