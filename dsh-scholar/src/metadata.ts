/**
 * dsh-scholar — outbound paper-metadata lookup (host half).
 *
 * `fetchMetadata(input)` accepts an arXiv id, arXiv abs/pdf URL, DOI or
 * doi.org URL and returns normalized paper fields. Sources: the official
 * arXiv Atom API and api.crossref.org. Zero dependencies; when HTTPS_PROXY /
 * HTTP_PROXY is set, requests tunnel through it via a CONNECT agent.
 */
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import type { Socket } from 'node:net';

export interface PaperMeta {
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  arxivId?: string;
  doi?: string;
  url?: string;
  abstract?: string;
}

/** 与直连路径一致的 UA（代理路径也带上，避免被数据源按默认 UA 拦截）。 */
const USER_AGENT = 'dsh-scholar/0.1 (paper library)';
const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_REDIRECTS = 5;

/* ---------- input classification ---------- */

const ARXIV_NEW = /^(\d{4}\.\d{4,5})(v\d+)?$/i;

/** Try to read an arXiv id out of arbitrary user input; null if not arXiv-ish. */
export function parseArxivId(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  // bare new-style id (with optional version)
  let m = ARXIV_NEW.exec(s);
  if (m) return m[1];
  try {
    const u = new URL(s.startsWith('http') ? s : `https://${s}`);
    if (!/arxiv\.org$/i.test(u.hostname)) return null;
    m = /\/abs\/([^/?#]+)/i.exec(u.pathname) ?? /\/pdf\/([^/?#]+?)(?:\.pdf)?$/i.exec(u.pathname);
    if (!m) return null;
    const raw = decodeURIComponent(m[1]).replace(/^arxiv:/i, '');
    const n = ARXIV_NEW.exec(raw);
    return n ? n[1] : null;
  } catch {
    return null;
  }
}

/** Read a bare or doi.org-wrapped DOI; null if not DOI-ish. */
export function parseDoi(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  s = s.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  if (/^10\.\d{4,9}\/\S+$/.test(s)) return s;
  return null;
}

/* ---------- proxy-aware https helpers ---------- */

const proxyUrl = (): string | undefined =>
  process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;

/** 代理 URL 带用户名/密码时生成 Proxy-Authorization 头（Basic）。 */
function proxyAuthHeader(pu: URL): Record<string, string> {
  if (!pu.username && !pu.password) return {};
  const cred = `${decodeURIComponent(pu.username)}:${decodeURIComponent(pu.password)}`;
  return { 'proxy-authorization': `Basic ${Buffer.from(cred).toString('base64')}` };
}

/** 经代理建立 CONNECT 隧道（带超时，无响应即销毁而不是永久挂起）。 */
function connectViaProxy(pu: URL, targetHost: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const setup = http.request({
      host: pu.hostname,
      port: Number(pu.port || 443),
      method: 'CONNECT',
      path: `${targetHost}:443`,
      headers: {
        host: `${targetHost}:443`,
        ...proxyAuthHeader(pu),
      },
    });
    setup.setTimeout(timeoutMs, () => setup.destroy(new Error('代理 CONNECT 超时')));
    setup.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`代理 CONNECT 失败 (${res.statusCode})`));
        return;
      }
      resolve(socket);
    });
    setup.once('error', reject);
    setup.end();
  });
}

/** 在已建立的隧道上发一次 GET（不跟重定向），响应体流式累计、超限即断开。 */
function tunneledGetOnce(
  u: URL,
  socket: Socket,
  timeoutMs: number,
  accept: string,
  maxBytes: number,
): Promise<{ status: number; location?: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: u.hostname,
      path: `${u.pathname}${u.search}`,
      method: 'GET',
      headers: { host: u.host, accept, 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
      createConnection: () => tls.connect({ socket, servername: u.hostname }),
    }, (r) => {
      const chunks: Buffer[] = [];
      let total = 0;
      r.on('data', (c: Buffer) => {
        total += c.length;
        if (total > maxBytes) {
          req.destroy(); // 超限立刻断流，而不是全量入内存后再检查
          reject(new Error(`响应体超过大小上限（${Math.floor(maxBytes / 1024 / 1024)}MB）`));
          return;
        }
        chunks.push(c);
      });
      r.on('end', () => resolve({
        status: r.statusCode ?? 500,
        location: typeof r.headers.location === 'string' ? r.headers.location : undefined,
        body: Buffer.concat(chunks),
      }));
    });
    req.once('error', reject);
    req.end();
  });
}

/**
 * 代理路径 GET（CONNECT 隧道 + 手动跟随 3xx，≤5 跳）。我们只发 GET，
 * 301/302/303 的"改写为 GET"语义天然满足；每跳重建隧道以支持跨 host 重定向。
 */
async function proxyGet(url: string, timeoutMs: number, proxy: string, accept: string, maxBytes: number): Promise<Buffer> {
  let current = new URL(url);
  if (current.protocol !== 'https:') throw new Error('仅支持 https 数据源');
  const pu = new URL(proxy);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const socket = await connectViaProxy(pu, current.host, timeoutMs);
    let res: { status: number; location?: string; body: Buffer };
    try {
      res = await tunneledGetOnce(current, socket, timeoutMs, accept, maxBytes);
    } catch (err) {
      socket.destroy();
      throw err;
    }
    socket.destroy();
    if (res.status >= 300 && res.status < 400 && res.location) {
      if (hop === MAX_REDIRECTS) throw new Error(`重定向超过 ${MAX_REDIRECTS} 跳`);
      const next = new URL(res.location, current);
      if (next.protocol !== 'https:') throw new Error('重定向目标不是 https，已停止跟随');
      current = next;
      continue;
    }
    if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
    return res.body;
  }
  throw new Error(`重定向超过 ${MAX_REDIRECTS} 跳`);
}

/** 直连 fetch 的流式读取 + 大小上限（与代理路径同语义，超限即取消下载）。 */
async function fetchBodyWithLimit(res: Response, maxBytes: number): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.from(await res.arrayBuffer());
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`响应体超过大小上限（${Math.floor(maxBytes / 1024 / 1024)}MB）`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * GET an https resource as text. Proxy resolution order: explicit argument
 * (plugin setting) → HTTPS_PROXY/HTTP_PROXY env → direct fetch.
 */
export async function getText(url: string, timeoutMs = 15000, proxyOverride?: string): Promise<string> {
  const signal = AbortSignal.timeout(timeoutMs);
  const proxy = proxyOverride || proxyUrl();
  if (!proxy) {
    const res = await fetch(url, { signal, headers: { 'user-agent': USER_AGENT } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await fetchBodyWithLimit(res, MAX_TEXT_BYTES);
    return body.toString('utf8');
  }
  const body = await proxyGet(url, timeoutMs, proxy, '*/*', MAX_TEXT_BYTES);
  return body.toString('utf8');
}

const decodeEntities = (s: string): string =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;|&#x27;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ').trim();

/**
 * GET an https resource as raw bytes (PDF download). Same proxy resolution
 * as getText: explicit argument (plugin setting) -> env proxy -> direct.
 */
export async function fetchPdf(url: string, timeoutMs = 60000, proxyOverride?: string): Promise<Buffer> {
  const signal = AbortSignal.timeout(timeoutMs);
  const proxy = proxyOverride || proxyUrl();
  if (!proxy) {
    const res = await fetch(url, { signal, headers: { 'user-agent': USER_AGENT } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return fetchBodyWithLimit(res, MAX_PDF_BYTES);
  }
  return proxyGet(url, timeoutMs, proxy, 'application/pdf,*/*', MAX_PDF_BYTES);
}

/** Minimal Atom entry reader for the arXiv API response. */
export function parseArxivFeed(xml: string): Omit<PaperMeta, 'arxivId'> & { arxivId: string } {
  const entry = /<entry>([\s\S]*?)<\/entry>/.exec(xml)?.[1];
  if (!entry) throw new Error('arXiv 返回中没有条目（id 可能无效）');
  const tag = (name: string): string => {
    const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(entry);
    return m ? decodeEntities(m[1]) : '';
  };
  const title = tag('title');
  if (!title) throw new Error('arXiv 条目缺少标题');
  const authors = [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)]
    .map((m) => decodeEntities(m[1]));
  const published = tag('published');
  const year = Number(published.slice(0, 4)) || undefined;
  const journalRef = tag('arxiv:journal_ref');
  const idAttr = /<id>http:\/\/arxiv\.org\/abs\/([^<]+)<\/id>/.exec(entry)?.[1] ?? '';
  const abstract = tag('summary');
  return {
    title,
    authors,
    year,
    venue: journalRef || 'arXiv',
    arxivId: ARXIV_NEW.exec(idAttr)?.[1] ?? idAttr.replace(/v\d+$/i, ''),
    abstract,
  };
}

/** 仅 429/网络类瞬态错误（限流、超时、断连、代理失败）值得重试；解析失败等确定性错误直接抛。 */
function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /429|timeout|timed out|abort|ECONN|socket|network|fetch failed|代理/i.test(msg);
}

async function fetchArxiv(arxivId: string, proxy?: string): Promise<PaperMeta> {
  const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}&max_results=1`;
  // arXiv asks for ~3s between API hits and answers 429 when a burst arrives;
  // retry once after a polite pause before giving up (仅限流/网络类瞬态错误).
  try {
    return parseArxivFeed(await getText(url, 20000, proxy));
  } catch (err) {
    if (!isTransientError(err)) throw err;
    await new Promise((r) => setTimeout(r, 3500));
    return parseArxivFeed(await getText(url, 20000, proxy));
  }
}

/** CrossRef JSON → common shape; exported for tests (pure). */
export function crossrefToMeta(body: {
  message?: {
    title?: string[];
    author?: { given?: string; family?: string; name?: string }[];
    issued?: { 'date-parts'?: number[][] };
    'container-title'?: string[];
    'published-print'?: { 'date-parts'?: number[][] };
    DOI?: string;
    URL?: string;
    abstract?: string;
  };
}): PaperMeta {
  const msg = body.message ?? {};
  const title = msg.title?.[0]?.trim();
  if (!title) throw new Error('CrossRef 条目缺少标题');
  const year =
    msg.issued?.['date-parts']?.[0]?.[0] ??
    msg['published-print']?.['date-parts']?.[0]?.[0];
  const authors = (msg.author ?? []).map((a) =>
    ([a.given, a.family].filter(Boolean).join(' ') || a.name || ''),
  ).filter(Boolean);
  const jats = msg.abstract ?? '';
  const abstract = decodeEntities(jats.replace(/<[^>]+>/g, '')).replace(/^Abstract\s*[:.]?\s*/i, '') || undefined;
  return {
    title,
    authors,
    year: typeof year === 'number' ? year : undefined,
    venue: msg['container-title']?.[0] || undefined,
    doi: msg.DOI,
    url: msg.URL || (msg.DOI ? `https://doi.org/${msg.DOI}` : undefined),
    abstract,
  };
}

async function fetchDoi(doi: string, proxy?: string): Promise<PaperMeta> {
  const text = await getText(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, 15000, proxy);
  return crossrefToMeta(JSON.parse(text));
}

/** Main entry: classify input then query the matching source. */
export async function fetchMetadata(input: string, proxy?: string): Promise<PaperMeta> {
  const s = input.trim();
  if (!s) throw new Error('请输入 arXiv 链接/编号或 DOI');
  const arxiv = parseArxivId(s);
  if (arxiv) return fetchArxiv(arxiv, proxy);
  const doi = parseDoi(s);
  if (doi) return fetchDoi(doi, proxy);
  throw new Error('无法识别的输入：请提供 arXiv 链接/编号（如 2106.09685）或 DOI');
}
