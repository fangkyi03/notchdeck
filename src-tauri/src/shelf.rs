//! File shelf: files dropped on the island are remembered by path (never copied)
//! and can be opened, revealed, copied to the clipboard or dragged out again.

use serde::Serialize;
use std::path::Path;
use std::process::Command;

#[derive(Serialize)]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub is_dir: bool,
    pub exists: bool,
    pub ext: String,
}

pub fn info(paths: &[String]) -> Vec<FileInfo> {
    paths
        .iter()
        .map(|p| {
            let path = Path::new(p);
            let meta = std::fs::metadata(path).ok();
            FileInfo {
                path: p.clone(),
                name: path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| p.clone()),
                size: meta.as_ref().map(|m| if m.is_dir() { 0 } else { m.len() }).unwrap_or(0),
                is_dir: meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
                exists: meta.is_some(),
                ext: path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default(),
            }
        })
        .collect()
}

fn run(cmd: &mut Command) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let st = cmd.status().map_err(|e| e.to_string())?;
    if st.success() { Ok(()) } else { Err("操作失败".into()) }
}

pub fn open(path: &str) -> Result<(), String> {
    if !Path::new(path).exists() {
        return Err("文件已被移动或删除".into());
    }
    #[cfg(target_os = "macos")]
    return run(Command::new("open").arg(path));
    #[cfg(windows)]
    return run(Command::new("cmd").args(["/C", "start", "", path]));
    #[cfg(not(any(target_os = "macos", windows)))]
    return run(Command::new("xdg-open").arg(path));
}

/// Show the file in Finder / Explorer.
pub fn reveal(path: &str) -> Result<(), String> {
    if !Path::new(path).exists() {
        return Err("文件已被移动或删除".into());
    }
    #[cfg(target_os = "macos")]
    return run(Command::new("open").args(["-R", path]));
    #[cfg(windows)]
    {
        // explorer returns 1 even on success.
        let _ = Command::new("explorer").arg(format!("/select,{path}")).spawn();
        return Ok(());
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    return run(Command::new("xdg-open").arg(Path::new(path).parent().unwrap_or(Path::new("/"))));
}

/// Put the files themselves on the clipboard, so ⌘V / Ctrl+V pastes them in Finder,
/// Explorer, chat apps, etc.
pub fn copy_files(paths: &[String]) -> Result<(), String> {
    let paths: Vec<&String> = paths.iter().filter(|p| Path::new(p).exists()).collect();
    if paths.is_empty() {
        return Err("文件已被移动或删除".into());
    }
    #[cfg(target_os = "macos")]
    {
        let list = paths.iter().map(|p| format!("POSIX file \"{}\"", p.replace('\\', "\\\\").replace('"', "\\\""))).collect::<Vec<_>>().join(", ");
        run(Command::new("osascript").args(["-e", &format!("set the clipboard to {{{list}}}")]))
    }
    #[cfg(windows)]
    {
        let list = paths.iter().map(|p| format!("'{}'", p.replace('\'', "''"))).collect::<Vec<_>>().join(",");
        return run(Command::new("powershell").args(["-NoProfile", "-Command", &format!("Set-Clipboard -Path {list}")]));
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = paths;
        Err("当前平台不支持".into())
    }
}

/// The drag plugin needs an image file to show under the cursor.
pub fn drag_icon() -> String {
    let p = crate::extras::data_dir().join("drag-icon.png");
    if !p.exists() {
        let _ = std::fs::write(&p, include_bytes!("../icons/64x64.png"));
    }
    p.to_string_lossy().to_string()
}
