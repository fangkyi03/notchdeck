export type Dock = "top" | "bottom" | "left" | "right";
export type ThemeColors = { bg: string; fg: string; muted: string; accent: string; card: string; border: string };

export type ProviderKind = "claude" | "codex" | "cursor" | "antigravity" | "glm" | "zai" | "kimi_code" | "deepseek" | "openrouter" | "moonshot" | "command" | "http";
export type Provider = {
  id: string;
  name: string;
  kind: ProviderKind;
  enabled: boolean;
  color: string;
  /** Show this provider's ring in the collapsed island. */
  compact: boolean;
  command?: string;
  url?: string;
  headers?: Record<string, string>;
  percentPath?: string;
  labelPath?: string;
  quotaTitle?: string;
};

export type MetricId = "cpu" | "mem" | "gpu" | "net" | "disk";
export type PageId = "devices" | "calendar" | "water" | "translate" | "shelf" | "messages" | "ai" | "details" | "music" | "monitor" | "todo" | "focus" | "clipboard" | "weather";
export type CompactItem = "devices" | "event" | "water" | "shelf" | "msg" | "music" | "rings" | "cores" | "cpu" | "mem" | "gpu" | "net" | "lyric" | "eq" | "clock" | "weather" | "focus" | "todo";

/** Message alerts are Windows-only (macOS no longer exposes Dock badges). */
export const HAS_MESSAGES = !navigator.userAgent.includes("Mac");

export type Config = {
  lang: "auto" | "zh" | "en";
  skin: string;
  customTheme: ThemeColors;
  shape: "notch" | "capsule" | "line";
  scale: number;
  opacity: number;
  position: { x: number; y: number; dock?: Dock };
  lockPosition: boolean;
  proxy: string;
  autostart: boolean;
  /** Game mode: clicks pass through the collapsed island; open it with the shortcut. */
  clickThrough: boolean;
  /** Seconds of inactivity before the collapsed island tucks into a thin line (0 = off). */
  idleHide: number;
  shortcuts: Record<"toggle" | "clipboard" | "translate" | "todo", string>;
  translate: { provider: string; baseUrl: string; model: string; target: string };
  calendars: CalSource[];
  water: { enabled: boolean; goal: number; cup: number; interval: number; start: string; end: string };
  /** Minutes before a timed event to show a reminder (0 = off). */
  eventReminder: number;
  autoUpdate: boolean;
  statusAlerts: Record<"volume" | "caps" | "input" | "network" | "power" | "devices", boolean>;
  /** Display key ("name@x,y"); empty = primary. */
  monitor: string;
  expandMode: "hover" | "click";
  hoverDelay: number;
  hideOnFullscreen: boolean;
  clock24: boolean;
  compact: {
    items: CompactItem[];
    autoWidth: boolean;
    width: number;
    ringMode: "single" | "multi";
    showRemaining: boolean;
    alerts: boolean;
  };
  pages: { id: PageId; enabled: boolean }[];
  panel: { width: number; height: number };
  metrics: { id: MetricId; color: string }[];
  weatherCity: string;
  clipboard: boolean;
  clipboardImages: boolean;
  focus: { work: number; rest: number };
  providers: Provider[];
};

export type Sys = {
  cpu: number;
  cores: number[];
  mem_used: number;
  mem_total: number;
  gpu: number | null;
  net_rx: number;
  net_tx: number;
  disk_name: string;
  disk_used: number;
  disk_total: number;
  battery: { percent: number; charging: boolean } | null;
};
export type Proc = { name: string; cpu: number; mem: number };

export type Quota = { title: string; percent: number | null; value: string; reset_at: number | null; reset_text: string };
export type Column = {
  id: string;
  name: string;
  color: string;
  plan: string;
  quotas: Quota[];
  has_stats: boolean;
  today_tokens: number;
  today_cost: number;
  week_tokens: number;
  week_cost: number;
  models: ModelStat[];
  error: string | null;
  stale_since: number | null;
};

export type MsgApp = { id: string; name: string; count: number | null; active: boolean; since: number };
export type Toast = { id: number; app: string; title: string; body: string; at: number };
export type Messages = { platform: string; apps: MsgApp[]; toasts: Toast[]; toast_status: string };

export type ModelStat = { model: string; today_tokens: number; today_cost: number; week_tokens: number; week_cost: number; requests: number };
export type MonitorInfo = { key: string; name: string; width: number; height: number; primary: boolean };

export type Media = {
  title: string;
  artist: string;
  album: string;
  playing: boolean;
  source: string;
  position: number;
  duration: number;
  artwork: string;
};
export type LyricLine = { t: number; text: string };

export type ClipItem = { text: string; at: number; pinned: boolean; kind: "text" | "image"; image: string; thumb: string };

export type Weather = {
  city: string;
  temp: number;
  feels: number;
  humidity: number;
  wind: number;
  code: number;
  is_day: boolean;
  sunrise: string;
  sunset: string;
  daily: { date: string; code: number; max: number; min: number; rain: number }[];
  updated: number;
};

export type CalSource = { id: string; name: string; kind: "ics" | "caldav"; url: string; user?: string; color: string; enabled: boolean };
export type CalEvent = { id: string; title: string; start: number; end: number; all_day: boolean; location: string; calendar: string; color: string };
export type Device = { name: string; kind: string; percent: number; parts: { label: string; percent: number }[] };
export type StatusEvent = { kind: string; icon: string; text: string; value: number | null };
export type WaterState = { date: string; ml: number; log: number[]; lastAt: number };
export type ShelfItem = { path: string; added: number };
export type Todo = { id: string; text: string; done: boolean; date: string; current?: boolean; doneAt?: number };
export type FocusState = { mode: "work" | "rest"; running: boolean; endsAt: number; remaining: number; rounds: number };

export const PAGE_META: Record<PageId, { title: [string, string]; label: string }> = {
  messages: { title: ["消息", "提醒"], label: "消息提醒" },
  shelf: { title: ["文件", "中转"], label: "文件中转" },
  translate: { title: ["快捷", "翻译"], label: "快捷翻译" },
  calendar: { title: ["今日", "日程"], label: "日程" },
  water: { title: ["饮水", "提醒"], label: "饮水提醒" },
  devices: { title: ["设备", "电量"], label: "设备电量" },
  ai: { title: ["AI", "额度"], label: "AI 额度" },
  details: { title: ["模型", "明细"], label: "模型明细" },
  music: { title: ["正在", "播放"], label: "音乐" },
  monitor: { title: ["系统", "监控"], label: "系统监控" },
  todo: { title: ["待办", "清单"], label: "待办" },
  focus: { title: ["番茄", "专注"], label: "番茄专注" },
  clipboard: { title: ["剪贴", "历史"], label: "剪贴板" },
  weather: { title: ["今日", "天气"], label: "天气" },
};

export const COMPACT_LABELS: Record<CompactItem, string> = {
  msg: "消息提醒",
  shelf: "文件中转数量",
  event: "下一个日程",
  water: "饮水进度",
  devices: "设备电量",
  music: "专辑封面",
  rings: "AI 额度环",
  cores: "CPU 核心柱",
  cpu: "CPU 表盘",
  mem: "内存表盘",
  gpu: "GPU 表盘",
  net: "网速",
  lyric: "歌词 / 歌名",
  eq: "律动条",
  clock: "时间",
  weather: "天气",
  focus: "专注倒计时",
  todo: "待办进度",
};

export const METRIC_LABELS: Record<MetricId, string> = { cpu: "CPU", mem: "内存", gpu: "GPU", net: "网速", disk: "硬盘" };
