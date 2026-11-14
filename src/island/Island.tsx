import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../lib/api";
import { fmtClock, fmtDate } from "../lib/format";
import { Icon } from "../lib/icons";
import { applySkin } from "../lib/themes";
import { PAGE_META, type Dock, type PageId } from "../lib/types";
import { Compact } from "./Compact";
import { useData } from "./data";
import { AiPage } from "./pages/Ai";
import { MessagesPage } from "./pages/Messages";
import { DetailsPage } from "./pages/Details";
import { ClipboardPage, FocusPage, TodoPage, WeatherPage } from "./pages/Daily";
import { MonitorPage } from "./pages/Monitor";
import { MusicPage } from "./pages/Music";

const PILL_H = 32;
const SIDE_W = 34;
const SHOULDER = 10;
const CAPSULE_GAP = 8;
const COLLAPSE_MS = 280;

const PAGES: Record<PageId, () => JSX.Element | null> = {
  messages: MessagesPage, ai: AiPage, details: DetailsPage, music: MusicPage, monitor: MonitorPage, todo: TodoPage, focus: FocusPage, clipboard: ClipboardPage, weather: WeatherPage,
};

export function Island() {
  const d = useData();
  const { cfg, setCfg, now } = d;
  const [expanded, setExpanded] = useState(false);
  const [compactW, setCompactW] = useState(160);
  const [compactH, setCompactH] = useState(120);
  const [tucked, setTucked] = useState(false);
  const lastActive = useRef(Date.now());
  const [pos, setPos] = useState(cfg.position);
  const [panel, setPanel] = useState(cfg.panel);
  const [page, setPage] = useState<PageId>(() => (localStorage.getItem("page") as PageId) || "ai");
  const compactRef = useRef<HTMLDivElement>(null);
  const timers = useRef<{ open?: number; close?: number; shrink?: number }>({});
  const busy = useRef(false); // dragging / resizing
  const expandedRef = useRef(false);
  expandedRef.current = expanded;

  useEffect(() => { applySkin(cfg); }, [cfg]);
  useEffect(() => setPos(cfg.position), [cfg.position]);
  useEffect(() => setPanel(cfg.panel), [cfg.panel]);

  const pages = cfg.pages.filter((p) => p.enabled).map((p) => p.id);
  const curPage = pages.includes(page) ? page : pages[0] ?? "ai";

  /* ---------------- geometry ---------------- */
  const dock: Dock = pos.dock ?? "top";
  const side = dock !== "top";
  const floating = !side && (cfg.shape === "capsule" || pos.y > 0);
  const y = side ? pos.y : cfg.shape === "capsule" ? Math.max(pos.y, CAPSULE_GAP) : pos.y;
  const shoulder = side || floating ? 0 : SHOULDER;
  const s = cfg.scale;
  const horiz = { w: cfg.compact.autoWidth ? Math.max(120, compactW) : cfg.compact.width, h: PILL_H };
  const vert = { w: SIDE_W, h: Math.max(80, compactH) };
  // Idle-tucked: a thin line along the edge; hovering it brings the island back.
  const line = side ? { w: 6, h: Math.max(60, vert.h * 0.6) } : { w: Math.max(90, horiz.w * 0.5), h: 6 };
  const collapsed = tucked ? line : side ? vert : horiz;
  const body = expanded ? { w: panel.width, h: panel.height } : collapsed;

  const winSize = useCallback((b: { w: number; h: number }) => ({ w: (b.w + shoulder * 2) * s, h: b.h * s }), [shoulder, s]);

  const place = useCallback(async (b: { w: number; h: number }, p = { x: pos.x, y }) => {
    const w = winSize(b);
    return api.place(w.w, w.h, p.x, p.y, dock);
  }, [winSize, pos.x, y, dock]);

  // Measure the compact row after every render. Grow immediately, but only shrink
  // after the content has stayed narrower for a while, so ticking numbers don't
  // make the island breathe. Widths are rounded up to 8px steps.
  const shrinkTimer = useRef<number>();
  useLayoutEffect(() => {
    const h = Math.ceil((compactRef.current?.offsetHeight ?? 0) / 8) * 8;
    if (side && h && h !== compactH) setCompactH(h);
    const raw = compactRef.current?.offsetWidth ?? 0;
    if (!raw || side) return;
    const w = Math.ceil(raw / 8) * 8;
    if (w > compactW) {
      clearTimeout(shrinkTimer.current);
      shrinkTimer.current = undefined;
      setCompactW(w);
    } else if (w < compactW - 8 && !shrinkTimer.current) {
      shrinkTimer.current = window.setTimeout(() => {
        shrinkTimer.current = undefined;
        setCompactW(Math.ceil((compactRef.current?.offsetWidth ?? w) / 8) * 8);
      }, 3000);
    } else if (w >= compactW - 8 && shrinkTimer.current) {
      clearTimeout(shrinkTimer.current);
      shrinkTimer.current = undefined;
    }
  });

  // Keep the window sized to the collapsed pill (debounced via the shrink timer when collapsing).
  useEffect(() => {
    if (!expanded && !busy.current) {
      clearTimeout(timers.current.shrink);
      timers.current.shrink = window.setTimeout(() => place(collapsed), expandedRef.current ? 0 : 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed.w, collapsed.h, expanded, shoulder, s, y, dock]);

  useEffect(() => { place(collapsed).then(() => api.show()); /* first paint */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------- expand / collapse ---------------- */
  const expand = useCallback(async () => {
    clearTimeout(timers.current.close);
    clearTimeout(timers.current.shrink);
    if (expandedRef.current) return;
    lastActive.current = Date.now();
    setTucked(false);
    if (cfg.clickThrough) api.setClickThrough(false);
    await place({ w: panel.width, h: panel.height });
    setExpanded(true);
  }, [place, panel, cfg.clickThrough]);

  const collapse = useCallback(() => {
    clearTimeout(timers.current.open);
    if (!expandedRef.current || busy.current) return;
    setExpanded(false);
    lastActive.current = Date.now();
    if (cfg.clickThrough) api.setClickThrough(true);
    clearTimeout(timers.current.shrink);
    timers.current.shrink = window.setTimeout(() => place(collapsed), COLLAPSE_MS);
  }, [place, collapsed, cfg.clickThrough]);

  // Tuck away after a period without interaction; alerts bring it back.
  useEffect(() => {
    if (!cfg.idleHide) { setTucked(false); return; }
    const id = setInterval(() => {
      if (!expandedRef.current && !busy.current && Date.now() - lastActive.current > cfg.idleHide * 1000) setTucked(true);
    }, 1000);
    return () => clearInterval(id);
  }, [cfg.idleHide]);
  useEffect(() => { if (d.alert) { lastActive.current = Date.now(); setTucked(false); } }, [d.alert]);

  // Global shortcuts (registered by the Rust side).
  useEffect(() => {
    const un = listen<string>("shortcut", ({ payload }) => {
      const open = (p?: PageId) => { if (p) { setPage(p); localStorage.setItem("page", p); } expand(); };
      if (payload === "toggle") (expandedRef.current ? collapse() : open());
      else if (payload === "clipboard") open("clipboard");
      else if (payload === "todo") open("todo");
    });
    return () => { un.then((f) => f()); };
  }, [expand, collapse]);

  useEffect(() => {
    const un = listen<[boolean, number, number]>("island-cursor", ({ payload: [inside] }) => {
      if (busy.current) return;
      if (inside) lastActive.current = Date.now();
      if (inside && cfg.clickThrough && !expandedRef.current) return; // game mode: shortcut only
      if (inside) {
        clearTimeout(timers.current.close);
        setTucked(false);
        if (!expandedRef.current && cfg.expandMode === "hover" && !timers.current.open) {
          timers.current.open = window.setTimeout(() => { timers.current.open = undefined; expand(); }, cfg.hoverDelay);
        }
      } else {
        clearTimeout(timers.current.open);
        timers.current.open = undefined;
        const typing = document.activeElement instanceof HTMLInputElement && document.hasFocus();
        if (expandedRef.current && !typing) {
          clearTimeout(timers.current.close);
          timers.current.close = window.setTimeout(collapse, 220);
        }
      }
    });
    return () => { un.then((f) => f()); };
  }, [cfg.expandMode, cfg.hoverDelay, cfg.clickThrough, expand, collapse]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { (document.activeElement as HTMLElement)?.blur(); collapse(); }
      if (!expandedRef.current || document.activeElement instanceof HTMLInputElement) return;
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
    };
    const blur = () => { if (expandedRef.current) timers.current.close = window.setTimeout(collapse, 400); };
    window.addEventListener("keydown", key);
    window.addEventListener("blur", blur);
    return () => { window.removeEventListener("keydown", key); window.removeEventListener("blur", blur); };
  });

  /* ---------------- pages ---------------- */
  const go = (dir: number) => {
    const i = pages.indexOf(curPage);
    const next = pages[(i + dir + pages.length) % pages.length];
    setPage(next);
    localStorage.setItem("page", next);
  };
  const wheelAcc = useRef(0);
  const onWheel = (e: React.WheelEvent) => {
    if ((e.target as HTMLElement).closest(".scroll")) return;
    wheelAcc.current += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (Math.abs(wheelAcc.current) > 60) { go(wheelAcc.current > 0 ? 1 : -1); wheelAcc.current = 0; }
  };

  /* ---------------- drag to move ---------------- */
  const onDragStart = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button,input,textarea,.no-drag,.handle")) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    clearTimeout(timers.current.open);
    timers.current.open = undefined;
    const sx = e.screenX, sy = e.screenY;
    // Grab point relative to the island's top-centre, in window (logical) px.
    const grabX = e.clientX - window.innerWidth / 2, grabY = e.clientY;
    let moved = false, pending = false;
    let last: { monitor: string; dock: Dock; x: number; y: number } | null = null;
    const move = (ev: PointerEvent) => {
      const dx = ev.screenX - sx, dy = ev.screenY - sy;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      if (cfg.lockPosition || pending) return;
      moved = true;
      busy.current = true;
      pending = true;
      const exp = expandedRef.current;
      const hb = exp ? { w: panel.width, h: panel.height } : horiz;
      const vb = exp ? { w: panel.width, h: panel.height } : vert;
      // The Rust side follows the real cursor, so the island can cross to another
      // display; near a left/right edge it snaps into a vertical capsule.
      api.drag((hb.w + SHOULDER * 2) * s, hb.h * s, vb.w * s, vb.h * s, side ? 0 : grabX, side ? 0 : grabY, cfg.shape === "capsule" ? CAPSULE_GAP : 0)
        .then((r) => { last = r; setPos({ x: r.x, y: r.y, dock: r.dock }); })
        .finally(() => { pending = false; });
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      busy.current = false;
      if (moved && last) {
        const r: { monitor: string; dock: Dock; x: number; y: number } = last;
        setCfg({ ...cfg, position: { x: r.x, y: r.y, dock: r.dock }, monitor: r.monitor });
      } else if (cfg.expandMode === "click" && !expandedRef.current) {
        expand();
      }
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  /* ---------------- edge resize ---------------- */
  const onResizeStart = (edge: string) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    busy.current = true;
    const sx = e.screenX, sy = e.screenY, start = { ...panel };
    let raf = 0, cur = start;
    const move = (ev: PointerEvent) => {
      const dx = (ev.screenX - sx) / s, dy = (ev.screenY - sy) / s;
      let w = start.width, h = start.height;
      if (edge.includes("l")) w = start.width - dx * 2;
      if (edge.includes("r")) w = start.width + dx * 2;
      if (edge.includes("b")) h = start.height + dy;
      cur = { width: Math.round(Math.max(420, Math.min(1200, w))), height: Math.round(Math.max(180, Math.min(640, h))) };
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; setPanel(cur); place({ w: cur.width, h: cur.height }); });
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      busy.current = false;
      setCfg({ ...cfg, panel: cur });
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const Page = PAGES[curPage];
  const meta = PAGE_META[curPage];
  const radius = expanded ? 26 : floating ? PILL_H / 2 : side ? SIDE_W / 2 : 14;
  const borderRadius = side
    ? dock === "left" ? `0 ${radius}px ${radius}px 0` : `${radius}px 0 0 ${radius}px`
    : floating ? `${radius}px` : `0 0 ${radius}px ${radius}px`;

  return (
    <div className="stage" style={{ zoom: s }}>
      <div
        className={`body ${tucked && !expanded ? "tucked" : ""} ${expanded ? "expanded" : "collapsed"} ${floating ? "floating" : "docked"} dock-${dock}`}
        style={{ width: body.w, height: body.h, borderRadius, ["--alpha" as string]: `${Math.round(cfg.opacity * 100)}%` }}
        onPointerDown={!expanded ? onDragStart : undefined}
        onWheel={expanded ? onWheel : undefined}
      >
        {!floating && !side && <><i className="shoulder l" /><i className="shoulder r" /></>}
        <Compact ref={compactRef} vertical={side} />
        <div className="panel">
          <div className="p-head" onPointerDown={onDragStart}>
            <div className="p-title">{meta.title[0]}<em>{meta.title[1]}</em></div>
            <div className="p-clock"><span>{fmtDate(now)}</span><b>{fmtClock(now, cfg.clock24)}</b></div>
            <div className="p-actions">
              {(curPage === "ai" || curPage === "details" || curPage === "weather") && (
                <button className="icon-btn" title="刷新" onClick={() => (curPage !== "weather" ? d.refreshUsage() : d.refreshWeather())}><Icon name="refresh" size={15} /></button>
              )}
              <button className="icon-btn" title="设置" onClick={() => api.openSettings()}><Icon name="settings" size={15} /></button>
            </div>
          </div>
          <div className="p-main">
            {pages.length > 1 && <button className="nav prev" onClick={() => go(-1)} aria-label="上一页"><Icon name="left" size={14} /></button>}
            <div className="p-page" key={curPage}><Page /></div>
            {pages.length > 1 && <button className="nav next" onClick={() => go(1)} aria-label="下一页"><Icon name="right" size={14} /></button>}
          </div>
          {pages.length > 1 && (
            <div className="dots">
              {pages.map((p) => <button key={p} className={p === curPage ? "on" : ""} onClick={() => { setPage(p); localStorage.setItem("page", p); }} title={PAGE_META[p].label} />)}
            </div>
          )}
          <i className="handle h-l" onPointerDown={onResizeStart("l")} />
          <i className="handle h-r" onPointerDown={onResizeStart("r")} />
          <i className="handle h-b" onPointerDown={onResizeStart("b")} />
          <i className="handle h-bl" onPointerDown={onResizeStart("lb")} />
          <i className="handle h-br" onPointerDown={onResizeStart("rb")} />
        </div>
      </div>
    </div>
  );
}
