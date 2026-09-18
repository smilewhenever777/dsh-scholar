/**
 * 精读结果 → 学术报告 html（确定性渲染，零额外 token、版式稳定）。
 * 自包含：内联样式、明暗自适应（prefers-color-scheme）、无外链。
 * 视觉语言沿用旧版"知识地图"报告：彩色论点标签 / 概念树 / 徽章 / 表格。
 */
import type { PaperOutcome, QuickOutcome } from './engine.js'

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

function renderPaper(r: PaperOutcome, header: string): string {
  const conclusions = r.coreConclusions.map((c, i) =>
    `<li><span class="tag c-fact">结论 ${i + 1}</span> ${esc(c)}</li>`).join('')
  const items = r.items.map((it) => {
    const conf = CONFIDENCE_TAG[it.confidence] ?? 'c-unk'
    const rel = it.relations.map((x) => `<span class="rel">${esc(x.type)}→${esc(x.to.slice(0, 24))}</span>`).join(' ')
    return `<tr><td class="ty">${esc(it.type)}</td><td><b>${esc(it.claim)}</b>${rel ? `<div class="relrow">${rel}</div>` : ''}<div class="ev">${esc(it.evidence)}</div>${it.source ? `<div class="src">${esc(it.source)}</div>` : ''}</td><td><span class="tag ${conf}">${esc(it.confidence || '未标')}</span></td></tr>`
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
  const figures = (r.figures ?? []).map((f, i) =>
    `<tr><td class="ty">${esc(f.ref)}</td><td>${esc(f.caption)}${f.meaning ? `<div class="ev">${esc(f.meaning)}</div>` : ''}${figHtml(i)}</td></tr>`).join('')
  const gallery = (r.figures ?? []).length === 0 && imgs.length > 0
    ? imgs.map((_im, i) => figHtml(i)).join('')
    : ''
  return header + section('§1', '一页速览',
    `<div class="card"><p class="tldr">${esc(r.summary)}</p>`
    + (r.coreQuestion ? `<p style="margin:.6rem 0 0"><span class="lbl">核心问题</span>${esc(r.coreQuestion)}</p>` : '')
    + (conclusions ? `</div><ul class="plain">${conclusions}</ul>` : '</div>'))
    + (items ? section('§2', '方法与论点（设计选择 → 动机 → 消融证据）',
      `<table><tr><th>类型</th><th>主张 / 证据</th><th>置信度</th></tr>${items}</table>`) : '')
    + (dp ? section('§3', '实验还原（主表 / 消融表行）',
      `<table class="num"><tr><th>方法</th><th>数值</th><th>条件</th><th>基准</th><th>出处</th></tr>${dp}</table>`) : '')
    + (gallery ? section('§4', '图表原图（按文档顺序）', gallery) : '')
    + (figures ? section('§4', '图表清单（图注 + 正文解读）',
      `<table><tr><th>编号</th><th>图注 / 正文解读</th></tr>${figures}</table>`) : '')
    + ((r.concepts ?? []).length > 0 ? section('§5', '概念与术语地图', mindmap(r.concepts ?? [])) : '')
    + ((r.quotes ?? []).length > 0 ? section('§6', '关键原文摘录', quotesBlock(r.quotes ?? [])) : '')
    + (caveats ? section('§7', '局限与未验证假设', `<ul class="plain">${caveats}</ul>`) : '')
    + (recall ? section('§8', '主动回忆问题', `<ul class="plain">${recall}</ul>`) : '')
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
    + (qs ? section('§4', '批判性问题', `<ul class="plain">${qs}</ul>`) : '')
}

/** paper/quick 结果 → 完整自包含报告 html */
export function renderReportHtml(r: PaperOutcome | QuickOutcome, headerInfo: { title: string; sub: string }): string {
  const header = head(headerInfo.title, headerInfo.sub, r.kind === 'paper' ? 'paper' : 'quick')
  const body = r.kind === 'paper' ? renderPaper(r, header) : renderQuick(r, header)
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="scholar-report" content="${r.kind === 'paper' ? 'paper' : 'quick'}">`
    + `<title>${esc(headerInfo.title)}</title><style>${CSS}</style></head><body><div class="wrap">`
    + `${body}<div class="meta">学者工作台 · 自有精读引擎（${r.meta.mode} 模式）· ${r.meta.chunks} 段 · ${r.meta.chars} 字 · 耗时 ${Math.round(r.meta.durationMs / 1000)}s</div>`
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
