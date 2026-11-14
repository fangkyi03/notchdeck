//! Island placement across multiple displays.
//!
//! Everything is computed in one *global* coordinate space:
//! - macOS: points (top-left origin on the primary display). macOS lays displays
//!   out in points, while tao reports each monitor's physical origin scaled by that
//!   monitor's own factor — mixing those breaks as soon as two displays have
//!   different scales, so we never use physical coordinates there.
//! - Windows: physical pixels (per-monitor-DPI virtual screen is consistent).
//! Each monitor carries `unit`: global units per logical px on that monitor.

use serde::Serialize;
use tauri::{AppHandle, WebviewWindow};

#[derive(Clone, Debug)]
pub struct Mon {
    pub key: String,
    pub name: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// Global units per logical pixel.
    pub unit: f64,
    pub primary: bool,
}

impl Mon {
    pub fn contains(&self, px: f64, py: f64) -> bool {
        px >= self.x && px < self.x + self.w && py >= self.y && py < self.y + self.h
    }
    /// Logical size of the display.
    pub fn lw(&self) -> f64 {
        self.w / self.unit
    }
    pub fn lh(&self) -> f64 {
        self.h / self.unit
    }
}

fn key_of(m: &tauri::Monitor) -> String {
    format!("{}@{},{}", m.name().cloned().unwrap_or_default(), m.position().x, m.position().y)
}

pub fn monitors(win: &WebviewWindow) -> Vec<Mon> {
    let primary = win.primary_monitor().ok().flatten().map(|m| key_of(&m));
    win.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let s = m.scale_factor();
            let (px, py, pw, ph) = (m.position().x as f64, m.position().y as f64, m.size().width as f64, m.size().height as f64);
            let key = key_of(m);
            #[cfg(target_os = "macos")]
            let (x, y, w, h, unit) = (px / s, py / s, pw / s, ph / s, 1.0);
            #[cfg(not(target_os = "macos"))]
            let (x, y, w, h, unit) = (px, py, pw, ph, s);
            Mon { primary: Some(&key) == primary.as_ref(), key, name: m.name().cloned().unwrap_or_else(|| "显示器".into()), x, y, w, h, unit }
        })
        .collect()
}

/// Cursor in global units.
#[cfg(target_os = "macos")]
pub fn cursor(win: &WebviewWindow) -> Option<(f64, f64)> {
    use objc2::encode::{Encode, Encoding};
    use objc2::runtime::AnyClass;
    use objc2::msg_send;
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct P {
        x: f64,
        y: f64,
    }
    unsafe impl Encode for P {
        const ENCODING: Encoding = Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
    }
    let cls = AnyClass::get("NSEvent")?;
    // Bottom-left origin on the primary display, in points.
    let p: P = unsafe { msg_send![cls, mouseLocation] };
    let primary = monitors(win).into_iter().find(|m| m.primary)?;
    Some((p.x, primary.y + primary.h - p.y))
}

#[cfg(not(target_os = "macos"))]
pub fn cursor(win: &WebviewWindow) -> Option<(f64, f64)> {
    win.cursor_position().ok().map(|c| (c.x, c.y))
}

/// Window rect in global units.
pub fn window_rect(win: &WebviewWindow) -> Option<(f64, f64, f64, f64)> {
    let p = win.outer_position().ok()?;
    let s = win.outer_size().ok()?;
    #[cfg(target_os = "macos")]
    {
        let f = win.scale_factor().ok()?;
        Some((p.x as f64 / f, p.y as f64 / f, s.width as f64 / f, s.height as f64 / f))
    }
    #[cfg(not(target_os = "macos"))]
    Some((p.x as f64, p.y as f64, s.width as f64, s.height as f64))
}

/// Set the window to a logical size at a global position on `mon`.
pub fn set_rect(win: &WebviewWindow, mon: &Mon, gx: f64, gy: f64, lw: f64, lh: f64) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        win.set_size(tauri::LogicalSize::new(lw, lh)).map_err(|e| e.to_string())?;
        win.set_position(tauri::LogicalPosition::new(gx, gy)).map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        win.set_size(tauri::PhysicalSize::new((lw * mon.unit).round() as u32, (lh * mon.unit).round() as u32)).map_err(|e| e.to_string())?;
        win.set_position(tauri::PhysicalPosition::new(gx.round() as i32, gy.round() as i32)).map_err(|e| e.to_string())?;
    }
    let _ = mon;
    Ok(())
}

/// Where the island docks: along the top edge, or as a vertical capsule on a side.
#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Dock {
    Top,
    Bottom,
    Left,
    Right,
}

impl Dock {
    pub fn parse(s: &str) -> Dock {
        match s {
            "left" => Dock::Left,
            "right" => Dock::Right,
            "bottom" => Dock::Bottom,
            _ => Dock::Top,
        }
    }
}

/// Place a `lw`×`lh` (logical) island on `mon`.
/// Top dock: `x` = offset of the centre from the display centre, `y` = distance from the top.
/// Side dock: `y` = offset of the centre from the display's vertical centre.
/// Returns the clamped (x, y).
pub fn place(win: &WebviewWindow, mon: &Mon, dock: Dock, lw: f64, lh: f64, x: f64, y: f64) -> Result<(f64, f64), String> {
    let (mw, mh) = (mon.lw(), mon.lh());
    match dock {
        Dock::Top | Dock::Bottom => {
            let max_x = ((mw - lw) / 2.0).max(0.0);
            let x = x.clamp(-max_x, max_x);
            let y = if dock == Dock::Bottom { 0.0 } else { y.clamp(0.0, (mh - lh).max(0.0)) };
            let gx = mon.x + ((mw - lw) / 2.0 + x) * mon.unit;
            let gy = if dock == Dock::Bottom { mon.y + (mh - lh) * mon.unit } else { mon.y + y * mon.unit };
            set_rect(win, mon, gx, gy, lw, lh)?;
            Ok((x, y))
        }
        Dock::Left | Dock::Right => {
            let max_y = ((mh - lh) / 2.0).max(0.0);
            let y = y.clamp(-max_y, max_y);
            let gy = mon.y + ((mh - lh) / 2.0 + y) * mon.unit;
            let gx = if dock == Dock::Left { mon.x } else { mon.x + (mw - lw) * mon.unit };
            set_rect(win, mon, gx, gy, lw, lh)?;
            Ok((0.0, y))
        }
    }
}

pub fn pick(app: &AppHandle, win: &WebviewWindow, want: &str) -> Option<Mon> {
    let _ = app;
    let all = monitors(win);
    if !want.is_empty() {
        if let Some(m) = all.iter().find(|m| m.key == want).or_else(|| all.iter().find(|m| want.starts_with(&format!("{}@", m.name)))) {
            return Some(m.clone());
        }
    }
    all.iter().find(|m| m.primary).cloned().or_else(|| all.into_iter().next())
}

#[derive(Serialize)]
pub struct DragResult {
    pub monitor: String,
    pub dock: Dock,
    pub x: f64,
    pub y: f64,
}

/// Distance (logical px) from a side edge at which the island snaps vertical.
const SIDE_SNAP: f64 = 28.0;

/// Follow the cursor while dragging, across displays, snapping to the top or a side.
/// `h_*` = horizontal (top) size, `v_*` = vertical (side) size; `grab_*` = grab point
/// relative to the island's top-centre (top dock) or centre (side dock), logical px.
pub fn drag(win: &WebviewWindow, h: (f64, f64), v: (f64, f64), grab: (f64, f64), min_y: f64) -> Result<DragResult, String> {
    let (cx, cy) = cursor(win).ok_or("no cursor")?;
    let all = monitors(win);
    let mon = all.iter().find(|m| m.contains(cx, cy)).cloned().or_else(|| all.iter().find(|m| m.primary).cloned()).ok_or("no monitor")?;
    let lx = (cx - mon.x) / mon.unit;
    let ly = (cy - mon.y) / mon.unit;
    let (mw, mh) = (mon.lw(), mon.lh());
    let dock = if lx < SIDE_SNAP {
        Dock::Left
    } else if lx > mw - SIDE_SNAP {
        Dock::Right
    } else if ly > mh - SIDE_SNAP {
        Dock::Bottom
    } else {
        Dock::Top
    };
    let (x, y) = match dock {
        Dock::Top => {
            let mut y = (ly - grab.1).max(0.0);
            if y < 16.0 {
                y = 0.0;
            }
            let (x, _) = place(win, &mon, dock, h.0, h.1, lx - grab.0 - mw / 2.0, y.max(min_y))?;
            (x, y)
        }
        Dock::Bottom => place(win, &mon, dock, h.0, h.1, lx - grab.0 - mw / 2.0, 0.0)?,
        _ => place(win, &mon, dock, v.0, v.1, 0.0, ly - mh / 2.0)?,
    };
    Ok(DragResult { monitor: mon.key, dock, x, y })
}
