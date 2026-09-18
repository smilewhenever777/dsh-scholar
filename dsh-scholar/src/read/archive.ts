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
  file: string
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
  await mkdir(dir, { recursive: true });
  const file = `${safeName(paper.id)}-${Date.now()}.html`;
  await writeFile(join(dir, file), html, 'utf8');
  const summary = extractSummary(outcome);
  let updated = false;
  if (opts.updateSummary !== false && summary !== '') {
    const patched = applyPaperPatch(paper, { summary });
    await store.upsertPaper(patched);
    updated = true;
  }
  // 交互式精读的原料：保存章节块（保留历史问答）
  if ((outcome.meta.chunksText ?? []).length > 0) {
    await saveSessionAfterRead(store.dir, paper.id, outcome.meta.chunksText ?? [])
  }
  return { file, summary, mode: outcome.meta.mode, summaryUpdated: updated };
}
