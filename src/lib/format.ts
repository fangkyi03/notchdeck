export function fmtBytes(n: number, digits = 1): string {
  const u = ["B", "K", "M", "G", "T"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${i > 0 && n < 100 ? n.toFixed(digits) : Math.round(n)}${u[i]}`;
}

export function fmtGB(n: number): string {
  return (n / 1024 ** 3).toFixed(1);
}

export function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 1 : 2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return `${n}`;
}

export function fmtCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** "2 时 13 分后" / "3 天 5 时后" */
export function fmtReset(at: number | null, now = Date.now() / 1000): string {
  if (!at) return "";
  let s = Math.max(0, Math.round(at - now));
  if (s === 0) return "即将重置";
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d > 0) return `${d} 天 ${h} 时后`;
  if (h > 0) return `${h} 时 ${m} 分后`;
  return `${Math.max(1, m)} 分后`;
}

export function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
export function fmtDate(d: Date): string {
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEK[d.getDay()]}`;
}
export function fmtClock(d: Date, h24: boolean): string {
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  if (!h24) { h = h % 12 || 12; }
  return `${String(h).padStart(2, "0")}:${m}`;
}
export function todayKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** WMO weather codes used by Open-Meteo. */
export function weatherInfo(code: number, day = true): { icon: string; text: string } {
  if (code === 0) return { icon: day ? "☀️" : "🌙", text: "晴" };
  if (code <= 2) return { icon: day ? "🌤️" : "☁️", text: "少云" };
  if (code === 3) return { icon: "☁️", text: "阴" };
  if (code <= 48) return { icon: "🌫️", text: "雾" };
  if (code <= 57) return { icon: "🌦️", text: "毛毛雨" };
  if (code <= 67) return { icon: "🌧️", text: "雨" };
  if (code <= 77) return { icon: "🌨️", text: "雪" };
  if (code <= 82) return { icon: "🌧️", text: "阵雨" };
  if (code <= 86) return { icon: "🌨️", text: "阵雪" };
  return { icon: "⛈️", text: "雷雨" };
}

/** Quota color: tool color normally, amber ≥70%, red ≥90%. */
export function quotaColor(pct: number | null, base: string): string {
  if (pct == null) return base;
  if (pct >= 90) return "#ff453a";
  if (pct >= 70) return "#ff9f0a";
  return base;
}
