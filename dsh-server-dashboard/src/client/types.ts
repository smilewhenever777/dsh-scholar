/** Wire types shared by the snapshot endpoint and the client panel. */

export interface GpuProcessInfo {
  pid: number;
  user: string;
  name: string;
  /** full command line (truncated ~200 chars) — identifies WHICH experiment runs */
  cmd?: string;
  /** MiB */
  memoryMiB: number;
}

export interface GpuInfo {
  index: number;
  name: string;
  /** driver uuid — used to map compute processes onto GPUs */
  uuid?: string;
  utilPercent: number;
  memoryUsedMiB: number;
  memoryTotalMiB: number;
  tempC: number;
  powerW: number;
  processes: GpuProcessInfo[];
  /** experiment log discovered for THIS gpu's processes */
  log?: LogTail;
  /** metric curves parsed from this gpu's log */
  series?: MetricSeries[];
}

export interface BaseInfo {
  cpuPercent: number;
  memUsedMiB: number;
  memTotalMiB: number;
  disks: { mount: string; usedPercent: number }[];
  /** 1-minute load average (absent when the read failed) */
  load1?: number;
}

export interface MetricSeries {
  /** metric name, e.g. "loss" */
  name: string;
  /** recent samples, oldest first */
  points: { t: number; v: number }[];
}

export interface LogTail {
  path: string;
  /** last lines, newest last */
  lines: string[];
  /** file size in bytes at snapshot time */
  size: number;
  /** mtime (ms epoch) at snapshot time */
  mtimeMs: number;
}

export interface ServerSnapshot {
  hostId: string;
  at: number;
  ok: boolean;
  error?: string;
  base?: BaseInfo;
  gpus?: GpuInfo[];
  log?: LogTail;
  series?: MetricSeries[];
  /** one-shot notice: the host auto-cleared a stalled logPath this poll —
   *  the client turns it into the experiment-finished toast (dedup by `at`) */
  stallNotice?: { path: string; minutes: number; at: number };
}
