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

const PDF_MAX_BYTES = 50 * 1024 * 1024;

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
    const ct = String(req.headers['content-type'] ?? '');
    if (!ct.includes('application/json')) {
      reject(new Error('请求必须是 application/json'));
      return;
    }
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        // 超限即断流：继续收 chunk 会让恶意/失控客户端无限灌内存（OOM）
        req.destroy();
        reject(new Error('请求体过大'));
        return;
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/** Raw binary body reader for the PDF upload route (octet-stream only, size-capped). */
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
          const body = JSON.parse(await readBody(req)) as { paperDir?: unknown; defaultTags?: unknown; fetchProxy?: unknown; openalexEmail?: unknown };
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

        /* ---------- reading reports (list / serve) ---------- */
        const reportsMatch = /^\/(.+)\/reports(?:\/([^/]+))?$/i.exec(rest);
        if (reportsMatch) {
          const pid = decodeURIComponent(reportsMatch[1]);
          if (!store.papers.get(pid)) return sendJson(res, 404, { error: '论文不存在' });
          const prefix = `${safeName(pid)}-`;
          const reportsDir = join(store.dir, 'reports');

          if (req.method === 'GET' && !reportsMatch[2]) {
            try {
              const files = (await Promise.all(
                (await readdir(reportsDir))
                  .filter((f) => f.startsWith(prefix) && f.endsWith('.html'))
                  .map(async (f) => {
                    const st = await stat(join(reportsDir, f));
                    return { file: f, size: st.size, savedAt: st.mtimeMs };
                  }),
              )).sort((a, b) => b.savedAt - a.savedAt);
              return sendJson(res, 200, { reports: files });
            } catch {
              return sendJson(res, 200, { reports: [] });
            }
          }

          if (req.method === 'GET' && reportsMatch[2]) {
            const fname = safeName(decodeURIComponent(reportsMatch[2]));
            if (!fname.startsWith(prefix) || !fname.endsWith('.html')) {
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
              paper.pdfPath = `attachments/${safeName(pid)}.pdf`;
              paper.updatedAt = Date.now();
              await store.upsertPaper(paper);
              return sendJson(res, 200, { ok: true, pdfPath: paper.pdfPath });
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
          const paper = applyPaperPatch(existing, {
            ...input,
            ...(colIds !== undefined ? { collectionIds: colIds } : {}),
          });
          await store.upsertPaper(paper);
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
