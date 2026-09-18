/**
 * 交互式追问（"带着问题反复翻"的引擎侧）：检索章节块 → 基于片段的带引证回答。
 * 检索不依赖向量库：ASCII 词 + 中文 bigram 命中计分（单 token 命中封顶防 tf 爆炸），
 * 表号/图号（Table 5 / Fig.3）精确匹配加权——论文体量（几十个块）下足够准。
 */
import { createLlmRuntime } from './llm.js'
import type { HostContext } from './types.js'

/** 问题/文本 → 检索 token（ASCII 词 lowercase + 中文 bigram） */
export function qTokens(input: string): string[] {
  const out: string[] = []
  const ascii = input.toLowerCase().match(/[a-z][a-z0-9_-]{1,}/g) ?? []
  out.push(...ascii)
  const cjk = input.replace(/[^\p{Script=Han}]+/gu, ' ')
  for (const word of cjk.split(/\s+/).filter(Boolean)) {
    if (word.length === 1) out.push(word)
    for (let i = 0; i + 2 <= word.length; i++) out.push(word.slice(i, i + 2))
  }
  return [...new Set(out)]
}

/** 显式编号引用（table 3 / tab.3 / fig.2 / figure 2 / 图3 / 表3）——出现即强命中 */
function explicitRefs(input: string): string[] {
  const re = /\b(?:tab(?:le)?s?\.?|fig(?:ure)?s?\.?|图|表)\s*(\d+[a-zA-Z]?)|\b(\d+[a-zA-Z]?)\s*(?:表|图)/gi
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(input)) !== null) {
    const num = m[1] ?? m[2]
    if (num) out.push(num.toLowerCase())
  }
  return [...new Set(out)]
}

/** 检索：返回与问题最相关的 top-k 章节块（原文顺序） */
export function retrieveChunks(chunks: string[], question: string, k = 4): number[] {
  const tokens = qTokens(question)
  const refs = explicitRefs(question)
  if (tokens.length === 0 && refs.length === 0) return chunks.map((_, i) => i).slice(0, k)
  const scored = chunks.map((text, i) => {
    const lower = text.toLowerCase()
    let score = 0
    for (const tk of tokens) {
      // 单 token 命中封顶 3 次：防高频词淹没区分度
      let hit = 0, idx = 0
      while (hit < 3) {
        const at = lower.indexOf(tk, idx)
        if (at < 0) break
        hit++; idx = at + tk.length
      }
      score += hit * (tk.length >= 4 ? 3 : tk.length >= 2 ? 2 : 1)
    }
    for (const num of refs) {
      if (new RegExp(`(?:tab(?:le)?s?\\.?|fig(?:ure)?s?\\.?)?\\s*${num.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(lower)) score += 40
    }
    return { i, score }
  })
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((s) => s.i)
    .sort((a, b) => a - b) // 恢复原文顺序，利于上下文连续
}

export interface AskAnswer {
  answer: string
  pages: string[]
  confidence: string
  sufficient: boolean
}

/** 基于检索片段回答：严格引证【第N页】；片段不足以回答时明说（sufficient=false） */
export function createAsker(ctx: HostContext) {
  const { callModelJson, pickConfig } = createLlmRuntime({
    ctx: ctx as never,
    estimateTokens: (t) => Math.ceil(t.length * 0.6),
    llmCallStats: { calls: 0, ms: 0 },
    recordCalibration: (() => undefined) as never,
  })

  return async function ask(chunks: string[], question: string, history?: { q: string; a: string }[]): Promise<AskAnswer> {
    const picked = retrieveChunks(chunks, question)
    const use = picked.length > 0 ? picked : chunks.map((_, i) => i).slice(0, 2)
    const frag = use.map((i) => `【片段 ${i + 1}】\n${chunks[i]!.slice(0, 12000)}`).join('\n\n')
    const hist = (history ?? []).slice(-3).map((h) => `问：${h.q}\n答：${h.a.slice(0, 200)}`).join('\n')
    const cfg = await pickConfig()
    const parsed = await callModelJson(cfg,
      '你是论文精读助答。基于给出的原文片段回答读者的问题，严格只输出一个 JSON 对象（不要任何解释或 Markdown 代码块）：\n'
      + '{\n  "answer": "回答（直接了当；引用出处用【第N页】格式；需要时引具体数值与表号）",\n  "pages": ["涉及的页码，如 第3页"],\n  "confidence": "作者原意|原文事实与数据|合理推断|无法确认（四选一）",\n  "sufficient": true\n}\n'
      + '规则：只依据片段作答，不引入外部知识；片段不足以回答时 sufficient=false 并在 answer 里说明缺什么（建议重读哪部分）；'
      + '推断性内容必须标合理推断；原文没有就明说。\n输出语言：简体中文。',
      (hist ? '先前的问答记录（供衔接）：\n' + hist + '\n\n' : '')
      + '读者的新问题：' + question + '\n\n相关原文片段：\n\n' + frag,
      2500)
    const o = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
    const pages = Array.isArray(o.pages) ? o.pages.map(String).filter(Boolean).slice(0, 6) : []
    return {
      answer: String(o.answer ?? '未能生成回答'),
      pages,
      confidence: String(o.confidence ?? '无法确认'),
      sufficient: o.sufficient !== false,
    }
  }
}
