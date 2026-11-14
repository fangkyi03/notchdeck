import type { Config, ThemeColors } from "./types";

/** Visual "material" on top of the palette (glass skins are drawn with CSS only). */
export type Skin = { name: string; desc: string; colors: ThemeColors; glass?: "light" | "dark"; edge?: string };

export const SKINS: Record<string, Skin> = {
  classic: { name: "经典黑", desc: "熟悉的黑色小岛", colors: { bg: "#000000", fg: "#f5f5f7", muted: "#8e8e93", accent: "#0a84ff", card: "#1c1c1e", border: "#2c2c2e" } },
  cream: { name: "奶油", desc: "温暖柔和的浅色", colors: { bg: "#f8f1e3", fg: "#2b2420", muted: "#8a7d70", accent: "#e8524a", card: "#efe5d2", border: "#e2d5bd" } },
  "glass-light": { name: "毛玻璃 · 浅", desc: "通透的明亮层次", glass: "light", colors: { bg: "rgba(250,248,252,0.72)", fg: "#1d1d1f", muted: "#6e6e73", accent: "#007aff", card: "rgba(255,255,255,0.55)", border: "rgba(0,0,0,0.08)" } },
  "glass-dark": { name: "毛玻璃 · 深", desc: "融进桌面的深色质感", glass: "dark", colors: { bg: "rgba(28,26,32,0.72)", fg: "#f5f5f7", muted: "#a1a1a6", accent: "#64d2ff", card: "rgba(255,255,255,0.07)", border: "rgba(255,255,255,0.10)" } },
  "one-dark": { name: "One Dark Pro", desc: "编辑器同款配色", colors: { bg: "#21252b", fg: "#d7dae0", muted: "#7f848e", accent: "#61afef", card: "#282c34", border: "#3b4048" } },
  dracula: { name: "Dracula", desc: "紫调暗色", colors: { bg: "#21222c", fg: "#f8f8f2", muted: "#9aa2c8", accent: "#bd93f9", card: "#282a36", border: "#44475a" } },
  "night-owl": { name: "Night Owl", desc: "深夜蓝", colors: { bg: "#011627", fg: "#d6deeb", muted: "#7e93a8", accent: "#82aaff", card: "#0b2942", border: "#1d3b53" } },
  "github-light": { name: "GitHub Light", desc: "干净的浅色", colors: { bg: "#ffffff", fg: "#1f2328", muted: "#656d76", accent: "#0969da", card: "#f6f8fa", border: "#d0d7de" } },
  cyberpunk: { name: "赛博朋克", desc: "霓虹描边", edge: "linear-gradient(90deg,#00f0ff,#ff2a6d,#f9f871)", colors: { bg: "#120b1f", fg: "#f3f0ff", muted: "#9d8cc2", accent: "#f9f871", card: "#1d1233", border: "#3a2560" } },
};

export function skinOf(cfg: Config): Skin {
  if (cfg.skin === "custom") return { name: "自定义", desc: "", colors: cfg.customTheme };
  return SKINS[cfg.skin] ?? SKINS.classic;
}

/** Relative luminance check so text/ring tracks adapt to light skins. */
export function isLight(color: string): boolean {
  const m = color.match(/^#([0-9a-f]{6})$/i);
  let r = 0, g = 0, b = 0;
  if (m) {
    const n = parseInt(m[1], 16);
    r = n >> 16; g = (n >> 8) & 255; b = n & 255;
  } else {
    const p = color.match(/rgba?\(([^)]+)\)/);
    if (!p) return false;
    [r, g, b] = p[1].split(",").map((x) => parseFloat(x));
  }
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 150;
}

export function applySkin(cfg: Config, el: HTMLElement = document.documentElement) {
  const s = skinOf(cfg);
  for (const [k, v] of Object.entries(s.colors)) el.style.setProperty(`--${k}`, v);
  el.style.setProperty("--track", isLight(s.colors.bg) ? "rgba(0,0,0,0.10)" : "rgba(255,255,255,0.13)");
  el.style.setProperty("--edge", s.edge ?? "none");
  el.dataset.glass = s.glass ?? "";
  el.dataset.light = isLight(s.colors.bg) ? "1" : "";
}
