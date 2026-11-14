import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { fmtBytes, fmtGB } from "../../lib/format";
import { Icon } from "../../lib/icons";
import type { Proc } from "../../lib/types";
import { useData } from "../data";
import { Bar, CoreBars, Dial, Spark } from "../widgets";

export function MonitorPage() {
  const { cfg, sys, hist } = useData();
  const [byMem, setByMem] = useState(false);
  const [procs, setProcs] = useState<Proc[]>([]);
  useEffect(() => {
    let alive = true;
    const tick = () => api.procs(byMem).then((p) => alive && setProcs(p)).catch(() => {});
    tick();
    const id = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(id); };
  }, [byMem]);

  const c = (id: string) => cfg.metrics.find((m) => m.id === id)?.color ?? "var(--accent)";
  if (!sys) return null;
  const memPct = (sys.mem_used / sys.mem_total) * 100;
  const diskPct = sys.disk_total ? (sys.disk_used / sys.disk_total) * 100 : 0;
  const order = cfg.metrics.map((m) => m.id);

  const rows: Record<string, JSX.Element> = {
    cpu: (
      <div className="mon-cpu" key="cpu">
        <div className="mon-line">
          <Dial value={sys.cpu} color={c("cpu")} letter="C" size={22} />
          <span className="big">{Math.round(sys.cpu)}<small>%</small></span>
          <Spark values={hist.cpu} color={c("cpu")} max={100} className="grow" />
          {sys.gpu != null && order.includes("gpu") && <><Dial value={sys.gpu} color={c("gpu")} letter="G" size={22} /><span className="big">{Math.round(sys.gpu)}<small>%</small></span></>}
        </div>
        <CoreBars cores={sys.cores} color={c("cpu")} height={30} width={Math.max(4, Math.min(12, 300 / sys.cores.length - 3))} gap={3} />
      </div>
    ),
    mem: (
      <div className="mon-line" key="mem">
        <Dial value={memPct} color={c("mem")} letter="M" size={22} />
        <span className="big">{fmtGB(sys.mem_used)}<small> / {fmtGB(sys.mem_total)} GB</small></span>
        <Bar pct={memPct} color={c("mem")} style={{ flex: 1 }} />
      </div>
    ),
    gpu: <span key="gpu" />,
    net: (
      <div className="mon-line" key="net">
        <Icon name="down" size={15} className="ic" /><span className="mid" style={{ color: c("net") }}>{fmtBytes(sys.net_rx)}/s</span>
        <Spark values={hist.rx} color={c("net")} className="grow" />
        <Icon name="up" size={15} className="ic" /><span className="mid" style={{ color: c("net") }}>{fmtBytes(sys.net_tx)}/s</span>
        <Spark values={hist.tx} color={c("net")} className="grow" />
      </div>
    ),
    disk: (
      <div className="mon-line" key="disk">
        <Icon name="disk" size={15} className="ic" />
        <span className="mid">{sys.disk_name} {fmtGB(sys.disk_used)}<small> / {fmtGB(sys.disk_total)} GB</small></span>
        <Bar pct={diskPct} color={c("disk")} style={{ flex: 1 }} />
        {sys.battery && <span className="batt"><Icon name="bolt" size={12} className={sys.battery.charging ? "charging" : "ic"} />{Math.round(sys.battery.percent)}%</span>}
      </div>
    ),
  };

  return (
    <div className="monitor">
      <div className="mon-left">{order.map((id) => rows[id])}</div>
      <div className="mon-right">
        <div className="seg">
          <button className={!byMem ? "on" : ""} onClick={() => setByMem(false)}>CPU</button>
          <button className={byMem ? "on" : ""} onClick={() => setByMem(true)}>内存</button>
        </div>
        {procs.map((p) => (
          <div className="proc" key={p.name}>
            <span className="p-ava">{p.name.slice(0, 1).toUpperCase()}</span>
            <span className="p-name">{p.name}</span>
            <span className="p-val">{byMem ? fmtBytes(p.mem) : `${p.cpu.toFixed(1)}%`}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
