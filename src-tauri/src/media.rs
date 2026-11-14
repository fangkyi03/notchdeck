//! Now-playing info + transport control.
//! macOS: AppleScript (Spotify / Music). Windows: System Media Transport Controls,
//! which covers NetEase Cloud Music, QQ Music, Kugou, Spotify, browsers, ...

use serde::Serialize;

#[derive(Serialize, Clone, Default)]
pub struct Media {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub playing: bool,
    pub source: String,
    /// Seconds.
    pub position: f64,
    pub duration: f64,
    /// http(s) URL or data: URL.
    pub artwork: String,
}

#[cfg(target_os = "macos")]
mod imp {
    use super::Media;
    use base64::Engine;
    use std::process::Command;
    use std::sync::Mutex;

    static STATE: Mutex<(String, String, String)> = Mutex::new((String::new(), String::new(), String::new())); // app, track key, artwork

    const SCRIPT: &str = r#"
set out to ""
if application "Spotify" is running then
  tell application "Spotify"
    if player state is not stopped then
      set t to current track
      set out to (name of t) & "\t" & (artist of t) & "\t" & (album of t) & "\t" & (player state as string) & "\tSpotify\t" & (player position as string) & "\t" & ((duration of t) / 1000 as string) & "\t" & (artwork url of t)
    end if
  end tell
end if
if out is "" and application "Music" is running then
  tell application "Music"
    if player state is not stopped then
      set t to current track
      set out to (name of t) & "\t" & (artist of t) & "\t" & (album of t) & "\t" & (player state as string) & "\tMusic\t" & (player position as string) & "\t" & (duration of t as string) & "\t"
    end if
  end tell
end if
return out
"#;

    fn osa(script: &str) -> Option<String> {
        let out = Command::new("osascript").args(["-e", script]).output().ok()?;
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    fn num(s: &str) -> f64 {
        s.trim().replace(',', ".").parse().unwrap_or(0.0)
    }

    /// Music.app has no artwork URL; export the embedded image once per track.
    fn music_artwork() -> String {
        let path = std::env::temp_dir().join("notchdeck-artwork.bin");
        let p = path.to_string_lossy();
        let script = format!(
            r#"tell application "Music"
  try
    set d to raw data of artwork 1 of current track
    set f to open for access (POSIX file "{p}") with write permission
    set eof f to 0
    write d to f
    close access f
    return "ok"
  end try
end tell
return """#
        );
        if osa(&script).as_deref() != Some("ok") {
            return String::new();
        }
        match std::fs::read(&path) {
            Ok(b) if !b.is_empty() => {
                let mime = if b.starts_with(&[0x89, b'P']) { "image/png" } else { "image/jpeg" };
                format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(b))
            }
            _ => String::new(),
        }
    }

    pub fn get() -> Option<Media> {
        let s = osa(SCRIPT)?;
        let p: Vec<&str> = s.split('\t').collect();
        if p.len() < 8 {
            return None;
        }
        let mut st = STATE.lock().unwrap();
        st.0 = p[4].to_string();
        let key = format!("{}|{}|{}", p[0], p[1], p[2]);
        if st.1 != key {
            st.1 = key;
            st.2 = if p[4] == "Music" { music_artwork() } else { p[7].to_string() };
        }
        Some(Media {
            title: p[0].into(),
            artist: p[1].into(),
            album: p[2].into(),
            playing: p[3] == "playing",
            source: p[4].into(),
            position: num(p[5]),
            duration: num(p[6]),
            artwork: st.2.clone(),
        })
    }

    pub fn control(action: &str, value: f64) {
        let app = STATE.lock().unwrap().0.clone();
        if app.is_empty() {
            return;
        }
        let cmd = match action {
            "toggle" => "playpause".to_string(),
            "next" => "next track".to_string(),
            "prev" => "previous track".to_string(),
            "seek" => format!("set player position to {value}"),
            _ => return,
        };
        osa(&format!("tell application \"{app}\" to {cmd}"));
    }
}

#[cfg(windows)]
mod imp {
    use super::Media;
    use base64::Engine;
    use std::sync::Mutex;
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session, GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };
    use windows::Storage::Streams::DataReader;

    static ART: Mutex<(String, String)> = Mutex::new((String::new(), String::new()));

    fn session() -> Option<Session> {
        let mgr = Manager::RequestAsync().ok()?.get().ok()?;
        mgr.GetCurrentSession().ok()
    }

    fn thumbnail(props: &windows::Media::Control::GlobalSystemMediaTransportControlsSessionMediaProperties) -> Option<String> {
        let stream = props.Thumbnail().ok()?.OpenReadAsync().ok()?.get().ok()?;
        let size = stream.Size().ok()? as u32;
        if size == 0 || size > 8 * 1024 * 1024 {
            return None;
        }
        let reader = DataReader::CreateDataReader(&stream).ok()?;
        reader.LoadAsync(size).ok()?.get().ok()?;
        let mut buf = vec![0u8; size as usize];
        reader.ReadBytes(&mut buf).ok()?;
        let mime = stream.ContentType().map(|c| c.to_string()).unwrap_or_else(|_| "image/jpeg".into());
        let mime = if mime.is_empty() { "image/jpeg".to_string() } else { mime };
        Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(buf)))
    }

    pub fn get() -> Option<Media> {
        let s = session()?;
        let props = s.TryGetMediaPropertiesAsync().ok()?.get().ok()?;
        let title = props.Title().ok()?.to_string();
        if title.is_empty() {
            return None;
        }
        let artist = props.Artist().map(|a| a.to_string()).unwrap_or_default();
        let album = props.AlbumTitle().map(|a| a.to_string()).unwrap_or_default();
        let playing = s.GetPlaybackInfo().and_then(|i| i.PlaybackStatus()).map(|st| st == Status::Playing).unwrap_or(false);
        let source = s.SourceAppUserModelId().map(|x| x.to_string()).unwrap_or_default();
        let source = source.rsplit(['!', '\\']).next().unwrap_or("").trim_end_matches(".exe").to_string();
        let (mut position, mut duration) = (0.0, 0.0);
        if let Ok(tl) = s.GetTimelineProperties() {
            let secs = |t: windows::Foundation::TimeSpan| t.Duration as f64 / 1e7;
            position = tl.Position().map(secs).unwrap_or(0.0);
            duration = tl.EndTime().map(secs).unwrap_or(0.0);
            // SMTC position is a snapshot; advance it by the time since it was taken.
            if playing {
                if let Ok(updated) = tl.LastUpdatedTime() {
                    // UniversalTime: 100ns ticks since 1601-01-01.
                    let now_ticks = (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() / 100) as i64 + 116_444_736_000_000_000;
                    let dt = (now_ticks - updated.UniversalTime) as f64 / 1e7;
                    if dt > 0.0 && dt < 3600.0 {
                        position = (position + dt).min(duration.max(position));
                    }
                }
            }
        }
        let key = format!("{title}|{artist}|{album}");
        let artwork = {
            let mut a = ART.lock().unwrap();
            if a.0 != key {
                a.0 = key;
                a.1 = thumbnail(&props).unwrap_or_default();
            }
            a.1.clone()
        };
        Some(Media { title, artist, album, playing, source, position, duration, artwork })
    }

    pub fn control(action: &str, value: f64) {
        let Some(s) = session() else { return };
        let r = match action {
            "toggle" => s.TryTogglePlayPauseAsync(),
            "next" => s.TrySkipNextAsync(),
            "prev" => s.TrySkipPreviousAsync(),
            "seek" => s.TryChangePlaybackPositionAsync((value * 1e7) as i64),
            _ => return,
        };
        if let Ok(op) = r {
            let _ = op.get();
        }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod imp {
    use super::Media;
    pub fn get() -> Option<Media> {
        None
    }
    pub fn control(_: &str, _: f64) {}
}

pub use imp::{control, get};

/* ------------------------------ lyrics ------------------------------ */

#[derive(Serialize, Clone, Default)]
pub struct LyricLine {
    pub t: f64,
    pub text: String,
}

use std::collections::HashMap;
use std::sync::Mutex;
static LYRICS: Mutex<Option<HashMap<String, Vec<LyricLine>>>> = Mutex::new(None);

/// Synced lyrics from LRCLIB (free, no key). Cached per track for the session.
pub fn lyrics(title: &str, artist: &str, album: &str, duration: f64) -> Vec<LyricLine> {
    let key = format!("{title}|{artist}");
    if let Some(v) = LYRICS.lock().unwrap().get_or_insert_with(HashMap::new).get(&key) {
        return v.clone();
    }
    let lines = fetch_lrclib(title, artist, album, duration).unwrap_or_default();
    LYRICS.lock().unwrap().get_or_insert_with(HashMap::new).insert(key, lines.clone());
    lines
}

fn fetch_lrclib(title: &str, artist: &str, album: &str, duration: f64) -> Option<Vec<LyricLine>> {
    let agent = crate::net::agent(std::time::Duration::from_secs(8));
    let mut req = agent
        .get("https://lrclib.net/api/get")
        .set("User-Agent", "NotchDeck (https://github.com)")
        .query("track_name", title)
        .query("artist_name", artist);
    if !album.is_empty() {
        req = req.query("album_name", album);
    }
    if duration > 0.0 {
        req = req.query("duration", &format!("{}", duration.round() as i64));
    }
    let v: serde_json::Value = match req.call() {
        Ok(r) => r.into_json().ok()?,
        Err(_) => {
            // Fallback: fuzzy search.
            let r = agent
                .get("https://lrclib.net/api/search")
                .set("User-Agent", "NotchDeck")
                .query("track_name", title)
                .query("artist_name", artist)
                .call()
                .ok()?;
            let arr: serde_json::Value = r.into_json().ok()?;
            arr.as_array()?.iter().find(|x| x.get("syncedLyrics").and_then(|s| s.as_str()).is_some())?.clone()
        }
    };
    let lrc = v.get("syncedLyrics").and_then(|s| s.as_str())?;
    Some(parse_lrc(lrc))
}

fn parse_lrc(lrc: &str) -> Vec<LyricLine> {
    let mut out = vec![];
    for line in lrc.lines() {
        let mut rest = line;
        let mut times = vec![];
        while let Some(stripped) = rest.strip_prefix('[') {
            let Some(end) = stripped.find(']') else { break };
            let tag = &stripped[..end];
            if let Some((m, s)) = tag.split_once(':') {
                if let (Ok(m), Ok(s)) = (m.parse::<f64>(), s.parse::<f64>()) {
                    times.push(m * 60.0 + s);
                }
            }
            rest = &stripped[end + 1..];
        }
        let text = rest.trim().to_string();
        for t in times {
            out.push(LyricLine { t, text: text.clone() });
        }
    }
    out.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap());
    out
}
