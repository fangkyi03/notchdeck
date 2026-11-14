import { useState } from "react";
import { fmtCost, fmtTokens } from "../../lib/format";
import { useData } from "../data";

/** Per-model token & cost breakdown for every tool that has local usage logs. */
export function DetailsPage() {
  const { cfg, cols } = useData();
  const withStats = cols.filter((c) => c.has_stats);
  const [sel, setSel] = useState<string>("all");
  const [range, setRange] = useState<"today" | "week">("week");
  if (!withStats.length) return <div className="empty">暂无本地用量记录<small>Claude Code、Codex 使用后会出现在这里</small></div>;

  const rows = withStats
    .filter((c) => sel === "all" || c.id === sel)
    .flatMap((c) => c.models.map((m) => ({ ...m, app: c.name, color: cfg.providers.find((p) => p.id === c.id)?.color ?? "var(--accent)" })))
    .map((m) => ({ ...m, tokens: range === "today" ? m.today_tokens : m.week_tokens, cost: range === "today" ? m.today_cost : m.week_cost }))
    .filter((m) => m.tokens > 0)
    .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
  const total = rows.reduce((a, r) => ({ tokens: a.tokens + r.tokens, cost: a.cost + r.cost }), { tokens: 0, cost: 0 });
  const maxCost = Math.max(...rows.map((r) => r.cost), 1e-9);

  return (
    <div className="details">
      <div className="d-bar">
        <div className="seg">
          <button className={sel === "all" ? "on" : ""} onClick={() => setSel("all")}>全部</button>
          {withStats.map((c) => <button key={c.id} className={sel === c.id ? "on" : ""} onClick={() => setSel(c.id)}>{c.name}</button>)}
        </div>
        <div className="seg">
          <button className={range === "today" ? "on" : ""} onClick={() => setRange("today")}>今日</button>
          <button className={range === "week" ? "on" : ""} onClick={() => setRange("week")}>七日</button>
        </div>
        <span className="d-total">{fmtTokens(total.tokens)} · <b>{fmtCost(total.cost)}</b></span>
      </div>
      <div className="d-list scroll">
        {rows.map((r) => (
          <div className="d-row" key={`${r.app}-${r.model}`}>
            <i className="d-dot" style={{ background: r.color }} />
            <span className="d-model" title={r.model}>{r.model}</span>
            <span className="d-app">{r.app}</span>
            <span className="d-bar-w"><i style={{ width: `${(r.cost / maxCost) * 100}%`, background: r.color }} /></span>
            <span className="d-tok">{fmtTokens(r.tokens)}</span>
            <b className="d-cost">{fmtCost(r.cost)}</b>
          </div>
        ))}
        {!rows.length && <div className="muted pad">这个时间段没有用量</div>}
      </div>
      <div className="d-note">费用按公开模型单价估算，订阅套餐的实际扣费以账单为准</div>
    </div>
  );
}
