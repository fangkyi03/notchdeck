import type { CSSProperties } from "react";

/** Concentric quota rings; `values` from outer to inner (0–100, null = no data). */
export function Rings({ values, color, size = 18, stroke = 2.6, label }: { values: (number | null)[]; color: string | string[]; size?: number; stroke?: number; label?: string }) {
  const gap = 1;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="ring">
      {values.map((v, i) => {
        const r = size / 2 - stroke / 2 - i * (stroke + gap);
        if (r <= 1) return null;
        const c = 2 * Math.PI * r;
        const col = Array.isArray(color) ? color[i] ?? color[0] : color;
        return (
          <g key={i}>
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--track)" strokeWidth={stroke} />
            {v != null && (
              <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={col} strokeWidth={stroke} strokeLinecap="round"
                strokeDasharray={`${(Math.max(0, Math.min(100, v)) / 100) * c} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`}
                style={{ transition: "stroke-dasharray .5s" }} />
            )}
          </g>
        );
      })}
      {label && <text x="50%" y="52%" dominantBaseline="middle" textAnchor="middle" fontSize={size * 0.42} fontWeight={700} fill="currentColor">{label}</text>}
    </svg>
  );
}

/** Ring with a letter in the middle (C / M / G), like a gauge. */
export function Dial({ value, color, letter, size = 20 }: { value: number | null; color: string; letter: string; size?: number }) {
  return <Rings values={[value]} color={color} size={size} stroke={2.4} label={letter} />;
}

export function Spark({ values, color, max, height = 22, fill = true, className }: { values: number[]; color: string; max?: number; height?: number; fill?: boolean; className?: string }) {
  if (values.length < 2) return <svg className={className} height={height} />;
  const m = Math.max(max ?? 0, ...values, 1e-9);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * 100, height - 1 - (v / m) * (height - 2)]);
  const line = pts.map((p) => p.join(",")).join(" ");
  return (
    <svg className={className} viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" height={height} style={{ width: "100%", display: "block" }}>
      {fill && <polygon points={`0,${height} ${line} 100,${height}`} fill={color} opacity={0.18} />}
      <polyline points={line} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

export function Bar({ pct, color, height = 4, style }: { pct: number; color: string; height?: number; style?: CSSProperties }) {
  return (
    <div className="bar" style={{ height, ...style }}>
      <i style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }} />
    </div>
  );
}

/** Vertical mini bars, one per CPU core. */
export function CoreBars({ cores, color, height = 16, width = 3, gap = 1.5 }: { cores: number[]; color: string; height?: number; width?: number; gap?: number }) {
  return (
    <svg width={cores.length * (width + gap)} height={height} className="cores">
      {cores.map((c, i) => {
        const h = Math.max(1.5, (c / 100) * height);
        return (
          <g key={i}>
            <rect x={i * (width + gap)} y={0} width={width} height={height} rx={1} fill="var(--track)" />
            <rect x={i * (width + gap)} y={height - h} width={width} height={h} rx={1} fill={color} style={{ transition: "height .4s, y .4s" }} />
          </g>
        );
      })}
    </svg>
  );
}

/** Animated equalizer bars; freezes when paused. */
export function Eq({ playing, color = "var(--accent)", bars = 5, height = 14 }: { playing: boolean; color?: string; bars?: number; height?: number }) {
  return (
    <span className={`eq ${playing ? "on" : ""}`} style={{ height, color }}>
      {Array.from({ length: bars }, (_, i) => <i key={i} style={{ animationDelay: `${(i * 137) % 600}ms` }} />)}
    </span>
  );
}

export function Cover({ src, size }: { src: string; size: number }) {
  return src
    ? <img className="cover" src={src} width={size} height={size} draggable={false} alt="" />
    : <span className="cover cover-empty" style={{ width: size, height: size }}>♪</span>;
}
