//! Chat / mail reminders — one implementation per platform.
//!
//! macOS: unread counts from Dock badges (`lsappinfo … StatusLabel`), no message
//!        content is read. Click → bring the app to the front.
//! Windows: taskbar flashing via a shell hook (`HSHELL_FLASH`) — how WeChat and QQ
//!        signal new messages — plus toast notifications from the Notification
//!        Center (`UserNotificationListener`, needs the user's permission).
//!        Click → restore and focus that window.

use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone, Debug)]
pub struct MsgApp {
    pub id: String,
    pub name: String,
    /// Unread count when the platform exposes it; `None` = "has new" without a number.
    pub count: Option<u32>,
    pub active: bool,
    pub since: i64,
}

#[derive(Serialize, Clone, Debug)]
pub struct Toast {
    pub id: u32,
    pub app: String,
    pub title: String,
    pub body: String,
    pub at: i64,
}

#[derive(Serialize, Clone, Default)]
pub struct Messages {
    pub platform: String,
    pub apps: Vec<MsgApp>,
    pub toasts: Vec<Toast>,
    /// Why toasts aren't available (permission etc.), shown in the UI.
    pub toast_status: String,
}

/// (id, display name, macOS bundle ids, Windows exe names)
const APPS: &[(&str, &str, &[&str], &[&str])] = &[
    ("wechat", "微信", &["com.tencent.xinWeChat"], &["wechat.exe", "weixin.exe"]),
    ("qq", "QQ", &["com.tencent.qq"], &["qq.exe", "qqnt.exe"]),
    ("wework", "企业微信", &["com.tencent.WeWorkMac"], &["wxwork.exe"]),
    ("dingtalk", "钉钉", &["com.alibaba.DingTalkMac"], &["dingtalk.exe"]),
    ("feishu", "飞书", &["com.electron.lark", "com.bytedance.lark"], &["feishu.exe", "lark.exe"]),
    ("mail", "邮件", &["com.apple.mail"], &["outlook.exe", "foxmail.exe"]),
    ("telegram", "Telegram", &["ru.keepcoder.Telegram", "org.telegram.desktop"], &["telegram.exe"]),
    ("slack", "Slack", &["com.tinyspeck.slackmacgap"], &["slack.exe"]),
];

static STATE: Mutex<Option<Messages>> = Mutex::new(None);

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

pub fn get() -> Messages {
    STATE.lock().unwrap().clone().unwrap_or_default()
}

fn publish(app: &AppHandle, m: Messages) {
    let changed = {
        let mut s = STATE.lock().unwrap();
        let old = s.as_ref().map(|o| (o.apps.iter().map(|a| (a.id.clone(), a.count, a.active)).collect::<Vec<_>>(), o.toasts.len()));
        let new = (m.apps.iter().map(|a| (a.id.clone(), a.count, a.active)).collect::<Vec<_>>(), m.toasts.len());
        let changed = old.as_ref() != Some(&new);
        *s = Some(m.clone());
        changed
    };
    if changed {
        let _ = app.emit("messages-changed", m);
    }
}

/* ------------------------------- macOS ------------------------------- */

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use std::process::Command;

    fn badge(bundle: &str) -> Option<Option<u32>> {
        let out = Command::new("lsappinfo").args(["info", "-only", "StatusLabel", "-app", bundle]).output().ok()?;
        let s = String::from_utf8_lossy(&out.stdout);
        // "StatusLabel"={ "label"="3" }   (absent when there is no badge)
        let i = s.find("\"label\"=\"")? + 9;
        let label: String = s[i..].chars().take_while(|c| *c != '"').collect();
        if label.is_empty() {
            return None;
        }
        Some(label.trim().parse::<u32>().ok())
    }

    pub fn spawn(app: AppHandle) {
        std::thread::spawn(move || {
            let mut since: std::collections::HashMap<&str, i64> = Default::default();
            loop {
                let mut apps = vec![];
                for (id, name, bundles, _) in APPS {
                    if let Some(count) = bundles.iter().find_map(|b| badge(b)) {
                        let t = *since.entry(id).or_insert_with(now);
                        apps.push(MsgApp { id: id.to_string(), name: name.to_string(), count, active: true, since: t });
                    } else {
                        since.remove(id);
                    }
                }
                publish(&app, Messages { platform: "macos".into(), apps, toasts: vec![], toast_status: "macOS 不开放其他应用的通知内容，显示 Dock 未读数".into() });
                std::thread::sleep(std::time::Duration::from_secs(3));
            }
        });
    }

    pub fn open(id: &str) {
        if let Some((_, _, bundles, _)) = APPS.iter().find(|a| a.0 == id) {
            for b in *bundles {
                if Command::new("open").args(["-b", b]).status().map(|s| s.success()).unwrap_or(false) {
                    break;
                }
            }
        }
    }
}

/* ------------------------------ Windows ------------------------------ */

#[cfg(windows)]
mod imp {
    use super::*;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicU32, Ordering};
    use windows::core::{w, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows::Win32::UI::WindowsAndMessaging::*;

    const HSHELL_WINDOWACTIVATED: usize = 4;
    const HSHELL_RUDEAPPACTIVATED: usize = 0x8004;
    const HSHELL_FLASH: usize = 0x8006;

    static SHELL_MSG: AtomicU32 = AtomicU32::new(0);
    /// app id -> (hwnd, since)
    static FLASHING: Mutex<Option<HashMap<String, (isize, i64)>>> = Mutex::new(None);
    static TOASTS: Mutex<(Vec<Toast>, String)> = Mutex::new((Vec::new(), String::new()));
    static APP: Mutex<Option<AppHandle>> = Mutex::new(None);

    fn exe_of(hwnd: HWND) -> String {
        unsafe {
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return String::new() };
            let mut buf = [0u16; 520];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
            let _ = CloseHandle(h);
            if !ok {
                return String::new();
            }
            let path = String::from_utf16_lossy(&buf[..len as usize]);
            path.rsplit('\\').next().unwrap_or("").to_lowercase()
        }
    }

    fn app_id_of(hwnd: HWND) -> Option<&'static str> {
        let exe = exe_of(hwnd);
        APPS.iter().find(|a| a.3.contains(&exe.as_str())).map(|a| a.0)
    }

    fn refresh() {
        let Some(app) = APP.lock().unwrap().clone() else { return };
        let flashing = FLASHING.lock().unwrap().clone().unwrap_or_default();
        let apps = APPS
            .iter()
            .filter_map(|(id, name, _, _)| flashing.get(*id).map(|(_, since)| MsgApp { id: id.to_string(), name: name.to_string(), count: None, active: true, since: *since }))
            .collect();
        let (toasts, status) = TOASTS.lock().unwrap().clone();
        publish(&app, Messages { platform: "windows".into(), apps, toasts, toast_status: status });
    }

    unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        let shell = SHELL_MSG.load(Ordering::Relaxed);
        if shell != 0 && msg == shell {
            let target = HWND(lp.0 as *mut core::ffi::c_void);
            match wp.0 {
                HSHELL_FLASH => {
                    if let Some(id) = app_id_of(target) {
                        FLASHING.lock().unwrap().get_or_insert_with(HashMap::new).entry(id.to_string()).or_insert((target.0 as isize, now()));
                        refresh();
                    }
                }
                HSHELL_WINDOWACTIVATED | HSHELL_RUDEAPPACTIVATED => {
                    // The user looked at the app: its flashing reminder is done.
                    if let Some(id) = app_id_of(target) {
                        if FLASHING.lock().unwrap().get_or_insert_with(HashMap::new).remove(id).is_some() {
                            refresh();
                        }
                    }
                }
                _ => {}
            }
            return LRESULT(0);
        }
        DefWindowProcW(hwnd, msg, wp, lp)
    }

    fn shell_hook_thread() {
        std::thread::spawn(|| unsafe {
            let Ok(module) = GetModuleHandleW(None) else { return };
            let class = w!("NotchDeckShellHook");
            let wc = WNDCLASSW { lpfnWndProc: Some(wndproc), hInstance: module.into(), lpszClassName: class, ..Default::default() };
            RegisterClassW(&wc);
            let Ok(hwnd) = CreateWindowExW(WINDOW_EX_STYLE(0), class, w!(""), WINDOW_STYLE(0), 0, 0, 0, 0, None, None, module, None) else { return };
            SHELL_MSG.store(RegisterWindowMessageW(w!("SHELLHOOK")), Ordering::Relaxed);
            let _ = RegisterShellHookWindow(hwnd);
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        });
    }

    fn toast_thread() {
        use windows::UI::Notifications::Management::{UserNotificationListener, UserNotificationListenerAccessStatus};
        use windows::UI::Notifications::{KnownNotificationBindings, NotificationKinds};
        std::thread::spawn(|| {
            let set_status = |s: &str| {
                TOASTS.lock().unwrap().1 = s.to_string();
                refresh();
            };
            let listener = match UserNotificationListener::Current() {
                Ok(l) => l,
                Err(_) => return set_status("此系统不支持读取通知"),
            };
            let access = listener.RequestAccessAsync().and_then(|op| op.get());
            if access.ok() != Some(UserNotificationListenerAccessStatus::Allowed) {
                return set_status("未获得通知访问权限：设置 › 隐私和安全性 › 通知 中允许应用访问通知");
            }
            set_status("");
            loop {
                if let Ok(list) = listener.GetNotificationsAsync(NotificationKinds::Toast).and_then(|op| op.get()) {
                    let mut out = vec![];
                    for n in list {
                        let app = n.AppInfo().and_then(|a| a.DisplayInfo()).and_then(|d| d.DisplayName()).map(|s| s.to_string()).unwrap_or_default();
                        let texts: Vec<String> = n
                            .Notification()
                            .and_then(|x| x.Visual())
                            .and_then(|v| v.GetBinding(&KnownNotificationBindings::ToastGeneric()?))
                            .and_then(|b| b.GetTextElements())
                            .map(|els| els.into_iter().filter_map(|t| t.Text().ok().map(|s| s.to_string())).collect())
                            .unwrap_or_default();
                        let at = n.CreationTime().map(|t| (t.UniversalTime - 116_444_736_000_000_000) / 10_000_000).unwrap_or(0);
                        out.push(Toast {
                            id: n.Id().unwrap_or(0),
                            app,
                            title: texts.first().cloned().unwrap_or_default(),
                            body: texts.iter().skip(1).cloned().collect::<Vec<_>>().join(" "),
                            at,
                        });
                    }
                    out.sort_by(|a, b| b.at.cmp(&a.at));
                    out.truncate(30);
                    let changed = TOASTS.lock().unwrap().0.iter().map(|t| t.id).collect::<Vec<_>>() != out.iter().map(|t| t.id).collect::<Vec<_>>();
                    if changed {
                        TOASTS.lock().unwrap().0 = out;
                        refresh();
                    }
                }
                std::thread::sleep(std::time::Duration::from_secs(2));
            }
        });
    }

    pub fn spawn(app: AppHandle) {
        *APP.lock().unwrap() = Some(app);
        refresh();
        shell_hook_thread();
        toast_thread();
    }

    pub fn open(id: &str) {
        let hwnd = FLASHING.lock().unwrap().as_mut().and_then(|m| m.remove(id)).map(|(h, _)| h);
        if let Some(h) = hwnd {
            unsafe {
                let hwnd = HWND(h as *mut core::ffi::c_void);
                let _ = ShowWindow(hwnd, SW_RESTORE);
                let _ = SetForegroundWindow(hwnd);
            }
        }
        refresh();
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod imp {
    use super::*;
    pub fn spawn(_: AppHandle) {}
    pub fn open(_: &str) {}
}

pub use imp::{open, spawn};
