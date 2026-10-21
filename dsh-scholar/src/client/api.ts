export { api, qs } from '../../../shared-client/src/index';


/**
 * 筛选/排序状态按 tab 存 sessionStorage（重新挂载恢复，关闭页面即失效）。
 * sessionStorage 在某些沙箱环境会抛异常——全部 try/catch 静默降级。
 */
export function loadSavedFilters<T>(key: string): Partial<T> {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Partial<T> : {};
  } catch {
    return {};
  }
}

export function saveFilters(key: string, value: unknown): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable — filters just won't persist */
  }
}
