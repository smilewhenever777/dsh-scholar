/**
 * Live experiment progress for bound experiment nodes, projected client-side
 * from the dsh-server-dashboard REST surface (same-origin; the statusbar uses
 * the same pattern). Dashboard absence is non-fatal — degrade to no progress.
 *
 * Progress percentage: dashboard's series only keep the tqdm NUMERATOR
 * (`12/100 [` → progress=12), so the denominator is re-parsed here from the
 * raw log tail lines (`(\d+)/(\d+)\s*\[`, newest last).
 */
import { useEffect, useRef, useState } from 'react';
import type { TrajNode } from '../shared/types';

export interface DashProgress {
  /** 0–100 when derivable (tqdm cur/total in raw log lines) */
  pct: number | null;
  /** human label: "269/741" / "epoch 12" / "progress 87" */
  label: string;
  running: boolean;
  /** log mtime older than the dashboard's stale threshold while bound → likely stalled */
  stale: boolean;
}

const POLL_MS = 8000;
/** 停滞阈值兜底:dashboard 响应缺 staleMinutes 字段时回落 10min(正常以响应为准)。 */
const DEFAULT_STALE_MINUTES = 10;

interface SnapGpu {
  index?: number;
  utilPercent?: number;
  log?: { path: string; lines: string[]; mtimeMs: number };
  series?: { name: string; points: { t: number; v: number }[] }[];
  processes?: { cmd?: string }[];
}
interface SnapBody {
  hosts?: { id: string; name?: string }[];
  snapshots?: Record<string, { ok?: boolean; gpus?: SnapGpu[] }>;
  /** dashboard 配置的停滞阈值(分钟),与 /dash 配置同源;缺省回落 DEFAULT_STALE_MINUTES */
  staleMinutes?: number;
}

const normPath = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** Scan a log tail bottom-up for the newest tqdm `cur/total [` pair. */
function tqdmFromLines(lines: string[] | undefined): { pct: number; label: string } | null {
  if (!lines?.length) return null;
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 40; i--) {
    const m = /(\d+)\s*\/\s*(\d+)\s*\[/.exec(lines[i]);
    if (m) {
      const cur = Number(m[1]);
      const total = Number(m[2]);
      if (total > 0) return { pct: Math.max(0, Math.min(100, (cur / total) * 100)), label: `${cur}/${total}` };
    }
  }
  return null;
}

function gpuMatches(gpu: SnapGpu, node: TrajNode): boolean {
  const refs = node.refs;
  if (!refs) return false;
  if (refs.logPath && gpu.log?.path) {
    if (normPath(gpu.log.path) === normPath(refs.logPath)) return true;
  }
  if (refs.cmdPattern) {
    const pat = refs.cmdPattern.toLowerCase();
    if ((gpu.processes ?? []).some((p) => typeof p.cmd === 'string' && p.cmd.toLowerCase().includes(pat))) return true;
  }
  return false;
}

function progressOfGpu(gpu: SnapGpu, staleMs: number): DashProgress | null {
  const log = gpu.log;
  const stale = !!log && Date.now() - log.mtimeMs >= staleMs;
  const tqdm = tqdmFromLines(log?.lines);
  if (tqdm) {
    return { pct: tqdm.pct, label: tqdm.label, running: !stale, stale };
  }
  const series = gpu.series ?? [];
  const pick = (name: string) => {
    const s = series.find((x) => x.name === name);
    const last = s?.points[s.points.length - 1];
    return last ? last.v : null;
  };
  const prog = pick('progress');
  if (prog !== null) return { pct: prog <= 1 ? prog * 100 : null, label: `progress ${prog}`, running: !stale, stale };
  const epoch = pick('epoch');
  if (epoch !== null) return { pct: null, label: `epoch ${epoch}`, running: !stale, stale };
  if (log || (gpu.processes?.length ?? 0) > 0) {
    return { pct: null, label: '', running: !stale, stale };
  }
  return null;
}

/**
 * @param nodes project nodes (experiment bindings extracted inside)
 * @param enabled poll only while the drawer is open
 */
export function useDashProgress(nodes: TrajNode[], enabled: boolean): Map<string, DashProgress> {
  const [map, setMap] = useState<Map<string, DashProgress>>(new Map());
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  const boundCount = nodes.filter((n) => n.kind === 'experiment' && n.refs
    && !!(n.refs.logPath || n.refs.cmdPattern)).length;

  useEffect(() => {
    if (!enabled || boundCount === 0) {
      setMap(new Map());
      return;
    }
    let alive = true;

    const refresh = async () => {
      const current = nodesRef.current;
      const bindings = current.filter((n) => n.kind === 'experiment' && n.refs
        && !!(n.refs.logPath || n.refs.cmdPattern));
      if (!bindings.length) return;
      let body: SnapBody | null = null;
      try {
        const res = await fetch('/dash/snapshots', { headers: { accept: 'application/json' } });
        if (res.ok) body = await res.json() as SnapBody;
      } catch {
        body = null;
      }
      if (!alive) return;
      // 停滞阈值优先取 dashboard 响应的 staleMinutes(与 /dash 配置同源),缺字段回落 10min
      const staleMinutes = typeof body?.staleMinutes === 'number' && body.staleMinutes > 0
        ? body.staleMinutes
        : DEFAULT_STALE_MINUTES;
      const staleMs = staleMinutes * 60_000;
      const next = new Map<string, DashProgress>();
      if (body?.snapshots && body.hosts) {
        for (const node of bindings) {
          const hostFilter = node.refs?.hostId;
          let hit: DashProgress | null = null;
          for (const host of body.hosts) {
            if (hostFilter && host.id !== hostFilter) continue;
            const snap = body.snapshots[host.id];
            if (!snap?.ok) continue;
            for (const gpu of snap.gpus ?? []) {
              if (!gpuMatches(gpu, node)) continue;
              const p = progressOfGpu(gpu, staleMs);
              if (p) { hit = p; break; }
            }
            if (hit) break;
          }
          if (hit) next.set(node.id, hit);
        }
      }
      setMap(next);
    };

    void refresh();
    const timer = setInterval(() => { void refresh(); }, POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [enabled, boundCount]);

  return map;
}
