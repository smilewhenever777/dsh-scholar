/**
 * 精读结果归档：渲染五段式报告 html 落 reports/ + summary 回填论文。
 * paper_read 工具与 /scholar/read/run 路由共用。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Paper } from '../shared/types.js';
import type { PaperStore } from '../store.js';
import { safeName } from '../store.js';
import { applyPaperPatch } from '../domain.js';
import { renderReportHtml, extractSummary } from './render.js';
import { saveSessionAfterRead } from './session.js';
import type { PaperOutcome, QuickOutcome } from './engine.js';

export interface ArchiveInfo {
  file: string | null
  summary: string
  mode: 'paper' | 'quick'
  summaryUpdated: boolean
}

/** 报告头部的副标题行：作者 ≤3 + venue/年 + 模式 + 日期 */
function headerSub(p: Paper, mode: 'paper' | 'quick', focusNote: string): string {
  const authors = p.authors.length > 3
    ? p.authors.slice(0, 3).join(', ') + ', et al.'
    : p.authors.join(', ');
  const bits = [authors, [p.venue, p.year].filter(Boolean).join(' '), p.arxivId ? 'arXiv:' + p.arxivId : '']
    .filter(Boolean).join(' · ');
  return bits + ' · ' + (mode === 'paper' ? '学术论文精读' : '速读') + ' · ' + new Date().toISOString().slice(0, 10)
    + (focusNote ? ' · ' + focusNote : '');
}

export async function archiveReadResult(
  store: PaperStore,
  paper: Paper,
  outcome: PaperOutcome | QuickOutcome,
  opts: { focusNote?: string; updateSummary?: boolean } = {},
): Promise<ArchiveInfo> {
  const html = renderReportHtml(outcome, {
    title: outcome.kind === 'paper' && outcome.title !== '未命名论文' ? outcome.title : paper.title,
    sub: headerSub(paper, outcome.meta.mode, opts.focusNote ?? ''),
  });
  const dir = join(store.dir, 'reports');
  const summary = extractSummary(outcome);
  const update = opts.updateSummary !== false && outcome.meta.synth !== 'assembled' && summary !== '';
  const archived = await store.commitPaperArtifacts([paper], async () => {
    await mkdir(dir, { recursive: true });
    const ts = Date.now();
    const file = `${safeName(paper.id)}-${ts}.html`;
    await writeFile(join(dir, file), html, 'utf8');
    // sidecar：对比原料（"直接对比已有成果"路径的数据源，免去重读）
    if (outcome.kind === 'paper') {
      try {
        const { sidecarOf } = await import('./compare.js');
        await writeFile(join(dir, `${safeName(paper.id)}-${ts}.json`), JSON.stringify(sidecarOf(outcome, paper.title), null, 1), 'utf8');
      } catch { /* sidecar 失败不影响归档 */ }
    }
    // 拼装档（综合彻底失败的兜底）的 summary 是分段摘要机械拼接——不覆盖
    // 论文已有 summary：读失败不该污染原有数据，页脚 ⚠ 标记已提示重读
    // 交互式精读的原料：保存章节块（保留历史问答）
    if ((outcome.meta.chunksText ?? []).length > 0) {
      await saveSessionAfterRead(store.dir, paper.id, outcome.meta.chunksText ?? [])
    }
    return { file, summary, mode: outcome.meta.mode, summaryUpdated: update };
  }, update ? { id: paper.id, apply: cur => applyPaperPatch(cur, { summary }) } : undefined);
  return archived ?? { file: null, summary: '', mode: outcome.meta.mode, summaryUpdated: false };
}
