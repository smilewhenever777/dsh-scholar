import type { AbortLike } from './types.js';

export function throwIfCancelled(signal?: AbortLike | null): void {
  if (signal?.aborted) throw new Error('任务已取消');
}

/** The host jobs API exposes a flag; providers receive a real AbortSignal. */
export function providerSignal(signal?: AbortLike | null): { signal?: AbortSignal; dispose(): void } {
  if (!signal) return { dispose() {} };
  const controller = new AbortController();
  let timer: ReturnType<typeof setInterval> | undefined;
  if (signal.aborted) controller.abort();
  else timer = setInterval(() => {
    if (signal.aborted) { controller.abort(); clearInterval(timer); }
  }, 100);
  return { signal: controller.signal, dispose() { if (timer) clearInterval(timer); } };
}
