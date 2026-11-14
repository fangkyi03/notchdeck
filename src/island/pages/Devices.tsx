import { useData } from "../data";
import { Rings } from "../widgets";

const ICON: Record<string, string> = { mouse: "🖱", keyboard: "⌨️", trackpad: "▭", headphones: "🎧", gamepad: "🎮", other: "🔵" };
export const batteryColor = (p: number) => (p <= 10 ? "#ff453a" : p <= 20 ? "#ff9f0a" : "#30d158");

export function DevicesPage() {
  const { devices, messages } = useData();
  if (!devices.length) {
    return (
      <div className="empty">没有读到无线设备电量
        <small>{messages.platform === "windows"
          ? "需要设备通过蓝牙连接并向系统报告电量（Windows 设置 › 蓝牙和设备 中能看到电量的设备）"
          : "macOS 可读取 Apple 键盘、鼠标、触控板和 AirPods 等向系统报告电量的设备；部分第三方蓝牙设备不向系统报告电量"}</small>
      </div>
    );
  }
  return (
    <div className="devs">
      {devices.map((d) => (
        <div key={d.name} className="dev">
          <div className="dev-ring">
            <Rings values={[d.percent]} color={batteryColor(d.percent)} size={58} stroke={5} />
            <span className="dev-ic">{ICON[d.kind] ?? ICON.other}</span>
          </div>
          <b className="dev-pct" style={{ color: d.percent <= 20 ? batteryColor(d.percent) : undefined }}>{d.percent}%</b>
          <span className="dev-name" title={d.name}>{d.name}</span>
          {d.parts.length > 0 && <span className="muted small">{d.parts.map((p) => `${p.label} ${p.percent}%`).join(" · ")}</span>}
        </div>
      ))}
    </div>
  );
}
