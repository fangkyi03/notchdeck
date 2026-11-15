//! Settings that take effect outside the webview: launch at login, global
//! shortcuts and click-through ("game") mode.

use serde_json::Value;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// Registered shortcut -> action name sent to the island.
static BINDINGS: Mutex<Vec<(Shortcut, String)>> = Mutex::new(Vec::new());

pub fn shortcut_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            let action = BINDINGS.lock().unwrap().iter().find(|(s, _)| s == shortcut).map(|(_, a)| a.clone());
            if let Some(a) = action {
                if a.ends_with("-page") {
                    let _ = app.emit_to("main", "shortcut", a);
                    return;
                }
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                }
                let _ = app.emit_to("main", "shortcut", a);
            }
        })
        .build()
}

/// Returns a list of problems (e.g. shortcuts already taken) for the settings page.
pub fn apply(app: &AppHandle, cfg: &Value) -> Vec<String> {
    let mut errors = vec![];

    // Launch at login.
    let want = cfg.get("autostart").and_then(|v| v.as_bool()).unwrap_or(false);
    let auto = app.autolaunch();
    if auto.is_enabled().unwrap_or(false) != want {
        let r = if want { auto.enable() } else { auto.disable() };
        if let Err(e) = r {
            errors.push(format!("开机自启设置失败：{e}"));
        }
    }

    // Global shortcuts.
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let mut bindings = vec![];
    if let Some(map) = cfg.get("shortcuts").and_then(|v| v.as_object()) {
        for (action, keys) in map {
            let Some(keys) = keys.as_str().filter(|k| !k.trim().is_empty()) else { continue };
            match keys.parse::<Shortcut>() {
                Ok(sc) => match gs.register(sc) {
                    Ok(_) => bindings.push((sc, action.clone())),
                    Err(e) => errors.push(format!("快捷键 {keys} 注册失败（可能被占用）：{e}")),
                },
                Err(_) => errors.push(format!("快捷键格式不对：{keys}")),
            }
        }
    }
    *BINDINGS.lock().unwrap() = bindings;

    // Click-through starts collapsed; the island flips it while expanded.
    let through = cfg.get("clickThrough").and_then(|v| v.as_bool()).unwrap_or(false);
    set_click_through(app, through);
    errors
}

/// ← / → switch pages while the island is expanded. They are global shortcuts only
/// for that time, because the island never takes keyboard focus on hover.
pub fn set_arrow_keys(app: &AppHandle, on: bool) {
    let gs = app.global_shortcut();
    let mut b = BINDINGS.lock().unwrap();
    for (key, action) in [("ArrowLeft", "prev-page"), ("ArrowRight", "next-page")] {
        let Ok(sc) = key.parse::<Shortcut>() else { continue };
        let has = b.iter().any(|(s, a)| *s == sc && a == action);
        if on && !has {
            if gs.register(sc).is_ok() { b.push((sc, action.into())); }
        } else if !on && has {
            let _ = gs.unregister(sc);
            b.retain(|(s, _)| *s != sc);
        }
    }
}

pub fn set_click_through(app: &AppHandle, on: bool) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_ignore_cursor_events(on);
    }
}
