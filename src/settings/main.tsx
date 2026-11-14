import { useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import { api } from "../lib/api";
import { Icon } from "../lib/icons";
import { applySkin, SKINS } from "../lib/themes";
import { COMPACT_LABELS, METRIC_LABELS, PAGE_META, type CompactItem, type Config, type MonitorInfo, type Provider, type ThemeColors } from "../lib/types";
import "./settings.css";

const SECTIONS = [
  ["general", "常规", "settings"],
  ["look", "外观与皮肤", "star"],
  ["compact", "收起内容", "todo"],
  ["pages", "展开页面", "clipboard"],
  ["ai", "AI 额度", "ai"],
  ["monitor", "系统监控", "monitor"],
  ["daily", "天气与专注", "weather"],
] as const;
type Sec = (typeof SECTIONS)[number][0];

const ALL_COMPACT = Object.keys(COMPACT_LABELS) as CompactItem[];

const PRESETS: Record<string, Partial<Provider>> = {
  Claude: { name: "Claude", kind: "claude", color: "#e8916b" },
  Codex: { name: "Codex", kind: "codex", color: "#7fd6a0" },
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
  useEffect(() => { const un = listen<Config>("config-changed", (e) => setCfgState(e.payload)); return () => { un.then((f) => f()); }; }, []);
  const set = (patch: Partial<Config>) => { const n = { ...cfg, ...patch }; setCfgState(n); api.saveConfig(n); };

  const body = (() => {
    switch (sec) {
      case "general": return <>
        <h2>常规</h2>
        <Row label="展开方式"><Seg value={cfg.expandMode} options={[["hover", "悬停展开"], ["click", "点击展开"]]} set={(v) => set({ expandMode: v })} /></Row>
        <Row label="悬停延迟" hint="鼠标停留多久后展开"><input type="range" min={0} max={800} step={20} value={cfg.hoverDelay} onChange={(e) => set({ hoverDelay: +e.target.value })} /><span className="num">{cfg.hoverDelay} ms</span></Row>
        <Row label="全屏时自动隐藏" hint="游戏、视频全屏时不打扰（macOS 全屏应用自动隐藏）"><Toggle on={cfg.hideOnFullscreen} set={(v) => set({ hideOnFullscreen: v })} /></Row>
        <Row label="24 小时制"><Toggle on={cfg.clock24} set={(v) => set({ clock24: v })} /></Row>
        <Row label="锁定位置" hint="锁定后不能拖动小岛"><Toggle on={cfg.lockPosition} set={(v) => set({ lockPosition: v })} /></Row>
        <Row label="显示在" hint="也可以直接把小岛拖到另一块屏幕上"><MonitorSelect value={cfg.monitor} set={(monitor) => set({ monitor, position: { x: 0, y: 0 } })} /></Row>
        <Row label="小岛位置" hint="拖动收起的小岛或展开面板顶栏即可移动；拖回顶边自动吸附"><button className="btn" onClick={() => set({ position: { x: 0, y: 0 } })}>回到顶部居中</button></Row>
        <Row label="记录剪贴板" hint="只记录文字，保存在本机"><Toggle on={cfg.clipboard} set={(v) => set({ clipboard: v })} /></Row>
        <Row label="开机自动启动"><Toggle on={cfg.autostart} set={(v) => set({ autostart: v })} /></Row>
        <Row label="闲置后贴边隐藏" hint="收起后一段时间没有操作，缩成一条细线；鼠标移上去恢复"><Seg value={String(cfg.idleHide)} options={[["0", "关闭"], ["10", "10 秒"], ["30", "30 秒"], ["60", "1 分钟"], ["300", "5 分钟"]]} set={(v) => set({ idleHide: +v })} /></Row>
        <Row label="游戏模式（鼠标穿透）" hint="收起时鼠标点击会穿过小岛、悬停不展开，只能用快捷键打开"><Toggle on={cfg.clickThrough} set={(v) => set({ clickThrough: v })} /></Row>
        <Row label="网络代理" hint="留空 = 自动（环境变量或系统代理）；填 direct 表示不用代理；例如 http://127.0.0.1:7890"><ProxyInput value={cfg.proxy} set={(v) => set({ proxy: v })} /></Row>
        <h2 style={{ marginTop: 24 }}>快捷键</h2>
        <p className="hint">点击输入框后直接按下组合键；按 Backspace 清除。</p>
        {problems.length > 0 && <div className="problems">{problems.map((p) => <div key={p}>{p}</div>)}</div>}
        {([["toggle", "展开 / 收起小岛"], ["clipboard", "打开剪贴板"], ["todo", "打开待办"]] as const).map(([k, label]) => (
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
        <Row label="形态" hint="刘海贴住屏幕顶边；胶囊悬浮在顶部下方"><Seg value={cfg.shape} options={[["notch", "刘海"], ["capsule", "胶囊"]]} set={(v) => set({ shape: v })} /></Row>
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
      case "daily": return <>
        <h2>天气与专注</h2>
        <Row label="天气城市" hint="留空则按网络自动定位（Open-Meteo，免费、无需密钥）"><CityInput value={cfg.weatherCity} set={(v) => set({ weatherCity: v })} /></Row>
        <Row label="专注时长"><input type="number" min={1} max={180} value={cfg.focus.work} onChange={(e) => set({ focus: { ...cfg.focus, work: +e.target.value || 25 } })} /><span className="num">分钟</span></Row>
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
          {(p.kind === "deepseek" || p.kind === "openrouter" || p.kind === "moonshot") && <KeyInput id={p.id} />}
          {p.kind === "command" && <label className="f">命令（输出 JSON 数组 [{"{"}title, percent, value, resetAt{"}"}] 或纯文本）<textarea rows={2} value={p.command ?? ""} onChange={(e) => upd(p.id, { command: e.target.value })} /></label>}
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
function KeyInput({ id }: { id: string }) {
  const [has, setHas] = useState(false);
  const [v, setV] = useState("");
  const [msg, setMsg] = useState("");
  useEffect(() => { api.secretHas(id).then(setHas); }, [id]);
  const save = async (value: string) => {
    try { await api.secretSet(id, value); setHas(!!value); setV(""); setMsg(value ? "已保存到系统钥匙串" : "已删除"); }
    catch (e) { setMsg(String(e)); }
  };
  return (
    <label className="f">API Key{has && <span className="ok"> · 已保存</span>}
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

api.getConfig().then((cfg) => createRoot(document.getElementById("root")!).render(<App initial={cfg} />));
