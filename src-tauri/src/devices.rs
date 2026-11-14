//! Wireless device batteries + system status changes (volume, caps lock, input
//! method, network, power). One implementation per platform.

use serde::Serialize;
use serde_json::json;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Part {
    pub label: String,
    pub percent: u8,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Device {
    pub name: String,
    /// mouse | keyboard | trackpad | headphones | gamepad | other
    pub kind: String,
    pub percent: u8,
    /// AirPods: left / right / case.
    pub parts: Vec<Part>,
}

static DEVICES: Mutex<Vec<Device>> = Mutex::new(Vec::new());

pub fn devices() -> Vec<Device> {
    DEVICES.lock().unwrap().clone()
}

fn guess_kind(name: &str, hint: &str) -> String {
    let s = format!("{name} {hint}").to_lowercase();
    for (k, words) in [
        ("mouse", &["mouse", "鼠标", "mx master", "mx anywhere"][..]),
        ("trackpad", &["trackpad", "触控板"][..]),
        ("keyboard", &["keyboard", "键盘", "keys", "mx mechanical"][..]),
        ("gamepad", &["controller", "gamepad", "手柄", "xbox", "dualsense", "joy-con"][..]),
        ("headphones", &["airpods", "headphone", "headset", "buds", "耳机", "beats", "wh-", "wf-", "freebuds"][..]),
    ] {
        if words.iter().any(|w| s.contains(w)) {
            return k.into();
        }
    }
    "other".into()
}

/* ----------------------------- device batteries ----------------------------- */

#[cfg(target_os = "macos")]
fn read_devices() -> Vec<Device> {
    use std::process::Command;
    let mut out: Vec<Device> = vec![];
    // Apple HID accessories (Magic Mouse / Keyboard / Trackpad).
    if let Ok(o) = Command::new("ioreg").args(["-r", "-l", "-w0", "-k", "BatteryPercent"]).output() {
        let s = String::from_utf8_lossy(&o.stdout);
        let mut name = String::new();
        for line in s.lines() {
            let l = line.trim_start_matches([' ', '|']);
            if let Some(v) = l.strip_prefix("\"Product\" = ") {
                name = v.trim_matches('"').to_string();
            } else if let Some(v) = l.strip_prefix("\"BatteryPercent\" = ") {
                if let Ok(p) = v.trim().parse::<u8>() {
                    if !name.is_empty() && !out.iter().any(|d| d.name == name) {
                        out.push(Device { kind: guess_kind(&name, ""), name: name.clone(), percent: p, parts: vec![] });
                    }
                }
            }
        }
    }
    // Bluetooth devices that report battery to the system (AirPods, Beats, many headphones).
    if let Ok(o) = Command::new("system_profiler").args(["SPBluetoothDataType", "-json"]).output() {
        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&o.stdout) {
            let connected = v.pointer("/SPBluetoothDataType/0/device_connected").and_then(|x| x.as_array()).cloned().unwrap_or_default();
            for entry in connected {
                let Some((name, d)) = entry.as_object().and_then(|m| m.iter().next()) else { continue };
                let pct = |k: &str| d.get(k).and_then(|x| x.as_str()).and_then(|s| s.trim_end_matches('%').trim().parse::<u8>().ok());
                let mut parts = vec![];
                for (k, label) in [("device_batteryLevelLeft", "左"), ("device_batteryLevelRight", "右"), ("device_batteryLevelCase", "盒")] {
                    if let Some(p) = pct(k) {
                        parts.push(Part { label: label.into(), percent: p });
                    }
                }
                let main = pct("device_batteryLevelMain").or_else(|| pct("device_batteryLevel")).or_else(|| parts.iter().filter(|p| p.label != "盒").map(|p| p.percent).min());
                let Some(main) = main else { continue };
                if out.iter().any(|x| &x.name == name) {
                    continue;
                }
                let hint = d.get("device_minorType").and_then(|x| x.as_str()).unwrap_or("");
                out.push(Device { name: name.clone(), kind: guess_kind(name, hint), percent: main, parts });
            }
        }
    }
    out
}

#[cfg(windows)]
fn read_devices() -> Vec<Device> {
    use std::os::windows::process::CommandExt;
    // DEVPKEY_Bluetooth_Battery on present Bluetooth devices (classic + BLE HID).
    let script = r#"Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.Class -in 'Bluetooth','HIDClass','AudioEndpoint','Keyboard','Mouse','System' -and $_.InstanceId -match 'BTH' } | ForEach-Object { $b = Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName '{104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2' -ErrorAction SilentlyContinue; if ($b -and $b.Data -ne $null) { "$($_.FriendlyName)`t$($b.Data)`t$($_.Class)" } }"#;
    let Ok(o) = std::process::Command::new("powershell").args(["-NoProfile", "-NonInteractive", "-Command", script]).creation_flags(0x0800_0000).output() else { return vec![] };
    let mut out: Vec<Device> = vec![];
    for line in String::from_utf8_lossy(&o.stdout).lines() {
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() < 2 {
            continue;
        }
        let (name, pct) = (f[0].trim(), f[1].trim().parse::<u8>().unwrap_or(0));
        if name.is_empty() || out.iter().any(|d| d.name == name) {
            continue;
        }
        out.push(Device { name: name.into(), kind: guess_kind(name, f.get(2).unwrap_or(&"")), percent: pct, parts: vec![] });
    }
    out
}

#[cfg(not(any(target_os = "macos", windows)))]
fn read_devices() -> Vec<Device> {
    vec![]
}

/* ------------------------------ system status ------------------------------ */

#[derive(Clone, PartialEq, Default, Debug)]
struct Snapshot {
    caps: Option<bool>,
    input: Option<String>,
    volume: Option<(u8, bool)>,
}

#[cfg(target_os = "macos")]
mod sys {
    use super::Snapshot;
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};
    use std::ffi::c_void;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceFlagsState(state: i32) -> u64;
    }
    #[link(name = "Carbon", kind = "framework")]
    extern "C" {
        fn TISCopyCurrentKeyboardInputSource() -> *mut c_void;
        fn TISGetInputSourceProperty(src: *mut c_void, key: CFStringRef) -> *const c_void;
        static kTISPropertyLocalizedName: CFStringRef;
        fn CFRelease(cf: *const c_void);
    }

    pub fn caps() -> Option<bool> {
        // kCGEventSourceStateHIDSystemState = 1, kCGEventFlagMaskAlphaShift = 1 << 16
        Some(unsafe { CGEventSourceFlagsState(1) } & (1 << 16) != 0)
    }

    /// Must run on the main thread (Text Input Sources API).
    pub fn input_source() -> Option<String> {
        unsafe {
            let src = TISCopyCurrentKeyboardInputSource();
            if src.is_null() {
                return None;
            }
            let name = TISGetInputSourceProperty(src, kTISPropertyLocalizedName);
            let s = if name.is_null() { None } else { Some(CFString::wrap_under_get_rule(name as CFStringRef).to_string()) };
            CFRelease(src);
            s
        }
    }

    pub fn volume() -> Option<(u8, bool)> {
        let o = std::process::Command::new("osascript").args(["-e", "set s to get volume settings\nreturn (output volume of s as string) & \",\" & (output muted of s as string)"]).output().ok()?;
        let s = String::from_utf8_lossy(&o.stdout);
        let (v, m) = s.trim().split_once(',')?;
        Some((v.parse().ok()?, m == "true"))
    }

    pub fn snapshot(app: &tauri::AppHandle) -> Snapshot {
        let (tx, rx) = std::sync::mpsc::channel();
        let _ = app.run_on_main_thread(move || {
            let _ = tx.send(input_source());
        });
        Snapshot { caps: caps(), input: rx.recv_timeout(std::time::Duration::from_secs(1)).ok().flatten(), volume: volume() }
    }
}

#[cfg(windows)]
mod sys {
    use super::Snapshot;
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
    use windows::Win32::UI::Input::Ime::ImmGetDefaultIMEWnd;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, GetKeyboardLayout, VK_CAPITAL};
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId, SendMessageW};
    use windows::Win32::Foundation::{LPARAM, WPARAM};

    pub fn caps() -> Option<bool> {
        Some(unsafe { GetKeyState(VK_CAPITAL.0 as i32) } & 1 != 0)
    }

    fn lang_name(langid: u16) -> String {
        match langid {
            0x0804 => "简体中文",
            0x0404 | 0x0c04 => "繁體中文",
            0x0409 => "English (US)",
            0x0809 => "English (UK)",
            0x0411 => "日本語",
            0x0412 => "한국어",
            0x0407 => "Deutsch",
            0x040c => "Français",
            0x0419 => "Русский",
            _ => return format!("0x{langid:04x}"),
        }
        .into()
    }

    pub fn input_source() -> Option<String> {
        unsafe {
            let fg = GetForegroundWindow();
            let tid = GetWindowThreadProcessId(fg, None);
            let hkl = GetKeyboardLayout(tid);
            let lang = (hkl.0 as usize & 0xffff) as u16;
            let mut name = lang_name(lang);
            // Chinese / Japanese / Korean IMEs: report 中 / 英 (native vs alphanumeric).
            if matches!(lang, 0x0804 | 0x0404 | 0x0411 | 0x0412) {
                let ime = ImmGetDefaultIMEWnd(fg);
                if !ime.0.is_null() {
                    // WM_IME_CONTROL = 0x283, IMC_GETOPENSTATUS = 5, IMC_GETCONVERSIONMODE = 1
                    let open = SendMessageW(ime, 0x283, WPARAM(5), LPARAM(0)).0 != 0;
                    let mode = SendMessageW(ime, 0x283, WPARAM(1), LPARAM(0)).0;
                    name.push_str(if open && mode & 1 != 0 { " · 中" } else { " · 英" });
                }
            }
            Some(name)
        }
    }

    pub fn volume() -> Option<(u8, bool)> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
            let dev = en.GetDefaultAudioEndpoint(eRender, eConsole).ok()?;
            let vol: IAudioEndpointVolume = dev.Activate(CLSCTX_ALL, None).ok()?;
            let v = vol.GetMasterVolumeLevelScalar().ok()?;
            let m = vol.GetMute().ok()?.as_bool();
            Some(((v * 100.0).round() as u8, m))
        }
    }

    pub fn snapshot(_app: &tauri::AppHandle) -> Snapshot {
        Snapshot { caps: caps(), input: input_source(), volume: volume() }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod sys {
    pub fn snapshot(_app: &tauri::AppHandle) -> super::Snapshot {
        super::Snapshot::default()
    }
}

fn online() -> bool {
    use std::net::{SocketAddr, TcpStream};
    ["223.5.5.5:53", "1.1.1.1:53", "8.8.8.8:53"]
        .iter()
        .filter_map(|a| a.parse::<SocketAddr>().ok())
        .any(|a| TcpStream::connect_timeout(&a, Duration::from_millis(1500)).is_ok())
}

fn status(app: &AppHandle, kind: &str, icon: &str, text: String, value: Option<u8>) {
    let enabled = app
        .state::<crate::AppState>()
        .config
        .lock()
        .unwrap()
        .pointer(&format!("/statusAlerts/{kind}"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    if enabled {
        let _ = app.emit("status", json!({ "kind": kind, "icon": icon, "text": text, "value": value }));
    }
}

pub fn spawn(app: AppHandle) {
    // Device batteries: every 2 minutes (system_profiler / PowerShell are slow).
    let a = app.clone();
    std::thread::spawn(move || {
        let mut warned: std::collections::HashSet<String> = Default::default();
        loop {
            let list = read_devices();
            for d in &list {
                let low = d.percent <= 20;
                if low && warned.insert(d.name.clone()) {
                    status(&a, "devices", "🔋", format!("{} 电量低：{}%", d.name, d.percent), Some(d.percent));
                } else if !low {
                    warned.remove(&d.name);
                }
            }
            let changed = *DEVICES.lock().unwrap() != list;
            *DEVICES.lock().unwrap() = list.clone();
            if changed {
                let _ = a.emit("devices-changed", list);
            }
            std::thread::sleep(Duration::from_secs(120));
        }
    });

    // Fast-changing status: caps lock, input method, volume.
    let a = app.clone();
    std::thread::spawn(move || {
        let mut last = sys::snapshot(&a);
        loop {
            std::thread::sleep(Duration::from_millis(700));
            let now = sys::snapshot(&a);
            if now.caps.is_some() && now.caps != last.caps {
                let on = now.caps.unwrap_or(false);
                status(&a, "caps", "⇪", if on { "大写锁定 已开启".into() } else { "大写锁定 已关闭".into() }, None);
            }
            if now.input.is_some() && last.input.is_some() && now.input != last.input {
                status(&a, "input", "⌨", now.input.clone().unwrap_or_default(), None);
            }
            if let (Some((v, m)), Some((lv, lm))) = (now.volume, last.volume) {
                if v != lv || m != lm {
                    status(&a, "volume", if m || v == 0 { "🔇" } else { "🔊" }, if m { "已静音".into() } else { format!("音量 {v}%") }, Some(if m { 0 } else { v }));
                }
            }
            if now.caps.is_some() { last.caps = now.caps; }
            if now.input.is_some() { last.input = now.input; }
            if now.volume.is_some() { last.volume = now.volume; }
        }
    });

    // Network + power: every few seconds.
    let a = app;
    std::thread::spawn(move || {
        let mut was_online = online();
        let mut last_power: Option<(bool, u8)> = None;
        let mut tick = 0u32;
        loop {
            std::thread::sleep(Duration::from_secs(5));
            tick += 1;
            if tick.is_multiple_of(2) {
                let on = online();
                if on != was_online {
                    status(&a, "network", if on { "📶" } else { "⚠️" }, if on { "网络已恢复".into() } else { "网络已断开".into() }, None);
                    was_online = on;
                }
            }
            let bat = a.state::<crate::AppState>().sys.lock().unwrap().battery().map(|b| (b.charging, b.percent.round() as u8));
            if let Some((charging, pct)) = bat {
                if let Some((lc, lp)) = last_power {
                    if charging != lc {
                        status(&a, "power", "⚡", if charging { format!("已接通电源 · {pct}%") } else { format!("使用电池 · {pct}%") }, Some(pct));
                    } else if !charging && ((lp > 20 && pct <= 20) || (lp > 10 && pct <= 10)) {
                        status(&a, "power", "🪫", format!("电量低：{pct}%"), Some(pct));
                    }
                }
                last_power = Some((charging, pct));
            }
        }
    });
}
