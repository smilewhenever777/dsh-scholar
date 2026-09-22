/** Same-origin fetch helper for /dispatch/* routes(与 dsh-trajectory client 同款)。 */
export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const b = body as { error?: string; code?: string };
    throw new Error(b.error ? `${b.error}${b.code ? `(${b.code})` : ''}` : `HTTP ${res.status}`);
  }
  return body as T;
}
