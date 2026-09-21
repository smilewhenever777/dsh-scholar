/**
 * dsh-scholar — REST routes under /scholar/* (host half).
 *
 * NOTE: routes must NOT live under /api — dsh-client-connection owns the
 * /api prefix (RPC bridge) and would swallow them.
 *
 * POST/PUT bodies are forced to application/json (CSRF hardening, same as
 * dsh-server-dashboard). Validation uses schemastery schemas.
 */
import type { Context } from '@deepseek-ai/cordis';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import z from 'schemastery';
import type { CardQuery, CardSort, KnowledgeGraph, PaperQuery, PaperSort, ReadStatus, ScholarConfig } from './shared/types.js';
import type { PaperStore } from './store.js';
import {
  allCardTags, allPaperTags, assertRebuildAllowed, conceptId, conceptSubgraph, filterCards, filterPapers, mergeGraph,
  safeName,
} from './store.js';
import { applyCardPatch, applyPaperPatch, createCard, createPaper, findDuplicate, findSimilarCards } from './domain.js';
import { fetchMetadata } from './metadata.js';
import { getRelatedReport, citeSyncPatch } from './related.js';
import { createReadEngine } from './read/engine.js';
import type { PaperOutcome } from './read/engine.js';
import { runCompare, runCompareEntries } from './read/compare.js';
import { renderCompareHtml } from './read/render.js';
import { archiveReadResult } from './read/archive.js';
import { loadSession, appendQA } from './read/session.js';
import { extractPdfFigures } from './read/figures.js';
import { createFigureReader } from './read/vlm.js';
import { createAsker as createAskerRoute } from './read/ask.js';

const PDF_MAX_BYTES = 50 * 1024 * 1024;

/* ---------- UI 启动的后台精读：内存进度注册表（单活动 run，新 run 替换旧 run） ---------- */
export interface ReadRunPaper {
  title: string;
  state: 'pending' | 'running' | 'ok' | 'fail';
}
export interface ReadRunState {
  id: number;
  mode: 'paper' | 'quick';
  total: number;
  skipped: number;
  startedAt: number;
  finishedAt: number | null;
  ok: number;
  fail: number;
  papers: ReadRunPaper[];
  /** 引擎 onProgress 的最新一行（"解析 PDF 32%""学术精读第 2/5 段"…） */
  phase: string;
  /** 最后一次失败的原因（供横幅展示，截断 200 字） */
  error: string;
}
let readRun: ReadRunState | null = null;
let readRunSeq = 0;
/** F12:活动 run 的取消信号——新 run 启动前必须先确认旧 run 已结束或被取消,
 * 防止后台任务重叠消耗模型额度且 UI 只见最后一个;/scholar/read/cancel 可中止。 */
let activeSignal: { aborted: boolean } | null = null;
function readRunBusy(): ReadRunState | null {
  if (readRun && readRun.finishedAt === null) return readRun;
  return null;
}

const PaperInputSchema = z.object({
  title: z.string().required(),
  authors: z.array(z.string()).default([]),
  year: z.number().step(1).min(1900).max(2100),
  venue: z.string().default(''),
  arxivId: z.string().default(''),
  doi: z.string().default(''),
  url: z.string().default(''),
  abstract: z.string().default(''),
  summary: z.string().default(''),
  tags: z.array(z.string()).default([]),
  importance: z.number().step(1).min(1).max(5),
  readStatus: z.union(['want', 'reading', 'done']).default('want'),
  notes: z.string().default(''),
});

/**
 * PUT / dup+update 专用的部分更新 schema：所有字段可选、无默认值——
 * 未提交的字段不会出现在输出里，applyPatch 视为"保持不变"而不是"清空"。
 * （带 default 的全量 schema 会把缺字段填满，PUT {importance:5} 会静默清空 summary/tags。）
 * 导出供冒烟/手工验证脚本直接使用。
 */
export const PaperPatchInputSchema = z.object({
  title: z.string(),
  authors: z.array(z.string()),
  year: z.number().step(1).min(1900).max(2100),
  venue: z.string(),
  arxivId: z.string(),
  doi: z.string(),
  url: z.string(),
  abstract: z.string(),
  summary: z.string(),
  tags: z.array(z.string()),
  importance: z.number().step(1).min(1).max(5),
  readStatus: z.union(['want', 'reading', 'done']),
  notes: z.string(),
});

const CardInputSchema = z.object({
  title: z.string().required(),
  insight: z.string().required(),
  paperId: z.string().default(''),
  category: z.union(['method', 'theory', 'dataset', 'evaluation', 'engineering', 'other']).default('other'),
  tags: z.array(z.string()).default([]),
  importance: z.number().step(1).min(1).max(5).default(3),
  status: z.union(['pending', 'validated', 'adopted', 'dropped']).default('pending'),
  notes: z.string().default(''),
  evidence: z.string().default(''),
});

/** PUT 卡片的部分更新 schema（语义同 PaperPatchInputSchema，无默认值；导出供验证脚本使用）。 */
const CardPatchInputSchema = z.object({
  title: z.string(),
  insight: z.string(),
  paperId: z.string(),
  category: z.union(['method', 'theory', 'dataset', 'evaluation', 'engineering', 'other']),
  tags: z.array(z.string()),
  importance: z.number().step(1).min(1).max(5),
  status: z.union(['pending', 'validated', 'adopted', 'dropped']),
  notes: z.string(),
  evidence: z.string(),
});

/**
 * schemastery 对未提交的可选数组字段会隐式填 []（等效默认值，实测确认），
 * 会把 patch 语义破坏成"清空该字段"。这里把校验输出裁剪为"实际出现在
 * 提交 body 里的字段"：既保留类型校验，又保证 PUT 只动用户提交的字段。
 */
export function pickSubmitted<S extends (data: any) => object>(schema: S, body: Record<string, any>): Partial<ReturnType<S>> {
  const out = { ...(schema(body) as Record<string, unknown>) };
  for (const k of Object.keys(out)) {
    if (!(k in body)) delete out[k];
  }
  return out as Partial<ReturnType<S>>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    // F02:严格媒体类型——分号前主类型必须精确等于 application/json;includes 匹配
    // 可被 "text/plain;application/json" 绕过(浏览器简单请求不需预检即可携带)
    const ct = String(req.headers['content-type'] ?? '');
    if (ct.split(';')[0].trim().toLowerCase() !== 'application/json') {
      reject(new Error('请求必须是 application/json'));
      return;
    }
    // F02:Host 必须是回环域——DNS rebinding 把外域解析到 127.0.0.1 时 Host 是外域名
    const hostRaw = String(req.headers.host ?? '').toLowerCase();
    let hostName = hostRaw;
    if (hostName.startsWith('[')) hostName = hostName.slice(1, hostName.includes(']') ? hostName.indexOf(']') : undefined);
    else if (hostName.includes(':')) hostName = hostName.split(':')[0];
    // R17:IPv6 loopback 统一去方括号比较(WHATWG hostname 对 IPv6 带 [::1])
    const normHost = hostName.replace(/^\[/, '').replace(/\]$/, '');
    if (hostName && !['localhost', '127.0.0.1', '::1'].includes(normHost)) {
      reject(new Error('非法 Host'));
      return;
    }
    // F02:浏览器跨源请求的 Origin 必须与 Host 同源——本机其他端口的页面发起的
    // 简单 CSRF 因此被拒;无 Origin 的非浏览器客户端放行(loopback 对端已校验)
    const origin = String(req.headers.origin ?? '');
    if (origin) {
      try {
        const o = new URL(origin);
        const oHost = (o.hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
        const loopback = oHost === 'localhost' || oHost === '127.0.0.1' || oHost === '::1';
        const sameOrigin = o.host === hostRaw || (oHost === hostName && !o.port && !hostRaw.includes(':'));
        if (!loopback || !sameOrigin) {
          reject(new Error('跨源请求被拒绝'));
          return;
        }
      } catch {
        reject(new Error('非法 Origin'));
        return;
      }
    }
    // F10:按字节缓冲、超限即断流、结束时一次性 UTF-8 解码——逐 chunk 字符串拼接会把多字节汉字拆坏
    const chunks: Buffer[] = [];
    let bytes = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      if (over) return;
      chunks.push(chunk);
      bytes += chunk.length;
      if (bytes > 1_000_000) {
        over = true;
        req.destroy();
        reject(new Error('请求体过大'));
      }
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}
function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ct = String(req.headers['content-type'] ?? '');
    if (!ct.includes('application/octet-stream')) {
      reject(new Error('上传必须是 application/octet-stream'));
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error(`文件过大（上限 ${Math.floor(maxBytes / 1024 / 1024)}MB）`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, code: number, payload: unknown): void {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

/** 403 unless loopback(与 dsh-server-dashboard 同款):0.1.5 的 Web 认证门不覆盖
 * 插件命名路由,/scholar/* 需要自己的本机围栏 */
function guardRoute(req: import('node:http').IncomingMessage, res: ServerResponse): boolean {
  // F02:Host 必须是回环域——DNS rebinding 把外域解析到 127.0.0.1 时 Host 是外域名
  const hostRaw = String(req.headers.host ?? '').toLowerCase();
  let hostName = hostRaw;
  if (hostName.startsWith('[')) hostName = hostName.slice(1, hostName.includes(']') ? hostName.indexOf(']') : undefined);
  else if (hostName.includes(':')) hostName = hostName.split(':')[0];
  if (hostName && !['localhost', '127.0.0.1', '::1'].includes(hostName)) {
    sendJson(res, 403, { error: '非法 Host' });
    return false;
  }
  // F02:浏览器跨源请求的 Origin 必须与 Host 同源——本机其他端口的页面发起的简单 CSRF 因此被拒
  const origin = String(req.headers.origin ?? '');
  if (origin) {
    try {
      const o = new URL(origin);
      const oHost = (o.hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
      const loopback = oHost === 'localhost' || oHost === '127.0.0.1' || oHost === '::1';
      const sameOrigin = o.host === hostRaw || (oHost === hostName && !o.port && !hostRaw.includes(':'));
      if (!loopback || !sameOrigin) {
        sendJson(res, 403, { error: '跨源请求被拒绝' });
        return false;
      }
    } catch {
      sendJson(res, 403, { error: '非法 Origin' });
      return false;
    }
  }
  const addr = req.socket.remoteAddress ?? '';
  if (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1') return true;
  sendJson(res, 403, { error: '仅允许本机(loopback)访问' });
  return false;
}

function num(s: string | null): number | undefined {
  if (s === null || s === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function pathInfo(req: IncomingMessage, prefix: string): { rest: string; params: URLSearchParams } {
  const u = new URL(req.url ?? '/', 'http://localhost');
  return { rest: u.pathname.slice(prefix.length), params: u.searchParams };
}

export function registerScholarRoutes(
  ctx: Context,
  getStore: () => Promise<PaperStore>,
  getConfig: () => ScholarConfig,
  updateConfig: (patch: Partial<ScholarConfig>) => Promise<void>,
): void {
  /* ---------- config ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/scholar/config',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      try {
        if (req.method === 'GET') {
          sendJson(res, 200, { config: getConfig() });
          return;
        }
        if (req.method === 'PUT') {
          const body = JSON.parse(await readBody(req)) as { paperDir?: unknown; defaultTags?: unknown; fetchProxy?: unknown; openalexEmail?: unknown; researchFocus?: unknown; vlmFigures?: unknown };
          if (typeof body.paperDir !== 'string' || !body.paperDir.trim()) {
            return sendJson(res, 400, { error: 'paperDir 必须是非空字符串' });
          }
          const patch: Partial<ScholarConfig> = { paperDir: body.paperDir.trim() };
          if (Array.isArray(body.defaultTags)) {
            patch.defaultTags = body.defaultTags.filter((t): t is string => typeof t === 'string');
          }
          if (body.fetchProxy === undefined || typeof body.fetchProxy === 'string') {
            patch.fetchProxy = typeof body.fetchProxy === 'string' ? body.fetchProxy.trim() : '';
          }
          if (body.openalexEmail === undefined || typeof body.openalexEmail === 'string') {
            patch.openalexEmail = typeof body.openalexEmail === 'string' ? body.openalexEmail.trim() : '';
          }
          if (body.researchFocus === undefined || typeof body.researchFocus === 'string') {
            patch.researchFocus = typeof body.researchFocus === 'string' ? body.researchFocus.slice(0, 2000) : '';
          }
          if (body.vlmFigures === 'off' || body.vlmFigures === 'auto') {
            patch.vlmFigures = body.vlmFigures;
          }
          await updateConfig(patch);
          sendJson(res, 200, { ok: true, config: getConfig() });
          return;
        }
        sendJson(res, 405, { error: 'method not allowed' });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- stats ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/scholar/stats',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      try {
        const store = await getStore();
        sendJson(res, 200, { ...store.stats(), dir: store.dir });
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- metadata fetch (arXiv / DOI) ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/scholar/fetch',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      try {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
        const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
        const meta = await fetchMetadata(params.get('input') ?? '', getConfig().fetchProxy || undefined);
        sendJson(res, 200, { meta });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- collections (folders) ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/scholar/collections',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      try {
        const store = await getStore();
        const { rest } = pathInfo(req, '/scholar/collections');

        if (!rest || rest === '/') {
          if (req.method === 'GET') {
            sendJson(res, 200, { collections: store.listCollections() });
            return;
          }
          if (req.method === 'POST') {
            const body = JSON.parse(await readBody(req)) as { name?: unknown; color?: unknown };
            if (typeof body.name !== 'string' || !body.name.trim()) {
              return sendJson(res, 400, { error: 'name 必须是非空字符串' });
            }
            const { collection, existed } = await store.upsertCollection(
              body.name,
              typeof body.color === 'string' && body.color ? body.color : undefined,
            );
            sendJson(res, existed ? 200 : 201, { created: !existed, collection });
            return;
          }
          return sendJson(res, 405, { error: 'method not allowed' });
        }

        const id = decodeURIComponent(rest.slice(1));
        if (!id || id.includes('/')) return sendJson(res, 404, { error: 'not found' });
        if (req.method === 'PUT') {
          const body = JSON.parse(await readBody(req)) as { name?: unknown; color?: unknown };
          const next = await store.renameCollection(id, {
            name: typeof body.name === 'string' ? body.name : undefined,
            color: typeof body.color === 'string' ? body.color : undefined,
          });
          if (!next) return sendJson(res, 404, { error: '分区不存在' });
          sendJson(res, 200, { collection: next });
          return;
        }
        if (req.method === 'DELETE') {
          // membership is stripped from papers; papers themselves are kept
          const ok = await store.deleteCollection(id);
          sendJson(res, ok ? 200 : 404, ok ? { deleted: true } : { error: '分区不存在' });
          return;
        }
        sendJson(res, 405, { error: 'method not allowed' });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- papers ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/scholar/papers',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      try {
        const store = await getStore();
        const { rest, params } = pathInfo(req, '/scholar/papers');

        if (!rest) {
          if (req.method === 'GET') {
            const query: PaperQuery = {
              q: params.get('q') || undefined,
              tag: params.get('tag') || undefined,
              yearFrom: num(params.get('yearFrom')),
              yearTo: num(params.get('yearTo')),
              importance: num(params.get('importance')),
              collection: params.get('collection') || undefined,
              unfiled: params.get('unfiled') === '1' || undefined,
              readStatus: (params.get('readStatus') as ReadStatus) || undefined,
              sort: (params.get('sort') as PaperSort) || undefined,
            };
            // 可选分页：limit/offset（均须为非负整数）；不传 = 全量（默认行为不变）
            const limit = num(params.get('limit'));
            const offset = num(params.get('offset'));
            const badPage = [limit, offset].some((v) => v !== undefined && (!Number.isInteger(v) || v < 0));
            if (badPage) return sendJson(res, 400, { error: 'limit/offset 必须是非负整数' });
            const papers = filterPapers([...store.papers.values()], query);
            sendJson(res, 200, {
              papers: limit !== undefined || offset !== undefined
                ? papers.slice(offset ?? 0, (offset ?? 0) + (limit ?? papers.length))
                : papers,
              total: papers.length,
              tags: allPaperTags(store.papers.values()),
            });
            return;
          }
          if (req.method === 'POST') {
            const body = JSON.parse(await readBody(req)) as Record<string, any>;
            const input = PaperInputSchema(body);
            // collection membership: only meaningful when caller sends explicit arrays
            const wantCol = Array.isArray(body.collectionIds) || Array.isArray(body.collectionNames);
            const colIds = Array.isArray(body.collectionIds)
              ? store.filterExistingCollectionIds(body.collectionIds as string[])
              : Array.isArray(body.collectionNames)
                ? await store.ensureCollectionNames(body.collectionNames as string[])
                : undefined;

            const dup = findDuplicate(store.papers.values(), input);
            if (dup && !body.update) {
              sendJson(res, 200, { created: false, duplicate: true, paper: dup });
              return;
            }
            if (dup) {
              // 更新走部分更新语义：只合并实际提交的字段，未提交字段保持不变
              const patch = pickSubmitted(PaperPatchInputSchema, body);
              const paper = applyPaperPatch(dup, {
                ...patch,
                ...(wantCol ? { collectionIds: colIds ?? [] } : {}),
              });
              await store.upsertPaper(paper);
              sendJson(res, 200, { created: false, duplicate: true, updated: true, paper });
              return;
            }
            const tags = [...new Set([...(getConfig().defaultTags ?? []), ...input.tags])];
            const paper = createPaper({
              ...input, tags, source: 'manual',
              ...(colIds !== undefined ? { collectionIds: colIds } : {}),
            });
            await store.upsertPaper(paper);
            sendJson(res, 201, { created: true, paper });
            return;
          }
          sendJson(res, 405, { error: 'method not allowed' });
          return;
        }

        /* ---------- sidecar 查询（透镜 focus 的上下文论文迷你摘要） ---------- */
        const sidecarMatch = /^\/(.+)\/sidecar$/i.exec(rest);
        if (sidecarMatch) {
          if (req.method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return; }
          const pid = decodeURIComponent(sidecarMatch[1]);
          if (!store.papers.get(pid)) return sendJson(res, 404, { error: '论文不存在' });
          try {
            const sidecars = (await readdir(join(store.dir, 'reports')))
              .filter((f) => f.startsWith(`${safeName(pid)}-`) && f.endsWith('.json'))
              .sort();
            const last = sidecars[sidecars.length - 1];
            if (!last) return sendJson(res, 200, { sidecar: null });
            const sc = JSON.parse(await readFile(join(store.dir, 'reports', last), 'utf8'));
            return sendJson(res, 200, { sidecar: sc });
          } catch {
            return sendJson(res, 200, { sidecar: null });
          }
        }

        /* ---------- reading reports (list / serve / delete) ---------- */
        const reportsMatch = /^\/(.+)\/reports(?:\/([^/]+))?$/i.exec(rest);
        if (reportsMatch) {
          const pid = decodeURIComponent(reportsMatch[1]);
          if (!store.papers.get(pid)) return sendJson(res, 404, { error: '论文不存在' });
          const prefix = `${safeName(pid)}-`;
          const reportsDir = join(store.dir, 'reports');

          if (req.method === 'GET' && !reportsMatch[2]) {
            try {
              // 模式解析只读文件头尾各 4KB（新报告 meta 在头；旧报告副标题在头、
              // "精读引擎（" 在尾）——避免为拿模式整读 1.9MB 级大报告
              const readHeadTail = async (f: string): Promise<string> => {
                const full = join(reportsDir, f);
                const st = await stat(full);
                const { open } = await import('node:fs/promises');
                const h = await open(full, 'r');
                try {
                  const headBuf = Buffer.alloc(4096);
                  const tailBuf = Buffer.alloc(4096);
                  await h.read(headBuf, 0, 4096, 0);
                  await h.read(tailBuf, 0, 4096, Math.max(0, st.size - 4096));
                  return headBuf.toString('utf8') + '\n' + tailBuf.toString('utf8');
                } finally {
                  await h.close();
                }
              };
              const files = (await Promise.all(
                (await readdir(reportsDir))
                  .filter((f) => f.endsWith('.html')
                    && (f.startsWith(prefix) || (f.startsWith('cmp-') && f.includes(prefix.replace(/-$/, '')))))
                  .map(async (f) => {
                    const st = await stat(join(reportsDir, f));
                    let mode: 'paper' | 'quick' | 'compare' | '' = '';
                    if (f.startsWith('cmp-')) mode = 'compare';
                    else {
                      try {
                        const fh = await readHeadTail(f);
                        const meta = /<meta name="scholar-report" content="(\w+)">/.exec(fh.slice(0, 4200));
                        if (meta) mode = meta[1] === 'quick' ? 'quick' : 'paper';
                        else if (/精读引擎（(paper|quick)/.test(fh)) mode = /精读引擎（quick/.test(fh) ? 'quick' : 'paper';
                        else if (/学术论文精读/.test(fh)) mode = 'paper';
                        else if (/速读/.test(fh)) mode = 'quick';
                      } catch { /* 读不了就空模式，不阻塞列表 */ }
                    }
                    return { file: f, size: st.size, savedAt: st.mtimeMs, mode };
                  }),
              )).sort((a, b) => b.savedAt - a.savedAt);
              return sendJson(res, 200, { reports: files });
            } catch {
              return sendJson(res, 200, { reports: [] });
            }
          }

          if (req.method === 'GET' && reportsMatch[2]) {
            const fname = safeName(decodeURIComponent(reportsMatch[2]));
            const belongs = fname.startsWith(prefix)
              || (fname.startsWith('cmp-') && fname.includes(prefix.replace(/-$/, '')) && /^cmp-[\w.-]+-\d{9,15}\.html$/.test(fname));
            if (!belongs || !fname.endsWith('.html')) {
              return sendJson(res, 400, { error: '非法的报告文件名' });
            }
            try {
              const data = await readFile(join(reportsDir, fname));
              res.statusCode = 200;
              res.setHeader('content-type', 'text/html; charset=utf-8');
              // 报告内容源自 LLM 生成的 HTML（可能被论文正文提示注入携带脚本）：
              // sandbox CSP 让浏览器以唯一源沙箱打开（脚本禁用、同源隔离），保持在线阅读可用
              res.setHeader('content-security-policy', 'sandbox');
              res.setHeader('x-content-type-options', 'nosniff');
              res.setHeader('content-length', data.length);
              res.end(data);
            } catch {
              return sendJson(res, 404, { error: '报告文件不存在' });
            }
            return;
          }

          // 删除单份报告（自有报告锚定前缀+时间戳；对比报告锚定 cmp-+本论文 id+时间戳，杜绝路径穿越）
          if (req.method === 'DELETE' && reportsMatch[2]) {
            const fname = safeName(decodeURIComponent(reportsMatch[2]));
            const belongs = (fname.startsWith(prefix) && /^[\w.-]+-\d{9,15}\.html$/.test(fname))
              || (fname.startsWith('cmp-') && fname.includes(prefix.replace(/-$/, '')) && /^cmp-[\w.-]+-\d{9,15}\.html$/.test(fname));
            if (!belongs) {
              return sendJson(res, 400, { error: '非法的报告文件名' });
            }
            try {
              await unlink(join(reportsDir, fname));
              // 顺带清理同名 sidecar（对比原料 JSON）
              await unlink(join(reportsDir, fname.replace(/\.html$/, '.json'))).catch(() => {});
              return sendJson(res, 200, { ok: true, deleted: fname });
            } catch {
              return sendJson(res, 404, { error: '报告文件不存在' });
            }
          }

          return sendJson(res, 405, { error: 'method not allowed' });
        }

        /* ---------- PDF attachment (upload / open) ---------- */
        const pdfMatch = /^\/(.+)\/pdf$/i.exec(rest);
        if (pdfMatch) {
          const pid = decodeURIComponent(pdfMatch[1]);
          const paper = store.papers.get(pid);
          if (!paper) return sendJson(res, 404, { error: '论文不存在' });
          const file = join(store.dir, 'attachments', `${safeName(pid)}.pdf`);

          if (req.method === 'PUT') {
            try {
              const buf = await readRawBody(req, PDF_MAX_BYTES);
              if (buf.length === 0) return sendJson(res, 400, { error: '空文件' });
              // 魔数校验：坏文件入档会毁掉 deepread 动线
              if (buf.subarray(0, 4).toString('latin1') !== '%PDF') {
                return sendJson(res, 400, { error: '文件内容不是有效的 PDF（缺少 %PDF 魔数）' });
              }
              await mkdir(join(store.dir, 'attachments'), { recursive: true });
              const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
              await writeFile(tmp, buf);
              await rename(tmp, file).catch(async (err: unknown) => {
                await unlink(tmp).catch(() => {});
                throw err;
              });
              // R03:事务化(基于最新记录,只动 pdfPath/updatedAt)
              const saved = await store.updatePaperTx(pid, (cur) => ({ ...cur, pdfPath: `attachments/${safeName(pid)}.pdf`, updatedAt: Date.now() }));
              if (!saved) return sendJson(res, 404, { error: '论文不存在' });
              return sendJson(res, 200, { ok: true, pdfPath: saved.pdfPath });
            } catch (err) {
              return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
            }
          }

          if (req.method === 'GET') {
            if (!paper.pdfPath) return sendJson(res, 404, { error: '该论文没有 PDF 附件' });
            try {
              const info = await stat(file);
              res.statusCode = 200;
              res.setHeader('content-type', 'application/pdf');
              res.setHeader('x-content-type-options', 'nosniff');
              res.setHeader('content-length', info.size);
              // 读取中途失败（文件被删/锁定）时收尾响应，而不是未捕获异常或挂死
              const stream = createReadStream(file);
              stream.on('error', (err) => {
                if (res.headersSent) res.end();
                else sendJson(res, 500, { error: `PDF 读取失败: ${err instanceof Error ? err.message : String(err)}` });
              });
              stream.pipe(res);
            } catch {
              sendJson(res, 404, { error: 'PDF 文件丢失（可重新上传）' });
            }
            return;
          }

          return sendJson(res, 405, { error: 'method not allowed' });
        }

        /* ---------- related papers (OpenAlex discovery, 10min cached) ---------- */
        const relatedMatch = /^\/(.+)\/related$/i.exec(rest);
        if (relatedMatch) {
          if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
          const pid = decodeURIComponent(relatedMatch[1]);
          const paper = store.papers.get(pid);
          if (!paper) return sendJson(res, 404, { error: '论文不存在' });
          const report = await getRelatedReport(paper, [...store.papers.values()], getConfig().fetchProxy || undefined);
          return sendJson(res, 200, report);
        }

        const id = decodeURIComponent(rest.slice(1));
        if (!id || id.includes('/')) return sendJson(res, 404, { error: 'not found' });
        if (req.method === 'GET') {
          const paper = store.papers.get(id);
          if (!paper) return sendJson(res, 404, { error: '论文不存在' });
          sendJson(res, 200, { paper });
          return;
        }
        if (req.method === 'PUT') {
          const existing = store.papers.get(id);
          if (!existing) return sendJson(res, 404, { error: '论文不存在' });
          const body = JSON.parse(await readBody(req)) as Record<string, any>;
          // PUT 为部分更新语义：只合并实际提交的字段，未提交字段（如 summary/tags）保持不变
          const input = pickSubmitted(PaperPatchInputSchema, body);
          const colIds = Array.isArray(body.collectionIds)
            ? store.filterExistingCollectionIds(body.collectionIds as string[])
            : Array.isArray(body.collectionNames)
              ? await store.ensureCollectionNames(body.collectionNames as string[])
              : undefined;
          // F07:事务化部分更新——持锁内基于最新记录 patch,并发编辑不再互相覆盖
          const paper = await store.updatePaperTx(id, (cur) => applyPaperPatch(cur, {
            ...input,
            ...(colIds !== undefined ? { collectionIds: colIds } : {}),
          }));
          if (!paper) return sendJson(res, 404, { error: '论文不存在' });
          sendJson(res, 200, { paper });
          return;
        }
        if (req.method === 'DELETE') {
          const ok = await store.deletePaper(id);
          sendJson(res, ok ? 200 : 404, ok ? { deleted: true } : { error: '论文不存在' });
          return;
        }
        sendJson(res, 405, { error: 'method not allowed' });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- idea cards ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/scholar/cards',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      try {
        const store = await getStore();
        const { rest, params } = pathInfo(req, '/scholar/cards');

        if (!rest) {
          if (req.method === 'GET') {
            const query: CardQuery = {
              q: params.get('q') || undefined,
              category: (params.get('category') as CardQuery['category']) || undefined,
              tag: params.get('tag') || undefined,
              importance: num(params.get('importance')),
              status: (params.get('status') as CardQuery['status']) || undefined,
              paperId: params.get('paperId') || undefined,
              sort: (params.get('sort') as CardSort) || undefined,
            };
            const cards = filterCards([...store.cards.values()], query);
            sendJson(res, 200, { cards, tags: allCardTags(store.cards.values()) });
            return;
          }
          if (req.method === 'POST') {
            const body = JSON.parse(await readBody(req));
            const input = CardInputSchema(body);
            if (input.paperId && !store.papers.has(input.paperId)) {
              return sendJson(res, 400, { error: `论文 ${input.paperId} 不在论文库中` });
            }
            const relIds = Array.isArray(body.relatedCardIds)
              ? store.filterExistingCardIds(body.relatedCardIds as string[])
              : undefined;
            const card = createCard({
              ...input, paperId: input.paperId || undefined,
              ...(relIds !== undefined ? { relatedCardIds: relIds } : {}),
              ...(body.plain !== undefined ? { plain: String(body.plain) } : {}),
              ...(Array.isArray(body.steps) ? { steps: body.steps as string[] } : {}),
              ...(body.evidence !== undefined ? { evidence: String(body.evidence) } : {}),
            });
            await store.upsertCard(card);
            // 相似卡提醒（非阻塞）：手动建卡同样提示可能的重复沉淀
            const similar = findSimilarCards([...store.cards.values()], card.title, { excludeId: card.id, paperId: card.paperId });
            sendJson(res, 201, { created: true, card, ...(similar.length ? { similar } : {}) });
            return;
          }
          sendJson(res, 405, { error: 'method not allowed' });
          return;
        }

        const id = decodeURIComponent(rest.slice(1));
        if (!id || id.includes('/')) return sendJson(res, 404, { error: 'not found' });
        if (req.method === 'GET') {
          const card = store.cards.get(id);
          if (!card) return sendJson(res, 404, { error: '卡片不存在' });
          sendJson(res, 200, { card });
          return;
        }
        if (req.method === 'PUT') {
          const existing = store.cards.get(id);
          if (!existing) return sendJson(res, 404, { error: '卡片不存在' });
          const body = JSON.parse(await readBody(req));
          // PUT 为部分更新语义：只合并实际提交的字段（与工具层 idea_card_update 一致）
          const input = pickSubmitted(CardPatchInputSchema, body);
          if (input.paperId && !store.papers.has(input.paperId)) {
            return sendJson(res, 400, { error: `论文 ${input.paperId} 不在论文库中` });
          }
          const relIds = Array.isArray(body.relatedCardIds)
            ? store.filterExistingCardIds(body.relatedCardIds as string[])
            : undefined;
          const card = applyCardPatch(existing, {
            ...input,
            ...(relIds !== undefined ? { relatedCardIds: relIds } : {}),
            ...(body.plain !== undefined ? { plain: String(body.plain) } : {}),
            ...(Array.isArray(body.steps) ? { steps: body.steps as string[] } : {}),
          });
          await store.upsertCard(card);
          sendJson(res, 200, { card });
          return;
        }
        if (req.method === 'DELETE') {
          const ok = await store.deleteCard(id);
          sendJson(res, ok ? 200 : 404, ok ? { deleted: true } : { error: '卡片不存在' });
          return;
        }
        sendJson(res, 405, { error: 'method not allowed' });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- tag auto-sync (heuristic, no AI) ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/scholar/graph/auto-sync',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      try {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        const store = await getStore();
        const knownIds = new Set(store.papers.keys());
        const papers = [...store.papers.values()];
        // 双同步：论文标签→概念（旧）+ 卡片→想法节点/derives_from/uses/related（新）
        const paperPatch = store.tagSyncPatch(papers);
        const cardPatch = store.cardSyncPatch([...store.cards.values()], papers);
        let graph = mergeGraph(store.graph, paperPatch, 'append', knownIds);
        graph = mergeGraph(graph, cardPatch, 'append', knownIds);
        await store.saveGraph(graph);
        sendJson(res, 200, {
          addedNodes: paperPatch.nodes.length + cardPatch.nodes.length,
          addedEdges: paperPatch.edges.length + cardPatch.edges.length,
          nodes: graph.nodes.length,
          edges: graph.edges.length,
        });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- citation sync (OpenAlex, cites edges only between library papers) ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/scholar/graph/cite-sync',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      try {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        const store = await getStore();
        // 全库扫描可能要几十秒（OpenAlex 逐篇解析），客户端需有等待态
        const result = await citeSyncPatch([...store.papers.values()], store.graph.edges, getConfig().fetchProxy || undefined);
        const graph = result.addedEdges.length
          ? mergeGraph(store.graph, { nodes: [], edges: result.addedEdges }, 'append', new Set(store.papers.keys()))
          : store.graph;
        await store.saveGraph(graph);
        sendJson(res, 200, {
          addedEdges: result.addedEdges.length,
          scanned: result.scanned,
          resolved: result.resolved,
          missCount: result.misses.length,
          nodes: graph.nodes.length,
          edges: graph.edges.length,
        });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- knowledge graph ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/scholar/graph',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      try {
        const store = await getStore();
        if (req.method === 'GET') {
          sendJson(res, 200, { graph: store.graph });
          return;
        }
        if (req.method === 'PUT') {
          const body = JSON.parse(await readBody(req)) as {
            nodes?: unknown; edges?: unknown; mode?: unknown; force?: unknown;
          };
          if (!Array.isArray(body.nodes) || !Array.isArray(body.edges)) {
            return sendJson(res, 400, { error: 'nodes 与 edges 必须是数组' });
          }
          const mode = body.mode === 'rebuild' ? 'rebuild' : 'append';
          // idea 节点是 cardSync 的系统产物（id=卡片 id）：外部提交的 idea 节点
          // 若不对应真实卡片一律丢弃，防止幻影节点混入（"查看卡片"会 404）
          const rawNodes = body.nodes as KnowledgeGraph['nodes'];
          const droppedIdeas = rawNodes.filter((n) => n?.kind === 'idea' && !store.cards.has(n.id)).length;
          const incoming = {
            nodes: rawNodes.filter((n) => !(n?.kind === 'idea' && !store.cards.has(n.id))),
            edges: body.edges as KnowledgeGraph['edges'],
          };
          // rebuild 保护：缩减型 rebuild（详见 assertRebuildAllowed）需 force=true 显式确认
          if (mode === 'rebuild') {
            try {
              assertRebuildAllowed(store.graph, incoming.nodes.length + incoming.edges.length, body.force === true);
            } catch (err) {
              return sendJson(res, 409, { error: err instanceof Error ? err.message : String(err) });
            }
          }
          const knownPapers = new Set(store.papers.keys());
          const graph = mergeGraph(store.graph, incoming, mode, knownPapers);
          // rebuild 前把旧图谱备份为 graph.json.bak（保留一代）
          await (mode === 'rebuild' ? store.saveGraphRebuild(graph) : store.saveGraph(graph));
          sendJson(res, 200, { graph, ...(droppedIdeas ? { droppedIdeaNodes: droppedIdeas } : {}) });
          return;
        }
          sendJson(res, 405, { error: 'method not allowed' });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ==================== 精读引擎（自有）：直跑 / 进度 / 追问 / 会话 / VLM 探针 ==================== */
  const readEngine = (ctx as { llm?: unknown }).llm ? createReadEngine(ctx as never) : null;
  const figureReader = createFigureReader(ctx as never);
  const asker = (ctx as { llm?: unknown }).llm ? createAskerRoute(ctx as never) : null;

  /* ---------- 精读直跑（面板「启动精读」→ 一个后台任务顺序读 N 篇，逐篇归档） ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/scholar/read/run',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      if (!readEngine) {
        sendJson(res, 503, { error: '精读引擎不可用（宿主缺少 llm 服务）' });
        return;
      }
      try {
        const store = await getStore();
        const body = JSON.parse(await readBody(req)) as {
          paperIds?: unknown; mode?: unknown; focus?: unknown; light?: unknown;
        };
        const mode = body.mode === 'quick' ? 'quick' : 'paper';
        const light = body.light === true;
        const paperIds = Array.isArray(body.paperIds)
          ? [...new Set(body.paperIds.filter((x): x is string => typeof x === 'string'))]
          : [];
        const badPaper = paperIds.find((id) => !store.papers.has(id));
        if (badPaper) return sendJson(res, 400, { error: `论文不存在: ${badPaper}` });
        if (paperIds.length < 1 || paperIds.length > 10) {
          return sendJson(res, 400, { error: '对象论文数量必须是 1-10 篇' });
        }
        const focus = typeof body.focus === 'string' ? body.focus.trim().slice(0, 2400) : '';
        const papers = paperIds.map((id) => store.papers.get(id)!).filter((p) => p.pdfPath);
        const missing = paperIds.length - papers.length;
        if (papers.length === 0) {
          return sendJson(res, 400, { error: '所选论文均无 PDF（arXiv 论文可在对话中重新保存触发下载，或在详情页手动上传）' });
        }
        // UI 直调无对话 agent，官方 jobs 不可用（绑定 agent）——脱离任务系统后台执行：
        // 不阻塞 HTTP，逐篇归档报告+回填 summary，结果直接落在库里。
        // 进度写入内存注册表，/scholar/read/status 供面板轮询。
        const run: ReadRunState = {
          id: ++readRunSeq, mode, total: papers.length, skipped: missing,
          startedAt: Date.now(), finishedAt: null, ok: 0, fail: 0,
          papers: papers.map((p) => ({ title: p.title, state: 'pending' as const })),
          phase: '',
          error: '',
        };
                // F12:上一 run 未结束/未取消时拒绝重叠启动(旧任务会在后台默默烧额度)
        const busy = readRunBusy();
        if (busy) {
          return sendJson(res, 409, { error: "已有精读任务进行中(#" + busy.id + ")", run: busy });
        }
readRun = run;
        const signal = { aborted: false };
        activeSignal = signal;
        type PaperOutcomeLike = PaperOutcome;
        void (async () => {
          const paperOutcomes: Array<{ paper: typeof papers[number]; outcome: PaperOutcomeLike }> = [];
          try {
            for (let i = 0; i < papers.length; i++) {
              if (signal.aborted) break;
              const p = papers[i]!;
              run.papers[i]!.state = 'running';
              run.phase = '准备中…';
              try {
                const outcome = await readEngine.readSync(
                  { path: `${store.dir}/${p.pdfPath}`, mode, light, focus, vlm: getConfig().vlmFigures !== 'off' },
                  (line) => { run.phase = line; },
                  signal,
                );
                await archiveReadResult(store, p, outcome, { focusNote: focus ? '带关注重点' : '' });
                if (outcome.kind === 'paper') paperOutcomes.push({ paper: p, outcome });
                run.ok++;
                run.papers[i]!.state = 'ok';
                console.log(`[dsh-scholar] 精读归档 ${run.ok}/${papers.length}: ${p.title.slice(0, 50)}`);
              } catch (err) {
                run.fail++;
                run.papers[i]!.state = 'fail';
                run.error = String(err instanceof Error ? err.message : err).slice(0, 200);
                console.error(`[dsh-scholar] 精读失败 ${p.title.slice(0, 50)}:`, err instanceof Error ? err.message : err);
              }
              run.phase = '';
            }
            // 多篇（≥2 篇深读成功）→ 自动生成横向对比报告：cmp-<id1>--<id2>-<ts>.html
            if (paperOutcomes.length >= 2 && !signal.aborted) {
              try {
                run.phase = '生成横向对比报告…';
                const cmp = await runCompare(ctx, paperOutcomes.map((x) => x.outcome), focus, signal);
                const cmpFile = `cmp-${paperOutcomes.map((x) => safeName(x.paper.id)).join('--')}-${Date.now()}.html`;
                await writeFile(join(store.dir, 'reports', cmpFile),
                  renderCompareHtml(cmp, {
                    title: `横向对比：${paperOutcomes.map((x) => x.paper.title.slice(0, 24)).join(' × ')}`,
                    sub: `${paperOutcomes.length} 篇 · ${mode === 'quick' ? '速读' : '学术深读'}产物 · ${new Date().toISOString().slice(0, 10)}`,
                  }), 'utf8');
                run.phase = '';
                console.log(`[dsh-scholar] 对比报告归档: ${cmpFile.slice(0, 80)}`);
              } catch (err) {
                run.phase = '';
                console.error('[dsh-scholar] 对比报告失败:', err instanceof Error ? err.message : err);
              }
            }
          } finally {
            run.finishedAt = Date.now();
            if (activeSignal) activeSignal = null;
            console.log(`[dsh-scholar] 批量精读结束：成功 ${run.ok} / 失败 ${run.fail}`);
          }
        })();
        sendJson(res, 200, {
          ok: true, detached: true, started: papers.length, skipped: missing,
          label: `${papers.length} 篇·${mode === 'quick' ? '速读' : light ? '轻量深读' : '学术深读'}`,
        });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- 直接对比已有成果（不重读）：读 sidecar JSON，无则回退论文 summary+abstract ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/scholar/read/compare',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return; }
      if (!(ctx as { llm?: unknown }).llm) return sendJson(res, 503, { error: '对比引擎不可用（宿主缺少 llm 服务）' });
      try {
        const store = await getStore();
        const body = JSON.parse(await readBody(req)) as { paperIds?: unknown; focus?: unknown };
        const paperIds = Array.isArray(body.paperIds)
          ? [...new Set(body.paperIds.filter((x): x is string => typeof x === 'string'))]
          : [];
        if (paperIds.length < 2 || paperIds.length > 10) return sendJson(res, 400, { error: '对比需要选 2-10 篇论文' });
        const bad = paperIds.find((id) => !store.papers.has(id));
        if (bad) return sendJson(res, 400, { error: `论文不存在: ${bad}` });
        const focus = typeof body.focus === 'string' ? body.focus.trim().slice(0, 2400) : '';
        // 进度注册（横幅可见）
        const papers = paperIds.map((id) => store.papers.get(id)!);
        const run: ReadRunState = {
          id: ++readRunSeq, mode: 'paper', total: 1, skipped: 0,
          startedAt: Date.now(), finishedAt: null, ok: 0, fail: 0,
          papers: [{ title: `直接对比 ${papers.length} 篇（已有成果）`, state: 'running' }],
          phase: '组装对比原料…', error: '',
        };
                // F12:上一 run 未结束/未取消时拒绝重叠启动(旧任务会在后台默默烧额度)
        const busy = readRunBusy();
        if (busy) {
          return sendJson(res, 409, { error: "已有精读任务进行中(#" + busy.id + ")", run: busy });
        }
readRun = run;
        const signal = { aborted: false };
        activeSignal = signal;
        void (async () => {
          try {
            const reportsDir = join(store.dir, 'reports');
            const entries: Array<{ title: string; digest: string }> = [];
            const usedSidecar: boolean[] = [];
            for (const p of papers) {
              // 最新 sidecar（深读归档时存的对比原料）
              let entry: { title: string; digest: string } | null = null;
              try {
                const sidecars = (await readdir(reportsDir))
                  .filter((f) => f.startsWith(`${safeName(p.id)}-`) && f.endsWith('.json'))
                  .sort();
                const last = sidecars[sidecars.length - 1];
                if (last) {
                  const sc = JSON.parse(await readFile(join(reportsDir, last), 'utf8')) as import('./read/compare.js').CompareSidecar;
                  if (sc && typeof sc.title === 'string' && (sc.summary || sc.items?.length)) {
                    const { digestOfSidecar } = await import('./read/compare.js');
                    entry = { title: sc.title, digest: digestOfSidecar(sc) };
                  }
                }
              } catch { /* 读不了走回退 */ }
              if (!entry) {
                // 回退：论文的 AI 总结 + 摘要（库内现成数据）
                const parts = [`【${p.title}】`, p.summary, p.abstract ? p.abstract.slice(0, 1200) : ''].filter(Boolean);
                entry = { title: p.title, digest: parts.join('\n') };
                usedSidecar.push(false);
              } else usedSidecar.push(true);
              entries.push(entry);
            }
            run.phase = '生成横向对比报告…';
            const cmp = await runCompareEntries(ctx, entries, focus, signal);
            const cmpFile = `cmp-${papers.map((p) => safeName(p.id)).join('--')}-${Date.now()}.html`;
            await writeFile(join(reportsDir, cmpFile), renderCompareHtml(cmp, {
              title: `横向对比：${papers.map((p) => p.title.slice(0, 24)).join(' × ')}`,
              sub: `${papers.length} 篇 · 已有精读成果（${usedSidecar.filter(Boolean).length}/${papers.length} 篇有结构化原料，其余用摘要回退） · ${new Date().toISOString().slice(0, 10)}`,
            }), 'utf8');
            run.ok = 1;
            run.papers[0]!.state = 'ok';
            run.phase = '';
            console.log(`[dsh-scholar] 直接对比归档: ${cmpFile.slice(0, 80)}`);
          } catch (err) {
            run.fail = 1;
            run.papers[0]!.state = 'fail';
            run.error = String(err instanceof Error ? err.message : err).slice(0, 200);
            run.phase = '';
            console.error('[dsh-scholar] 直接对比失败:', err instanceof Error ? err.message : err);
          } finally {
            run.finishedAt = Date.now();
            if (activeSignal) activeSignal = null;
          }
        })();
        sendJson(res, 200, { ok: true, detached: true, started: papers.length, label: `直接对比 ${papers.length} 篇` });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- 精读进度查询：面板轮询（running 时 1.5s 一拍） ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/scholar/read/status',
    handler: (req, res) => {
      if (!guardRoute(req, res)) return;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      sendJson(res, 200, { run: readRun });
    },
  } satisfies WebRoute));

  /* ---------- F12:精读任务取消(下一论文边界生效,进行中的模型流按段检查) ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/scholar/read/cancel',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      try {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' });
          return;
        }
        const busy = readRunBusy();
        if (!busy) {
          sendJson(res, 200, { cancelled: false, reason: '当前没有进行中的精读任务' });
          return;
        }
        if (activeSignal) activeSignal.aborted = true;
        busy.phase = '正在取消…（当前论文完成后停止）';
        sendJson(res, 200, { cancelled: true, run: busy });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- 交互式追问（详情页追问框）：检索精读章节块 → 带引证回答 → 落会话 ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/scholar/read/ask',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return; }
      try {
        if (!asker) return sendJson(res, 503, { error: '追问引擎不可用（宿主缺少 llm 服务）' });
        const store = await getStore();
        const body = JSON.parse(await readBody(req)) as { paperId?: unknown; question?: unknown };
        const paperId = String(body.paperId ?? '');
        const question = String(body.question ?? '').trim().slice(0, 500);
        if (!store.papers.has(paperId)) return sendJson(res, 404, { error: '论文不存在' });
        if (question === '') return sendJson(res, 400, { error: '问题不能为空' });
        const session = await loadSession(store.dir, paperId);
        if (!session) return sendJson(res, 400, { error: '该论文还没有精读会话（先精读一次才能追问）' });
        const history = session.qa.slice(-3).map((e) => ({ q: e.q, a: e.a }));
        const ans = await asker(session.chunks, question, history);
        await appendQA(store.dir, paperId, { q: question, a: ans.answer, pages: ans.pages, confidence: ans.confidence, sufficient: ans.sufficient, at: Date.now() });
        sendJson(res, 200, { ok: true, ...ans });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- 阅读会话查询（详情页追问区加载历史问答） ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/scholar/read/session',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      try {
        const { rest } = pathInfo(req, '/scholar/read/session');
        const paperId = decodeURIComponent(rest.replace(/^\/+/, ''));
        if (paperId === '') return sendJson(res, 400, { error: '缺少 paperId' });
        const store = await getStore();
        if (!store.papers.has(paperId)) return sendJson(res, 404, { error: '论文不存在' });
        const session = await loadSession(store.dir, paperId);
        sendJson(res, 200, { exists: session !== null, qa: session?.qa ?? [] });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- VLM 读图探针：验证模型能否看图（抽首图问一句，一次调用） ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/scholar/read/vlm-test',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return; }
      try {
        const store = await getStore();
        const body = JSON.parse(await readBody(req)) as { paperId?: unknown };
        const paper = store.papers.get(String(body.paperId ?? ''));
        if (!paper?.pdfPath) return sendJson(res, 400, { error: '论文不存在或没有 PDF' });
        const buf = await readFile(join(store.dir, paper.pdfPath));
        const { images: figs } = extractPdfFigures(buf.toString('latin1'));
        if (figs.length === 0) {
          return sendJson(res, 200, { usable: figureReader.usable, figures: 0, description: '' });
        }
        const description = await figureReader.describeFigure(figs[0]!, '一句话描述这张图的内容与类型。');
        sendJson(res, 200, { usable: figureReader.usable, figures: figs.length, description });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));
}

/** Resolve a concept id from a model-supplied label (direct or canonical). */
export function resolveConceptId(graph: KnowledgeGraph, input: string): string | undefined {
  const canonical = conceptId(input);
  const direct = graph.nodes.find((n) => n.kind === 'concept' && n.id === canonical);
  if (direct) return direct.id;
  const byLabel = graph.nodes.find((n) => n.kind === 'concept' && n.label.toLowerCase() === input.toLowerCase());
  if (byLabel) return byLabel.id;
  const sub = conceptSubgraph(graph, canonical);
  return sub.nodes.length > 0 ? canonical : undefined;
}
