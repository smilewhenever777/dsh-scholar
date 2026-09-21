/** Shared alarm thresholds — the dashboard's single source of truth so the
 *  heatmap cells, temp pills, anomaly flags and chart tones never drift apart. */

/** GPU is "hot" at or above this temperature (°C) */
export const TEMP_HOT = 82;
/** GPU enters the warm band at this temperature (°C) */
export const TEMP_WARM = 75;
/** utilization (%, 0-100) at/above which a GPU counts as maxed/saturated */
export const UTIL_SATURATED = 95;
/** disk usage (%) above which a mount is flagged */
export const DISK_WARN = 90;

export interface LogActivityStamp { mtimeMs: number; fresh?: boolean; changeAt?: number }

export function logStalled(log: LogActivityStamp | undefined, staleMinutes?: number, now = Date.now()): boolean {
  if (!log || log.mtimeMs <= 0) return false;
  if (log.fresh !== undefined) return !log.fresh;
  return staleMinutes !== undefined && now - log.mtimeMs >= staleMinutes * 60_000;
}

/** Prefer the host's local observation clock; remote mtime is legacy-only. */
export function logIdleMinutes(log: LogActivityStamp, now = Date.now()): number {
  const changed = log.changeAt ?? (log.fresh === undefined ? log.mtimeMs : now);
  return Math.max(0, Math.floor((now - changed) / 60_000));
}
