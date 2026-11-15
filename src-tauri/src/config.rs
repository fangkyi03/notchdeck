use serde_json::{json, Value};

pub fn defaults() -> Value {
    json!({
        "lang": "auto",
        "skin": "classic",
        "customTheme": { "bg": "#14121a", "fg": "#f5f5f7", "muted": "#8e8e93", "accent": "#bf5af2", "card": "#22202a", "border": "#2f2c38" },
        "shape": "notch",
        "scale": 1.0,
        "opacity": 1.0,
        "position": { "x": 0, "y": 0 },
        "lockPosition": false,
        "monitor": "",
        "proxy": "",
        "autostart": false,
        "clickThrough": false,
        "idleHide": 0,
        "shortcuts": {
            "toggle": "CommandOrControl+Shift+Space",
            "clipboard": "CommandOrControl+Shift+V",
            "translate": "CommandOrControl+Shift+T",
            "todo": ""
        },
        "expandMode": "hover",
        "hoverDelay": 120,
        "hideOnFullscreen": true,
        "clock24": true,
        "compact": {
            "items": ["msg", "tasks", "shelf", "music", "rings", "cpu", "mem", "net", "lyric", "eq", "clock"],
            "autoWidth": true,
            "width": 320,
            "ringMode": "single",
            "showRemaining": false,
            "alerts": true
        },
        "pages": [
            { "id": "messages", "enabled": true },
            { "id": "shelf", "enabled": true },
            { "id": "translate", "enabled": true },
            { "id": "calendar", "enabled": true },
            { "id": "water", "enabled": true },
            { "id": "devices", "enabled": true },
            { "id": "ai", "enabled": true },
            { "id": "tasks", "enabled": true },
            { "id": "music", "enabled": true },
            { "id": "monitor", "enabled": true },
            { "id": "details", "enabled": true },
            { "id": "todo", "enabled": true },
            { "id": "focus", "enabled": true },
            { "id": "clipboard", "enabled": true },
            { "id": "weather", "enabled": true }
        ],
        "panel": { "width": 640, "height": 250 },
        "metrics": [
            { "id": "cpu", "color": "#0a84ff" },
            { "id": "mem", "color": "#64d2ff" },
            { "id": "gpu", "color": "#ff7eb6" },
            { "id": "net", "color": "#30d158" },
            { "id": "disk", "color": "#5ac8fa" }
        ],
        "weatherCity": "",
        "clipboard": true,
        "clipboardImages": true,
        "calendars": [],
        "water": { "enabled": false, "goal": 2000, "cup": 250, "interval": 60, "start": "09:00", "end": "21:00" },
        "eventReminder": 10,
        "jenkins": { "enabled": false, "url": "", "user": "", "jobs": [], "interval": 30 },
        "taskAlerts": true,
        "autoUpdate": true,
        "statusAlerts": { "volume": true, "caps": true, "input": true, "network": true, "power": true, "devices": true },
        "translate": { "provider": "deepseek", "baseUrl": "https://api.deepseek.com/v1", "model": "deepseek-chat", "target": "auto" },
        "focus": { "work": 25, "rest": 5 },
        "providers": [
            { "id": "claude", "name": "Claude", "kind": "claude", "enabled": true, "color": "#e8916b", "compact": true },
            { "id": "codex", "name": "Codex", "kind": "codex", "enabled": true, "color": "#7fd6a0", "compact": true }
        ]
    })
}

fn path() -> std::path::PathBuf {
    crate::extras::data_dir().join("config.json")
}

/// Shallow-merge stored values over defaults so new keys appear after upgrades.
pub fn load() -> Value {
    let mut cfg = defaults();
    if let Ok(s) = std::fs::read_to_string(path()) {
        if let Ok(Value::Object(stored)) = serde_json::from_str::<Value>(&s) {
            // Old (v0.1) configs used a different schema; ignore them.
            if stored.contains_key("skin") {
                let obj = cfg.as_object_mut().unwrap();
                for (k, v) in stored {
                    if let (Some(Value::Object(d)), Value::Object(s)) = (obj.get_mut(&k), &v) {
                        for (kk, vv) in s {
                            d.insert(kk.clone(), vv.clone());
                        }
                    } else {
                        obj.insert(k, v);
                    }
                }
            }
        }
    }
    // Pages added in newer versions get appended to an older saved list.
    let defaults_pages = defaults()["pages"].as_array().cloned().unwrap_or_default();
    if let Some(pages) = cfg.get_mut("pages").and_then(|p| p.as_array_mut()) {
        for d in defaults_pages {
            if !pages.iter().any(|p| p.get("id") == d.get("id")) {
                pages.push(d);
            }
        }
    }
    cfg
}

pub fn save(cfg: &Value) -> Result<(), String> {
    let s = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(path(), s).map_err(|e| e.to_string())
}
