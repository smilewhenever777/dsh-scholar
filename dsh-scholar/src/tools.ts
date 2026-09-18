/**
 * dsh-scholar — agent-facing tools (registered via ctx.tools.register).
 *
 * These are what let the conversation model save papers, file idea cards,
 * and build the knowledge graph on the user's behalf. All AI-generated
 * content arrives as structured tool arguments (validated by defineTool),
 * is checked against the store, and is persisted locally.
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
// 0.1.5 类型线已原生收录 presentCall/presentResult/presentationMeta,直接使用官方类型
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { READ_STATUSES } from './shared/types.js';
import type { CardCategory, CardStatus, GraphEdge, GraphNode, ScholarConfig } from './shared/types.js';
import type { PaperStore } from './store.js';
import { assertRebuildAllowed, conceptId, conceptSubgraph, filterCards, filterPapers, mergeGraph, safeName } from './store.js';
import type { GraphMergeStats } from './store.js';
import { applyCardPatch, applyPaperPatch, createCard, createPaper, findDuplicate, findSimilarCards } from './domain.js';
import { fetchPdf } from './metadata.js';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const renderJson = (_args: unknown, value: unknown): ContentBlock[] => [
  { type: 'text', text: JSON.stringify(value, null, 2) },
];

/**
 * Deep-clone a value into plain JSON (drops `undefined` fields) so entity
 * objects satisfy the `JsonValue` output contract. The data is JSON-safe by
 * construction; this is a type-level bridge, not a sanitizer.
 */
const toJson = (v: unknown): any => JSON.parse(JSON.stringify(v));

const int = (n: number | undefined, min: number, max: number): number | undefined => {
  if (n === undefined) return undefined;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`数值必须在 ${min}-${max} 之间`);
  }
  return n;
};



/* ---------- conversation card presentation (presentCall/presentResult) ------
 * Generic cards: a titled pending row + a markdown result card. Presenters
 * MUST be pure (they run on live streaming AND session-log replay);
 * presentationMeta mirrors the canonical value so cards rebuild on replay. */

const callView = (title: string, rawInput?: unknown) => ({
  card: 'generic' as const,
  title,
  kind: 'other' as const,
  ...(rawInput !== undefined ? { rawInput } : {}),
});

const resultView = (title: string, md: string) => ({
  card: 'generic' as const,
  title,
  content: [{ type: 'text', text: md } as ContentBlock],
});

const READ_STATUS_LABELS: Record<string, string> = { want: '想读', reading: '在读', done: '读过' };

const mdPaper = (p: Record<string, any>): string => {
  if (!p || !p.title) return '';
  const meta = [p.year, p.venue, p.arxivId ? `arXiv:${p.arxivId}` : p.doi ? `DOI:${p.doi}` : '']
    .filter(Boolean).join(' · ');
  const tags = (p.tags ?? []).length ? (p.tags as string[]).map((x) => `#${x}`).join(' ') : '';
  const stars = p.importance ? `重要度 ${'★'.repeat(p.importance)}` : '';
  const read = READ_STATUS_LABELS[p.readStatus ?? 'want'];
  return [`**${p.title}**`, meta, [tags, [stars, read].filter(Boolean).join(' · ')].filter(Boolean).join('  ')]
    .filter(Boolean).join('\n');
};

const mdList = (items: string[], more = 0): string =>
  items.join('\n') + (more > 0 ? `\n_…另有 ${more} 条未列出_` : '');

/* ---------- PDF 自动下载（arXiv 直链，走已配置代理） ----------
 * 仅 arXiv 论文可自动下载（其他来源常有版权墙）。失败抛错，由调用方决定
 * 是阻塞（paper_fetch_pdf）还是附警告（paper_save）。 */
async function downloadPaperPdf(
  paper: import('./shared/types.js').Paper,
  store: PaperStore,
  proxy?: string,
): Promise<void> {
  if (!paper.arxivId) throw new Error('仅 arXiv 论文支持自动下载 PDF（其他来源常有版权墙，请在详情页手动上传）');
  const buf = await fetchPdf(`https://arxiv.org/pdf/${paper.arxivId}`, 60_000, proxy);
  if (buf.length === 0 || buf.subarray(0, 4).toString('latin1') !== '%PDF') {
    throw new Error('下载内容不是有效的 PDF（arXiv 可能限流，稍后再试）');
  }
  if (buf.length > 50 * 1024 * 1024) throw new Error('PDF 超过 50MB 附件上限');
  const file = join(store.dir, 'attachments', `${safeName(paper.id)}.pdf`);
  await mkdir(join(store.dir, 'attachments'), { recursive: true });
  // 随机 tmp 后缀：与 REST 上传/存储层并发写不再共用同一 tmp 名（防撕裂）
  const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, buf);
  await rename(tmp, file).catch(async (err: unknown) => {
    await unlink(tmp).catch(() => {});
    throw err;
  });
  paper.pdfPath = `attachments/${safeName(paper.id)}.pdf`;
  paper.updatedAt = Date.now();
  await store.upsertPaper(paper);
}

/**
 * 按 id 或标题关键词定位论文候选（精确 id 优先）。
 * 返回全部命中：0 = 未找到；>1 = 关键词有歧义，调用方应要求精确 id。
 */
function findPaperCandidates(store: PaperStore, key: string): import('./shared/types.js').Paper[] {
  const k = key.trim();
  if (!k) return [];
  const direct = store.papers.get(k);
  if (direct) return [direct];
  return filterPapers([...store.papers.values()], { q: k });
}

/** 多命中时的候选列表（≤5 条 id+title），供工具返回让模型/用户改用精确 id。 */
function candidateList(candidates: import('./shared/types.js').Paper[]): { id: string; title: string }[] {
  return candidates.slice(0, 5).map((p) => ({ id: p.id, title: p.title }));
}

export function registerScholarTools(
  ctx: Context,
  getStore: () => Promise<PaperStore>,
  getConfig: () => ScholarConfig,
): number {
  let toolCount = 0;
  ctx.effect(() => {
    const disposers = [
      /* ---------- 1. paper_save ---------- */
      ctx.tools.register(defineTool({
        name: 'paper_save',
        description:
          '把一篇论文保存进本地论文库（学者工作台插件）。对话中用户要求"保存这篇论文/把这篇加入论文库"时调用。'
          + '已在库中（arXiv id/DOI/标题命中）时默认不覆盖并返回已存在记录；update=true 时合并更新字段。'
          + '带 arxivId 时自动从 arXiv 下载 PDF 归档（失败仅附 pdfWarning，不阻塞保存）。'
          + 'summary 请给一句话总结（做了什么、为什么重要），tags 给 2-5 个标签。'
          + 'venue 填会议/期刊名：arXiv 元数据不含发表出处，若你从检索结果或已有知识中能确定（如 CVPR 2024），保存时务必传入 venue。'
          + 'collections 给分区名列表（如 ["LoRA 研究"]），不存在的分区会自动创建；用户说"存到 XX 文件夹/分区"时填写。',
        parameters: {
          title: { type: 'string', required: true, description: '论文完整标题' },
          authors: { type: 'array', items: { type: 'string' }, description: '作者列表（可选）' },
          year: { type: 'integer', description: '发表年份（1900-2100）' },
          venue: { type: 'string', description: '会议/期刊名' },
          arxivId: { type: 'string', description: 'arXiv 编号（去重主键）' },
          doi: { type: 'string', description: 'DOI（去重主键）' },
          url: { type: 'string', description: '论文链接' },
          abstract: { type: 'string', description: '摘要（原文或概括）' },
          summary: { type: 'string', description: '一句话总结：这篇论文做了什么、为什么重要' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签，如 扩散模型、视频生成、LoRA' },
          importance: { type: 'integer', description: '重要度 1-5（默认 3）' },
          readStatus: { type: 'string', description: '阅读状态：want=想读 / reading=在读 / done=读过（默认 want）' },
          update: { type: 'boolean', description: '已存在时是否合并更新（默认 false）' },
          collections: {
            type: 'array',
            items: { type: 'string' },
            description: '收集分区名称列表；不存在的分区自动创建',
          },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              created: { type: 'boolean' },
              duplicate: { type: 'boolean' },
              updated: { type: 'boolean' },
              paper: { type: 'json' },
            },
          },
          render: renderJson,
          presentationMeta: (_a: unknown, value: any) => value,
        },
        presentCall: (args: any) => callView(`保存论文：${String(args.title ?? '').slice(0, 36)}`, {
          arxivId: args.arxivId, doi: args.doi, tags: args.tags,
          update: args.update, collections: args.collections,
        }),
        presentResult: (args: any, result: { value?: any; meta?: any }) => {
          const v: any = result.value ?? result.meta ?? {};
          const p: any = v.paper ?? {};
          const state = v.updated ? '已合并更新' : v.created ? '已入库' : '已在库中';
          const hint = v.duplicate && !v.updated ? '_该论文已在库中；update=true 可合并更新_' : '';
          const md = [mdPaper(p), hint].filter(Boolean).join('\n');
          return resultView(`${state}：${String(p.title ?? '').slice(0, 36)}`, md);
        },
        async execute(args: any) {
          const store = await getStore();
          const year = int(args.year, 1900, 2100);
          const importance = int(args.importance, 1, 5);
          const colIds = Array.isArray(args.collections)
            ? await store.ensureCollectionNames(args.collections as string[])
            : undefined;
          const dup = findDuplicate(store.papers.values(), args);
          if (dup) {
            if (args.update) {
              const paper = applyPaperPatch(dup, {
                ...args, year, importance,
                ...(colIds !== undefined ? { collectionIds: colIds } : {}),
              });
              await store.upsertPaper(paper);
              let pdfWarning: string | undefined;
              if (paper.arxivId && !paper.pdfPath) {
                try {
                  await downloadPaperPdf(paper, store, getConfig().fetchProxy || undefined);
                } catch (err) {
                  pdfWarning = `PDF 自动下载失败：${err instanceof Error ? err.message : String(err)}`;
                }
              }
              return { ok: true, created: false, duplicate: true, updated: true, paper: toJson(paper), ...(pdfWarning ? { pdfWarning } : {}) };
            }
            return { ok: true, created: false, duplicate: true, updated: false, paper: toJson(dup) };
          }
          const tags = [...new Set([...(getConfig().defaultTags ?? []), ...(args.tags ?? [])])];
          const paper = createPaper({
            ...args, year, importance, tags, source: 'agent',
            ...(colIds !== undefined && colIds.length ? { collectionIds: colIds } : {}),
          });
          await store.upsertPaper(paper);
          let pdfWarning: string | undefined;
          if (paper.arxivId && !paper.pdfPath) {
            try {
              await downloadPaperPdf(paper, store, getConfig().fetchProxy || undefined);
            } catch (err) {
              pdfWarning = `PDF 自动下载失败：${err instanceof Error ? err.message : String(err)}`;
            }
          }
          return { ok: true, created: true, duplicate: false, updated: false, paper: toJson(paper), ...(pdfWarning ? { pdfWarning } : {}) };
        },
      })),

      /* ---------- 1a-2. paper_fetch_pdf：为已入库论文补齐 PDF ---------- */
      ctx.tools.register(defineTool({
        name: 'paper_fetch_pdf',
        description:
          '为已入库的论文下载并归档 PDF 附件（目前支持 arXiv 论文自动下载）。'
          + '用户说"把这篇的 PDF 下载下来 / 补个 PDF"时调用。参数给论文 id 或标题关键词。',
        parameters: {
          paper: { type: 'string', required: true, description: '论文 id 或标题关键词' },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              found: { type: 'boolean' },
              already: { type: 'boolean' },
              pdfPath: { type: 'string' },
              title: { type: 'string' },
              error: { type: 'string' },
              candidates: { type: 'json' },
            },
          },
          render: renderJson,
        },
        presentCall: (args: any) => callView(`补齐 PDF：${String(args.paper ?? '').slice(0, 30)}`),
        presentResult: (args: any, result: any) => {
          const v = result?.value ?? result ?? {};
          const md = v.ok
            ? (v.already ? '已有 PDF 附件' : `已归档：${v.pdfPath}`)
            : (v.error || '未找到该论文');
          return resultView(`补齐 PDF：${String(v.title ?? args.paper ?? '').slice(0, 36)}`, md);
        },
        async execute(args: any) {
          const store = await getStore();
          const candidates = findPaperCandidates(store, String(args.paper ?? ''));
          if (candidates.length === 0) return { ok: false, found: false, error: `未找到论文：${String(args.paper ?? '')}` };
          if (candidates.length > 1) {
            // 关键词多命中不再"模糊取第一条"（可能把 PDF 归档到错误论文）
            return {
              ok: false, found: true,
              error: `“${String(args.paper ?? '')}”匹配到 ${candidates.length} 篇论文，请用精确 id 重试`,
              candidates: candidateList(candidates),
            };
          }
          const paper = candidates[0];
          if (paper.pdfPath && existsSync(join(store.dir, paper.pdfPath))) {
            return { ok: true, found: true, already: true, pdfPath: paper.pdfPath, title: paper.title };
          }
          try {
            await downloadPaperPdf(paper, store, getConfig().fetchProxy || undefined);
            return { ok: true, found: true, already: false, pdfPath: paper.pdfPath, title: paper.title };
          } catch (err) {
            return { ok: false, found: true, title: paper.title, error: err instanceof Error ? err.message : String(err) };
          }
        },
      })),

      /* ---------- 1a-3. paper_save_report：精读报告归档 ---------- */
      ctx.tools.register(defineTool({
        name: 'paper_save_report',
        description:
          '把 deepread 精读报告（完整 html 内容）存进论文库并关联到指定论文；保存后该论文详情页会出现「精读报告」链接。'
          + '精读完成后调用。',
        parameters: {
          paper: { type: 'string', required: true, description: '论文 id 或标题关键词' },
          html: { type: 'string', required: true, description: '精读报告的完整 HTML 内容' },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              file: { type: 'string' },
              title: { type: 'string' },
              error: { type: 'string' },
              candidates: { type: 'json' },
            },
          },
          render: renderJson,
        },
        presentCall: (args: any) => callView(`保存精读报告：${String(args.paper ?? '').slice(0, 30)}`),
        presentResult: (args: any, result: any) => {
          const v = result?.value ?? result ?? {};
          return resultView(`保存精读报告：${String(v.title ?? args.paper ?? '').slice(0, 36)}`,
            v.ok ? `已归档：reports/${v.file}` : (v.error || '保存失败'));
        },
        async execute(args: any) {
          const store = await getStore();
          const candidates = findPaperCandidates(store, String(args.paper ?? ''));
          if (candidates.length === 0) return { ok: false, error: `未找到论文：${String(args.paper ?? '')}` };
          if (candidates.length > 1) {
            // 关键词多命中不再"模糊取第一条"（可能把报告归档到错误论文）
            return {
              ok: false,
              error: `“${String(args.paper ?? '')}”匹配到 ${candidates.length} 篇论文，请用精确 id 重试`,
              candidates: candidateList(candidates),
            };
          }
          const paper = candidates[0];
          const html = String(args.html ?? '');
          if (!html.trim()) return { ok: false, error: 'html 内容为空' };
          if (html.length > 20 * 1024 * 1024) return { ok: false, error: '报告超过 20MB 上限' };
          const dir = join(store.dir, 'reports');
          await mkdir(dir, { recursive: true });
          const name = `${safeName(paper.id)}-${Date.now()}.html`;
          await writeFile(join(dir, name), html, 'utf8');
          return { ok: true, file: name, title: paper.title };
        },
      })),

      /* ---------- 1b. paper_update ---------- */
      ctx.tools.register(defineTool({
        name: 'paper_update',
        description:
          '更新论文库中一篇已有论文的元数据或归档位置（学者工作台插件）。只更新提供的字段。'
          + '用户说"把这篇移到 XX 分区/加上标签/改重要度"等场景使用，id 可用 paper_search 查到。',
        parameters: {
          id: { type: 'string', required: true, description: '论文 id（paper_search/paper_get 返回的）' },
          title: { type: 'string', description: '新标题' },
          authors: { type: 'array', items: { type: 'string' }, description: '新作者列表' },
          year: { type: 'integer', description: '发表年份（1900-2100）' },
          venue: { type: 'string', description: '会议/期刊名' },
          summary: { type: 'string', description: '一句话总结' },
          abstract: { type: 'string', description: '摘要' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签（整体替换）' },
          importance: { type: 'integer', description: '重要度 1-5' },
          readStatus: { type: 'string', description: '阅读状态：want=想读 / reading=在读 / done=读过' },
          notes: { type: 'string', description: '备注' },
          collections: {
            type: 'array',
            items: { type: 'string' },
            description: '收集分区名称列表（整体替换归属；不存在的分区自动创建）；传空数组清除所有归属',
          },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: { ok: { type: 'boolean' }, paper: { type: 'json' } },
          },
          render: renderJson,
          presentationMeta: (_a: unknown, value: any) => value,
        },
        presentCall: (args: any) => callView(`更新论文：${String(args.id ?? '').slice(0, 40)}`, {
          status: undefined, collections: args.collections, tags: args.tags, importance: args.importance,
        }),
        presentResult: (args: any, result: { value?: any; meta?: any }) => {
          const v: any = result.value ?? {};
          const p: any = v.paper ?? {};
          return resultView(`论文已更新：${String(p.title ?? args.id ?? '').slice(0, 36)}`, mdPaper(p));
        },
        async execute(args: any) {
          const store = await getStore();
          const existing = store.papers.get(args.id);
          if (!existing) throw new Error(`论文不存在: ${args.id}`);
          const colIds = Array.isArray(args.collections)
            ? await store.ensureCollectionNames(args.collections as string[])
            : undefined;
          const paper = applyPaperPatch(existing, {
            title: args.title,
            authors: args.authors,
            year: int(args.year, 1900, 2100),
            venue: args.venue,
            summary: args.summary,
            tags: args.tags,
            importance: int(args.importance, 1, 5),
            readStatus: args.readStatus,
            notes: args.notes,
            ...(colIds !== undefined ? { collectionIds: colIds } : {}),
          });
          await store.upsertPaper(paper);
          return { ok: true, paper: toJson(paper) };
        },
      })),

      /* ---------- 2. paper_search ---------- */
      ctx.tools.register(defineTool({
        name: 'paper_search',
        description:
          '在本地论文库（学者工作台）中检索论文。返回精简字段（id/标题/年份/venue/标签/总结），'
          + '供对话中查阅、引用或继续加工。关键词可匹配标题/作者/摘要/标签。',
        parameters: {
          q: { type: 'string', description: '关键词' },
          tag: { type: 'string', description: '按标签精确筛选' },
          yearFrom: { type: 'integer', description: '发表年份下限' },
          yearTo: { type: 'integer', description: '发表年份上限' },
          importance: { type: 'integer', description: '最低重要度 1-5' },
          readStatus: { type: 'string', description: '阅读状态筛选：want=想读 / reading=在读 / done=读过' },
          limit: { type: 'integer', description: '返回条数上限（默认 10，最大 50）' },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              total: { type: 'integer' },
              papers: { type: 'json' },
            },
          },
          render: renderJson,
          presentationMeta: (_a: unknown, value: any) => value,
        },
        presentCall: (args: any) => callView(`检索论文库`, { q: args.q, tag: args.tag, yearFrom: args.yearFrom, yearTo: args.yearTo, importance: args.importance }),
        presentResult: (args: any, result: { value?: any; meta?: any }) => {
          const v: any = result.value ?? {};
          const items = (v.papers ?? []).slice(0, 8).map((p: any) =>
            `- **${p.title}**  ${p.year ?? ''} ${p.venue ?? ''} ${(p.tags ?? []).map((x: string) => '#' + x).join(' ')}`.replace(/\s+/g, ' '));
          return resultView(`找到 ${v.total ?? 0} 篇论文`, mdList(items, Math.max(0, (v.total ?? 0) - items.length)));
        },
        async execute(args: any) {
          const store = await getStore();
          const limit = Math.max(1, Math.min(50, args.limit ?? 10));
          // 非法 readStatus 视为未筛选（否则静默返回 0 条，模型会误以为库里没有）
          const readStatus = READ_STATUSES.includes(args.readStatus) ? args.readStatus : undefined;
          const all = filterPapers([...store.papers.values()], {
            q: args.q, tag: args.tag,
            yearFrom: int(args.yearFrom, 1900, 2100),
            yearTo: int(args.yearTo, 1900, 2100),
            importance: int(args.importance, 1, 5),
            readStatus,
            sort: 'createdAt',
          });
          const papers = all.slice(0, limit).map((p) => ({
            id: p.id, title: p.title, authors: p.authors, year: p.year, venue: p.venue,
            tags: p.tags, importance: p.importance, readStatus: p.readStatus ?? 'want',
            summary: p.summary, source: p.source,
          }));
          return { ok: true, total: all.length, papers: toJson(papers) };
        },
      })),

      /* ---------- 3. paper_get ---------- */
      ctx.tools.register(defineTool({
        name: 'paper_get',
        description: '读取本地论文库中单篇论文的完整记录（含摘要、总结、备注）。',
        parameters: {
          id: { type: 'string', required: true, description: '论文 id（来自 paper_save/paper_search）' },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: { ok: { type: 'boolean' }, paper: { type: 'json' } },
          },
          render: renderJson,
          presentationMeta: (_a: unknown, value: any) => value,
        },
        presentCall: (args: any) => callView(`读取论文：${String(args.id ?? '').slice(0, 40)}`),
        presentResult: (args: any, result: { value?: any; meta?: any }) => {
          const v: any = result.value ?? {};
          const p: any = v.paper ?? {};
          const md = [mdPaper(p), p.summary ? `\n> ${p.summary}` : ''].filter(Boolean).join('\n');
          return resultView(`论文：${String(p.title ?? args.id ?? '').slice(0, 36)}`, md);
        },
        async execute(args: any) {
          const store = await getStore();
          const paper = store.papers.get(args.id);
          if (!paper) throw new Error(`论文不存在: ${args.id}`);
          return { ok: true, paper: toJson(paper) };
        },
      })),

      /* ---------- 4. idea_card_create ---------- */
      ctx.tools.register(defineTool({
        name: 'idea_card_create',
        description:
          '把论文的创新点/有价值的想法保存为 Idea 卡片（学者工作台 Idea 书柜）。'
          + '用户说"记成 idea 卡片/把创新点记下来"时调用。'
          + 'insight 请精炼概括创新点本身（而非复述论文摘要）；paperId 引用论文库中已保存的论文。',
        parameters: {
          title: { type: 'string', required: true, description: '卡片标题（一句话）' },
          insight: { type: 'string', required: true, description: '创新点/想法内容' },
          paperId: { type: 'string', description: '来源论文 id（须已在论文库中；独立想法可不填）' },
          category: {
            type: 'string',
            enum: ['method', 'theory', 'dataset', 'evaluation', 'engineering', 'other'],
            description: '分类：方法/理论/数据集/评测/工程/其他',
          },
          tags: { type: 'array', items: { type: 'string' }, description: '标签' },
          importance: { type: 'integer', description: '重要度 1-5（默认 3）' },
          status: {
            type: 'string',
            enum: ['pending', 'validated', 'adopted', 'dropped'],
            description: '状态（默认 pending 待验证）',
          },
          notes: { type: 'string', description: '备注' },
          relatedIds: {
            type: 'array',
            items: { type: 'string' },
            description: '关联的已有卡片 id 列表（idea_card_search 可查）；不存在的 id 会被忽略',
          },
          plain: { type: 'string', description: '通俗表达：用一句大白话讲清这个想法（非本方向的人也能听懂）' },
          steps: {
            type: 'array',
            items: { type: 'string' },
            description: '实现/验证流程步骤，每步一句；面板会渲染为流程图',
          },
          evidence: {
            type: 'string',
            description: '证据摘录：支撑该想法的论文原文关键句 + 定位（如 "§3.2 / Fig.3：……"），让卡片脱离论文也可引用',
          },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              created: { type: 'boolean' },
              card: { type: 'json' },
              droppedRelatedIds: { type: 'json' },
              similar: { type: 'json' },
            },
          },
          render: renderJson,
          presentationMeta: (_a: unknown, value: any) => value,
        },
        presentCall: (args: any) => callView(`记卡片：${String(args.title ?? '').slice(0, 36)}`, {
          paperId: args.paperId, category: args.category, tags: args.tags, relatedIds: args.relatedIds,
        }),
        presentResult: (args: any, result: { value?: any; meta?: any }) => {
          const v: any = result.value ?? {};
          const c: any = v.card ?? {};
          const md = [
            c.plain ? `一句话：${c.plain}` : '',
            c.insight ?? '',
            c.paperId ? `来源论文：${c.paperId}` : '',
            (c.relatedCardIds ?? []).length ? `关联卡片 ${c.relatedCardIds.length} 张` : '',
            c.evidence ? `> 证据：${c.evidence}` : '',
            (v.droppedRelatedIds ?? []).length ? `忽略的未知卡片 id：${v.droppedRelatedIds.join('、')}` : '',
            (v.similar ?? []).length ? `⚠️ 库里已有相似卡片（可能是重复沉淀，请确认）：${(v.similar ?? []).map((s: any) => s.title).join('；')}` : '',
            ...((c.steps ?? []) as string[]).map((x: string, i: number) => `${i + 1}. ${x}`),
          ].filter(Boolean).join('\n');
          return resultView(`已建档：${String(c.title ?? '').slice(0, 36)}`, md);
        },
        async execute(args: any) {
          const store = await getStore();
          if (args.paperId && !store.papers.has(args.paperId)) {
            throw new Error(`论文 ${args.paperId} 不在论文库中，请先用 paper_save 保存该论文`);
          }
          const relRaw = Array.isArray(args.relatedIds) ? args.relatedIds as string[] : undefined;
          const relIds = relRaw !== undefined ? store.filterExistingCardIds(relRaw) : undefined;
          const card = createCard({
            ...args,
            category: args.category as CardCategory | undefined,
            status: args.status as CardStatus | undefined,
            importance: int(args.importance, 1, 5),
            ...(relIds !== undefined && relIds.length ? { relatedCardIds: relIds } : {}),
          });
          await store.upsertCard(card);
          // 静默过滤改为显式反馈：被忽略的关联 id 回传给模型
          const droppedRelatedIds = relRaw?.filter((x) => !store.cards.has(x)) ?? [];
          // 相似卡提醒（非阻塞）：跨会话重复沉淀的护栏
          const similar = findSimilarCards([...store.cards.values()], card.title, { excludeId: card.id, paperId: card.paperId });
          return { ok: true, created: true, card: toJson(card), ...(droppedRelatedIds.length ? { droppedRelatedIds } : {}), ...(similar.length ? { similar: toJson(similar) } : {}) };
        },
      })),

      /* ---------- 5. idea_card_search ---------- */
      ctx.tools.register(defineTool({
        name: 'idea_card_search',
        description: '在 Idea 书柜中检索卡片，支持分类/标签/重要度/状态/来源论文/关键词组合筛选。',
        parameters: {
          q: { type: 'string', description: '关键词（标题/内容/标签）' },
          category: {
            type: 'string',
            enum: ['method', 'theory', 'dataset', 'evaluation', 'engineering', 'other'],
            description: '分类筛选',
          },
          tag: { type: 'string', description: '标签筛选' },
          importance: { type: 'integer', description: '最低重要度 1-5' },
          status: { type: 'string', enum: ['pending', 'validated', 'adopted', 'dropped'], description: '状态筛选' },
          paperId: { type: 'string', description: '来源论文 id' },
          limit: { type: 'integer', description: '返回条数上限（默认 20，最大 100）' },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              total: { type: 'integer' },
              cards: { type: 'json' },
            },
          },
          render: renderJson,
          presentationMeta: (_a: unknown, value: any) => value,
        },
        presentCall: (args: any) => callView(`检索 Idea 卡片`, { q: args.q, category: args.category, status: args.status, tag: args.tag }),
        presentResult: (args: any, result: { value?: any; meta?: any }) => {
          const v: any = result.value ?? {};
          const items = (v.cards ?? []).slice(0, 8).map((c: any) =>
            `- **${c.title}**  ${c.category} \u2192 ${(c.insight ?? '').slice(0, 40)}`);
          return resultView(`找到 ${v.total ?? 0} 张卡片`, mdList(items, Math.max(0, (v.total ?? 0) - items.length)));
        },
        async execute(args: any) {
          const store = await getStore();
          const limit = Math.max(1, Math.min(100, args.limit ?? 20));
          const all = filterCards([...store.cards.values()], {
            q: args.q,
            category: args.category as CardCategory | undefined,
            tag: args.tag,
            importance: int(args.importance, 1, 5),
            status: args.status as CardStatus | undefined,
            paperId: args.paperId,
            sort: 'createdAt',
          });
          const cards = all.slice(0, limit).map((c) => ({
            id: c.id, title: c.title, insight: c.insight, paperId: c.paperId,
            category: c.category, tags: c.tags, importance: c.importance, status: c.status,
          }));
          return { ok: true, total: all.length, cards: toJson(cards) };
        },
      })),

      /* ---------- 6. idea_card_update ---------- */
      ctx.tools.register(defineTool({
        name: 'idea_card_update',
        description: '更新一张 Idea 卡片（状态流转、重要度、标签、内容等）。只更新提供的字段。',
        parameters: {
          id: { type: 'string', required: true, description: '卡片 id' },
          title: { type: 'string', description: '新标题' },
          insight: { type: 'string', description: '新内容' },
          paperId: { type: 'string', description: '来源论文 id（传空字符串解除关联）' },
          category: {
            type: 'string',
            enum: ['method', 'theory', 'dataset', 'evaluation', 'engineering', 'other'],
            description: '新分类',
          },
          tags: { type: 'array', items: { type: 'string' }, description: '新标签列表' },
          importance: { type: 'integer', description: '新重要度 1-5' },
          status: { type: 'string', enum: ['pending', 'validated', 'adopted', 'dropped'], description: '新状态' },
          notes: { type: 'string', description: '新备注' },
          plain: { type: 'string', description: '新的通俗表达' },
          steps: {
            type: 'array',
            items: { type: 'string' },
            description: '新的流程步骤（整体替换；传空数组清除）',
          },
          relatedIds: {
            type: 'array',
            items: { type: 'string' },
            description: '关联卡片 id 列表（整体替换；传空数组清除全部关联）',
          },
          evidence: { type: 'string', description: '新的证据摘录（传空字符串清除）' },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: { ok: { type: 'boolean' }, card: { type: 'json' }, droppedRelatedIds: { type: 'json' } },
          },
          render: renderJson,
          presentationMeta: (_a: unknown, value: any) => value,
        },
        presentCall: (args: any) => callView(`更新卡片：${String(args.id ?? '').slice(0, 40)}`, {
          status: args.status, importance: args.importance, tags: args.tags, relatedIds: args.relatedIds,
        }),
        presentResult: (args: any, result: { value?: any; meta?: any }) => {
          const v: any = result.value ?? {};
          const c: any = v.card ?? {};
          return resultView(`卡片已更新：${String(c.title ?? args.id ?? '').slice(0, 36)}`,
            [`状态 ${c.status ?? ''} · 重要度 ${'★'.repeat(c.importance ?? 3)}`].join('\n'));
        },
        async execute(args: any) {
          const store = await getStore();
          const existing = store.cards.get(args.id);
          if (!existing) throw new Error(`卡片不存在: ${args.id}`);
          if (args.paperId && !store.papers.has(args.paperId)) {
            throw new Error(`论文 ${args.paperId} 不在论文库中`);
          }
          const relRaw = Array.isArray(args.relatedIds) ? args.relatedIds as string[] : undefined;
          const card = applyCardPatch(existing, {
            title: args.title,
            insight: args.insight,
            paperId: args.paperId,
            category: args.category as CardCategory | undefined,
            tags: args.tags,
            importance: int(args.importance, 1, 5),
            status: args.status as CardStatus | undefined,
            notes: args.notes,
            ...(relRaw !== undefined ? { relatedCardIds: store.filterExistingCardIds(relRaw) } : {}),
            ...(args.plain !== undefined ? { plain: String(args.plain) } : {}),
            ...(Array.isArray(args.steps) ? { steps: args.steps as string[] } : {}),
            ...(args.evidence !== undefined ? { evidence: String(args.evidence) } : {}),
          });
          await store.upsertCard(card);
          // 静默过滤改为显式反馈：被忽略的关联 id 回传给模型
          const droppedRelatedIds = relRaw?.filter((x) => !store.cards.has(x)) ?? [];
          return { ok: true, card: toJson(card), ...(droppedRelatedIds.length ? { droppedRelatedIds } : {}) };
        },
      })),

      /* ---------- 7. kg_extract (two-phase) ---------- */
      ctx.tools.register(defineTool({
        name: 'kg_extract',
        description:
          '知识图谱抽取（学者工作台）。两阶段工具。用户要求“同步/更新图谱”时，'
          + '重点为尚未入图的论文（见返回的 unsynced 列表）建立节点并关联概念。\n'
          + '阶段一（准备）：不带 nodes/edges 调用（可带 paperId 指定单篇并返回该篇完整元数据，'
          + '省略则针对全库只返回 unsynced 清单与全库计数，需要细节时逐篇指定 paperId 再调）'
          + '（mode=rebuild 表示重建整个图谱）。\n'
          + '阶段二（提交）：阅读返回内容后，提炼概念节点（方法/任务/数据集/指标等）与关系边，'
          + '带上 nodes/edges 再次调用本工具提交。关系类型：proposes 提出 / improves 改进 / extends 扩展 / '
          + 'builds_on 基于 / compares 对比 / uses 使用。paper 节点 id 必须是论文库中的 id。'
          + '概念节点 id 用简短英文小写 slug（如 "lora"、"video-diffusion"），label 用自然语言名称。\n'
          + 'rebuild 保护：现有图谱较大（节点+边 > 20）而提交总量不足现有 50% 时会被拒绝，'
          + '确认要缩减重建才带 force=true（旧图谱会先备份为 graph.json.bak）。',
        parameters: {
          paperId: { type: 'string', description: '抽取目标论文 id；省略 = 全库' },
          mode: { type: 'string', enum: ['append', 'rebuild'], description: 'append=合并（默认）；rebuild=重建图谱' },
          force: { type: 'boolean', description: '缩减型 rebuild 的显式确认（默认 false）：现有图谱较大而提交内容不足其 50% 时须 force=true 才放行' },
          nodes: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string', required: true, description: '节点 id（paper 节点用论文 id）' },
                kind: { type: 'string', enum: ['paper', 'concept'], required: true, description: '节点类型' },
                label: { type: 'string', required: true, description: '节点显示名' },
              },
            },
            description: '阶段二提交：节点列表',
          },
          edges: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                source: { type: 'string', required: true, description: '起点节点 id' },
                target: { type: 'string', required: true, description: '终点节点 id' },
                kind: {
                  type: 'string', required: true,
                  enum: ['proposes', 'improves', 'extends', 'builds_on', 'compares', 'uses'],
                  description: '关系类型',
                },
              },
            },
            description: '阶段二提交：关系边列表',
          },
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: renderJson,
          presentationMeta: (_a: unknown, value: any) => value,
        },
        presentCall: (args: any) => callView(
          args.nodes || args.edges ? '提交知识图谱抽取' : `准备知识图谱抽取：${args.paperId ?? '全库'}`,
          { paperId: args.paperId, mode: args.mode }),
        presentResult: (args: any, result: { value?: any; meta?: any }) => {
          const v: any = result.value ?? {};
          if (v.phase === 'prepare') {
            const list = v.papers ?? v.unsynced ?? [];
            const names = list.slice(0, 8).map((p: any) => `- ${p.title}`);
            return resultView(`抽取准备：全库 ${v.totalPapers ?? list.length} 篇论文、${(v.existingConcepts ?? []).length} 个现有概念`,
              mdList(names, Math.max(0, list.length - names.length)));
          }
          const d = v.dropped ?? {};
          return resultView(`图谱已更新（${v.mode ?? 'append'}）：${v.nodes ?? 0} 节点 / ${v.edges ?? 0} 边`,
            [`本次提交 +${v.addedNodes ?? 0} 节点（概念 ${v.addedConceptNodes ?? 0}）/ +${v.addedEdges ?? 0} 边`,
             (v.truncatedNodes || v.truncatedEdges) ? '注意：超出图谱容量上限，部分内容被截断' : '',
             (d.unknownPaperNodes || d.invalidEdges) ? `丢弃：未知论文节点 ${d.unknownPaperNodes ?? 0}、非法边 ${d.invalidEdges ?? 0}` : '',
            ].filter(Boolean).join('\n'));
        },
        async execute(args: any) {
          const store = await getStore();

          /* phase 2: commit submitted nodes/edges */
          if (args.nodes !== undefined || args.edges !== undefined) {
            const mode = args.mode === 'rebuild' ? 'rebuild' : 'append';
            const nodes: GraphNode[] = [];
            for (const n of args.nodes ?? []) {
              if (n && typeof n.id === 'string' && typeof n.label === 'string') {
                nodes.push({ id: n.id, kind: n.kind === 'paper' ? 'paper' : 'concept', label: n.label });
              }
            }
            const edges: GraphEdge[] = [];
            for (const e of args.edges ?? []) {
              if (e && typeof e.source === 'string' && typeof e.target === 'string' && typeof e.kind === 'string') {
                edges.push({ source: e.source, target: e.target, kind: e.kind as GraphEdge['kind'] });
              }
            }
            // rebuild 保护：缩减型 rebuild（详见 assertRebuildAllowed）需 force=true 显式确认
            if (mode === 'rebuild') {
              assertRebuildAllowed(store.graph, nodes.length + edges.length, args.force === true);
            }
            const stats: GraphMergeStats = { truncatedNodes: false, truncatedEdges: false };
            const graph = mergeGraph(store.graph, { nodes, edges }, mode, new Set(store.papers.keys()), stats);
            const conceptCount = nodes.filter((n) => n.kind === 'concept').length;
            const edgeCount = edges.length;
            // rebuild 前把旧图谱备份为 graph.json.bak（保留一代，可手工恢复）
            await (mode === 'rebuild' ? store.saveGraphRebuild(graph) : store.saveGraph(graph));
            return toJson({
              ok: true,
              phase: 'commit',
              mode,
              nodes: graph.nodes.length,
              edges: graph.edges.length,
              addedNodes: nodes.length,
              addedConceptNodes: conceptCount,
              addedEdges: edgeCount,
              truncatedNodes: stats.truncatedNodes,
              truncatedEdges: stats.truncatedEdges,
              dropped: {
                unknownPaperNodes: nodes.length - conceptCount - nodes.filter((n) => store.papers.has(n.id)).length,
                invalidEdges: (args.edges?.length ?? 0) - edgeCount,
              },
            });
          }

          /* phase 1: prepare payload */
          const mode = args.mode === 'rebuild' ? 'rebuild' : 'append';
          const targets = args.paperId
            ? (store.papers.get(args.paperId) ? [store.papers.get(args.paperId) as never] : [])
            : [...store.papers.values()];
          if (targets.length === 0) {
            return toJson({
              ok: true,
              phase: 'prepare',
              mode,
              message: args.paperId
                ? `论文 ${args.paperId} 不在论文库中`
                : '论文库为空，请先用 paper_save 保存论文',
              totalPapers: store.papers.size,
              papers: [],
              existingConcepts: [],
              existingPapers: [],
            });
          }
          // 现有概念按度数（现有边计数）截断 top 200，超出时注明
          const degree = new Map<string, number>();
          for (const e of store.graph.edges) {
            degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
            degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
          }
          const allConcepts = store.graph.nodes.filter((n) => n.kind === 'concept');
          const existingConcepts = allConcepts
            .map((n) => ({ id: n.id, label: n.label, deg: degree.get(n.id) ?? 0 }))
            .sort((a, b) => b.deg - a.deg || a.id.localeCompare(b.id))
            .slice(0, 200)
            .map(({ id, label }) => ({ id, label }));
          const conceptsTruncated = allConcepts.length > existingConcepts.length;
          const existingPapers = store.graph.nodes
            .filter((n) => n.kind === 'paper')
            .map((n) => ({ id: n.id, title: n.label }))
            .slice(0, 300);
          const inGraphPapers = new Set(store.graph.nodes.filter((n) => n.kind === 'paper').map((n) => n.id));
          const unsynced = targets
            .filter((p: any) => !inGraphPapers.has(p.id))
            .map((p: any) => ({ id: p.id as string, title: p.title as string }))
            .slice(0, 100);
          // 单篇抽取（paperId 指定）返回该篇完整元数据；全库抽取不再返回全库清单
          // （防上下文打爆），改为 unsynced（≤100，id/title）+ 全库计数，
          // 需要某篇细节时模型可指定 paperId 再调本工具或用 paper_get。
          const papers = args.paperId
            ? targets.map((p: { id: string; title: string; authors: string[]; year?: number; venue?: string; tags: string[]; summary?: string; abstract?: string }) => ({
              id: p.id,
              title: p.title,
              authors: p.authors,
              year: p.year,
              venue: p.venue,
              tags: p.tags,
              summary: p.summary,
              abstract: (p.abstract ?? '').slice(0, 400),
            }))
            : [];
          return toJson({
            ok: true,
            phase: 'prepare',
            mode,
            totalPapers: store.papers.size,
            unsynced,
            papers,
            existingConcepts,
            ...(conceptsTruncated
              ? { existingConceptsTruncated: true, existingConceptsTotal: allConcepts.length }
              : {}),
            existingPapers,
            hint: unsynced.length
              ? '以下论文尚未入图，请优先为它们建立节点与关系：' + unsynced.map((u: { id: string }) => u.id).join('、')
              : '请基于以上论文元数据与现有概念，组织 nodes/edges 后再次调用本工具提交（阶段二）。',
          });
        },
      })),

      /* ---------- 8. kg_query ---------- */
      ctx.tools.register(defineTool({
        name: 'kg_query',
        description: '查询知识图谱：给定概念或论文，返回相关节点与关系（如"哪些论文用了 LoRA"、"这篇论文基于谁"）。',
        parameters: {
          concept: { type: 'string', description: '概念名（如 "LoRA"）' },
          paperId: { type: 'string', description: '论文 id' },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              nodes: { type: 'json' },
              edges: { type: 'json' },
              stats: { type: 'json' },
            },
          },
          render: renderJson,
          presentationMeta: (_a: unknown, value: any) => value,
        },
        presentCall: (args: any) => callView('查询知识图谱', { concept: args.concept, paperId: args.paperId }),
        presentResult: (args: any, result: { value?: any; meta?: any }) => {
          const v: any = result.value ?? {};
          const s: any = v.stats ?? {};
          if (s.conceptFound) return resultView(`概念关联：${String(s.conceptId ?? '').replace('cpt_', '')}`, mdList((v.nodes ?? []).filter((n: any) => n.kind === 'paper').map((n: any) => `- ${n.label}`)));
          if (s.paperId) return resultView(`论文邻域：${String(s.paperId).slice(0, 40)}`, mdList((v.nodes ?? []).map((n: any) => `- ${n.label}`)));
          const tops = (s.topConcepts ?? []).slice(0, 8).map((c: any) => `- **${c.label}** ×${c.degree}`);
          return resultView(`图谱热度：${s.nodes ?? 0} 节点 / ${s.edges ?? 0} 边`, mdList(tops));
        },
        async execute(args: any) {
          const store = await getStore();
          const graph = store.graph;
          if (args.concept) {
            const id = resolveConcept(graph, args.concept);
            if (!id) {
              return { ok: true, nodes: [], edges: [], stats: toJson({ conceptFound: false }) };
            }
            const sub = conceptSubgraph(graph, id);
            return { ok: true, nodes: toJson(sub.nodes), edges: toJson(sub.edges), stats: toJson({ conceptFound: true, conceptId: id }) };
          }
          if (args.paperId) {
            if (!store.papers.has(args.paperId)) throw new Error(`论文不存在: ${args.paperId}`);
            const edges = graph.edges.filter((e) => e.source === args.paperId || e.target === args.paperId);
            const ids = new Set<string>([args.paperId]);
            for (const e of edges) { ids.add(e.source); ids.add(e.target); }
            const nodes = graph.nodes.filter((n) => ids.has(n.id));
            return { ok: true, nodes: toJson(nodes), edges: toJson(edges), stats: toJson({ paperId: args.paperId }) };
          }
          const degree = new Map<string, number>();
          for (const e of graph.edges) {
            degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
            degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
          }
          const topConcepts = graph.nodes
            .filter((n) => n.kind === 'concept')
            .map((n) => ({ id: n.id, label: n.label, degree: degree.get(n.id) ?? 0 }))
            .sort((a, b) => b.degree - a.degree)
            .slice(0, 15);
          return {
            ok: true,
            nodes: [],
            edges: [],
            stats: toJson({ nodes: graph.nodes.length, edges: graph.edges.length, topConcepts }),
          };
        },
      })),
    ];
    toolCount = disposers.length;
    return () => {
      for (const d of disposers) d();
    };
  });
  return toolCount;
}

/** Concept id resolution for kg_query (mirrors routes.resolveConceptId). */
function resolveConcept(graph: { nodes: GraphNode[] }, input: string): string | undefined {
  const canonical = conceptId(input);
  if (graph.nodes.some((n) => n.kind === 'concept' && n.id === canonical)) return canonical;
  const byLabel = graph.nodes.find((n) => n.kind === 'concept' && n.label.toLowerCase() === input.toLowerCase());
  return byLabel?.id;
}
