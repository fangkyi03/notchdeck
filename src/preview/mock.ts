/**
 * Dev-only: fakes the Tauri backend so the island can be rendered in a normal
 * browser (`npm run dev` → http://localhost:1420/preview.html?page=ai&expand=1).
 */
const now = () => Date.now() / 1000;
const params = new URLSearchParams(location.search);
const handlers: Record<string, number[]> = {};
let cbId = 1;

const cfg = {
  skin: params.get("skin") ?? "classic",
  customTheme: { bg: "#14121a", fg: "#f5f5f7", muted: "#8e8e93", accent: "#bf5af2", card: "#22202a", border: "#2f2c38" },
  shape: params.get("shape") ?? "notch", scale: 1, opacity: 1, position: { x: 0, y: 0, dock: (params.get("dock") ?? "top") as any }, lockPosition: false, monitor: "", proxy: "", autostart: true, clickThrough: false, idleHide: 30, shortcuts: { toggle: "CommandOrControl+Shift+Space", clipboard: "CommandOrControl+Shift+V", translate: "CommandOrControl+Shift+T", todo: "" },
  clipboardImages: true, translate: { provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", target: "auto" },
  calendars: [{ id: "c1", name: "工作", kind: "ics", url: "https://example.com/work.ics", color: "#0a84ff", enabled: true }],
  water: { enabled: true, goal: 2000, cup: 250, interval: 60, start: "09:00", end: "21:00" }, eventReminder: 10, autoUpdate: true,
  statusAlerts: { volume: true, caps: true, input: true, network: true, power: true, devices: true },
  expandMode: "hover", hoverDelay: 0, hideOnFullscreen: true, clock24: true,
  compact: { items: (params.get("items") ?? "music,rings,cores,cpu,mem,gpu,net,eq").split(","), autoWidth: true, width: 320, ringMode: "single", showRemaining: false, alerts: false },
  pages: ["messages", "shelf", "translate", "calendar", "water", "devices", "ai", "details", "music", "monitor", "todo", "focus", "clipboard", "weather"].map((id) => ({ id, enabled: true })),
  panel: { width: 760, height: 250 },
  metrics: [{ id: "cpu", color: "#0a84ff" }, { id: "mem", color: "#64d2ff" }, { id: "gpu", color: "#ff7eb6" }, { id: "net", color: "#30d158" }, { id: "disk", color: "#5ac8fa" }],
  weatherCity: "", clipboard: true, focus: { work: 25, rest: 5 },
  providers: [
    { id: "claude", name: "Claude", kind: "claude", enabled: true, color: "#e8916b", compact: true },
    { id: "codex", name: "Codex", kind: "codex", enabled: true, color: "#7fd6a0", compact: true },
    { id: "cursor", name: "Cursor", kind: "command", enabled: true, color: "#e9c46a", compact: true },
    { id: "ds", name: "DeepSeek", kind: "http", enabled: true, color: "#8ea8ff", compact: true },
  ],
};

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const data: Record<string, (a: any) => unknown> = {
  get_config: () => cfg,
  save_config: () => null,
  store_get: ({ key }) => key === "todos"
    ? [{ id: "1", text: "站会", done: true, date: new Date().toISOString().slice(0, 10) }, { id: "2", text: "回复设计评审意见", done: false, current: true, date: new Date().toISOString().slice(0, 10) }, { id: "3", text: "健身", done: false, date: new Date().toISOString().slice(0, 10) }]
    : key === "shelf" ? [{ path: "/Users/me/Desktop/设计稿 v3.pdf", added: now() }, { path: "/Users/me/Downloads/截图 2026-11-15.png", added: now() }, { path: "/Users/me/Documents/季度报告.xlsx", added: now() }, { path: "/Users/me/Projects/notchdeck", added: now() }, { path: "/Users/me/Music/晚风邮局.mp3", added: now() }]
    : key === "water" ? { date: new Date().toLocaleDateString("sv-SE"), ml: 1250, log: [250, 250, 500, 250], lastAt: Date.now() - 20 * 60000 }
    : key === "focus" ? { mode: "work", running: true, endsAt: Date.now() + 1000 * 60 * 18 + 22000, remaining: 0, rounds: 3 } : null,
  store_set: () => null,
  get_sys: () => ({ cpu: rnd(20, 40), cores: Array.from({ length: 12 }, () => rnd(3, 80)), mem_used: 18.4 * 1024 ** 3, mem_total: 32 * 1024 ** 3, gpu: rnd(25, 45), net_rx: rnd(1e6, 4e6), net_tx: rnd(1e5, 5e5), disk_name: "磁盘", disk_used: 612 * 1024 ** 3, disk_total: 994 * 1024 ** 3, battery: { percent: 82, charging: true } }),
  get_procs: ({ byMem }) => [["Visual Studio Code", 9.1, 2.1], ["Google Chrome", 6.3, 3.4], ["Cursor", 3.7, 1.6], ["WindowServer", 2.1, 0.6], ["Finder", 0.9, 0.2], ["网易云音乐", 0.6, 0.4], ["Terminal", 0.5, 0.1]].map(([name, cpu, g]) => ({ name, cpu, mem: (g as number) * 1024 ** 3 })).sort((a: any, b: any) => (byMem ? b.mem - a.mem : b.cpu - a.cpu)),
  get_usage: () => [
    { id: "claude", name: "Claude", color: "", plan: "Max", quotas: [{ title: "5 小时", percent: 34, value: "", reset_at: now() + 7980, reset_text: "" }, { title: "每周", percent: 58, value: "", reset_at: now() + 277200, reset_text: "" }], models: [{ model: "claude-opus-4-6", today_tokens: 18.2e6, today_cost: 12.4, week_tokens: 120e6, week_cost: 82.1, requests: 900 }, { model: "claude-sonnet-4-5", today_tokens: 8.2e6, today_cost: 5.44, week_tokens: 43.9e6, week_cost: 28.65, requests: 700 }, { model: "claude-haiku-4-5", today_tokens: 0, today_cost: 0, week_tokens: 2.1e6, week_cost: 0.4, requests: 80 }], has_stats: true, today_tokens: 26.4e6, today_cost: 17.84, week_tokens: 163.89e6, week_cost: 110.75, error: null, stale_since: null },
    { id: "codex", name: "Codex", color: "", plan: "Plus", quotas: [{ title: "5 小时", percent: 22, value: "", reset_at: now() + 13260, reset_text: "" }, { title: "每周", percent: 41, value: "", reset_at: now() + 352800, reset_text: "" }], models: [{ model: "gpt-5-codex", today_tokens: 11.2e6, today_cost: 6.37, week_tokens: 67.68e6, week_cost: 38.5, requests: 400 }], has_stats: true, today_tokens: 11.2e6, today_cost: 6.37, week_tokens: 67.68e6, week_cost: 38.5, error: null, stale_since: null },
    { id: "cursor", name: "Cursor", color: "", plan: "Pro", quotas: [{ title: "Cursor 模型", percent: 76, value: "", reset_at: now() + 1058400, reset_text: "" }, { title: "其他模型", percent: 18, value: "", reset_at: now() + 1058400, reset_text: "" }], models: [], has_stats: false, today_tokens: 0, today_cost: 0, week_tokens: 0, week_cost: 0, error: null, stale_since: null },
    { id: "ds", name: "DeepSeek", color: "", plan: "", quotas: [{ title: "余额", percent: null, value: "¥4.18", reset_at: null, reset_text: "" }], models: [], has_stats: false, today_tokens: 0, today_cost: 0, week_tokens: 0, week_cost: 0, error: null, stale_since: null },
  ],
  get_media: () => ({ title: "晚风邮局", artist: "纸灯乐队", album: "海边来信", playing: true, source: "Spotify", position: 84, duration: 232, artwork: "" }),
  get_lyrics: () => [{ t: 70, text: "沿着海岸线慢慢走" }, { t: 80, text: "海浪替我盖上邮戳" }, { t: 90, text: "把晚风寄给你" }],
  get_weather: () => ({ city: "上海", temp: 18, feels: 17, humidity: 64, wind: 12, code: 2, is_day: true, sunrise: "06:24", sunset: "16:58", daily: [0, 1, 2, 3, 4].map((i) => ({ date: new Date(Date.now() + i * 864e5).toISOString().slice(0, 10), code: [2, 61, 3, 0, 80][i], max: 20 - i, min: 12 - i / 2, rain: [10, 70, 20, 0, 40][i] })), updated: now() }),
  clip_list: () => [{ text: "npm run tauri dev", at: now(), pinned: true, kind: "text", image: "", thumb: "" }, { text: "图片 1440×900", at: now(), pinned: false, kind: "image", image: "", thumb: "/src-tauri/icons/128x128@2x.png" }, { text: "#7955b8", at: now(), pinned: false }, { text: "https://github.com/flyl1u/fly-island", at: now(), pinned: false }, { text: "验证码 482913，5 分钟内有效", at: now(), pinned: false }],
  place_island: ({ x, y }) => [x, y],
  shelf_info: ({ paths }) => paths.map((p: string) => { const name = p.split("/").pop() ?? p; const ext = name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : ""; return { path: p, name, size: ext ? Math.round(Math.random() * 9e6) : 0, is_dir: !ext, exists: true, ext }; }),
  translate_text: ({ text }) => (/[\u4e00-\u9fff]/.test(text) ? "Every person who lives earnestly deserves to find their own light in ordinary days." : "愿每一个认真生活的人，都能在平凡的日子里找到属于自己的光。"),
  calendar_events: () => ({ errors: [], updated: now(), events: [
    { id: "e1", title: "站会", start: (() => { const x = new Date(); x.setDate(x.getDate() + 0); x.setHours(9, 30, 0, 0); return x.getTime() / 1000; })(), end: (() => { const x = new Date(); x.setDate(x.getDate() + 0); x.setHours(9, 45, 0, 0); return x.getTime() / 1000; })(), all_day: false, location: "", calendar: "工作", color: "#0a84ff" },
    { id: "e2", title: "产品方案评审", start: (() => { const x = new Date(); x.setDate(x.getDate() + 0); x.setHours(14, 30, 0, 0); return x.getTime() / 1000; })(), end: (() => { const x = new Date(); x.setDate(x.getDate() + 0); x.setHours(15, 15, 0, 0); return x.getTime() / 1000; })(), all_day: false, location: "3F 会议室", calendar: "工作", color: "#0a84ff" },
    { id: "e3", title: "客户沟通：合同条款确认", start: (() => { const x = new Date(); x.setDate(x.getDate() + 0); x.setHours(16, 0, 0, 0); return x.getTime() / 1000; })(), end: (() => { const x = new Date(); x.setDate(x.getDate() + 0); x.setHours(16, 30, 0, 0); return x.getTime() / 1000; })(), all_day: false, location: "", calendar: "工作", color: "#ff9f0a" },
    { id: "e4", title: "散步与读书", start: (() => { const x = new Date(); x.setDate(x.getDate() + 0); x.setHours(0, 0, 0, 0); return x.getTime() / 1000; })(), end: (() => { const x = new Date(); x.setDate(x.getDate() + 1); x.setHours(0, 0, 0, 0); return x.getTime() / 1000; })(), all_day: true, location: "", calendar: "个人", color: "#30d158" },
    { id: "e5", title: "交付验收会议", start: (() => { const x = new Date(); x.setDate(x.getDate() + 2); x.setHours(10, 0, 0, 0); return x.getTime() / 1000; })(), end: (() => { const x = new Date(); x.setDate(x.getDate() + 2); x.setHours(11, 0, 0, 0); return x.getTime() / 1000; })(), all_day: false, location: "", calendar: "工作", color: "#0a84ff" },
    { id: "e6", title: "周会", start: (() => { const x = new Date(); x.setDate(x.getDate() + 5); x.setHours(10, 0, 0, 0); return x.getTime() / 1000; })(), end: (() => { const x = new Date(); x.setDate(x.getDate() + 5); x.setHours(11, 0, 0, 0); return x.getTime() / 1000; })(), all_day: false, location: "", calendar: "工作", color: "#bf5af2" },
  ] }),
  get_devices: () => [{ name: "MX Master 3S", kind: "mouse", percent: 76, parts: [] }, { name: "Magic Keyboard", kind: "keyboard", percent: 18, parts: [] }, { name: "AirPods Pro", kind: "headphones", percent: 64, parts: [{ label: "左", percent: 64 }, { label: "右", percent: 70 }, { label: "盒", percent: 92 }] }, { name: "Xbox 手柄", kind: "gamepad", percent: 41, parts: [] }],
  get_messages: () => ({ platform: params.get("plat") ?? "windows", apps: [{ id: "wechat", name: "微信", count: 3, active: true, since: now() - 120 }, { id: "qq", name: "QQ", count: null, active: true, since: now() - 30 }, { id: "feishu", name: "飞书", count: 1, active: true, since: now() - 900 }], toast_status: "", toasts: [{ id: 1, app: "QQ", title: "产品群", body: "明天上午 10 点评审，记得带上新版设计稿", at: now() - 30 }, { id: 2, app: "Outlook", title: "周报提醒", body: "本周周报请在周五 18:00 前提交", at: now() - 600 }, { id: 3, app: "GitHub Desktop", title: "推送完成", body: "notchdeck · main", at: now() - 1800 }] }),
  list_monitors: () => [{ key: "a", name: "内建显示器", width: 1512, height: 982, primary: true }, { key: "b", name: "DELL U2723QE", width: 2560, height: 1440, primary: false }],
  secret_has: () => true,
  show_island: () => null,
  "plugin:event|listen": ({ event, handler }) => { (handlers[event] ??= []).push(handler); return cbId++; },
  "plugin:event|unlisten": () => null,
};

(window as any).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
  transformCallback: (cb: unknown) => { const id = cbId++; (window as any)[`_${id}`] = cb; return id; },
  invoke: async (cmd: string, args: any) => (data[cmd] ? data[cmd](args ?? {}) : null),
};
(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };

if (params.get("page")) localStorage.setItem("page", params.get("page")!);
if (params.get("expand")) {
  setTimeout(() => (handlers["island-cursor"] ?? []).forEach((h) => (window as any)[`_${h}`]({ event: "island-cursor", id: 0, payload: [true, 0, 0] })), 600);
}

// Headless browsers fire focus/blur unpredictably; the island collapses on blur.
if (params.get("expand")) {
  const orig = window.addEventListener.bind(window);
  (window as any).addEventListener = (t: string, ...rest: any[]) => (t === "blur" ? undefined : (orig as any)(t, ...rest));
}
