import { forwardRef, type ReactNode } from "react";
import { fmtBytes, fmtClock, weatherInfo } from "../lib/format";
import { todayKey } from "../lib/format";
import { HAS_MESSAGES, type Column, type CompactItem, type Config } from "../lib/types";
import { useData } from "./data";
import { CoreBars, Cover, Dial, Eq, Rings } from "./widgets";
import { AppBadge } from "./pages/Messages";
import { batteryColor } from "./pages/Devices";

/** Values shown in a provider's ring(s): highest-used quota, or up to 3 in multi mode. */
export function ringValues(c: Column, cfg: Config): (number | null)[] {
  const pcts = c.quotas.map((q) => q.percent).filter((p): p is number => p != null);
  const flip = (p: number | null) => (p == null ? null : cfg.compact.showRemaining ? 100 - p : p);
  if (cfg.compact.ringMode === "multi") return (c.quotas.length ? c.quotas.slice(0, 3).map((q) => flip(q.percent)) : [null]);
  return [flip(pcts.length ? Math.max(...pcts) : null)];
}

function metricColor(cfg: Config, id: string) {
  return cfg.metrics.find((m) => m.id === id)?.color ?? "var(--accent)";
}

/** The collapsed island content. Rendered as one row; width is measured by the shell. */
export const Compact = forwardRef<HTMLDivElement, { vertical?: boolean }>(function Compact({ vertical }, ref) {
  const d = useData();
  const { cfg, sys, media, lyrics, lyricIndex, cols, now, focus, todos, weather, alert, hud } = d;

  if (hud && !vertical) {
    return (
      <div className="compact" ref={ref}>
        <span className="c-hud"><span className="hud-ic">{hud.icon}</span>{hud.text}
          {hud.kind === "volume" && hud.value != null && <span className="hud-bar"><i style={{ width: `${hud.value}%` }} /></span>}
        </span>
      </div>
    );
  }
  if (alert) {
    return <div className={`compact ${vertical ? "vertical" : ""}`} ref={ref}><span className="c-alert">{vertical ? "!" : alert}</span></div>;
  }

  const item = (id: CompactItem): ReactNode => {
    switch (id) {
      case "devices":
        return d.devices.length ? <span className="c-rings">{d.devices.slice(0, 4).map((x) => (
          <span key={x.name} title={`${x.name} ${x.percent}%`}><Rings values={[x.percent]} color={batteryColor(x.percent)} size={18} stroke={2.6} /></span>
        ))}</span> : null;
      case "event": {
        const t = now.getTime() / 1000;
        const e = d.events.find((x) => !x.all_day && x.end > t && x.start - t < 12 * 3600);
        if (!e) return null;
        const mins = Math.round((e.start - t) / 60);
        return <span className="c-event"><i style={{ background: e.color || "var(--accent)" }} />{mins > 0 ? `${mins < 60 ? `${mins}分` : `${Math.floor(mins / 60)}时`}后` : "进行中"} <span data-notr>{e.title}</span></span>;
      }
      case "water":
        return cfg.water.enabled ? <span className="c-water">💧{Math.round((d.water.ml / Math.max(1, cfg.water.goal)) * 100)}%</span> : null;
      case "shelf":
        return d.shelf.length ? <span className="c-shelf">📎 {d.shelf.length}</span> : null;
      case "msg": {
        if (!HAS_MESSAGES) return null;
        const apps = d.messages.apps;
        if (!apps.length) return null;
        return <span className="c-msg">{apps.slice(0, 3).map((a) => (
          <span key={a.id} className="c-msg-i"><AppBadge id={a.id} size={18} /><i className="dot-red">{a.count ?? ""}</i></span>
        ))}</span>;
      }
      case "music":
        return media?.title ? <Cover src={media.artwork} size={20} /> : null;
      case "rings": {
        const shown = cfg.providers.filter((p) => p.enabled && p.compact).map((p) => cols.find((c) => c.id === p.id)).filter((c): c is Column => !!c && c.quotas.some((q) => q.percent != null));
        if (!shown.length) return null;
        return <span className="c-rings">{shown.map((c) => {
          const p = cfg.providers.find((x) => x.id === c.id)!;
          return <span key={c.id} title={`${c.name}`}><Rings values={ringValues(c, cfg)} color={p.color} size={18} stroke={cfg.compact.ringMode === "multi" ? 2 : 2.6} /></span>;
        })}</span>;
      }
      case "cores":
        return sys ? <CoreBars cores={sys.cores} color={metricColor(cfg, "cpu")} height={16} width={2.5} gap={1.2} /> : null;
      case "cpu":
        return sys ? <span className="c-dial"><Dial value={sys.cpu} color={metricColor(cfg, "cpu")} letter="C" /><span className="num3">{Math.round(sys.cpu)}%</span></span> : null;
      case "mem":
        return sys ? <span className="c-dial"><Dial value={(sys.mem_used / sys.mem_total) * 100} color={metricColor(cfg, "mem")} letter="M" /><span className="num3">{Math.round((sys.mem_used / sys.mem_total) * 100)}%</span></span> : null;
      case "gpu":
        return sys?.gpu != null ? <span className="c-dial"><Dial value={sys.gpu} color={metricColor(cfg, "gpu")} letter="G" /><span className="num3">{Math.round(sys.gpu)}%</span></span> : null;
      case "net":
        return sys ? <span className="c-net"><b style={{ color: metricColor(cfg, "net") }}>↓</b><span className="num5">{fmtBytes(sys.net_rx)}</span><b style={{ color: metricColor(cfg, "net") }}>↑</b><span className="num5">{fmtBytes(sys.net_tx)}</span></span> : null;
      case "lyric": {
        if (!media?.title) return null;
        const line = lyricIndex >= 0 ? lyrics[lyricIndex]?.text : "";
        return <span className="c-lyric" data-notr key={line || media.title}>{line || media.title}</span>;
      }
      case "eq":
        return media?.title ? <Eq playing={media.playing} height={13} /> : null;
      case "clock":
        return <span className="c-clock">{fmtClock(now, cfg.clock24)}</span>;
      case "weather":
        return weather ? <span className="c-weather">{weatherInfo(weather.code, weather.is_day).icon} {Math.round(weather.temp)}°</span> : null;
      case "focus": {
        if (!focus.running) return null;
        const left = Math.max(0, Math.round((focus.endsAt - now.getTime()) / 1000));
        return <span className={`c-focus ${focus.mode}`}>{focus.mode === "work" ? "🍅" : "☕"} {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</span>;
      }
      case "todo": {
        const t = todos.filter((x) => x.date === todayKey());
        return t.length ? <span className="c-todo">✓ {t.filter((x) => x.done).length}/{t.length}</span> : null;
      }
    }
  };

  // The vertical (side-docked) capsule only fits icon-like items.
  const VERTICAL_SKIP: CompactItem[] = ["lyric", "net", "weather", "todo", "focus"];
  const parts = cfg.compact.items
    .filter((id) => !vertical || !VERTICAL_SKIP.includes(id))
    .map((id) => [id, item(id)] as const)
    .filter(([, n]) => n != null);
  return (
    <div className={`compact ${vertical ? "vertical" : ""}`} ref={ref}>
      {parts.length ? parts.map(([id, n]) => <span key={id} className={`ci ci-${id}`}>{n}</span>) : <span className="c-clock">{fmtClock(now, cfg.clock24)}</span>}
    </div>
  );
});
