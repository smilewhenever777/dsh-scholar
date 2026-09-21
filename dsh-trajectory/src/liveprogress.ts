/**
 * dsh-trajectory — host 侧实验实时进度(dashboard loopback 投影)。
 *
 * traj_overview 输出并入实时进度,让模型口头汇报也能报出「epoch 142/300、无停滞」,
 * 而不是「未见具体日志/进度报告」。匹配逻辑与 client/dash.ts 同一套语义:
 *   logPath 精确(归一化) > cmdPattern 子串;进度优先取原始日志行的 tqdm cur/total
 *   (dashboard series 只存分子),回退 series progress/epoch 原始值。
 * dashboard 不可达时静默降级(返回空数组),绝不影响 overview 本身。
 */
import type { TrajNode, TrajProjectFile } from './shared/types.js';
import type { Context } from '@deepseek-ai/cordis';

export interface LiveProgressItem {
  nodeId: string;
  title: string;
  /** 0–100,分母不可得时 null */
  pct: number | null;
  /** "269/741" / "epoch 142" / "progress 87" */
  label: string;
  /** 日志 mtime 超过 dashboard staleMinutes */
  stale: boolean;
}

interface SnapGpu {
  index?: number;
  log?: { path?: string; lines?: string[]; mtimeMs?: number; fresh?: boolean };
  series?: { name: string; points: { t: number; v: number }[] }[];
  processes?: { cmd?: string }[];
}
interface DashBody {
  hosts?: { id: string; name?: string }[];
  snapshots?: Record<string, { ok?: boolean; gpus?: SnapGpu[] }>;
  staleMinutes?: number;
}

const DEFAULT_STALL_MIN = 10;

const normPath = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** 倒序扫日志尾,取最新 tqdm `cur/total [` 对(分母只在原始行里)。 */
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
  if (refs.logPath && gpu.log?.path && normPath(gpu.log.path) === normPath(refs.logPath)) return true;
  if (refs.cmdPattern) {
    const pat = refs.cmdPattern.toLowerCase();
    if ((gpu.processes ?? []).some((p) => typeof p.cmd === 'string' && p.cmd.toLowerCase().includes(pat))) return true;
  }
  return false;
}

function progressOfGpu(gpu: SnapGpu, staleMs: number): LiveProgressItem | null {
  const log = gpu.log;
  // F23:宿主盖章的增量新鲜度优先;未盖章(fresh 缺失,如合成数据/旧缓存)回退旧启发式
  const stale = !!log?.mtimeMs && (log.fresh === false || (log.fresh === undefined && Date.now() - (log.mtimeMs ?? 0) >= staleMs));
  const tqdm = tqdmFromLines(log?.lines);
  if (tqdm) return { nodeId: '', title: '', pct: tqdm.pct, label: tqdm.label, stale };
  const series = gpu.series ?? [];
  const pick = (name: string): number | null => {
    const s = series.find((x) => x.name === name);
    const last = s?.points[s.points.length - 1];
    return last ? last.v : null;
  };
  const prog = pick('progress');
  if (prog !== null) return { nodeId: '', title: '', pct: prog <= 1 ? prog * 100 : null, label: `progress ${prog}`, stale };
  const epoch = pick('epoch');
  if (epoch !== null) return { nodeId: '', title: '', pct: null, label: `epoch ${epoch}`, stale };
  if (log || (gpu.processes?.length ?? 0) > 0) return { nodeId: '', title: '', pct: null, label: '', stale };
  return null;
}

/** loopback 基址:优先 webServer 实际端口(支持动态分配),退 DSH_WEB_PORT,再退 3080。 */
export function apiBase(ctx: Context): string {
  const port = (ctx as { webServer?: { port?: number } }).webServer?.port;
  const p = typeof port === 'number' && port > 0
    ? port
    : Number(process.env.DSH_WEB_PORT) || 3080;
  return `http://127.0.0.1:${p}`;
}

export async function fetchDashSnapshots(base: string): Promise<DashBody | null> {
  try {
    const res = await fetch(`${base}/dash/snapshots`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    return (await res.json()) as DashBody;
  } catch {
    return null; // dashboard 未装/不可达 → 降级
  }
}

/** 项目内全部绑定实验节点的实时进度(dashboard 缺席 → 空数组)。 */
export function matchLiveProgress(file: TrajProjectFile, dash: DashBody | null): LiveProgressItem[] {
  if (!dash?.snapshots || !dash.hosts) return [];
  const staleMin = Number(dash.staleMinutes);
  const staleMs = (staleMin > 0 ? staleMin : DEFAULT_STALL_MIN) * 60_000;
  const out: LiveProgressItem[] = [];
  for (const node of file.nodes) {
    if (node.kind !== 'experiment' || !node.refs) continue;
    if (!node.refs.logPath && !node.refs.cmdPattern) continue;
    const hostFilter = node.refs.hostId;
    let hit: LiveProgressItem | null = null;
    for (const host of dash.hosts) {
      if (hostFilter && host.id !== hostFilter) continue;
      const snap = dash.snapshots[host.id];
      if (!snap?.ok) continue;
      for (const gpu of snap.gpus ?? []) {
        if (!gpuMatches(gpu, node)) continue;
        const p = progressOfGpu(gpu, staleMs);
        if (p) { hit = p; break; }
      }
      if (hit) break;
    }
    if (hit) out.push({ ...hit, nodeId: node.id, title: node.title });
  }
  return out;
}
