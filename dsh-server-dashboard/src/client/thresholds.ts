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

