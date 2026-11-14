import { useMemo, useState } from "react";
import { todayKey } from "../../lib/format";
import { Icon } from "../../lib/icons";
import type { CalEvent } from "../../lib/types";
import { useData } from "../data";
import { Rings } from "../widgets";

const WEEK = ["一", "二", "三", "四", "五", "六", "日"];
export const dayKey = (t: number) => todayKey(new Date(t * 1000));
const hm = (t: number) => { const d = new Date(t * 1000); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

/** Month grid (Monday first). `marks` maps "YYYY-MM-DD" → dot colors. */
export function MonthGrid({ month, setMonth, selected, onSelect, marks }: {
  month: Date; setMonth: (d: Date) => void; selected: string; onSelect: (key: string) => void; marks: Record<string, string[]>;
}) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  const days = Array.from({ length: 42 }, (_, i) => new Date(month.getFullYear(), month.getMonth(), 1 - offset + i));
  const today = todayKey();
  const shift = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));
  return (
    <div className="mgrid">
      <div className="mg-head">
        <button className="icon-btn" onClick={() => shift(-1)}><Icon name="left" size={12} /></button>
        <span>{month.getFullYear()}年{month.getMonth() + 1}月</span>
        <button className="icon-btn" onClick={() => shift(1)}><Icon name="right" size={12} /></button>
      </div>
      <div className="mg-cells">
        {WEEK.map((w) => <span key={w} className="mg-w">{w}</span>)}
        {days.map((d) => {
          const k = todayKey(d);
          const dots = marks[k] ?? [];
          return (
            <button key={k} className={`mg-d ${d.getMonth() !== month.getMonth() ? "out" : ""} ${k === today ? "today" : ""} ${k === selected ? "sel" : ""}`} onClick={() => onSelect(k)}>
              {d.getDate()}
              <i className="mg-dots">{dots.slice(0, 3).map((c, i) => <b key={i} style={{ background: c }} />)}</i>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** "15 分钟后" / "2 小时后" / "进行中" */
function until(secs: number): string {
  if (secs <= 0) return "进行中";
  const m = Math.round(secs / 60);
  if (m < 60) return `${Math.max(1, m)} 分钟后`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} 小时${m % 60 >= 30 ? "半" : ""}后` : `${Math.floor(h / 24)} 天后`;
}

export function CalendarPage() {
  const { events, calErrors, localEvents, setLocalEvents, now } = useData();
  const [month, setMonth] = useState(() => new Date());
  const [sel, setSel] = useState(todayKey());
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [time, setTime] = useState("10:00");
  const [dur, setDur] = useState(60);

  const marks = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const e of events) {
      // Multi-day events mark every day they cover.
      for (let t = e.start; t < Math.max(e.end, e.start + 1); t += 86400) (m[dayKey(t)] ??= []).push(e.color || "var(--accent)");
    }
    return m;
  }, [events]);
  const dayStart = new Date(`${sel}T00:00:00`).getTime() / 1000;
  const list = events.filter((e) => e.start < dayStart + 86400 && e.end > dayStart);
  const nowSec = now.getTime() / 1000;
  const next = events.find((e) => !e.all_day && e.end > nowSec);

  const add = () => {
    if (!title.trim()) return;
    const start = new Date(`${sel}T${time}:00`).getTime() / 1000;
    const ev: CalEvent = { id: `local-${Date.now()}`, title: title.trim(), start, end: start + dur * 60, all_day: false, location: "", calendar: "本机", color: "#30d158" };
    setLocalEvents([...localEvents, ev]);
    setTitle(""); setAdding(false);
  };

  return (
    <div className="cal">
      <MonthGrid month={month} setMonth={setMonth} selected={sel} onSelect={setSel} marks={marks} />
      <div className="cal-day">
        <div className="cal-day-head">
          <b>{sel === todayKey() ? "今天" : sel.slice(5).replace("-", "月") + "日"}</b>
          {next && sel === todayKey() && <span className="cal-next">{until(next.start - nowSec)} · {next.title}</span>}
          <span className="grow" />
          <button className="pill-btn" onClick={() => setAdding(!adding)}>+ 新增</button>
        </div>
        {adding && (
          <form className="cal-add" onSubmit={(e) => { e.preventDefault(); add(); }}>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="日程标题" autoFocus />
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            <select value={dur} onChange={(e) => setDur(+e.target.value)}>{[15, 30, 60, 90, 120].map((m) => <option key={m} value={m}>{m} 分钟</option>)}</select>
            <button className="pill-btn" type="submit">保存</button>
          </form>
        )}
        <div className="cal-list scroll">
          {list.map((e) => (
            <div key={e.id} className={`cal-ev ${e.end < nowSec ? "past" : ""}`}>
              <span className="cal-t">{e.all_day ? "全天" : hm(e.start)}</span>
              <i className="cal-bar" style={{ background: e.color || "var(--accent)" }} />
              <span className="cal-title">{e.title}{e.location && <small className="muted"> · {e.location}</small>}</span>
              <span className="muted small">{e.all_day ? e.calendar : `${hm(e.end)} 结束`}</span>
              {e.calendar === "本机" && <button className="icon-btn x" onClick={() => setLocalEvents(localEvents.filter((x) => x.id !== e.id))}><Icon name="x" size={11} /></button>}
            </div>
          ))}
          {!list.length && <div className="muted pad">这一天没有日程</div>}
          {calErrors.map((er) => <div key={er} className="err-text small">{er}</div>)}
        </div>
      </div>
    </div>
  );
}

export function WaterPage() {
  const { cfg, water, drink, undoDrink } = useData();
  const w = cfg.water;
  const pct = Math.min(100, (water.ml / Math.max(1, w.goal)) * 100);
  const next = water.lastAt ? new Date(water.lastAt + w.interval * 60_000) : null;
  return (
    <div className="water">
      <div className="w-ring">
        <Rings values={[pct]} color="#30b0ff" size={104} stroke={9} />
        <span className="w-pct">{Math.round(pct)}<small>%</small></span>
      </div>
      <div className="w-main">
        <div className="w-amt">{(water.ml / 1000).toFixed(2)}<small> / {(w.goal / 1000).toFixed(1)} L</small></div>
        <div className="muted">今天喝了 {water.log.length} 次{w.enabled && next && pct < 100 ? ` · 下次提醒 ${String(next.getHours()).padStart(2, "0")}:${String(next.getMinutes()).padStart(2, "0")}` : ""}{!w.enabled ? " · 提醒已关闭（设置 › 天气与专注）" : ""}</div>
        <div className="w-ctl">
          <button className="w-drink" onClick={() => drink()}>💧 喝一口 {w.cup}ml</button>
          <button className="pill-btn" onClick={() => drink(w.cup * 2)}>大杯 {w.cup * 2}ml</button>
          <button className="pill-btn" disabled={!water.log.length} onClick={undoDrink}>撤销</button>
        </div>
      </div>
    </div>
  );
}
