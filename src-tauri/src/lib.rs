mod config;
mod extras;
mod geom;
mod net;
mod runtime;
mod fullscreen;
mod media;
mod messages;
mod sysmon;
mod usage;

use serde_json::Value;
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

struct AppState {
    config: Mutex<Value>,
    sys: Mutex<sysmon::SysMon>,
}

fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> impl std::future::Future<Output = Result<T, String>> {
    async move { tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string()) }
}

/* ------------------------------ config ------------------------------ */

#[tauri::command]
fn get_config(state: State<AppState>) -> Value {
    state.config.lock().unwrap().clone()
}

#[tauri::command]
fn save_config(app: AppHandle, state: State<AppState>, config: Value) -> Result<(), String> {
    config::save(&config)?;
    let problems = runtime::apply(&app, &config);
    if !problems.is_empty() {
        let _ = app.emit("runtime-problems", problems);
    }
    net::set_override(config.get("proxy").and_then(|v| v.as_str()).unwrap_or(""));
    *state.config.lock().unwrap() = config.clone();
    app.emit("config-changed", config).map_err(|e| e.to_string())
}

#[tauri::command]
fn store_get(key: String) -> Value {
    extras::store_get(&key)
}

#[tauri::command]
fn store_set(key: String, value: Value) -> Result<(), String> {
    extras::store_set(&key, &value)
}

/* ------------------------------- data ------------------------------- */

#[tauri::command]
fn get_sys(state: State<AppState>) -> sysmon::SysStats {
    state.sys.lock().unwrap().sample()
}

#[tauri::command]
async fn get_procs(app: AppHandle, by_mem: bool) -> Result<Vec<sysmon::Proc>, String> {
    blocking(move || app.state::<AppState>().sys.lock().unwrap().processes(by_mem, 7)).await
}

#[tauri::command]
async fn get_usage(state: State<'_, AppState>, force: Option<bool>) -> Result<Vec<usage::Column>, String> {
    let cfg = state.config.lock().unwrap().clone();
    blocking(move || usage::fetch_all(&cfg, force.unwrap_or(false))).await
}

#[tauri::command]
async fn get_media() -> Result<Option<media::Media>, String> {
    blocking(media::get).await
}

#[tauri::command]
async fn media_control(action: String, value: Option<f64>) -> Result<(), String> {
    blocking(move || media::control(&action, value.unwrap_or(0.0))).await
}

#[tauri::command]
async fn get_lyrics(title: String, artist: String, album: String, duration: f64) -> Result<Vec<media::LyricLine>, String> {
    blocking(move || media::lyrics(&title, &artist, &album, duration)).await
}

#[tauri::command]
async fn get_weather(state: State<'_, AppState>, force: Option<bool>) -> Result<extras::Weather, String> {
    let city = state.config.lock().unwrap().get("weatherCity").and_then(|v| v.as_str()).unwrap_or("").to_string();
    blocking(move || extras::weather(&city, force.unwrap_or(false))).await?
}

#[tauri::command]
fn clip_list() -> Vec<extras::ClipItem> {
    extras::clips()
}

#[tauri::command]
fn clip_copy(text: String) -> Result<(), String> {
    extras::clip_copy(&text)
}

#[tauri::command]
fn clip_update(index: usize, action: String) {
    extras::clip_update(index, &action)
}

#[tauri::command]
fn clip_clear() {
    extras::clip_clear()
}

#[tauri::command]
fn secret_set(id: String, value: String) -> Result<(), String> {
    usage::secret_set(&id, &value)
}

#[tauri::command]
fn secret_has(id: String) -> bool {
    usage::secret_get(&id).is_some()
}

#[tauri::command]
fn set_click_through(app: AppHandle, on: bool) {
    runtime::set_click_through(&app, on)
}

#[tauri::command]
fn get_messages() -> messages::Messages {
    messages::get()
}

#[tauri::command]
async fn open_message_app(id: String) -> Result<(), String> {
    blocking(move || messages::open(&id)).await
}

/* ------------------------------ window ------------------------------ */

fn want_monitor(app: &AppHandle) -> String {
    app.state::<AppState>().config.lock().unwrap().get("monitor").and_then(|v| v.as_str()).unwrap_or("").to_string()
}

/// Size and place the island on its display. See `geom::place` for the meaning of x / y.
#[tauri::command]
fn place_island(app: AppHandle, width: f64, height: f64, x: f64, y: f64, dock: Option<String>) -> Result<(f64, f64), String> {
    let win = app.get_webview_window("main").ok_or("no main window")?;
    let mon = geom::pick(&app, &win, &want_monitor(&app)).ok_or("no monitor")?;
    geom::place(&win, &mon, geom::Dock::parse(dock.as_deref().unwrap_or("top")), width, height, x, y)
}

/// Follow the cursor while dragging (across displays; snaps to top / left / right).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn drag_island(app: AppHandle, hw: f64, hh: f64, vw: f64, vh: f64, grab_x: f64, grab_y: f64, min_y: f64) -> Result<geom::DragResult, String> {
    let win = app.get_webview_window("main").ok_or("no main window")?;
    geom::drag(&win, (hw, hh), (vw, vh), (grab_x, grab_y), min_y)
}

#[derive(serde::Serialize)]
struct MonitorInfo {
    key: String,
    name: String,
    width: u32,
    height: u32,
    primary: bool,
}

#[tauri::command]
fn list_monitors(app: AppHandle) -> Vec<MonitorInfo> {
    let Some(win) = app.get_webview_window("main") else { return vec![] };
    geom::monitors(&win)
        .into_iter()
        .map(|m| MonitorInfo { width: m.lw() as u32, height: m.lh() as u32, key: m.key, name: m.name, primary: m.primary })
        .collect()
}

#[tauri::command]
fn show_island(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        raise_above_menubar(&w);
    }
}

#[tauri::command]
fn open_settings(app: AppHandle) -> Result<(), String> {
    open_settings_window(&app)
}

fn open_settings_window(app: &AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
        .title("NotchDeck 设置")
        .inner_size(860.0, 640.0)
        .min_inner_size(680.0, 480.0)
        .disable_drag_drop_handler()
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// macOS: floating windows sit *below* the menu bar. Lift the island above it.
#[cfg(target_os = "macos")]
fn raise_above_menubar(w: &tauri::WebviewWindow) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    if let Ok(ptr) = w.ns_window() {
        let ptr = ptr as usize;
        let _ = w.run_on_main_thread(move || unsafe {
            let obj = &*(ptr as *const AnyObject);
            // NSScreenSaverWindowLevel: newer macOS draws the menu bar above status level,
            // so a notch overlay has to sit higher to cover it.
            let _: () = msg_send![obj, setLevel: 1000isize];
            // canJoinAllSpaces | stationary | ignoresCycle
            let _: () = msg_send![obj, setCollectionBehavior: (1usize << 0) | (1usize << 4) | (1usize << 6)];
            let _: () = msg_send![obj, setHasShadow: false];
        });
    }
}

#[cfg(not(target_os = "macos"))]
fn raise_above_menubar(_w: &tauri::WebviewWindow) {}

#[cfg(windows)]
fn own_hwnd(w: &tauri::WebviewWindow) -> isize {
    w.hwnd().map(|h| h.0 as isize).unwrap_or(0)
}
#[cfg(not(windows))]
fn own_hwnd(_w: &tauri::WebviewWindow) -> isize {
    0
}

/// Polls the cursor so hover works even when the window is not focused
/// (WebViews don't reliably receive mouse-enter in inactive windows),
/// and hides the island while another app is full screen.
fn spawn_watchers(app: AppHandle) {
    std::thread::spawn(move || {
        let mut inside_last = false;
        let mut hidden = false;
        let mut tick = 0u32;
        loop {
            std::thread::sleep(Duration::from_millis(60));
            tick = tick.wrapping_add(1);
            let Some(win) = app.get_webview_window("main") else { continue };

            if tick % 12 == 0 {
                let hide_fs = app.state::<AppState>().config.lock().unwrap().get("hideOnFullscreen").and_then(|v| v.as_bool()).unwrap_or(true);
                let fs = hide_fs && fullscreen::foreground_is_fullscreen(own_hwnd(&win));
                if fs != hidden {
                    hidden = fs;
                    let _ = if fs { win.hide() } else { win.show() };
                }
            }
            if hidden {
                continue;
            }
            let (Some((cx, cy)), Some((wx, wy, ww, wh))) = (geom::cursor(&win), geom::window_rect(&win)) else { continue };
            let inside = cx >= wx - 2.0 && cx <= wx + ww + 2.0 && cy >= wy - 4.0 && cy <= wy + wh + 2.0;
            // Window-logical coordinates for the page.
            // Global units per logical px: points on macOS (1), physical px on Windows.
            #[cfg(target_os = "macos")]
            let unit = 1.0;
            #[cfg(not(target_os = "macos"))]
            let unit = win.scale_factor().unwrap_or(1.0);
            let lx = (cx - wx) / unit;
            let ly = (cy - wy) / unit;
            if inside != inside_last || inside {
                inside_last = inside;
                let _ = app.emit_to("main", "island-cursor", (inside, lx, ly));
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(runtime::shortcut_plugin())
        .manage(AppState { config: Mutex::new(config::load()), sys: Mutex::new(sysmon::SysMon::new()) })
        .invoke_handler(tauri::generate_handler![
            get_config, save_config, store_get, store_set, get_sys, get_procs, get_usage, get_media, media_control, get_lyrics,
            get_weather, clip_list, clip_copy, clip_update, clip_clear, place_island, drag_island, list_monitors, show_island, open_settings,
            secret_set, secret_has, get_messages, open_message_app, set_click_through
        ])
        .setup(|app| {
            net::set_override(app.state::<AppState>().config.lock().unwrap().get("proxy").and_then(|v| v.as_str()).unwrap_or(""));
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let settings = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出 NotchDeck", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&settings, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("NotchDeck")
                .menu(&menu)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "settings" => {
                        let _ = open_settings_window(app);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            let h = app.handle().clone();
            extras::spawn_clipboard_watcher(app.handle().clone(), move || {
                h.state::<AppState>().config.lock().unwrap().get("clipboard").and_then(|v| v.as_bool()).unwrap_or(true)
            });
            spawn_watchers(app.handle().clone());
            messages::spawn(app.handle().clone());
            let cfg = app.state::<AppState>().config.lock().unwrap().clone();
            for p in runtime::apply(app.handle(), &cfg) {
                eprintln!("[notchdeck] {p}");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running NotchDeck");
}
