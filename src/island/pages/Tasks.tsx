import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { api } from "../../lib/api";
import { Icon } from "../../lib/icons";
import type { AgentTask, Build, JobParam } from "../../lib/types";
import { useData } from "../data";

const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** "45 秒" / "12 分钟" / "2 小时 5 分" */
export function dur(s: number): string {
  s = Math.max(0, Math.round(s));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}
function ago(t: number, now: number): string {
  const s = now - t;
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

const STATE_TEXT: Record<AgentTask["state"], string> = { running: "运行中", done: "已完成", idle: "已停止" };
const BUILD_COLOR: Record<Build["state"], string> = { building: "var(--accent)", success: "#30d158", failure: "#ff453a", unstable: "#ff9f0a", aborted: "#8e8e93", notbuilt: "#8e8e93", error: "#ff453a" };
const BUILD_TEXT: Record<Build["state"], string> = { building: "构建中", success: "成功", failure: "失败", unstable: "不稳定", aborted: "已中止", notbuilt: "未构建", error: "出错" };

function AgentRow({ t, now, open, onOpen }: { t: AgentTask; now: number; open: boolean; onOpen: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={`tk ${t.state} ${open ? "open" : ""}`}>
      <button className="tk-row" onClick={onOpen}>
        <span className={`tk-tool ${t.tool}`}>{t.tool === "claude" ? "C" : "X"}</span>
        <span className="tk-title" data-notr>{t.title || base(t.cwd)}</span>
        <span className={`tk-state ${t.state}`}>{t.state === "running" && <i className="tk-spin" />}{STATE_TEXT[t.state]}</span>
        <span className="muted small tk-time">{t.state === "running" && t.started ? dur(now - t.started) : ago(t.updated, now)}</span>
      </button>
      {open && (
        <div className="tk-detail">
          <div className="muted small tk-meta"><span data-notr>{t.cwd}</span>{t.state === "done" && t.started ? <> · {`用时 ${dur(t.updated - t.started)}`}</> : null}</div>
          {t.prompt && <div className="tk-prompt small" data-notr>› {t.prompt}</div>}
          {t.result ? <div className="tk-result" data-notr>{t.result}</div>
            : <div className="muted small">{t.state === "running" ? "还在运行，完成后这里会显示最后的回复" : "这一轮没有完成：可能在等你确认，或者被中断了"}</div>}
          <div className="tk-actions">
            <button className="pill-btn" onClick={() => invoke("shelf_action", { action: "open", paths: [t.cwd] })}>打开目录</button>
            {t.result && <button className="pill-btn" onClick={() => api.clipCopy(t.result).then(() => setCopied(true))}>{copied ? "已复制" : "复制结果"}</button>}
          </div>
        </div>
      )}
    </div>
  );
}

function BuildForm({ b, onDone }: { b: Build; onDone: (msg: string) => void }) {
  const [params, setParams] = useState<JobParam[] | null>(null);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [err, setErr] = useState("");
  const [sending, setSending] = useState(false);
  useEffect(() => {
    invoke<JobParam[]>("jenkins_params", { job: b.job })
      .then((p) => { setParams(p); setVals(Object.fromEntries(p.map((x) => [x.name, x.kind === "choice" && !x.default ? x.choices[0] ?? "" : x.default]))); })
      .catch((e) => setErr(String(e)));
  }, [b.job]);
  const submit = () => {
    setSending(true); setErr("");
    invoke("jenkins_build", { job: b.job, params: params?.length ? vals : {} })
      .then(() => onDone("已加入构建队列"))
      .catch((e) => setErr(String(e)))
      .finally(() => setSending(false));
  };
  if (err && !params) return <div className="err-text small">{err}</div>;
  if (!params) return <div className="muted small">{"正在读取参数…"}</div>;
  const set = (k: string, v: string) => setVals({ ...vals, [k]: v });
  return (
    <form className="bd-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      {params.map((p) => (
        <label key={p.name} className="bd-field" title={p.description}>
          <span data-notr>{p.name}</span>
          {p.kind === "boolean" ? <input type="checkbox" checked={vals[p.name] === "true"} onChange={(e) => set(p.name, String(e.target.checked))} />
            : p.kind === "choice" ? <select value={vals[p.name]} onChange={(e) => set(p.name, e.target.value)}>{p.choices.map((c) => <option key={c}>{c}</option>)}</select>
            : p.kind === "text" ? <textarea rows={2} value={vals[p.name]} onChange={(e) => set(p.name, e.target.value)} />
            : <input type={p.kind === "password" ? "password" : "text"} value={vals[p.name]} onChange={(e) => set(p.name, e.target.value)} />}
        </label>
      ))}
      {!params.length && <div className="muted small">{"这个任务没有参数"}</div>}
      {err && <div className="err-text small">{err}</div>}
      <div className="tk-actions"><button className="pill-btn primary" type="submit" disabled={sending}>{sending ? "提交中…" : "开始构建"}</button></div>
    </form>
  );
}

function BuildRow({ b, now, open, onOpen }: { b: Build; now: number; open: boolean; onOpen: () => void }) {
  const pct = b.state === "building" && b.estimated > 0 ? Math.min(99, ((now - b.started) / b.estimated) * 100) : null;
  const [form, setForm] = useState(false);
  const [msg, setMsg] = useState("");
  return (
    <div className={`bd-wrap ${open ? "open" : ""}`}>
      <button className="bd" onClick={onOpen}>
        <i className={`bd-dot ${b.state}`} style={{ background: BUILD_COLOR[b.state] }} />
        <span className="bd-name"><span data-notr>{b.job}</span>{b.number ? <small className="muted"> #{b.number}</small> : null}{b.mine && <small className="bd-mine">{"我"}</small>}</span>
        <span className="bd-st small" style={{ color: BUILD_COLOR[b.state] }}>{b.error ? b.error : BUILD_TEXT[b.state]}</span>
        <span className="muted small">{b.state === "building" ? (pct != null ? `${Math.round(pct)}%` : dur(now - b.started)) : b.updated ? ago(b.updated, now) : ""}</span>
        {pct != null && <span className="bd-bar"><i style={{ width: `${pct}%` }} /></span>}
      </button>
      {open && b.state !== "error" && (
        <div className="bd-detail">
          {b.started > 0 && <div className="muted small">{b.state === "building" ? `已运行 ${dur(now - b.started)}` : `用时 ${dur(b.duration)}`}</div>}
          <div className="tk-actions">
            <button className="pill-btn" onClick={() => setForm(!form)}>{form ? "收起" : "构建…"}</button>
            {b.url && <button className="pill-btn" onClick={() => invoke("open_url", { url: b.url })}>打开页面</button>}
          </div>
          {msg && <div className="small" style={{ color: "#30d158" }}>{msg}</div>}
          {form && <BuildForm b={b} onDone={(m) => { setMsg(m); setForm(false); }} />}
        </div>
      )}
    </div>
  );
}

export function TasksPage() {
  const { agents, builds, setBuilds, cfg, now } = useData();
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openB, setOpenB] = useState<string | null>(null);
  const n = now.getTime() / 1000;
  const jenkins = cfg.jenkins?.enabled && cfg.jenkins.url;
  const refresh = () => { setBusy(true); invoke<Build[]>("refresh_builds").then(setBuilds).finally(() => setBusy(false)); };
  return (
    <div className={`tasks ${jenkins ? "two" : ""}`}>
      <div className="tk-list scroll">
        {agents.map((t) => <AgentRow key={t.id} t={t} now={n} open={open === t.id} onOpen={() => setOpen(open === t.id ? null : t.id)} />)}
        {!agents.length && <div className="empty">最近 24 小时没有 Claude Code / Codex 任务<small>直接读取本机的会话记录，不需要额外配置</small></div>}
      </div>
      {jenkins ? (
        <div className="bd-list scroll">
          <div className="bd-head"><b>Jenkins</b><span className="grow" /><button className="icon-btn" disabled={busy} onClick={refresh} title="刷新"><Icon name="refresh" size={12} /></button></div>
          {builds.map((b) => <BuildRow key={b.job} b={b} now={n} open={openB === b.job} onOpen={() => setOpenB(openB === b.job ? null : b.job)} />)}
          {!builds.length && <div className="muted small pad">没有找到与你相关的构建；可以在 设置 › 任务 中手动添加</div>}
        </div>
      ) : null}
    </div>
  );
}

/** Collapsed-island item: running agents / builds. */
export function tasksSummary(agents: AgentTask[], builds: Build[]): { running: number; failed: number } {
  return { running: agents.filter((t) => t.state === "running").length + builds.filter((b) => b.state === "building").length, failed: builds.filter((b) => b.state === "failure").length };
}
