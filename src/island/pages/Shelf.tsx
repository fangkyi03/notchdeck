import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { fmtBytes } from "../../lib/format";
import { Icon } from "../../lib/icons";
import { useData } from "../data";

type Info = { path: string; name: string; size: number; is_dir: boolean; exists: boolean; ext: string };

const EXT_COLOR: Record<string, string> = {
  pdf: "#ff453a", doc: "#2b7ff4", docx: "#2b7ff4", xls: "#30a14e", xlsx: "#30a14e", csv: "#30a14e", ppt: "#ff7a1a", pptx: "#ff7a1a",
  png: "#bf5af2", jpg: "#bf5af2", jpeg: "#bf5af2", gif: "#bf5af2", webp: "#bf5af2", heic: "#bf5af2", svg: "#bf5af2",
  zip: "#8e8e93", rar: "#8e8e93", "7z": "#8e8e93", dmg: "#8e8e93", mp4: "#ff375f", mov: "#ff375f", mp3: "#ff9f0a", txt: "#64d2ff", md: "#64d2ff",
};

export function FileIcon({ info, size = 30 }: { info: Pick<Info, "ext" | "is_dir">; size?: number }) {
  const label = info.is_dir ? "📁" : (info.ext || "?").slice(0, 4).toUpperCase();
  return <span className="file-ic" style={{ width: size, height: size * 1.2, background: info.is_dir ? "transparent" : EXT_COLOR[info.ext] ?? "var(--track)", fontSize: info.is_dir ? size * 0.8 : size * 0.26 }}>{label}</span>;
}

export function ShelfPage() {
  const { shelf, setShelf, pushAlert } = useData();
  const [infos, setInfos] = useState<Info[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  useEffect(() => {
    invoke<Info[]>("shelf_info", { paths: shelf.map((s) => s.path) }).then(setInfos);
  }, [shelf]);

  const act = (action: "open" | "reveal" | "copy", paths: string[]) =>
    invoke("shelf_action", { action, paths })
      .then(() => action === "copy" && pushAlert(`已复制 ${paths.length} 个文件，可直接粘贴`))
      .catch((e) => pushAlert(String(e)));
  const remove = (paths: string[]) => { setShelf(shelf.filter((s) => !paths.includes(s.path))); setSel(new Set()); };
  const dragOut = async (e: React.PointerEvent, path: string) => {
    if (e.button !== 0) return;
    const items = sel.has(path) ? [...sel] : [path];
    const icon = await invoke<string>("drag_icon");
    startDrag({ item: items, icon }).catch(() => {});
  };

  if (!shelf.length) return <div className="empty"><Icon name="clipboard" size={22} />把文件拖到小岛上暂存<small>只记录文件位置，不会复制文件。之后可以打开、复制，或再拖到别的应用里</small></div>;
  const picked = [...sel];

  return (
    <div className="shelf">
      <div className="shelf-bar">
        <span className="muted">{`${shelf.length} 个文件`}{picked.length ? ` · 已选 ${picked.length}` : ""}</span>
        <span className="grow" />
        <button className="pill-btn" onClick={() => act("copy", picked.length ? picked : shelf.map((s) => s.path))}>{picked.length ? "复制所选" : "复制全部"}</button>
        <button className="pill-btn" onClick={() => remove(picked.length ? picked : shelf.map((s) => s.path))}>{picked.length ? "移除所选" : "全部移除"}</button>
      </div>
      <div className="shelf-grid scroll">
        {infos.map((f) => (
          <div key={f.path} className={`shelf-item ${sel.has(f.path) ? "sel" : ""} ${f.exists ? "" : "gone"}`}
            title={`${f.path}\n拖出到其他应用；双击打开；⌘/Ctrl+点击多选`}
            onPointerDown={(e) => f.exists && dragOut(e, f.path)}
            onClick={(e) => { if (e.metaKey || e.ctrlKey) { const n = new Set(sel); n.has(f.path) ? n.delete(f.path) : n.add(f.path); setSel(n); } }}
            onDoubleClick={() => act("open", [f.path])}>
            <FileIcon info={f} />
            <span className="sh-name" data-notr>{f.name}</span>
            <span className="sh-meta">{f.exists ? (f.is_dir ? "文件夹" : fmtBytes(f.size)) : "已移动或删除"}</span>
            <span className="sh-acts">
              <button className="icon-btn" title="在访达 / 资源管理器中显示" onClick={(e) => { e.stopPropagation(); act("reveal", [f.path]); }}><Icon name="monitor" size={12} /></button>
              <button className="icon-btn" title="复制文件" onClick={(e) => { e.stopPropagation(); act("copy", [f.path]); }}><Icon name="copy" size={12} /></button>
              <button className="icon-btn" title="移除" onClick={(e) => { e.stopPropagation(); remove([f.path]); }}><Icon name="x" size={12} /></button>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
