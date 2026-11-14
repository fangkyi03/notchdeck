import { api } from "../../lib/api";
import { useData } from "../data";

const COLORS: Record<string, string> = {
  wechat: "#07c160", qq: "#12b7f5", wework: "#2b7ff4", dingtalk: "#3296fa", feishu: "#3370ff",
  mail: "#3a8dff", telegram: "#2aabee", slack: "#e01e5a",
};
const LETTER: Record<string, string> = { wechat: "微", qq: "Q", wework: "企", dingtalk: "钉", feishu: "飞", mail: "✉", telegram: "T", slack: "S" };

export function AppBadge({ id, size = 18 }: { id: string; size?: number }) {
  return <span className="app-badge" style={{ width: size, height: size, background: COLORS[id] ?? "var(--accent)", fontSize: size * 0.55 }}>{LETTER[id] ?? id[0]?.toUpperCase()}</span>;
}

function ago(ts: number) {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  const d = new Date(ts * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function MessagesPage() {
  const { messages: m } = useData();
  const win = m.platform === "windows";
  return (
    <div className="msgs">
      <div className="msg-apps">
        {m.apps.length ? m.apps.map((a) => (
          <button key={a.id} className="msg-app" onClick={() => api.openMessageApp(a.id)} title="点击切换到该应用">
            <AppBadge id={a.id} size={30} />
            <span className="ma-name">{a.name}</span>
            <span className="ma-count">{a.count != null ? `${a.count} 条未读` : "有新消息"}</span>
            <span className="muted small">{ago(a.since)}</span>
          </button>
        )) : <div className="muted pad">{win ? "微信、QQ 等有新消息时（任务栏闪烁）会出现在这里" : "微信、QQ 等应用的 Dock 未读数会显示在这里"}</div>}
      </div>
      {win && (
        <div className="msg-toasts scroll">
          {m.toast_status && <div className="muted small pad">{m.toast_status}</div>}
          {m.toasts.map((t) => (
            <div key={t.id} className="toast">
              <div className="t-head"><b>{t.title || t.app}</b><span className="muted small">{t.app} · {ago(t.at)}</span></div>
              {t.body && <div className="t-body">{t.body}</div>}
            </div>
          ))}
          {!m.toast_status && !m.toasts.length && <div className="muted pad">系统通知中心暂无通知</div>}
        </div>
      )}
    </div>
  );
}
