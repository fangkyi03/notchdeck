import { useRef } from "react";
import { api } from "../../lib/api";
import { fmtTime } from "../../lib/format";
import { Icon } from "../../lib/icons";
import { useData } from "../data";
import { Cover, Eq } from "../widgets";

export function MusicPage() {
  const { media, position, lyrics, lyricIndex } = useData();
  const bar = useRef<HTMLDivElement>(null);
  if (!media?.title) return <div className="empty">没有正在播放的音乐<small>支持 Spotify、Apple Music；Windows 上支持网易云、QQ 音乐等系统媒体会话</small></div>;

  const pct = media.duration > 0 ? (position / media.duration) * 100 : 0;
  const seek = (e: React.PointerEvent) => {
    if (!bar.current || media.duration <= 0) return;
    const r = bar.current.getBoundingClientRect();
    api.mediaControl("seek", Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * media.duration);
  };
  const ctl = (a: "toggle" | "prev" | "next") => () => api.mediaControl(a);
  const lines = lyricIndex >= 0 ? [lyrics[lyricIndex - 1], lyrics[lyricIndex], lyrics[lyricIndex + 1]] : [undefined, lyrics[0], lyrics[1]];

  return (
    <div className="music">
      <div className="m-left">
        <div className="m-top">
          <Cover src={media.artwork} size={64} />
          <div className="m-info">
            <div className="m-title">{media.title}</div>
            <div className="m-artist">{[media.artist, media.album].filter(Boolean).join(" · ")}</div>
          </div>
          <Eq playing={media.playing} height={16} />
        </div>
        <div className="m-progress" ref={bar} onPointerDown={seek}>
          <div className="bar"><i style={{ width: `${pct}%`, background: "var(--accent)" }} /></div>
        </div>
        <div className="m-times"><span>{fmtTime(position)}</span><span>-{fmtTime(media.duration - position)}</span></div>
        <div className="m-ctl">
          <button onClick={ctl("prev")} aria-label="上一首"><Icon name="prev" size={20} /></button>
          <button className="m-play" onClick={ctl("toggle")} aria-label="播放/暂停"><Icon name={media.playing ? "pause" : "play"} size={24} /></button>
          <button onClick={ctl("next")} aria-label="下一首"><Icon name="next" size={20} /></button>
        </div>
      </div>
      <div className="m-lyrics">
        {lyrics.length ? lines.map((l, i) => <div key={i} className={i === 1 ? "cur" : ""}>{l?.text || " "}</div>) : <div className="muted">暂无歌词</div>}
      </div>
    </div>
  );
}
