import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { api } from "../../lib/api";
import { Icon } from "../../lib/icons";
import { useData } from "../data";

const TARGETS: [string, string][] = [["auto", "自动（中⇄英）"], ["zh", "→ 中文"], ["en", "→ English"], ["ja", "→ 日本語"], ["ko", "→ 한국어"]];

/** `seed` is set when the page is opened by the shortcut: translate that text right away. */
export function TranslatePage() {
  const { cfg, setCfg, clips, translateSeed, pushAlert } = useData();
  const [text, setText] = useState("");
  const [out, setOut] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const target = cfg.translate.target;
  const seq = useRef(0);

  const run = async (t = text) => {
    if (!t.trim()) return;
    const id = ++seq.current;
    setBusy(true); setErr("");
    try {
      const r = await invoke<string>("translate_text", { text: t, target });
      if (id === seq.current) setOut(r);
    } catch (e) {
      if (id === seq.current) setErr(String(e));
    } finally {
      if (id === seq.current) setBusy(false);
    }
  };

  useEffect(() => {
    if (translateSeed.text) { setText(translateSeed.text); run(translateSeed.text); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [translateSeed.n]);

  const latestText = clips.find((c) => c.kind !== "image")?.text ?? "";
  return (
    <div className="tr">
      <div className="tr-col">
        <textarea className="no-drag" value={text} placeholder="输入或粘贴要翻译的文字，⌘/Ctrl + Enter 翻译" onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run(); } }} />
        <div className="tr-bar">
          <select value={target} onChange={(e) => setCfg({ ...cfg, translate: { ...cfg.translate, target: e.target.value } })}>
            {TARGETS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          {latestText && <button className="pill-btn" onClick={() => { setText(latestText); run(latestText); }} title={latestText.slice(0, 80)}>翻译剪贴板</button>}
          <span className="grow" />
          <button className="tr-go" disabled={busy || !text.trim()} onClick={() => run()}>{busy ? "翻译中…" : "翻译"}</button>
        </div>
      </div>
      <div className="tr-col tr-out">
        {err ? <div className="err-text">{err}</div> : out ? <div className="tr-text" data-notr>{out}</div> : <div className="muted">译文会显示在这里</div>}
        {out && !err && <button className="icon-btn tr-copy" title="复制译文" onClick={() => api.clipCopy(out).then(() => pushAlert("译文已复制"))}><Icon name="copy" size={14} /></button>}
      </div>
    </div>
  );
}
