/**
 * 多篇横向对比：各论文精读产物 → 压缩摘要 → 一次 LLM 调用 → 对比报告。
 * 输入只有摘要级（每篇几百字），调用规格小——后端半血也能跑。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PaperOutcome } from './engine.js'
import { createLlmRuntime } from './llm.js'

export interface CompareCell { paper: string; point: string }
export interface CompareDimension { dim: string; cells: CompareCell[]; verdict: string }
export interface CompareConflict { topic: string; detail: string; judge: string }
export interface CompareOutcome {
  kind: 'compare'
  positioning: string
  dimensions: CompareDimension[]
  shared: string[]
  conflicts: CompareConflict[]
  migration: string[]
  readingOrder: string
  titles: string[]
  meta: { papers: number; durationMs: number; synth?: string }
}

const COMPARE_SCHEMA = [
  '{',
  '  "positioning": "这些论文的总体定位关系（同赛道竞品/上下游/互补，2-3 句）",',
  '  "dimensions": [',
  '    {"dim": "对比维度（如骨干策略/蒸馏方式/实时性/小目标/数据效率/部署友好）",',
  '     "cells": [{"paper": "论文简称", "point": "该论文在此维度的做法与关键数字"}],',
  '     "verdict": "横评结论：谁强在哪、什么条件下选谁"}',
  '  ],',
  '  "shared": ["共同基础/共识点"],',
  '  "conflicts": [{"topic": "分歧点", "detail": "各自主张与证据差异", "judge": "怎么设计实验/看什么指标判断"}],',
  '  "migration": ["对我的研究方向可迁移的组合与机会点"],',
  '  "readingOrder": "读序与取舍建议（1-2 句）"',
  '}',
].join('\n')

/** 单篇 → 压缩摘要（对比调用的输入原料） */
function digestOf(o: PaperOutcome): string {
  const parts = [
    `【${o.title}】`,
    o.summary,
    o.coreConclusions.length > 0 ? '核心结论：' + o.coreConclusions.slice(0, 3).join('；') : '',
    o.items.slice(0, 4).map((it) => `- ${it.claim}${it.evidence && it.evidence !== '原文未提供证据' ? `（证据：${it.evidence.slice(0, 90)}）` : ''}`).join('\n'),
    o.dataPoints.slice(0, 4).map((d) => `- ${d.subject}: ${d.value}${d.baseline ? `（vs ${d.baseline}）` : ''}${d.source ? ` [${d.source}]` : ''}`).join('\n'),
    o.caveats.length > 0 ? '局限：' + o.caveats.slice(0, 2).join('；') : '',
  ]
  return parts.filter(Boolean).join('\n')
}

/** 归档时持久化的对比原料（sidecar JSON 的形状；也是"直接对比"路径的数据源） */
export interface CompareSidecar {
  title: string
  summary: string
  coreConclusions: string[]
  items: Array<{ claim: string; evidence: string }>
  dataPoints: Array<{ subject: string; value: string; baseline: string; source: string }>
  caveats: string[]
  at: number
}

export function sidecarOf(o: PaperOutcome, title: string): CompareSidecar {
  return {
    title,
    summary: o.summary,
    coreConclusions: o.coreConclusions.slice(0, 4),
    items: o.items.slice(0, 8).map((it) => ({ claim: it.claim, evidence: it.evidence })),
    dataPoints: o.dataPoints.slice(0, 8).map((d) => ({ subject: d.subject, value: d.value, baseline: d.baseline, source: d.source })),
    caveats: o.caveats.slice(0, 4),
    at: Date.now(),
  }
}

export function digestOfSidecar(s: CompareSidecar): string {
  const parts = [
    `【${s.title}】`,
    s.summary,
    s.coreConclusions.length > 0 ? '核心结论：' + s.coreConclusions.join('；') : '',
    s.items.slice(0, 6).map((it) => `- ${it.claim}${it.evidence && it.evidence !== '原文未提供证据' ? `（证据：${it.evidence.slice(0, 90)}）` : ''}`).join('\n'),
    s.dataPoints.slice(0, 6).map((d) => `- ${d.subject}: ${d.value}${d.baseline ? `（vs ${d.baseline}）` : ''}${d.source ? ` [${d.source}]` : ''}`).join('\n'),
    s.caveats.length > 0 ? '局限：' + s.caveats.join('；') : '',
  ]
  return parts.filter(Boolean).join('\n')
}

function sanitizeCompare(parsed: unknown, titles: string[]): Omit<CompareOutcome, 'kind' | 'meta'> {
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
  const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d)
  const arr = Array.isArray ? (v: unknown) => (Array.isArray(v) ? v : []) : () => []
  const p = isRecord(parsed) ? parsed : {}
  return {
    positioning: str(p.positioning),
    dimensions: arr(p.dimensions).slice(0, 8).map((d) => {
      const o = isRecord(d) ? d : {}
      return {
        dim: str(o.dim, '未命名维度').slice(0, 60),
        cells: arr(o.cells).slice(0, 10).map((c) => {
          const co = isRecord(c) ? c : {}
          return { paper: str(co.paper).slice(0, 80), point: str(co.point).slice(0, 400) }
        }).filter((c) => c.point !== ''),
        verdict: str(o.verdict).slice(0, 300),
      }
    }).filter((d) => d.cells.length >= 2),
    shared: arr(p.shared).slice(0, 6).map((s) => String(s)).filter(Boolean),
    conflicts: arr(p.conflicts).slice(0, 6).map((c) => {
      const o = isRecord(c) ? c : {}
      return { topic: str(o.topic).slice(0, 80), detail: str(o.detail).slice(0, 400), judge: str(o.judge).slice(0, 300) }
    }).filter((c) => c.topic !== ''),
    migration: arr(p.migration).slice(0, 6).map((s) => String(s)).filter(Boolean),
    readingOrder: str(p.readingOrder).slice(0, 300),
    titles,
  }
}

/** 多篇对比主入口（通用）：entries = 标题+已拼好的摘要文本 */
export async function runCompareEntries(ctx: Context, entries: Array<{ title: string; digest: string }>, focus: string, signal: { aborted: boolean }): Promise<CompareOutcome> {
  const started = Date.now()
  const { callModelJson, pickConfig } = createLlmRuntime({
    ctx: ctx as never,
    estimateTokens: (t) => Math.ceil(t.length * 0.6),
    llmCallStats: { calls: 0, ms: 0 },
    recordCalibration: (() => undefined) as never,
  })
  const cfg = await pickConfig()
  const titles = entries.map((o) => o.title)
  const user = '以下是要对比的 ' + entries.length + ' 篇论文的精读摘要：\n\n'
    + entries.map((e) => e.digest).join('\n\n')
    + (focus.trim() !== '' ? '\n\n读者特别关注：' + focus.trim() : '')
  const parsed = await callModelJson(
    cfg,
    '你是论文横向对比专家。基于各论文的精读摘要做对比分析，严格只输出一个 JSON 对象（不要任何解释或 Markdown 代码块），结构如下：\n'
    + COMPARE_SCHEMA + '\n'
    + '要求：dimensions 选 3-6 个最能区分这些论文的维度（读者关注方向优先）；cells 覆盖全部论文且只写摘要里有的内容，'
    + '带具体数字/表号；冲突必须写清各自证据；不编造摘要里没有的内容。输出语言：简体中文。',
    user,
    8000,
    signal,
  )
  const s = sanitizeCompare(parsed, titles)
  return { kind: 'compare', ...s, meta: { papers: entries.length, durationMs: Date.now() - started } }
}

/** 多篇对比（用 PaperOutcome 产物） */
export async function runCompare(ctx: Context, outcomes: PaperOutcome[], focus: string, signal: { aborted: boolean }): Promise<CompareOutcome> {
  return runCompareEntries(ctx, outcomes.map((o) => ({ title: o.title, digest: digestOf(o) })), focus, signal)
}
