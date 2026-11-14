import { useMemo, useState } from "react";
import { api } from "../../lib/api";
import { todayKey, weatherInfo } from "../../lib/format";
import { Icon } from "../../lib/icons";
import type { Todo } from "../../lib/types";
import { useData } from "../data";
import { Rings } from "../widgets";
import { MonthGrid } from "./Calendar";

/* ------------------------------- todo ------------------------------- */

type TodoView = "today" | "calendar" | "history" | "notes";

function TodoList({ date }: { date: string }) {
  const { todos, setTodos } = useData();
  const [text, setText] = useState("");
  const [when, setWhen] = useState(date);
  const list = todos.filter((t) => t.date === date);
  const update = (id: string, patch: Partial<Todo>) =>
    setTodos(todos.map((t) => (t.id === id ? { ...t, ...patch } : patch.current ? { ...t, current: false } : t)));
  const add = () => {
    if (!text.trim()) return;
    setTodos([...todos, { id: Math.random().toString(36).slice(2), text: text.trim(), done: false, date: when || date }]);
    setText("");
  };
  return (
    <div className="todo-list">
      <form className="todo-add" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <Icon name="plus" size={14} />
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={date === todayKey() ? "添加待办，回车保存" : `添加 ${date.slice(5)} 的待办`} />
        <input className="todo-date" type="date" value={when} min={todayKey()} onChange={(e) => setWhen(e.target.value)} title="安排到哪一天" />
      </form>
      <div className="todo-items">
        {list.map((t) => (
          <div key={t.id} className={`todo-item ${t.done ? "done" : ""} ${t.current ? "current" : ""}`}>
            <button className="chk" onClick={() => update(t.id, { done: !t.done, current: false, doneAt: !t.done ? Date.now() : undefined })} aria-label="完成">{t.done ? "✓" : ""}</button>
            <span className="tt">{t.text}</span>
            {!t.done && date === todayKey() && <button className={`cur-btn ${t.current ? "on" : ""}`} onClick={() => update(t.id, { current: !t.current })}>{t.current ? "进行中" : "开始"}</button>}
            <button className="x" onClick={() => setTodos(todos.filter((x) => x.id !== t.id))} aria-label="删除"><Icon name="x" size={12} /></button>
          </div>
        ))}
        {!list.length && <div className="muted pad">{date === todayKey() ? "今天还没有待办" : "这一天没有待办"}</div>}
      </div>
    </div>
  );
}

export function TodoPage() {
  const { todos, notes, setNote } = useData();
  const [view, setView] = useState<TodoView>("today");
  const [month, setMonth] = useState(() => new Date());
  const [sel, setSel] = useState(todayKey());
  const today = todayKey();
  const list = todos.filter((t) => t.date === today);
  const done = list.filter((t) => t.done).length;

  const marks = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const t of todos) (m[t.date] ??= []).push(t.done ? "#30d158" : "#ff9f0a");
    for (const k of Object.keys(notes)) (m[k] ??= []).push("#64d2ff");
    return m;
  }, [todos, notes]);
  const history = useMemo(() => {
    const byDay: Record<string, Todo[]> = {};
    for (const t of todos) if (t.date < today || (t.date === today && t.done)) (byDay[t.date] ??= []).push(t);
    return Object.entries(byDay).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [todos, today]);

  return (
    <div className="todo">
      <div className="todo-side">
        <div className="seg todo-tabs">
          {([["today", "今天"], ["calendar", "日历"], ["history", "历史"], ["notes", "笔记"]] as [TodoView, string][]).map(([v, l]) => (
            <button key={v} className={view === v ? "on" : ""} onClick={() => setView(v)}>{l}</button>
          ))}
        </div>
        {view === "calendar"
          ? <MonthGrid month={month} setMonth={setMonth} selected={sel} onSelect={setSel} marks={marks} />
          : <div className="todo-sum">
              <Rings values={[list.length ? (done / list.length) * 100 : 0]} color="#30d158" size={60} stroke={6} />
              <div><span className="big">{done}/{list.length}</span><div className="muted">今日完成</div></div>
            </div>}
      </div>
      {view === "today" && <TodoList date={today} />}
      {view === "calendar" && <TodoList key={sel} date={sel} />}
      {view === "history" && (
        <div className="todo-list scroll">
          {history.map(([day, items]) => (
            <div key={day} className="hist-day">
              <div className="hist-head"><b>{day === today ? "今天" : day.slice(5)}</b><span className="muted small">{items.filter((t) => t.done).length}/{items.length} 完成</span></div>
              {items.map((t) => <div key={t.id} className={`hist-item ${t.done ? "done" : ""}`}>{t.done ? "✓" : "○"} {t.text}</div>)}
            </div>
          ))}
          {!history.length && <div className="muted pad">完成的待办会按日期记录在这里</div>}
        </div>
      )}
      {view === "notes" && (
        <div className="todo-list">
          <div className="hist-head"><b>{today.slice(5).replace("-", "月")}日 · 笔记</b><span className="muted small">自动保存</span></div>
          <textarea className="note-area" value={notes[today] ?? ""} placeholder="今天想记下点什么……" onChange={(e) => setNote(today, e.target.value)} />
        </div>
      )}
    </div>
  );
}

/* ------------------------------ focus ------------------------------- */

export function FocusPage() {
  const { cfg, focus, setFocus, now } = useData();
  const total = (focus.mode === "work" ? cfg.focus.work : cfg.focus.rest) * 60;
  const left = focus.running ? Math.max(0, Math.round((focus.endsAt - now.getTime()) / 1000)) : focus.remaining || total;
  const pct = 100 - (left / total) * 100;
  const color = focus.mode === "work" ? "#ff453a" : "#30d158";
  const toggle = () =>
    focus.running
      ? setFocus({ ...focus, running: false, remaining: left })
      : setFocus({ ...focus, running: true, endsAt: Date.now() + left * 1000 });
  const mode = (m: "work" | "rest") => setFocus({ mode: m, running: false, endsAt: 0, remaining: (m === "work" ? cfg.focus.work : cfg.focus.rest) * 60, rounds: focus.rounds });
  return (
    <div className="focus">
      <div className="f-dial" style={{ color }}>
        <Rings values={[pct]} color={color} size={96} stroke={8} />
        <span className="f-emoji">{focus.mode === "work" ? "🍅" : "☕"}</span>
      </div>
      <div className="f-main">
        <div className="f-time">{Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
          <button className="icon-btn" onClick={() => mode(focus.mode)} title="重置"><Icon name="reset" size={16} /></button>
        </div>
        <div className="muted">{focus.mode === "work" ? "专注时间" : "休息时间"} · 今日完成 {focus.rounds} 个番茄</div>
        <div className="f-ctl">
          <button className={`pill ${focus.mode === "work" ? "on work" : ""}`} onClick={() => mode("work")}>专注</button>
          <button className="f-play" style={{ background: color }} onClick={toggle}><Icon name={focus.running ? "pause" : "play"} size={18} /></button>
          <button className={`pill ${focus.mode === "rest" ? "on rest" : ""}`} onClick={() => mode("rest")}>休息</button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------- clipboard ----------------------------- */

export function ClipboardPage() {
  const { clips, reloadClips, pushAlert } = useData();
  const [q, setQ] = useState("");
  const list = clips.map((c, i) => ({ ...c, i })).filter((c) => !q || c.text.toLowerCase().includes(q.toLowerCase()));
  const sorted = [...list.filter((c) => c.pinned), ...list.filter((c) => !c.pinned)];
  const act = (i: number, a: "pin" | "delete") => api.clipUpdate(i, a).then(reloadClips);
  return (
    <div className="clip">
      <div className="clip-bar">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索剪贴历史" />
        <button className="icon-btn" title="清空（保留置顶）" onClick={() => api.clipClear().then(reloadClips)}><Icon name="trash" size={14} /></button>
      </div>
      <div className="clip-list">
        {sorted.map((c) => (
          <div key={c.i} className={`clip-item ${c.pinned ? "pinned" : ""} ${c.kind === "image" ? "is-image" : ""}`} onClick={() => api.clipRestore(c.i).then(() => pushAlert(c.kind === "image" ? "图片已复制到剪贴板" : "已复制到剪贴板")).catch((e) => pushAlert(String(e)))} title="点击复制">
            {c.kind === "image"
              ? <span className="ct"><img className="clip-thumb" src={c.thumb} alt="" draggable={false} /><small className="muted">{c.text}</small></span>
              : <span className="ct">{/^#[0-9a-f]{3,8}$/i.test(c.text.trim()) && <i className="swatch" style={{ background: c.text.trim() }} />}{c.text.trim().slice(0, 200)}</span>}
            <button className={`icon-btn ${c.pinned ? "on" : ""}`} onClick={(e) => { e.stopPropagation(); act(c.i, "pin"); }} title="置顶"><Icon name="pin" size={13} /></button>
            <button className="icon-btn" onClick={(e) => { e.stopPropagation(); act(c.i, "delete"); }} title="删除"><Icon name="x" size={13} /></button>
          </div>
        ))}
        {!sorted.length && <div className="muted pad">复制过的文字和图片会出现在这里</div>}
      </div>
    </div>
  );
}

/* ------------------------------ weather ----------------------------- */

const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function WeatherPage() {
  const { weather: w, weatherError } = useData();
  if (!w) return <div className="empty">{weatherError || "正在获取天气…"}</div>;
  const info = weatherInfo(w.code, w.is_day);
  const stale = Date.now() / 1000 - w.updated > 3600;
  return (
    <div className="weather">
      <div className="w-now">
        <span className="w-icon">{info.icon}</span>
        <div>
          <div className="w-temp">{Math.round(w.temp)}°<small>{info.text}</small></div>
          <div className="muted">{w.city} · 体感 {Math.round(w.feels)}° · 湿度 {Math.round(w.humidity)}% · 风 {Math.round(w.wind)} km/h</div>
          <div className={`muted small ${stale ? "warn" : ""}`}>日出 {w.sunrise} · 日落 {w.sunset} · {new Date(w.updated * 1000).toLocaleTimeString().slice(0, 5)} 更新</div>
        </div>
      </div>
      <div className="w-days">
        {w.daily.slice(0, 4).map((d, i) => {
          const di = weatherInfo(d.code);
          return (
            <div className="w-day" key={d.date}>
              <span className="muted">{i === 0 ? "今天" : WEEK[new Date(`${d.date}T00:00:00`).getDay()]}</span>
              <span className="w-di">{di.icon}</span>
              <span>{Math.round(d.max)}° <small className="muted">{Math.round(d.min)}°</small></span>
              <span className="muted small">💧{Math.round(d.rain)}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
