import { fmtCost, fmtReset, fmtTokens, quotaColor } from "../../lib/format";
import { useData } from "../data";
import { Bar } from "../widgets";

export function AiPage() {
  const { cfg, cols, now } = useData();
  if (!cols.length) return <div className="empty">在设置 › AI 额度中添加工具</div>;
  const remaining = cfg.compact.showRemaining;
  const nowSec = now.getTime() / 1000;
  return (
    <div className="ai-grid" style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(0, 1fr))` }}>
      {cols.map((c) => {
        const color = cfg.providers.find((p) => p.id === c.id)?.color || c.color || "var(--accent)";
        return (
          <div className="ai-col" key={c.id}>
            <div className="ai-head" title={c.stale_since ? `显示的是 ${new Date(c.stale_since * 1000).toLocaleTimeString()} 的读数` : undefined}>
              <span className="ai-name">{c.name}</span>
              {c.plan && <span className="badge">{c.plan}</span>}
              {c.stale_since && <span className="stale">旧</span>}
            </div>
            <div className="ai-quotas">
              {c.error && !c.quotas.length && <div className="ai-err">{c.error}</div>}
              {c.quotas.slice(0, 2).map((q, i) => {
                const pct = q.percent == null ? null : remaining ? 100 - q.percent : q.percent;
                const col = remaining ? color : quotaColor(q.percent, color);
                return (
                  <div className="quota" key={i}>
                    <div className="q-title">{q.title}</div>
                    <div className="q-row">
                      {pct != null
                        ? <span className="q-pct" style={{ color: (q.percent ?? 0) >= 70 && !remaining ? col : undefined }}>{Math.round(pct)}%<small>{remaining ? "剩余" : "已用"}</small></span>
                        : <span className="q-pct">{q.value || "—"}</span>}
                      <span className="q-reset">{q.reset_text || fmtReset(q.reset_at, nowSec)}</span>
                    </div>
                    {pct != null && <Bar pct={pct} color={col} />}
                  </div>
                );
              })}
            </div>
            {c.has_stats && (
              <div className="ai-stats">
                <div><span className="k">今日</span><span className="t">{fmtTokens(c.today_tokens)}</span><b>{fmtCost(c.today_cost)}</b></div>
                <div><span className="k">七日</span><span className="t">{fmtTokens(c.week_tokens)}</span><b>{fmtCost(c.week_cost)}</b></div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
