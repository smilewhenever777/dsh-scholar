/** Same-origin fetch helper for /dispatch/* routes(与 dsh-trajectory client 同款);
 * 抛出的 Error 携带 .status 与 .code,便于 UI 做 409 等友好映射。 */
export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const b = body as { error?: string; code?: string };
    const err = new Error(b.error ? `${b.error}${b.code ? `(${b.code})` : ''}` : `HTTP ${res.status}`);
    (err as Error & { status?: number; code?: string }).status = res.status;
    (err as Error & { status?: number; code?: string }).code = b.code;
    throw err;
  }
  return body as T;
}
