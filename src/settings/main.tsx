import { useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { emit, listen } from "@tauri-apps/api/event";
import { api } from "../lib/api";
import { Icon } from "../lib/icons";
import { applySkin, SKINS } from "../lib/themes";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { COMPACT_LABELS, METRIC_LABELS, PAGE_META, type CalEvent, type CalSource, type CompactItem, type Config, type MonitorInfo, type Provider, type ThemeColors } from "../lib/types";
import { setLang } from "../lib/i18n";
import "./settings.css";

const SECTIONS = [
  ["general", "常规", "settings"],
  ["look", "外观与皮肤", "star"],
  ["compact", "收起内容", "todo"],
  ["pages", "展开页面", "clipboard"],
  ["ai", "AI 额度", "ai"],
  ["monitor", "系统监控", "monitor"],
  ["translate", "翻译", "copy"],
  ["calendar", "日历", "todo"],
  ["daily", "天气 · 饮水 · 专注", "weather"],
  ["about", "关于与更新", "refresh"],
] as const;
type Sec = (typeof SECTIONS)[number][0];

const ALL_COMPACT = Object.keys(COMPACT_LABELS) as CompactItem[];

const PRESETS: Record<string, Partial<Provider>> = {
  Claude: { name: "Claude", kind: "claude", color: "#e8916b" },
  Codex: { name: "Codex", kind: "codex", color: "#7fd6a0" },
  "Cursor（实验性）": { name: "Cursor", kind: "cursor", color: "#e9c46a" },
  "Antigravity（实验性）": { name: "Antigravity", kind: "antigravity", color: "#8ea8ff" },
  "智谱 GLM Coding Plan": { name: "GLM", kind: "glm", color: "#4f7bff" },
  "Z.ai GLM Coding Plan": { name: "Z.ai", kind: "zai", color: "#7a5cff" },
  "Kimi Code": { name: "Kimi Code", kind: "kimi_code", color: "#c0c4ff" },
  DeepSeek: { name: "DeepSeek", kind: "deepseek", color: "#4d6bfe" },
  "Kimi（Moonshot 开放平台）": { name: "Kimi", kind: "moonshot", color: "#a0a0ff" },
  OpenRouter: { name: "OpenRouter", kind: "openrouter", color: "#8e8cf7" },
  "自定义命令": { name: "Custom", kind: "command", color: "#c8a2ff", command: "echo '[{\"title\":\"本月\",\"percent\":42,\"resetAt\":\"3 天后\"}]'" },
  "自定义 HTTP": { name: "HTTP", kind: "http", color: "#5ac8fa", url: "https://", headers: {} },
};

/* ---------------- small controls ---------------- */

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <div className="row"><div className="row-l"><div>{label}</div>{hint && <small>{hint}</small>}</div><div className="row-r">{children}</div></div>;
}
function Toggle({ on, set }: { on: boolean; set: (v: boolean) => void }) {
  return <button className={`toggle ${on ? "on" : ""}`} onClick={() => set(!on)} role="switch" aria-checked={on}><i /></button>;
}
function Seg<T extends string>({ value, options, set }: { value: T; options: [T, string][]; set: (v: T) => void }) {
  return <div className="seg">{options.map(([v, l]) => <button key={v} className={v === value ? "on" : ""} onClick={() => set(v)}>{l}</button>)}</div>;
}

/** Pointer-based sortable list (HTML5 DnD is unreliable in WebView2). */
function Sortable<T>({ items, keyOf, render, onChange }: { items: T[]; keyOf: (t: T) => string; render: (t: T) => ReactNode; onChange: (t: T[]) => void }) {
  const ref = useRef<HTMLUListElement>(null);
  const down = (e: React.PointerEvent, key: string) => {
    e.preventDefault();
    const list = ref.current!;
    const li = list.querySelector<HTMLElement>(`[data-k="${CSS.escape(key)}"]`)!;
    li.classList.add("dragging");
    const move = (ev: PointerEvent) => {
      const sib = [...list.querySelectorAll<HTMLElement>("li:not(.dragging)")];
      const after = sib.find((s) => { const r = s.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2; });
      if (after) list.insertBefore(li, after); else list.appendChild(li);
    };
    const up = () => {
      li.classList.remove("dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const order = [...list.querySelectorAll<HTMLElement>("li")].map((x) => x.dataset.k!);
      onChange(order.map((k) => items.find((t) => keyOf(t) === k)!));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <ul className="sort" ref={ref}>
      {items.map((t) => <li key={keyOf(t)} data-k={keyOf(t)}><span className="grip" onPointerDown={(e) => down(e, keyOf(t))}>⋮⋮</span>{render(t)}</li>)}
    </ul>
  );
}

/* ---------------- app ---------------- */

function App({ initial }: { initial: Config }) {
  const [cfg, setCfgState] = useState(initial);
  const [sec, setSec] = useState<Sec>("general");
  const [problems, setProblems] = useState<string[]>([]);
  useEffect(() => { const un = listen<string[]>("runtime-problems", (e) => setProblems(e.payload)); return () => { un.then((f) => f()); }; }, []);
  useEffect(() => { applySkin(cfg); }, [cfg]);
  useEffect(() => { const un = listen<Config>("config-changed", (e) => { setLang(e.payload.lang); setCfgState(e.payload); }); return () => { un.then((f) => f()); }; }, []);
  const set = (patch: Partial<Config>) => { const n = { ...cfg, ...patch }; if (patch.lang) setLang(patch.lang); setCfgState(n); api.saveConfig(n); };

  const body = (() => {
    switch (sec) {
      case "general": return <>
        <h2>常规</h2>
        <Row label="语言 · Language" hint="界面语言，跟随系统时按系统语言自动选择"><Seg value={cfg.lang ?? "auto"} options={[["auto", "跟随系统"], ["zh", "中文"], ["en", "English"]]} set={(v) => set({ lang: v })} /></Row>
        <Row label="展开方式"><Seg value={cfg.expandMode} options={[["hover", "悬停展开"], ["click", "点击展开"]]} set={(v) => set({ expandMode: v })} /></Row>
        <Row label="悬停延迟" hint="鼠标停留多久后展开"><input type="range" min={0} max={800} step={20} value={cfg.hoverDelay} onChange={(e) => set({ hoverDelay: +e.target.value })} /><span className="num">{cfg.hoverDelay} ms</span></Row>
        <Row label="全屏时自动隐藏" hint="游戏、视频全屏时不打扰（macOS 全屏应用自动隐藏）"><Toggle on={cfg.hideOnFullscreen} set={(v) => set({ hideOnFullscreen: v })} /></Row>
        <Row label="24 小时制"><Toggle on={cfg.clock24} set={(v) => set({ clock24: v })} /></Row>
        <Row label="锁定位置" hint="锁定后不能拖动小岛"><Toggle on={cfg.lockPosition} set={(v) => set({ lockPosition: v })} /></Row>
        <Row label="显示在" hint="也可以直接把小岛拖到另一块屏幕上"><MonitorSelect value={cfg.monitor} set={(monitor) => set({ monitor, position: { x: 0, y: 0 } })} /></Row>
        <Row label="小岛位置" hint="拖动收起的小岛或展开面板顶栏即可移动；拖回顶边自动吸附"><button className="btn" onClick={() => set({ position: { x: 0, y: 0 } })}>回到顶部居中</button></Row>
        <Row label="记录剪贴板" hint="保存在本机，最多 60 条（置顶的不计）"><Toggle on={cfg.clipboard} set={(v) => set({ clipboard: v })} /></Row>
        <Row label="记录剪贴板图片" hint="截图、复制的图片也会记录"><Toggle on={cfg.clipboardImages} set={(v) => set({ clipboardImages: v })} /></Row>
        <Row label="开机自动启动"><Toggle on={cfg.autostart} set={(v) => set({ autostart: v })} /></Row>
        <Row label="闲置后贴边隐藏" hint="收起后一段时间没有操作，缩成一条细线；鼠标移上去恢复"><Seg value={String(cfg.idleHide)} options={[["0", "关闭"], ["10", "10 秒"], ["30", "30 秒"], ["60", "1 分钟"], ["300", "5 分钟"]]} set={(v) => set({ idleHide: +v })} /></Row>
        <Row label="游戏模式（鼠标穿透）" hint="收起时鼠标点击会穿过小岛、悬停不展开，只能用快捷键打开"><Toggle on={cfg.clickThrough} set={(v) => set({ clickThrough: v })} /></Row>
        <h2 style={{ marginTop: 24 }}>系统状态提示</h2>
        <p className="hint">状态变化时在收起的小岛上短暂显示。</p>
        {([["volume", "音量调节"], ["caps", "大写锁定"], ["input", "输入法切换"], ["network", "网络断开 / 恢复"], ["power", "充电插拔与低电量"], ["devices", "无线设备电量低"]] as const).map(([k, l]) => (
          <Row key={k} label={l}><Toggle on={cfg.statusAlerts[k]} set={(v) => set({ statusAlerts: { ...cfg.statusAlerts, [k]: v } })} /></Row>
        ))}
        <Row label="网络代理" hint="留空 = 自动（环境变量或系统代理）；填 direct 表示不用代理；例如 http://127.0.0.1:7890"><ProxyInput value={cfg.proxy} set={(v) => set({ proxy: v })} /></Row>
        <h2 style={{ marginTop: 24 }}>快捷键</h2>
        <p className="hint">点击输入框后直接按下组合键；按 Backspace 清除。</p>
        {problems.length > 0 && <div className="problems">{problems.map((p) => <div key={p}>{p}</div>)}</div>}
        {([["toggle", "展开 / 收起小岛"], ["clipboard", "打开剪贴板"], ["translate", "翻译剪贴板内容"], ["todo", "打开待办"]] as const).map(([k, label]) => (
          <Row key={k} label={label}><ShortcutInput value={cfg.shortcuts[k]} set={(v) => set({ shortcuts: { ...cfg.shortcuts, [k]: v } })} /></Row>
        ))}
      </>;
      case "look": return <>
        <h2>外观与皮肤</h2>
        <div className="skins">
          {Object.entries(SKINS).map(([k, s]) => (
            <button key={k} className={`skin ${cfg.skin === k ? "on" : ""}`} onClick={() => set({ skin: k })}>
              <span className="skin-prev" style={{ background: s.colors.bg, color: s.colors.fg, borderColor: s.colors.border }}>
                <i style={{ background: s.colors.accent }} /> 09:41 <b style={{ color: s.colors.accent }}>●●</b>
              </span>
              <b>{s.name}</b><small>{s.desc}</small>
            </button>
          ))}
          <button className={`skin ${cfg.skin === "custom" ? "on" : ""}`} onClick={() => set({ skin: "custom" })}>
            <span className="skin-prev" style={{ background: cfg.customTheme.bg, color: cfg.customTheme.fg, borderColor: cfg.customTheme.border }}><i style={{ background: cfg.customTheme.accent }} /> 09:41</span>
            <b>自定义</b><small>自己调配颜色</small>
          </button>
        </div>
        {cfg.skin === "custom" && <div className="colors">
          {(["bg", "fg", "muted", "accent", "card", "border"] as (keyof ThemeColors)[]).map((k) => (
            <label key={k}>{({ bg: "背景", fg: "文字", muted: "次要文字", accent: "强调色", card: "卡片", border: "分隔线" })[k]}
              <input type="color" value={cfg.customTheme[k]} onChange={(e) => set({ customTheme: { ...cfg.customTheme, [k]: e.target.value } })} /></label>
          ))}
        </div>}
        <Row label="形态" hint="刘海贴住屏幕边缘；胶囊悬浮；指示条平时只是一条细线，悬停展开。拖到屏幕底边或左右边缘可改为贴底 / 侧边"><Seg value={cfg.shape} options={[["notch", "刘海"], ["capsule", "胶囊"], ["line", "指示条"]]} set={(v) => set({ shape: v })} /></Row>
        <Row label="大小"><input type="range" min={0.8} max={1.4} step={0.05} value={cfg.scale} onChange={(e) => set({ scale: +e.target.value })} /><span className="num">{Math.round(cfg.scale * 100)}%</span></Row>
        <Row label="背景不透明度"><input type="range" min={0.5} max={1} step={0.05} value={cfg.opacity} onChange={(e) => set({ opacity: +e.target.value })} /><span className="num">{Math.round(cfg.opacity * 100)}%</span></Row>
      </>;
      case "compact": {
        const items = [...cfg.compact.items, ...ALL_COMPACT.filter((i) => !cfg.compact.items.includes(i))];
        const c = cfg.compact;
        return <>
          <h2>收起内容</h2>
          <p className="hint">拖动 ⋮⋮ 调整顺序，打开开关显示在收起的小岛上。</p>
          <Sortable items={items} keyOf={(i) => i} onChange={(order) => set({ compact: { ...c, items: order.filter((i) => c.items.includes(i)) } })}
            render={(i) => <><span className="grow">{COMPACT_LABELS[i]}</span><Toggle on={c.items.includes(i)} set={(v) => set({ compact: { ...c, items: v ? items.filter((x) => x === i || c.items.includes(x)) : c.items.filter((x) => x !== i) } })} /></>} />
          <Row label="自适应宽度" hint="宽度随显示内容变化"><Toggle on={c.autoWidth} set={(v) => set({ compact: { ...c, autoWidth: v } })} /></Row>
          {!c.autoWidth && <Row label="固定宽度"><input type="range" min={160} max={900} step={10} value={c.width} onChange={(e) => set({ compact: { ...c, width: +e.target.value } })} /><span className="num">{c.width}px</span></Row>}
          <Row label="额度环" hint="单环显示用得最多的一项；多环最多显示三项"><Seg value={c.ringMode} options={[["single", "单环"], ["multi", "多环"]]} set={(v) => set({ compact: { ...c, ringMode: v } })} /></Row>
          <Row label="显示剩余额度" hint="环和进度条显示剩余而不是已用"><Toggle on={c.showRemaining} set={(v) => set({ compact: { ...c, showRemaining: v } })} /></Row>
          <Row label="额度提醒" hint="用到 70% / 90% 时在小岛上提示 5 秒"><Toggle on={c.alerts} set={(v) => set({ compact: { ...c, alerts: v } })} /></Row>
        </>;
      }
      case "pages": return <>
        <h2>展开页面</h2>
        <p className="hint">拖动调整顺序。展开后用左右箭头、滚轮或 ← → 键切换页面。</p>
        <Sortable items={cfg.pages} keyOf={(p) => p.id} onChange={(pages) => set({ pages })}
          render={(p) => <><span className="grow">{PAGE_META[p.id].label}</span><Toggle on={p.enabled} set={(v) => set({ pages: cfg.pages.map((x) => (x.id === p.id ? { ...x, enabled: v } : x)) })} /></>} />
        <Row label="面板尺寸" hint="也可以在展开面板上拖动左右和底部边缘调整">
          <input type="number" min={420} max={1200} value={cfg.panel.width} onChange={(e) => set({ panel: { ...cfg.panel, width: +e.target.value } })} /> ×
          <input type="number" min={180} max={640} value={cfg.panel.height} onChange={(e) => set({ panel: { ...cfg.panel, height: +e.target.value } })} />
        </Row>
      </>;
      case "ai": return <AiSection cfg={cfg} set={set} />;
      case "monitor": return <>
        <h2>系统监控</h2>
        <p className="hint">拖动调整监控页的读数顺序，并设置每项的颜色。</p>
        <Sortable items={cfg.metrics} keyOf={(m) => m.id} onChange={(metrics) => set({ metrics })}
          render={(m) => <><span className="grow">{METRIC_LABELS[m.id]}</span><input type="color" value={m.color} onChange={(e) => set({ metrics: cfg.metrics.map((x) => (x.id === m.id ? { ...x, color: e.target.value } : x)) })} /></>} />
      </>;
      case "translate": return <TranslateSection cfg={cfg} set={set} />;
      case "calendar": return <CalendarSection cfg={cfg} set={set} />;
      case "about": return <AboutSection cfg={cfg} set={set} />;
      case "daily": return <>
        <h2>天气</h2>
        <Row label="天气城市" hint="留空则按网络自动定位（Open-Meteo，免费、无需密钥）"><CityInput value={cfg.weatherCity} set={(v) => set({ weatherCity: v })} /></Row>
        <Row label="专注时长"><input type="number" min={1} max={180} value={cfg.focus.work} onChange={(e) => set({ focus: { ...cfg.focus, work: +e.target.value || 25 } })} /><span className="num">分钟</span></Row>
        <h2 style={{ marginTop: 24 }}>饮水提醒</h2>
        <Row label="开启饮水提醒" hint="在设定时段内，距离上次喝水超过间隔就在小岛上提醒"><Toggle on={cfg.water.enabled} set={(v) => set({ water: { ...cfg.water, enabled: v } })} /></Row>
        <Row label="每日目标"><input type="number" min={500} max={6000} step={100} value={cfg.water.goal} onChange={(e) => set({ water: { ...cfg.water, goal: +e.target.value || 2000 } })} /><span className="num">ml</span></Row>
        <Row label="每次饮水量"><input type="number" min={50} max={1000} step={50} value={cfg.water.cup} onChange={(e) => set({ water: { ...cfg.water, cup: +e.target.value || 250 } })} /><span className="num">ml</span></Row>
        <Row label="提醒间隔"><input type="number" min={15} max={240} step={5} value={cfg.water.interval} onChange={(e) => set({ water: { ...cfg.water, interval: +e.target.value || 60 } })} /><span className="num">分钟</span></Row>
        <Row label="提醒时段"><input type="time" value={cfg.water.start} onChange={(e) => set({ water: { ...cfg.water, start: e.target.value } })} />–<input type="time" value={cfg.water.end} onChange={(e) => set({ water: { ...cfg.water, end: e.target.value } })} /></Row>
        <h2 style={{ marginTop: 24 }}>番茄专注</h2>
        <Row label="休息时长"><input type="number" min={1} max={60} value={cfg.focus.rest} onChange={(e) => set({ focus: { ...cfg.focus, rest: +e.target.value || 5 } })} /><span className="num">分钟</span></Row>
      </>;
    }
  })();

  return (
    <div className="app">
      <nav>
        <div className="logo">NotchDeck</div>
        {SECTIONS.map(([id, label, icon]) => <button key={id} className={sec === id ? "on" : ""} onClick={() => setSec(id)}><Icon name={icon} size={15} />{label}</button>)}
      </nav>
      <main>{body}</main>
    </div>
  );
}

const TR_PRESETS: Record<string, { name: string; baseUrl: string; model: string }> = {
  deepseek: { name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  kimi: { name: "Kimi（Moonshot）", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
  qwen: { name: "通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-turbo" },
  siliconflow: { name: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen2.5-7B-Instruct" },
  ark: { name: "火山方舟", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", model: "" },
  openai: { name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  custom: { name: "自定义（OpenAI 兼容）", baseUrl: "", model: "" },
};

function TranslateSection({ cfg, set }: { cfg: Config; set: (p: Partial<Config>) => void }) {
  const t = cfg.translate;
  const upd = (p: Partial<Config["translate"]>) => set({ translate: { ...t, ...p } });
  return <>
    <h2>翻译</h2>
    <p className="hint">使用任意 OpenAI 兼容的对话接口翻译。提交翻译时，原文会发送到所选服务。快捷键（默认 ⌘/Ctrl+Shift+T）会直接翻译剪贴板里最新的文字。</p>
    <Row label="服务"><select value={t.provider} onChange={(e) => { const p = TR_PRESETS[e.target.value]; upd({ provider: e.target.value, baseUrl: p.baseUrl || t.baseUrl, model: p.model || (e.target.value === "custom" || e.target.value === "ark" ? "" : t.model) }); }}>
      {Object.entries(TR_PRESETS).map(([k, p]) => <option key={k} value={k}>{p.name}</option>)}
    </select></Row>
    <Row label="接口地址" hint="以 /v1 结尾的 OpenAI 兼容地址"><TextField value={t.baseUrl} set={(v) => upd({ baseUrl: v })} width={320} /></Row>
    <Row label="模型" hint={t.provider === "ark" ? "火山方舟填写推理接入点 ID（ep- 开头）" : "例如 deepseek-chat"}><TextField value={t.model} set={(v) => upd({ model: v })} width={320} /></Row>
    <div className="row"><div className="row-l"><div>API Key</div><small>保存在系统钥匙串 / 凭据管理器</small></div><div className="row-r" style={{ flex: 1, maxWidth: 420 }}><KeyInput id="translate" /></div></div>
  </>;
}

const CAL_HINTS: Record<string, string> = {
  ics: "订阅链接（https:// 或 webcal://）。iCloud：日历 App 中共享日历 › 公开日历；Google：日历设置 › 私密 iCal 地址；飞书 / 钉钉 / 企业微信 / Outlook：日历设置中的「订阅 / 导出链接」",
  caldav: "CalDAV 地址，会自动发现账户下的所有日历。iCloud 填 https://caldav.icloud.com 并使用 App 专用密码（appleid.apple.com 生成）；飞书、钉钉等填写其提供的 CalDAV 服务器与账号",
};

function CalendarSection({ cfg, set }: { cfg: Config; set: (p: Partial<Config>) => void }) {
  const [msg, setMsg] = useState("");
  const upd = (id: string, p: Partial<CalSource>) => set({ calendars: cfg.calendars.map((c) => (c.id === id ? { ...c, ...p } : c)) });
  const add = (kind: "ics" | "caldav") => set({ calendars: [...cfg.calendars, { id: Math.random().toString(36).slice(2, 8), name: kind === "ics" ? "订阅日历" : "CalDAV", kind, url: kind === "caldav" ? "https://caldav.icloud.com" : "", user: "", color: ["#0a84ff", "#ff9f0a", "#bf5af2", "#30d158", "#ff375f"][cfg.calendars.length % 5], enabled: true }] });
  const importIcs = async (file: File) => {
    const text = await file.text();
    const evs = await invoke<CalEvent[]>("calendar_import", { text });
    const cur = (await api.storeGet<CalEvent[]>("events")) ?? [];
    const ids = new Set(cur.map((e) => e.id));
    const merged = [...cur, ...evs.filter((e) => !ids.has(e.id))];
    await api.storeSet("events", merged);
    await emit("local-events-changed");
    setMsg(`已导入 ${evs.length} 个日程`);
  };
  return <>
    <h2>日历</h2>
    <p className="hint">远程日历只读同步，每 10 分钟刷新；相同时间、相同标题的日程会合并。也可以在小岛的日程页直接新增本机日程。</p>
    <Sortable items={cfg.calendars} keyOf={(c) => c.id} onChange={(calendars) => set({ calendars })}
      render={(c) => (
        <div className="prov">
          <div className="prov-head">
            <Toggle on={c.enabled} set={(v) => upd(c.id, { enabled: v })} />
            <input type="color" value={c.color} onChange={(e) => upd(c.id, { color: e.target.value })} />
            <input className="pname" value={c.name} onChange={(e) => upd(c.id, { name: e.target.value })} />
            <span className="kind">{c.kind === "ics" ? "订阅" : "CalDAV"}</span>
            <button className="icon-btn danger" onClick={() => set({ calendars: cfg.calendars.filter((x) => x.id !== c.id) })} title="删除"><Icon name="trash" size={14} /></button>
          </div>
          <label className="f">{c.kind === "ics" ? "订阅链接" : "服务器地址"}<TextField value={c.url} set={(v) => upd(c.id, { url: v })} width={520} /></label>
          <small className="hint">{CAL_HINTS[c.kind]}</small>
          {c.kind === "caldav" && <div className="f2">
            <label className="f">账号<TextField value={c.user ?? ""} set={(v) => upd(c.id, { user: v })} /></label>
            <div className="f" style={{ flex: 2 }}><KeyInput id={`cal-${c.id}`} label="密码 / App 专用密码" /></div>
          </div>}
        </div>
      )} />
    <div className="add">
      <button className="btn primary" onClick={() => add("ics")}>添加订阅链接</button>
      <button className="btn" onClick={() => add("caldav")}>添加 CalDAV 账户</button>
      <label className="btn" style={{ cursor: "pointer" }}>导入 .ics 文件<input type="file" accept=".ics,text/calendar" hidden onChange={(e) => e.target.files?.[0] && importIcs(e.target.files[0])} /></label>
    </div>
    {msg && <p className="hint" style={{ marginTop: 8 }}>{msg}</p>}
    <Row label="日程提醒" hint="有时间的日程开始前在小岛上提醒"><Seg value={String(cfg.eventReminder)} options={[["0", "关闭"], ["5", "5 分钟"], ["10", "10 分钟"], ["15", "15 分钟"], ["30", "30 分钟"]]} set={(v) => set({ eventReminder: +v })} /></Row>
  </>;
}

function AboutSection({ cfg, set }: { cfg: Config; set: (p: Partial<Config>) => void }) {
  const [version, setVersion] = useState("");
  const [state, setState] = useState<{ phase: "idle" | "checking" | "none" | "available" | "downloading" | "ready" | "error"; text?: string; pct?: number }>({ phase: "idle" });
  const upd = useRef<Update | null>(null);
  useEffect(() => { getVersion().then(setVersion); }, []);
  const doCheck = async () => {
    setState({ phase: "checking" });
    try {
      const u = await check();
      upd.current = u;
      setState(u ? { phase: "available", text: `${u.version}${u.body ? `\n${u.body}` : ""}` } : { phase: "none" });
    } catch (e) {
      setState({ phase: "error", text: String(e) });
    }
  };
  const install = async () => {
    const u = upd.current;
    if (!u) return;
    let total = 0, got = 0;
    setState({ phase: "downloading", pct: 0 });
    try {
      await u.downloadAndInstall((ev) => {
        if (ev.event === "Started") total = ev.data.contentLength ?? 0;
        if (ev.event === "Progress") { got += ev.data.chunkLength; setState({ phase: "downloading", pct: total ? Math.round((got / total) * 100) : undefined }); }
        if (ev.event === "Finished") setState({ phase: "ready" });
      });
      setState({ phase: "ready" });
    } catch (e) {
      setState({ phase: "error", text: String(e) });
    }
  };
  return <>
    <h2>关于与更新</h2>
    <Row label="当前版本"><span className="num">v{version}</span></Row>
    <Row label="自动检查更新" hint="启动时和之后每天检查一次，有新版本时在小岛上提示"><Toggle on={cfg.autoUpdate} set={(v) => set({ autoUpdate: v })} /></Row>
    <Row label="检查更新" hint={state.phase === "none" ? "已是最新版本" : state.phase === "error" ? state.text : state.phase === "checking" ? "正在检查…" : undefined}>
      {state.phase === "available" && <button className="btn primary" onClick={install}>下载并安装</button>}
      {state.phase === "downloading" && <span className="num">{`下载中 ${state.pct ?? ""}%`}</span>}
      {state.phase === "ready" && <button className="btn primary" onClick={() => relaunch()}>重启以完成更新</button>}
      {!["available", "downloading", "ready"].includes(state.phase) && <button className="btn" disabled={state.phase === "checking"} onClick={doCheck}>立即检查</button>}
    </Row>
    {state.phase === "available" && <pre className="release-notes">{`新版本 v${state.text}`}</pre>}
    <p className="hint" style={{ marginTop: 16 }}>
      <a href="https://fangkyi03.github.io/notchdeck/" target="_blank">官网</a> · <a href="https://fangkyi03.github.io/notchdeck/guide.html" target="_blank">使用说明</a> · <a href="https://github.com/fangkyi03/notchdeck" target="_blank">GitHub</a> · <a href="https://github.com/fangkyi03/notchdeck/issues" target="_blank">反馈问题</a>
    </p>
  </>;
}

function TextField({ value, set, width = 220 }: { value: string; set: (v: string) => void; width?: number }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return <input value={v} style={{ width }} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && set(v.trim())} onKeyDown={(e) => e.key === "Enter" && set(v.trim())} />;
}

function CityInput({ value, set }: { value: string; set: (v: string) => void }) {
  const [v, setV] = useState(value);
  return <><input value={v} placeholder="例如：上海 / Tokyo" onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Enter" && set(v)} /><button className="btn" onClick={() => set(v)}>保存</button><button className="btn" onClick={() => { setV(""); set(""); }}>自动定位</button></>;
}

function AiSection({ cfg, set }: { cfg: Config; set: (p: Partial<Config>) => void }) {
  const [preset, setPreset] = useState(Object.keys(PRESETS)[0]);
  const upd = (id: string, patch: Partial<Provider>) => set({ providers: cfg.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
  return <>
    <h2>AI 额度</h2>
    <p className="hint">Claude 使用本机 Claude Code 的登录读取 5 小时 / 每周额度（macOS 首次读取钥匙串时会弹窗授权），Token 与费用来自本地会话记录；Codex 读取 ~/.codex 会话记录中的额度快照。费用按公开单价估算，不代表实际账单。</p>
    <Sortable items={cfg.providers} keyOf={(p) => p.id} onChange={(providers) => set({ providers })}
      render={(p) => (
        <div className="prov">
          <div className="prov-head">
            <Toggle on={p.enabled} set={(v) => upd(p.id, { enabled: v })} />
            <input type="color" value={p.color} onChange={(e) => upd(p.id, { color: e.target.value })} />
            <input className="pname" value={p.name} onChange={(e) => upd(p.id, { name: e.target.value })} />
            <span className="kind">{p.kind}</span>
            <label className="chk-l"><input type="checkbox" checked={p.compact} onChange={(e) => upd(p.id, { compact: e.target.checked })} /> 收起时显示环</label>
            <button className="icon-btn danger" onClick={() => set({ providers: cfg.providers.filter((x) => x.id !== p.id) })} title="删除"><Icon name="trash" size={14} /></button>
          </div>
          {["deepseek", "openrouter", "moonshot", "glm", "zai", "kimi_code"].includes(p.kind) && <KeyInput id={p.id} label={p.kind === "kimi_code" ? "Kimi Code API Key（sk-kimi- 开头）" : p.kind === "glm" || p.kind === "zai" ? "Coding Plan API Key" : "API Key"} />}
          {p.kind === "cursor" && <small className="hint">读取本机 Cursor 的登录（不需要填写），显示本月额度与按量计费。实验性：接口可能随 Cursor 更新变化。</small>}
          {p.kind === "antigravity" && <small className="hint">需要 Antigravity 桌面版正在运行，从它的本地服务读取各模型额度。实验性。</small>}
          {p.kind === "command" && <label className="f">{"命令（输出 JSON 数组 [{title, percent, value, resetAt}] 或纯文本）"}<textarea rows={2} value={p.command ?? ""} onChange={(e) => upd(p.id, { command: e.target.value })} /></label>}
          {p.kind === "http" && <>
            <label className="f">URL（仅 HTTPS）<input value={p.url ?? ""} onChange={(e) => upd(p.id, { url: e.target.value })} /></label>
            <label className="f">请求头 JSON<HeadersInput value={p.headers ?? {}} set={(h) => upd(p.id, { headers: h })} /></label>
            <div className="f2">
              <label className="f">名称<input value={p.quotaTitle ?? ""} onChange={(e) => upd(p.id, { quotaTitle: e.target.value })} /></label>
              <label className="f">百分比字段<input value={p.percentPath ?? ""} placeholder="data.percent" onChange={(e) => upd(p.id, { percentPath: e.target.value })} /></label>
              <label className="f">数值字段<input value={p.labelPath ?? ""} placeholder="data.balance" onChange={(e) => upd(p.id, { labelPath: e.target.value })} /></label>
            </div>
          </>}
        </div>
      )} />
    <div className="add">
      <select value={preset} onChange={(e) => setPreset(e.target.value)}>{Object.keys(PRESETS).map((k) => <option key={k}>{k}</option>)}</select>
      <button className="btn primary" onClick={() => set({ providers: [...cfg.providers, { id: Math.random().toString(36).slice(2, 8), name: "AI", kind: "command", enabled: true, color: "#888", compact: true, ...structuredClone(PRESETS[preset]) } as Provider] })}>添加</button>
    </div>
  </>;
}

const IS_MAC = navigator.userAgent.includes("Mac");

/** Records a key combo as a Tauri accelerator string, e.g. "CommandOrControl+Shift+Space". */
function ShortcutInput({ value, set }: { value: string; set: (v: string) => void }) {
  const pretty = (v: string) => v.replace("CommandOrControl", IS_MAC ? "⌘" : "Ctrl").replace("Shift", IS_MAC ? "⇧" : "Shift").replace("Alt", IS_MAC ? "⌥" : "Alt").replace("Control", IS_MAC ? "⌃" : "Ctrl").replaceAll("+", IS_MAC ? "" : " + ");
  const onKey = (e: React.KeyboardEvent) => {
    e.preventDefault();
    if (e.key === "Backspace" || e.key === "Delete") return set("");
    if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
    const mods = [(IS_MAC ? e.metaKey : e.ctrlKey) && "CommandOrControl", IS_MAC && e.ctrlKey && "Control", e.altKey && "Alt", e.shiftKey && "Shift"].filter(Boolean);
    if (!mods.length) return; // require a modifier
    const code = e.code.startsWith("Key") ? e.code.slice(3) : e.code.startsWith("Digit") ? e.code.slice(5) : e.code;
    set([...mods, code].join("+"));
  };
  return <input className="shortcut" readOnly value={value ? pretty(value) : ""} placeholder="未设置" onKeyDown={onKey} />;
}

function ProxyInput({ value, set }: { value: string; set: (v: string) => void }) {
  const [v, setV] = useState(value);
  return <><input value={v} placeholder="自动" onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && set(v.trim())} onKeyDown={(e) => e.key === "Enter" && set(v.trim())} style={{ width: 220 }} /></>;
}

function MonitorSelect({ value, set }: { value: string; set: (v: string) => void }) {
  const [list, setList] = useState<MonitorInfo[]>([]);
  useEffect(() => { api.monitors().then(setList); }, []);
  return (
    <select value={list.some((m) => m.key === value) ? value : ""} onChange={(e) => set(e.target.value)}>
      <option value="">主显示器</option>
      {list.map((m, i) => <option key={m.key} value={m.key}>{`显示器 ${i + 1} · ${m.name} (${m.width}×${m.height})${m.primary ? " · 主" : ""}`}</option>)}
    </select>
  );
}

/** API key goes straight to the system keychain; the field never shows the stored value. */
function KeyInput({ id, label = "API Key" }: { id: string; label?: string }) {
  const [has, setHas] = useState(false);
  const [v, setV] = useState("");
  const [msg, setMsg] = useState("");
  useEffect(() => { api.secretHas(id).then(setHas); }, [id]);
  const save = async (value: string) => {
    try { await api.secretSet(id, value); setHas(!!value); setV(""); setMsg(value ? "已保存到系统钥匙串" : "已删除"); }
    catch (e) { setMsg(String(e)); }
  };
  return (
    <label className="f">{label}{has && <span className="ok"> · 已保存</span>}
      <span className="key-row">
        <input type="password" value={v} placeholder={has ? "••••••••（输入新值可替换）" : "sk-..."} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Enter" && v && save(v)} />
        <button className="btn" disabled={!v} onClick={() => save(v)}>保存</button>
        {has && <button className="btn" onClick={() => save("")}>删除</button>}
      </span>
      {msg && <small>{msg}</small>}
    </label>
  );
}

function HeadersInput({ value, set }: { value: Record<string, string>; set: (v: Record<string, string>) => void }) {
  const [t, setT] = useState(JSON.stringify(value));
  const [bad, setBad] = useState(false);
  return <textarea rows={2} className={bad ? "bad" : ""} value={t} onChange={(e) => { setT(e.target.value); try { set(JSON.parse(e.target.value || "{}")); setBad(false); } catch { setBad(true); } }} />;
}

api.getConfig().then((cfg) => { setLang(cfg.lang); return cfg; }).then((cfg) => createRoot(document.getElementById("root")!).render(<App initial={cfg} />));
