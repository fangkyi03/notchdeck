import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../lib/api";
import { todayKey } from "../lib/format";
import type { ClipItem, Column, Config, Messages, FocusState, LyricLine, Media, Sys, Todo, Weather } from "../lib/types";

const HIST = 60;
export type Hist = { cpu: number[]; mem: number[]; gpu: number[]; rx: number[]; tx: number[] };

type Data = {
  cfg: Config;
  setCfg: (c: Config, persist?: boolean) => void;
  sys: Sys | null;
  hist: Hist;
  cols: Column[];
  refreshUsage: () => Promise<void>;
  media: Media | null;
  /** Interpolated playback position (seconds). */
  position: number;
  lyrics: LyricLine[];
  lyricIndex: number;
  weather: Weather | null;
  weatherError: string;
  refreshWeather: () => void;
  clips: ClipItem[];
  messages: Messages;
  reloadClips: () => void;
  todos: Todo[];
  setTodos: (t: Todo[]) => void;
  focus: FocusState;
  setFocus: (f: FocusState) => void;
  now: Date;
  /** Short message shown in the collapsed island (quota alert, timer done…). */
  alert: string | null;
  pushAlert: (msg: string) => void;
};

const Ctx = createContext<Data>(null as unknown as Data);
export const useData = () => useContext(Ctx);

const DEFAULT_FOCUS: FocusState = { mode: "work", running: false, endsAt: 0, remaining: 0, rounds: 0 };

export function DataProvider({ initial, children }: { initial: Config; children: ReactNode }) {
  const [cfg, setCfgState] = useState(initial);
  const [sys, setSys] = useState<Sys | null>(null);
  const [hist, setHist] = useState<Hist>({ cpu: [], mem: [], gpu: [], rx: [], tx: [] });
  const [cols, setCols] = useState<Column[]>([]);
  const [media, setMedia] = useState<Media | null>(null);
  const mediaAt = useRef(0);
  const [lyrics, setLyrics] = useState<LyricLine[]>([]);
  const [weather, setWeather] = useState<Weather | null>(null);
  const [weatherError, setWeatherError] = useState("");
  const [clips, setClips] = useState<ClipItem[]>([]);
  const [messages, setMessages] = useState<Messages>({ platform: "", apps: [], toasts: [], toast_status: "" });
  const seenMsg = useRef<Set<string>>(new Set());
  const msgLoaded = useRef(false);
  const [todos, setTodosState] = useState<Todo[]>([]);
  const [focus, setFocusState] = useState<FocusState>(DEFAULT_FOCUS);
  const [now, setNow] = useState(new Date());
  const [alert, setAlert] = useState<string | null>(null);
  const alertTimer = useRef<number>();
  const alerted = useRef<Record<string, number>>({});

  const pushAlert = useCallback((msg: string) => {
    setAlert(msg);
    clearTimeout(alertTimer.current);
    alertTimer.current = window.setTimeout(() => setAlert(null), 5000);
  }, []);

  const setCfg = useCallback((c: Config, persist = true) => {
    setCfgState(c);
    if (persist) api.saveConfig(c);
  }, []);

  useEffect(() => {
    const un = listen<Config>("config-changed", (e) => setCfgState(e.payload));
    return () => { un.then((f) => f()); };
  }, []);

  /* ---- system ---- */
  useEffect(() => {
    const tick = async () => {
      try {
        const s = await api.sys();
        setSys(s);
        setHist((h) => {
          const push = (a: number[], v: number) => [...a.slice(-(HIST - 1)), v];
          return {
            cpu: push(h.cpu, s.cpu),
            mem: push(h.mem, (s.mem_used / Math.max(1, s.mem_total)) * 100),
            gpu: push(h.gpu, s.gpu ?? 0),
            rx: push(h.rx, s.net_rx),
            tx: push(h.tx, s.net_tx),
          };
        });
      } catch (e) { console.error(e); }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  /* ---- AI usage ---- */
  const refreshUsage = useCallback(async (force = false) => {
    try {
      const c = await api.usage(force);
      setCols(c);
    } catch (e) { console.error(e); }
  }, []);
  useEffect(() => {
    refreshUsage();
    const id = setInterval(() => refreshUsage(), 60_000);
    return () => clearInterval(id);
  }, [refreshUsage, cfg.providers]);

  // Quota alerts when a reading crosses 70% / 90%.
  useEffect(() => {
    if (!cfg.compact.alerts) return;
    for (const c of cols) for (const q of c.quotas) {
      if (q.percent == null) continue;
      const key = `${c.id}:${q.title}`;
      const level = q.percent >= 90 ? 90 : q.percent >= 70 ? 70 : 0;
      const prev = alerted.current[key] ?? 0;
      if (level > prev) pushAlert(`${c.name} ${q.title}已用 ${Math.round(q.percent)}%`);
      alerted.current[key] = level;
    }
  }, [cols, cfg.compact.alerts, pushAlert]);

  /* ---- media + lyrics ---- */
  useEffect(() => {
    const tick = async () => {
      try {
        const m = await api.media();
        mediaAt.current = performance.now();
        setMedia(m);
      } catch (e) { console.error(e); }
    };
    tick();
    const id = setInterval(tick, 1500);
    return () => clearInterval(id);
  }, []);
  const trackKey = media ? `${media.title}|${media.artist}` : "";
  useEffect(() => {
    setLyrics([]);
    if (!media || !media.title) return;
    let alive = true;
    api.lyrics(media).then((l) => alive && setLyrics(l)).catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackKey]);

  /* ---- clock (250ms so lyrics/progress feel live) ---- */
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 250);
    return () => clearInterval(id);
  }, []);
  const position = media ? Math.min(media.duration || Infinity, media.position + (media.playing ? (performance.now() - mediaAt.current) / 1000 : 0)) : 0;
  const lyricIndex = useMemo(() => {
    let i = -1;
    for (let k = 0; k < lyrics.length; k++) { if (lyrics[k].t <= position + 0.3) i = k; else break; }
    return i;
  }, [lyrics, position]);

  /* ---- weather ---- */
  const refreshWeather = useCallback((force = false) => {
    api.weather(force).then((w) => { setWeather(w); setWeatherError(""); }).catch((e) => setWeatherError(String(e)));
  }, []);
  useEffect(() => {
    if (!cfg.pages.find((p) => p.id === "weather")?.enabled && !cfg.compact.items.includes("weather")) return;
    api.storeGet<Weather>("weather-cache").then((w) => w && setWeather((cur) => cur ?? w));
    refreshWeather();
    const id = setInterval(() => refreshWeather(), 15 * 60_000);
    return () => clearInterval(id);
  }, [cfg.weatherCity, refreshWeather, cfg.pages, cfg.compact.items]);

  /* ---- messages ---- */
  useEffect(() => {
    api.messages().then((m) => { msgLoaded.current = true; setMessages(m); });
    const un = listen<Messages>("messages-changed", (e) => setMessages(e.payload));
    return () => { un.then((f) => f()); };
  }, []);
  useEffect(() => {
    // Announce apps that just started showing unread / flashing, and new toasts.
    const keys = new Set([...messages.apps.map((a) => `a:${a.id}:${a.since}`), ...messages.toasts.map((t) => `t:${t.id}`)]);
    const fresh = [...keys].filter((k) => !seenMsg.current.has(k));
    // Unread that already existed at startup is not "new".
    if (msgLoaded.current && seenMsg.current.size && fresh.length) {
      const k = fresh[0];
      if (k.startsWith("a:")) {
        const a = messages.apps.find((x) => k.startsWith(`a:${x.id}:`));
        if (a) pushAlert(`${a.name} 有新消息${a.count ? `（${a.count}）` : ""}`);
      } else {
        const t = messages.toasts.find((x) => k === `t:${x.id}`);
        if (t) pushAlert(`${t.app}：${t.title || t.body}`);
      }
    }
    if (msgLoaded.current) seenMsg.current = keys.size ? keys : new Set(["∅"]);
  }, [messages, pushAlert]);

  /* ---- clipboard ---- */
  useEffect(() => {
    api.clips().then(setClips);
    const un = listen("clipboard-changed", () => api.clips().then(setClips));
    return () => { un.then((f) => f()); };
  }, []);
  const reloadClips = useCallback(() => { api.clips().then(setClips); }, []);

  /* ---- todos & focus (persisted) ---- */
  useEffect(() => {
    api.storeGet<Todo[]>("todos").then((t) => t && setTodosState(t));
    api.storeGet<FocusState>("focus").then((f) => f && setFocusState(f));
  }, []);
  const setTodos = useCallback((t: Todo[]) => { setTodosState(t); api.storeSet("todos", t); }, []);
  const setFocus = useCallback((f: FocusState) => { setFocusState(f); api.storeSet("focus", f); }, []);

  useEffect(() => {
    if (!focus.running || Date.now() < focus.endsAt) return;
    const nextMode = focus.mode === "work" ? "rest" : "work";
    pushAlert(focus.mode === "work" ? "专注完成，休息一下吧 ☕" : "休息结束，继续专注 🍅");
    setFocus({ mode: nextMode, running: false, endsAt: 0, remaining: (nextMode === "work" ? cfg.focus.work : cfg.focus.rest) * 60, rounds: focus.rounds + (focus.mode === "work" ? 1 : 0) });
  }, [now, focus, cfg.focus, pushAlert, setFocus]);

  // Carry unfinished todos forward to today.
  useEffect(() => {
    const t = todayKey();
    if (todos.some((x) => !x.done && x.date < t)) setTodos(todos.map((x) => (!x.done && x.date < t ? { ...x, date: t } : x)));
  }, [todos, setTodos]);

  const value: Data = {
    cfg, setCfg, sys, hist, cols, refreshUsage: () => refreshUsage(true), media, position, lyrics, lyricIndex,
    weather, weatherError, refreshWeather: () => refreshWeather(true), clips, messages, reloadClips, todos, setTodos, focus, setFocus, now, alert, pushAlert,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

