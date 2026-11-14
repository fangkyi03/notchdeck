import { useState } from "react";
import { api } from "../../lib/api";
import { todayKey, weatherInfo } from "../../lib/format";
import { Icon } from "../../lib/icons";
import type { Todo } from "../../lib/types";
import { useData } from "../data";
import { Rings } from "../widgets";

/* ------------------------------- todo ------------------------------- */

export function TodoPage() {
  const { todos, setTodos } = useData();
  const [text, setText] = useState("");
  const today = todayKey();
  const list = todos.filter((t) => t.date === today);
  const done = list.filter((t) => t.done).length;
  const update = (id: string, patch: Partial<Todo>) => setTodos(todos.map((t) => (t.id === id ? { ...t, ...patch } : patch.current ? { ...t, current: false } : t)));
  const add = () => {
    if (!text.trim()) return;
    setTodos([...todos, { id: Math.random().toString(36).slice(2), text: text.trim(), done: false, date: today }]);
    setText("");
  };
  return (
    <div className="todo">
      <div className="todo-sum">
        <Rings values={[list.length ? (done / list.length) * 100 : 0]} color="#30d158" size={64} stroke={6} />
        <div><span className="big">{done}/{list.length}</span><div className="muted">已完成</div></div>
      </div>
      <div className="todo-list">
        <form className="todo-add" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <Icon name="plus" size={14} />
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="添加今天的待办，回车保存" />
        </form>
        <div className="todo-items">
          {list.map((t) => (
            <div key={t.id} className={`todo-item ${t.done ? "done" : ""} ${t.current ? "current" : ""}`}>
              <button className="chk" onClick={() => update(t.id, { done: !t.done, current: false })} aria-label="完成">{t.done ? "✓" : ""}</button>
              <span className="tt" onDoubleClick={() => update(t.id, { current: !t.current })} title="双击设为当前任务">{t.text}</span>
              {!t.done && <button className={`cur-btn ${t.current ? "on" : ""}`} onClick={() => update(t.id, { current: !t.current })}>{t.current ? "进行中" : "开始"}</button>}
              <button className="x" onClick={() => setTodos(todos.filter((x) => x.id !== t.id))} aria-label="删除"><Icon name="x" size={12} /></button>
            </div>
          ))}
          {!list.length && <div className="muted pad">今天还没有待办</div>}
        </div>
      </div>
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
          <div key={c.i} className={`clip-item ${c.pinned ? "pinned" : ""}`} onClick={() => api.clipCopy(c.text).then(() => pushAlert("已复制到剪贴板"))} title="点击复制">
            <span className="ct">{/^#[0-9a-f]{3,8}$/i.test(c.text.trim()) && <i className="swatch" style={{ background: c.text.trim() }} />}{c.text.trim().slice(0, 200)}</span>
            <button className={`icon-btn ${c.pinned ? "on" : ""}`} onClick={(e) => { e.stopPropagation(); act(c.i, "pin"); }} title="置顶"><Icon name="pin" size={13} /></button>
            <button className="icon-btn" onClick={(e) => { e.stopPropagation(); act(c.i, "delete"); }} title="删除"><Icon name="x" size={13} /></button>
          </div>
        ))}
        {!sorted.length && <div className="muted pad">复制过的文字会出现在这里</div>}
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
