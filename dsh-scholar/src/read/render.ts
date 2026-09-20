/**
 * 精读结果 → 学术报告 html（确定性渲染，零额外 token、版式稳定）。
 * 自包含：内联样式、明暗自适应（prefers-color-scheme）、无外链。
 * 视觉语言沿用旧版"知识地图"报告：彩色论点标签 / 概念树 / 徽章 / 表格。
 */
import type { PaperOutcome, QuickOutcome } from './engine.js'
import type { MindNode } from './types.js'
import type { CompareOutcome } from './compare.js'

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const CONFIDENCE_TAG: Record<string, string> = {
  '作者原意': 'c-aut',
  '原文事实与数据': 'c-fact',
  '合理推断': 'c-inf',
  '无法确认': 'c-unk',
}

const CSS = `
:root { --bg:#ffffff; --fg:#1f2328; --muted:#57606a; --card:#f6f8fa; --border:#d0d7de;
  --accent:#0969da; --green:#1a7f37; --green-bg:#dafbe1; --blue:#0969da; --blue-bg:#ddf4ff;
  --amber:#9a6700; --amber-bg:#fff8c5; --red:#cf222e; --red-bg:#ffebe9; --violet:#8250df; --violet-bg:#fbefff; }
@media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --fg:#e6edf3; --muted:#8b949e; --card:#161b22; --border:#30363d;
  --accent:#58a6ff; --green:#3fb950; --green-bg:#12261e; --blue:#58a6ff; --blue-bg:#0c2233;
  --amber:#d29922; --amber-bg:#2b2410; --red:#f85149; --red-bg:#331114; --violet:#bc8cff; --violet-bg:#1d1b2e; } }
*{box-sizing:border-box}
body{margin:0;padding:2rem 1rem 4rem;background:var(--bg);color:var(--fg);
  font:14.5px/1.75 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:880px;margin:0 auto}
header{border-bottom:2px solid var(--border);padding-bottom:1rem;margin-bottom:1.6rem}
h1{font-size:1.5rem;margin:0 0 .4rem;line-height:1.45}
.sub{color:var(--muted);font-size:.85rem;line-height:1.6}
.badge{display:inline-block;padding:.1em .6em;border-radius:1em;font-size:.72rem;font-weight:600;vertical-align:2px;margin-left:.5em}
.b-paper{color:var(--blue);background:var(--blue-bg)}
.b-quick{color:var(--green);background:var(--green-bg)}
.b-cmp{color:var(--violet);background:var(--violet-bg)}
h2{font-size:1.12rem;margin:2.2rem 0 .7rem;border-left:4px solid var(--accent);padding-left:.6rem}
h3{font-size:1rem;margin:1.2rem 0 .4rem}
.card{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:1rem 1.2rem;margin:.9rem 0}
.tldr{font-size:1.02rem}
.lbl{display:inline-block;font-size:.75rem;color:var(--accent);font-weight:600;margin-right:.4em}
table{border-collapse:collapse;width:100%;font-size:.86rem;margin:.8rem 0}
th,td{border:1px solid var(--border);padding:.45rem .6rem;text-align:left;vertical-align:top}
th{background:var(--card);color:var(--muted);font-weight:600}
td.ty{color:var(--amber);white-space:nowrap;font-size:.8rem;font-weight:600}
.num td{font-variant-numeric:tabular-nums}
.ev{color:var(--muted);font-size:.84rem;margin-top:.25rem}
.src{color:var(--muted);font-size:.76rem;margin-top:.2rem;opacity:.85}
.tag{display:inline-block;font-size:.72rem;padding:.05em .6em;border-radius:1em;font-weight:600;white-space:nowrap}
.c-aut{color:var(--blue);background:var(--blue-bg)}
.c-fact{color:var(--green);background:var(--green-bg)}
.c-inf{color:var(--amber);background:var(--amber-bg)}
.c-unk{color:var(--red);background:var(--red-bg)}
.rel{display:inline-block;font-size:.72rem;color:var(--violet);border:1px solid var(--border);border-radius:4px;padding:0 .35em;margin:.15rem .25rem 0 0}
.relrow{margin-top:.2rem}
ul.plain{padding-left:1.3rem;margin:.6rem 0}ul.plain li{margin:.4rem 0}
.mindmap ul{list-style:none;padding-left:1.3rem;margin:.2rem 0}
.mindmap>ul{padding-left:0}
.mindmap li{margin:.3rem 0;position:relative}
.mindmap li::before{content:"—";position:absolute;left:-1rem;color:var(--muted)}
.mindmap li b{color:var(--accent)}
.mmroot{font-weight:700;font-size:1.02rem;margin-bottom:.4rem;color:var(--accent)}
.qt{color:var(--violet);font-size:.82rem;margin-top:.25rem;padding-left:.6rem;border-left:2px solid var(--violet)}
blockquote{margin:.7rem 0;padding:.6rem 1rem;border-left:3px solid var(--violet);background:var(--violet-bg);border-radius:0 6px 6px 0;font-size:.9rem}
blockquote .ctx{display:block;color:var(--muted);font-size:.78rem;margin-top:.3rem}
figure.fig{margin:.9rem 0}
figure.fig img{max-width:100%;border-radius:6px;border:1px solid var(--border);display:block}
figure.fig figcaption{color:var(--muted);font-size:.8rem;margin-top:.35rem}
.meta{color:var(--muted);font-size:.78rem;margin-top:2.6rem;border-top:1px solid var(--border);padding-top:.8rem}
`

function head(title: string, sub: string, mode: 'paper' | 'quick'): string {
  const badge = mode === 'paper'
    ? '<span class="badge b-paper">学术深读</span>'
    : '<span class="badge b-quick">速读</span>'
  return `<header><h1>${esc(title)}${badge}</h1><div class="sub">${esc(sub)}</div></header>`
}

function section(no: string, title: string, body: string): string {
  return `<section><h2>${no} ${esc(title)}</h2>${body}</section>`
}

function mindmap(items: Array<{ term: string; explanation: string }>): string {
  const lis = items.map((c) => `<li><b>${esc(c.term)}</b> — ${esc(c.explanation)}</li>`).join('')
  return `<div class="card mindmap"><ul>${lis}</ul></div>`
}

function quotesBlock(qs: Array<{ text: string; context?: string; source?: string }>): string {
  return qs.map((q) => `<blockquote>「${esc(q.text)}」${q.context ? `<span class="ctx">↳ ${esc(q.context)}</span>` : ''}${q.source ? `<span class="src">${esc(q.source)}</span>` : ''}</blockquote>`).join('')
}

/** 知识地图：递归嵌套树（根 label 作卡头，主分支加粗高亮） */
function mindTree(node: MindNode): string {
  const kids = (n: MindNode): string => n.children.length === 0
    ? ''
    : '<ul>' + n.children.map((c) => `<li>${c.children.length > 0 ? `<b>${esc(c.label)}</b>` : esc(c.label)}${kids(c)}</li>`).join('') + '</ul>'
  return `<div class="card mindmap"><div class="mmroot">${esc(node.label)}</div>${kids(node)}</div>`
}

function renderPaper(r: PaperOutcome, header: string): string {
  const sec: string[] = []
  const conclusions = r.coreConclusions.map((c, i) =>
    `<li><span class="tag c-fact">结论 ${i + 1}</span> ${esc(c)}</li>`).join('')
  const items = r.items.map((it) => {
    const conf = CONFIDENCE_TAG[it.confidence] ?? 'c-unk'
    const rel = it.relations.map((x) => `<span class="rel">${esc(x.type)}→${esc(x.to.slice(0, 24))}</span>`).join(' ')
    const q = it.quote ? `<div class="qt">「${esc(it.quote)}」</div>` : ''
    return `<tr><td class="ty">${esc(it.type)}</td><td><b>${esc(it.claim)}</b>${rel ? `<div class="relrow">${rel}</div>` : ''}<div class="ev">${esc(it.evidence)}</div>${q}${it.source ? `<div class="src">${esc(it.source)}</div>` : ''}</td><td><span class="tag ${conf}">${esc(it.confidence || '未标')}</span></td></tr>`
  }).join('')
  const dp = r.dataPoints.map((d) =>
    `<tr><td><b>${esc(d.subject)}</b></td><td>${esc(d.value)}</td><td>${esc(d.period)}</td><td>${esc(d.baseline)}</td><td>${esc(d.source)}${d.location ? ' · ' + esc(d.location) : ''}</td></tr>`).join('')
  const caveats = r.caveats.map((c) => `<li>${esc(c)}</li>`).join('')
  const recall = r.recallQuestions.map((q) => `<li>${esc(q)}</li>`).join('')
  const imgs = r.meta.figuresImgs ?? []
  const figHtml = (i: number): string => {
    const im = imgs[i]
    if (!im) return ''
    return `<figure class="fig"><img src="data:${im.mime};base64,${im.b64}" alt="figure ${i + 1}" loading="lazy">${(r.meta.figureDescriptions ?? [])[i] ? `<figcaption>👁 ${esc((r.meta.figureDescriptions ?? [])[i]!)}</figcaption>` : ''}</figure>`
  }
  // 图注表纯文字：PDF 位图与论文插图无法按下标配对（大位图可能是 logo/装饰图），
  // 盲配会张冠李戴——嵌原图只在 VLM 视觉解读存在时做（解读由该图生成，配对天然正确）
  const figures = (r.figures ?? []).map((f) =>
    `<tr><td class="ty">${esc(f.ref)}</td><td>${esc(f.caption)}${f.meaning ? `<div class="ev">${esc(f.meaning)}</div>` : ''}</td></tr>`).join('')
  const vlmDescs = r.meta.figureDescriptions ?? []
  const gallery = vlmDescs.length > 0
    ? imgs.slice(0, vlmDescs.length).map((_im, i) => figHtml(i)).join('')
    : ''

  sec.push(section('', '一页速览',
    `<div class="card"><p class="tldr">${esc(r.summary)}</p>`
    + (r.coreQuestion ? `<p style="margin:.6rem 0 0"><span class="lbl">核心问题</span>${esc(r.coreQuestion)}</p>` : '')
    + (conclusions ? `</div><ul class="plain">${conclusions}</ul>` : '</div>')))
  if (r.mindmap) sec.push(section('', '知识地图（全文骨架）', mindTree(r.mindmap)))
  if (items) sec.push(section('', '方法与论点（设计选择 → 动机 → 消融证据）',
    `<table><tr><th>类型</th><th>主张 / 证据 / 原文</th><th>置信度</th></tr>${items}</table>`))
  if (dp) sec.push(section('', '实验还原（主表 / 消融表行）',
    `<table class="num"><tr><th>方法</th><th>数值</th><th>条件</th><th>基准</th><th>出处</th></tr>${dp}</table>`))
  if (gallery) sec.push(section('', '图表视觉解读（VLM · 按文档顺序）', gallery))
  if (figures) sec.push(section('', '图表清单（图注 + 正文解读）',
    `<table><tr><th>编号</th><th>图注 / 正文解读</th></tr>${figures}</table>`))
  if ((r.concepts ?? []).length > 0) sec.push(section('', '概念与术语地图', mindmap(r.concepts ?? [])))
  if ((r.quotes ?? []).length > 0) sec.push(section('', '关键原文摘录', quotesBlock(r.quotes ?? [])))
  if (caveats) sec.push(section('', '局限与未验证假设', `<ul class="plain">${caveats}</ul>`))
  if (recall) sec.push(section('', '主动回忆问题', `<ul class="plain">${recall}</ul>`))
  return header + sec.map((s, i) => s.replace('<h2>', `<h2>§${i + 1} `)).join('')
}

function renderQuick(r: QuickOutcome, header: string): string {
  const args = r.arguments.map((a) =>
    `<tr><td><b>${esc(a.claim)}</b><div class="ev">${esc(a.evidence)}</div>${a.source ? `<div class="src">${esc(a.source)}</div>` : ''}</td></tr>`).join('')
  const concepts = r.concepts.map((c) => `<li><b>${esc(c.term)}</b> — ${esc(c.explanation)}</li>`).join('')
  const qs = r.questions.map((q) => `<li>${esc(q)}</li>`).join('')
  return header
    + section('§1', '速览', `<div class="card"><p class="tldr">${esc(r.summary)}</p>${r.thesis ? `<p style="margin:.6rem 0 0"><span class="lbl">核心论点</span>${esc(r.thesis)}</p>` : ''}</div>`)
    + (args ? section('§2', '分论点', `<table><tr><th>主张 / 证据</th></tr>${args}</table>`) : '')
    + (concepts ? section('§3', '核心概念', `<div class="card mindmap"><ul>${concepts}</ul></div>`) : '')
    + ((r.caveats ?? []).length > 0 ? section('§4', '局限与边界', `<ul class="plain">${(r.caveats ?? []).map((c) => `<li>${esc(c)}</li>`).join('')}</ul>`) : '')
    + (qs ? section('§5', '批判性问题', `<ul class="plain">${qs}</ul>`) : '')
}

/** paper/quick 结果 → 完整自包含报告 html */
export function renderReportHtml(r: PaperOutcome | QuickOutcome, headerInfo: { title: string; sub: string }): string {
  const light = r.kind === 'paper' && r.meta.synth === 'light' ? '·轻量' : ''
  const header = head(headerInfo.title, headerInfo.sub + (light ? ' · 轻量档' : ''), r.kind === 'paper' ? 'paper' : 'quick')
  const body = r.kind === 'paper' ? renderPaper(r, header) : renderQuick(r, header)
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="scholar-report" content="${r.kind === 'paper' ? 'paper' : 'quick'}">`
    + `<title>${esc(headerInfo.title)}</title><style>${CSS}</style></head><body><div class="wrap">`
    + `${body}<div class="meta">学者工作台 · 自有精读引擎（${r.meta.mode} 模式）· ${r.meta.chunks} 段 · ${r.meta.chars} 字 · 耗时 ${Math.round(r.meta.durationMs / 1000)}s`
    + (r.meta.gaps?.length ? ` · ⚠ 第${r.meta.gaps.join('、')}段提取失败（全文综合已尽量补全）` : '')
    + (r.meta.synth ? ` · 综合：${r.meta.synth === 'fulltext' ? '全文' : r.meta.synth === 'split' ? '分半（全文）' : r.meta.synth === 'light' ? '摘要（轻量档，主动选择）' : r.meta.synth === 'digest' ? '⚠ 摘要（全文综合未成功，建议后端空闲时重读）' : '⚠ 分段拼装（建议重读）'}` : '') + `</div>`
    + `</div></body></html>`
}

/** 多篇横向对比结果 → 自包含对比报告 html（维度表 + 共识/分歧/迁移/读序） */
export function renderCompareHtml(r: CompareOutcome, headerInfo: { title: string; sub: string }): string {
  const badge = '<span class="badge b-cmp">对比</span>'
  const header = `<header><h1>${esc(headerInfo.title)}${badge}</h1><div class="sub">${esc(headerInfo.sub)}</div></header>`
  const secs: string[] = []
  if (r.positioning) secs.push(section('', '总体定位', `<div class="card"><p class="tldr">${esc(r.positioning)}</p></div>`))
  if (r.dimensions.length > 0) {
    const tables = r.dimensions.map((d) => {
      const rows = d.cells.map((c) => `<tr><td class="ty">${esc(c.paper)}</td><td>${esc(c.point)}</td></tr>`).join('')
      return `<h3>${esc(d.dim)}</h3><table><tr><th>论文</th><th>做法 / 结果</th></tr>${rows}</table>`
        + (d.verdict ? `<div class="ev" style="margin-bottom:.6rem">⚖ ${esc(d.verdict)}</div>` : '')
    }).join('')
    secs.push(section('', '维度对比', tables))
  }
  if (r.shared.length > 0) secs.push(section('', '共同基础', `<ul class="plain">${r.shared.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`))
  if (r.conflicts.length > 0) {
    secs.push(section('', '分歧与判据', r.conflicts.map((c) =>
      `<div class="card"><b>${esc(c.topic)}</b><div style="margin-top:.3rem">${esc(c.detail)}</div>${c.judge ? `<div class="ev" style="margin-top:.3rem">🔬 判据：${esc(c.judge)}</div>` : ''}</div>`).join('')))
  }
  if (r.migration.length > 0) {
    secs.push(section('', '可迁移机会', `<ul class="plain">${r.migration.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`))
  }
  if (r.readingOrder) secs.push(section('', '读序建议', `<div class="card"><p class="tldr">${esc(r.readingOrder)}</p></div>`))
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="scholar-report" content="compare">`
    + `<title>${esc(headerInfo.title)}</title><style>${CSS}</style></head><body><div class="wrap">`
    + header + secs.map((s, i) => s.replace('<h2>', `<h2>§${i + 1} `)).join('')
    + `<div class="meta">学者工作台 · 横向对比（${r.meta.papers} 篇）· 耗时 ${Math.round(r.meta.durationMs / 1000)}s · 涉及：${r.titles.map((t) => esc(t.slice(0, 50))).join(' / ')}</div>`
    + `</div></body></html>`
}

/** 3 句内核心结论（paper_save_report 的 summary 参数 / 论文 summary 回填用） */
export function extractSummary(r: PaperOutcome | QuickOutcome, max = 320): string {
  if (r.kind === 'paper') {
    const parts = [r.summary, ...r.coreConclusions.slice(0, 2)]
    return parts.filter(Boolean).join('；').slice(0, max)
  }
  return [r.summary, r.thesis].filter(Boolean).join('；').slice(0, max)
}
