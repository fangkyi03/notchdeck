use serde::Serialize;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use sysinfo::{Disks, Networks, ProcessRefreshKind, ProcessesToUpdate, System};

#[derive(Serialize, Clone)]
pub struct Battery {
    pub percent: f32,
    pub charging: bool,
}

#[derive(Serialize, Clone)]
pub struct SysStats {
    pub cpu: f32,
    pub cores: Vec<f32>,
    pub mem_used: u64,
    pub mem_total: u64,
    pub gpu: Option<f32>,
    pub net_rx: f64,
    pub net_tx: f64,
    pub disk_name: String,
    pub disk_used: u64,
    pub disk_total: u64,
    pub battery: Option<Battery>,
}

#[derive(Serialize, Clone)]
pub struct Proc {
    pub name: String,
    pub cpu: f32,
    pub mem: u64,
}

pub struct SysMon {
    sys: System,
    nets: Networks,
    disks: Disks,
    last: Instant,
    disk_at: Option<Instant>,
    disk: (String, u64, u64),
    slow: Arc<Mutex<(Option<f32>, Option<Battery>)>>,
}

impl SysMon {
    pub fn new() -> Self {
        let mut sys = System::new();
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        let slow = Arc::new(Mutex::new((None, None)));
        spawn_slow_thread(slow.clone());
        Self {
            sys,
            nets: Networks::new_with_refreshed_list(),
            disks: Disks::new(),
            last: Instant::now(),
            disk_at: None,
            disk: (String::new(), 0, 0),
            slow,
        }
    }

    pub fn sample(&mut self) -> SysStats {
        self.sys.refresh_cpu_usage();
        self.sys.refresh_memory();
        self.nets.refresh();
        let dt = self.last.elapsed().as_secs_f64().max(0.001);
        self.last = Instant::now();
        let (mut rx, mut tx) = (0u64, 0u64);
        for (name, n) in self.nets.iter() {
            let l = name.to_lowercase();
            if l.starts_with("lo") || l.contains("loopback") || l.starts_with("utun") || l.starts_with("awdl") || l.starts_with("llw") || l.starts_with("bridge") {
                continue;
            }
            rx += n.received();
            tx += n.transmitted();
        }
        if self.disk_at.is_none_or(|t| t.elapsed() > Duration::from_secs(30)) {
            self.disk_at = Some(Instant::now());
            self.disks.refresh_list();
            self.disk = pick_disk(&self.disks);
        }
        let (gpu, battery) = self.slow.lock().unwrap().clone();
        SysStats {
            cpu: self.sys.global_cpu_usage(),
            cores: self.sys.cpus().iter().map(|c| c.cpu_usage()).collect(),
            mem_used: self.sys.used_memory(),
            mem_total: self.sys.total_memory(),
            gpu,
            net_rx: rx as f64 / dt,
            net_tx: tx as f64 / dt,
            disk_name: self.disk.0.clone(),
            disk_used: self.disk.1,
            disk_total: self.disk.2,
            battery,
        }
    }

    /// Last battery reading from the slow thread (doesn't touch CPU sampling).
    pub fn battery(&self) -> Option<Battery> {
        self.slow.lock().unwrap().1.clone()
    }

    /// Top processes grouped by name (helpers of one app are summed).
    pub fn processes(&mut self, by_mem: bool, n: usize) -> Vec<Proc> {
        self.sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::new().with_cpu().with_memory());
        let cores = self.sys.cpus().len().max(1) as f32;
        let mut map: std::collections::HashMap<String, Proc> = std::collections::HashMap::new();
        for p in self.sys.processes().values() {
            let raw = p.name().to_string_lossy().to_string();
            let name = app_name(&raw);
            let e = map.entry(name.clone()).or_insert(Proc { name, cpu: 0.0, mem: 0 });
            e.cpu += p.cpu_usage() / cores;
            e.mem += p.memory();
        }
        let mut v: Vec<Proc> = map.into_values().filter(|p| !p.name.is_empty()).collect();
        if by_mem {
            v.sort_by(|a, b| b.mem.cmp(&a.mem));
        } else {
            v.sort_by(|a, b| b.cpu.partial_cmp(&a.cpu).unwrap_or(std::cmp::Ordering::Equal));
        }
        v.truncate(n);
        v
    }
}

fn app_name(raw: &str) -> String {
    let s = raw.trim_end_matches(".exe");
    // "Google Chrome Helper (Renderer)" -> "Google Chrome"
    let s = s.split(" Helper").next().unwrap_or(s);
    s.to_string()
}

fn pick_disk(disks: &Disks) -> (String, u64, u64) {
    let list = disks.list();
    let pref = ["/System/Volumes/Data", "/", "C:\\"];
    let d = pref
        .iter()
        .find_map(|m| list.iter().find(|d| d.mount_point().to_string_lossy() == *m))
        .or_else(|| list.first());
    match d {
        Some(d) => {
            let mp = d.mount_point().to_string_lossy().to_string();
            let name = if mp.len() >= 2 && mp.as_bytes()[1] == b':' { mp[..2].to_string() } else { "磁盘".into() };
            (name, d.total_space() - d.available_space(), d.total_space())
        }
        None => (String::new(), 0, 0),
    }
}

fn spawn_slow_thread(out: Arc<Mutex<(Option<f32>, Option<Battery>)>>) {
    std::thread::spawn(move || {
        let mut reader = gpu::Reader::new();
        let mut tick = 0u32;
        let mut bat = None;
        loop {
            if tick.is_multiple_of(15) {
                bat = battery();
            }
            tick += 1;
            let g = reader.read();
            *out.lock().unwrap() = (g, bat.clone());
            std::thread::sleep(Duration::from_secs(2));
        }
    });
}

#[cfg(target_os = "macos")]
fn battery() -> Option<Battery> {
    let out = std::process::Command::new("pmset").args(["-g", "batt"]).output().ok()?;
    let s = String::from_utf8_lossy(&out.stdout);
    let line = s.lines().find(|l| l.contains('%'))?;
    let pct: String = line.split('%').next()?.chars().rev().take_while(|c| c.is_ascii_digit()).collect::<Vec<_>>().into_iter().rev().collect();
    Some(Battery { percent: pct.parse().ok()?, charging: s.contains("AC Power") })
}

#[cfg(windows)]
fn battery() -> Option<Battery> {
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    let mut st = SYSTEM_POWER_STATUS::default();
    unsafe { GetSystemPowerStatus(&mut st).ok()? };
    // 128 = no system battery, 255 = unknown
    if st.BatteryFlag & 128 != 0 || st.BatteryLifePercent == 255 {
        return None;
    }
    Some(Battery { percent: st.BatteryLifePercent as f32, charging: st.ACLineStatus == 1 })
}

#[cfg(not(any(target_os = "macos", windows)))]
fn battery() -> Option<Battery> {
    None
}

#[cfg(target_os = "macos")]
mod gpu {
    use std::process::Command;
    pub struct Reader;
    impl Reader {
        pub fn new() -> Self {
            Reader
        }
        /// "Device Utilization %" from the IOAccelerator registry entry (Apple Silicon & Intel).
        pub fn read(&mut self) -> Option<f32> {
            let out = Command::new("ioreg").args(["-r", "-d", "1", "-w", "0", "-c", "IOAccelerator"]).output().ok()?;
            let s = String::from_utf8_lossy(&out.stdout);
            let key = "\"Device Utilization %\"=";
            let i = s.find(key)? + key.len();
            let num: String = s[i..].chars().take_while(|c| c.is_ascii_digit()).collect();
            num.parse().ok()
        }
    }
}

#[cfg(windows)]
mod gpu {
    use windows::core::w;
    use windows::Win32::System::Performance::*;

    /// Sums the 3D engine utilization across processes, like Task Manager.
    pub struct Reader {
        query: isize,
        counter: isize,
        ok: bool,
    }

    impl Reader {
        pub fn new() -> Self {
            unsafe {
                let mut query = 0isize;
                let mut counter = 0isize;
                let mut ok = PdhOpenQueryW(None, 0, &mut query) == 0;
                if ok {
                    ok = PdhAddEnglishCounterW(query, w!("\\GPU Engine(*engtype_3D)\\Utilization Percentage"), 0, &mut counter) == 0;
                    let _ = PdhCollectQueryData(query);
                }
                Reader { query, counter, ok }
            }
        }

        pub fn read(&mut self) -> Option<f32> {
            if !self.ok {
                return None;
            }
            unsafe {
                if PdhCollectQueryData(self.query) != 0 {
                    return None;
                }
                let mut size = 0u32;
                let mut count = 0u32;
                let _ = PdhGetFormattedCounterArrayW(self.counter, PDH_FMT_DOUBLE, &mut size, &mut count, None);
                if size == 0 {
                    return Some(0.0);
                }
                let mut buf = vec![0u8; size as usize];
                let items = buf.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
                if PdhGetFormattedCounterArrayW(self.counter, PDH_FMT_DOUBLE, &mut size, &mut count, Some(items)) != 0 {
                    return None;
                }
                let slice = std::slice::from_raw_parts(items, count as usize);
                let total: f64 = slice.iter().map(|it| it.FmtValue.Anonymous.doubleValue).sum();
                Some(total.clamp(0.0, 100.0) as f32)
            }
        }
    }

    // PDH handles are only used from the single GPU thread.
    unsafe impl Send for Reader {}
}

#[cfg(not(any(target_os = "macos", windows)))]
mod gpu {
    pub struct Reader;
    impl Reader {
        pub fn new() -> Self {
            Reader
        }
        pub fn read(&mut self) -> Option<f32> {
            None
        }
    }
}
