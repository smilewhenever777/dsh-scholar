/**
 * scholar 自有精读引擎（lean port，源自 dsh-deepread@1.0.1 MIT，仅保留论文场景）。
 *
 * 两种模式：
 * - paper：学术论文精读——章节感知分段（splitChunksPaper）+ 论文 schema
 *   （方法选择→动机+消融、dataPoints=表行六要素、负结果照录、置信度四档）；
 * - quick：速读速览（筛文献 / 从报告提卡）。
 * 砍掉（相对上游）：deep/map/feynman/book/batch 模式、URL 抓取与缓存、预算校准、
 * md/mm/html 导出器、设置面与面板路由——scholar 侧用自己的五段式渲染器与归档管线。
 *
 * LLM 访问：直接走 ctx.llm（宿主模型服务）；长文经官方 jobs 转后台任务。
 */
import { createPdfTools } from './pdf.js'
import { extractPdfFigures, type PdfFigureImg } from './figures.js'
import { createFigureReader } from './vlm.js'
import { throwIfCancelled } from './cancel.js'
import { arr, createLlmRuntime, splitChunksPaper, str } from './llm.js'
import {
  errorMessage, isBinaryFileService, isRecord, isTextFileService,
  type AbortLike, type AnalysisChapter, type HostContext, type JobsService, type MapItem, type MindNode,
} from './types.js'

/** 单条分论点（claim/evidence/quote/source） */
interface SectionArgument {
  claim: string
  evidence: string
  quote: string
  source: string
}

/** 表行六要素 */
interface DataPoint {
  value: string
  period: string
  subject: string
  baseline: string
  source: string
  location: string
}

export type ReadMode = 'paper' | 'quick'

export interface ReadInput {
  /** 本地文件绝对路径（.pdf 必备；txt/md/html 亦可，用于读已归档的报告） */
  path: string
  mode: ReadMode
  /** 轻量档：长文综合直接走分段摘要（跳过全文大调用，快且 API 差时稳，精度略降）；
   *  仅对 >3 万字长文生效（短文本本来就是单次调用） */
  light?: boolean
  /** 拼装好的关注重点（研究方向/透镜/相关论文等由调用方组装） */
  focus?: string
  /** 输出语言：zh | en | auto（默认 auto=与原文一致） */
  language?: 'zh' | 'en' | 'auto'
  /** VLM 读图开关（默认开；纯文本模型自动降级） */
  vlm?: boolean
}

export interface ReadOutcome {
  kind: 'result' | 'background'
  jobId?: string
  label?: string
  result?: PaperOutcome | QuickOutcome
}

export interface PaperOutcome {
  kind: 'paper'
  title: string
  summary: string
  coreQuestion: string
  coreConclusions: string[]
  items: MapItem[]
  dataPoints: DataPoint[]
  caveats: string[]
  recallQuestions: string[]
  figures: Array<{ ref: string; caption: string; meaning: string }>
  /** 综合阶段从各段合并的概念术语（可选——旧结果无此字段） */
  concepts?: Array<{ term: string; explanation: string }>
  /** 综合阶段从各段合并的原文摘录（可选） */
  quotes?: Array<{ text: string; context?: string; source?: string }>
  /** 知识地图嵌套树（问题定义/方法设计/实验证据三大分支，可选） */
  mindmap?: MindNode
  meta: { source: string; chars: number; chunks: number; mode: ReadMode; durationMs: number; chunksText?: string[]; figuresImgs?: import('./figures.js').PdfFigureImg[]; figureDescriptions?: string[]; /** 综合方式：fulltext|digest|assembled（降级链） */ synth?: string; /** 分段提取失败的段号（1 基） */ gaps?: number[] }
}

export interface QuickOutcome {
  kind: 'quick'
  title: string
  summary: string
  thesis: string
  arguments: SectionArgument[]
  concepts: Array<{ term: string; explanation: string }>
  caveats?: string[]
  questions: string[]
  meta: { source: string; chars: number; chunks: number; mode: ReadMode; durationMs: number; chunksText?: string[]; figuresImgs?: import('./figures.js').PdfFigureImg[]; figureDescriptions?: string[]; synth?: string; gaps?: number[] }
}

const CHUNK_CHARS = 9000
/** ≤此长度单遍直出（不进分段管线）；超过才分段 */
const SINGLE_SHOT_CHARS = 30000
/** 综合阶段允许直喂全文的上限（超过只喂分段摘要） */
const FULLTEXT_SYNTHESIS_CHARS = 200000
/** 分段上限：MAX_INPUT_CHARS / CHUNK_CHARS 的全覆盖（400k/9k≈45）——
 *  此前 20 段会把 18 万字以后的正文静默丢掉（长论文尾部消融/附录全失） */
const MAX_PARTS = 45
const MAX_INPUT_CHARS = 400000

/* ---------- schemas（继承自上游的稳定 JSON 形状：截断重试/压缩指令依赖这些字段名） ---------- */

const SECTION_SCHEMA = [
  '{',
  '  "title": "标题",',
  '  "summary": "一句话概括",',
  '  "thesis": "核心论点",',
  '  "arguments": [{"claim": "分论点", "evidence": "支撑的论据或推理", "quote": "原文关键句（可选）", "source": "原文位置（如 第N页/第N段；原文没有位置标记时留空）"}],',
  '  "quotes": [{"text": "值得摘录的原文原句", "context": "这句话在论证什么（可选）", "source": "原文位置（如 第N页；没有标记时留空）"}],',
  '  "concepts": [{"term": "核心概念/术语", "explanation": "它在文中的含义"}],',
  '  "caveats": ["本段的局限/负结果/失效案例/适用边界（没有则空数组）"],',
  '  "questions": ["读者应继续追问的批判性问题"]',
  '}',
].join('\n')

const PAPER_SCHEMA = [
  '{',
  '  "title": "论文标题",',
  '  "summary": "150-250字摘要（问题→方法→结果→意义，完整句式）",',
  '  "coreQuestion": "作者试图回答的核心研究问题（不是主题）",',
  '  "coreConclusions": ["核心结论1", "核心结论2"],',
  '  "mindmap": {"label": "论文主题", "children": [',
  '    {"label": "问题定义", "children": [{"label": "子点（可挂数字，如 COCO 42.4 mAP）", "children": []}]},',
  '    {"label": "方法设计", "children": [{"label": "模块/设计选择", "children": []}]},',
  '    {"label": "实验证据", "children": [{"label": "主结果/消融关键行", "children": []}]}',
  '  ]},',
  '  "items": [',
  '    {"type": "核心结论|分论点|原因或作用机制|事实|数据|案例|隐含前提|反对意见|限制条件|可执行建议（十选一）",',
  '     "claim": "观点/事实陈述",',
  '     "evidence": "原文证据（原文确实没有证据时，必须填「原文未提供证据」）",',
  '     "quote": "支撑该条的原文关键句（可选，保留原文语言）",',
  '     "source": "页码或表号（如 第3页 / Table 2）",',
  '     "confidence": "作者原意|原文事实与数据|合理推断|无法确认（四选一）",',
  '     "relations": [{"to": "另一条 claim 的开头文字（用于定位）", "type": "支持|反驳|导致|解释|取决于|举例|对比|限制（八选一）"}]}',
  '  ],',
  '  "dataPoints": [',
  '    {"value": "完整数值+指标名+单位", "period": "实验条件或设定", "subject": "方法/模型名", "baseline": "比较基准与差值", "source": "表号（如 Table 2）", "location": "页码"}',
  '  ],',
  '  "figures": [{"ref": "Figure 3 / Table 2", "caption": "图注原文", "meaning": "正文如何解释它/支撑哪条结论"}],',
  '  "concepts": [{"term": "核心概念/术语", "explanation": "它在文中的含义与作用"}],',
  '  "quotes": [{"text": "值得摘录的原文原句", "context": "这句话在论证什么（可选）", "source": "原文位置"}],',
  '  "caveats": ["局限/负结果/失效案例/适用边界（合并各部分，作者自认+隐含局限）"],',
  '  "recallQuestions": ["主动回忆问题1", "问题2", "问题3", "问题4", "问题5"]',
  '}',
].join('\n')

/* ---------- prompts ---------- */

function langOf(language: 'zh' | 'en' | 'auto'): string {
  return language === 'en' ? 'English' : (language === 'zh' ? '简体中文' : '与原文语言保持一致')
}

function quickSystem(language: 'zh' | 'en' | 'auto', focus: string): string {
  let sys = '你是一位专业的精读分析师。请严格只输出一个 JSON 对象（不要输出任何解释、前后缀或 Markdown 代码块），字段如下：\n'
    + SECTION_SCHEMA + '\n'
    + '要求：thesis 必须凝练；arguments 的 claim 是分论点、evidence 是支撑它的论据或推理；quote 尽量引用原文原句。\n'
    + '引用溯源：若原文包含【第N页】等位置标记，arguments 与 quotes 的 source 字段必须注明对应页码；没有标记则留空。\n'
    + '模式：快速抓要点——arguments 不超过 5 条，quotes 不超过 3 条，concepts 不超过 5 个，questions 不超过 3 个。\n'
    + '输出语言：' + langOf(language) + '。\n'
  if (focus.trim() !== '') sys += '读者特别关注：' + focus.trim() + '。\n'
  return sys
}

function paperSystem(language: 'zh' | 'en' | 'auto', focus: string, isFinal: boolean): string {
  let sys = '你是学术论文精读专家（计算机/工程方向）。请' + (isFinal ? '把各部分已提取的要点综合' : '把论文整理') + '成「方法—实验—证据」结构化的论文知识地图。\n'
    + '严格只输出一个 JSON 对象（不要输出任何解释、前后缀或 Markdown 代码块），结构如下：\n'
    + PAPER_SCHEMA + '\n'
    + '论文特化规则：\n'
    + '1. coreQuestion 写论文要解决的研究问题（不是主题）；coreConclusions 是有实验支撑的核心贡献（1-3 条）。\n'
    + '2. items 优先收录：方法管线的各设计选择（type=原因或作用机制，claim=做了什么选择，evidence=动机+对应消融证据与数值）；'
    + '主结果与消融的关键数值（type=数据/事实，保留方法名/基准/指标/增益与表号）；作者验证过的结论与未验证的推测必须用 confidence 区分'
    + '（作者原意/原文事实与数据/合理推断/无法确认）；负结果与失效案例照录不许美化（type=限制条件或事实）。\n'
    + '3. dataPoints 每条对应主表/消融表的一行：value=数值+指标名+单位，period=实验条件或设定，subject=方法/模型名，'
    + 'baseline=对比基准与差值，source=表号（如 Table 2），location=页码。\n'
    + '4. relations 重点用「对比」（与 baseline 或读者关注的相关工作）和「限制」（结论依赖特定设定/数据集时）。\n'
    + '5. caveats 合并各部分的 caveats 与负结果：作者自认的局限 + 你读出的隐含局限（后者属合理推断）。\n'
    + '6. concepts 汇总各部分的关键概念与术语（去重，最多 8 个，按重要性排序）；'
    + 'quotes 汇总最值得摘录的原文原句（去重，最多 5 条，保留原文语言与措辞）；'
    + 'items 的 quote 填该条最有力的原文支撑句（保留原文语言，没有可留空）。\n'
    + '7. mindmap 是知识地图：以「问题定义→方法设计→实验证据」为主分支组织全文骨架'
    + '（可根据论文实际调整主分支），叶子节点尽量挂数字（如 COCO 42.4 mAP / 1.62ms），'
    + '深度 3-4 层、每层 ≤6 个子节点，label 是短语不是长句。\n'
    + '8. recallQuestions 覆盖方法动机、消融归因与适用边界。\n'
    + '9. 原文没有的数据严禁编造；表中读不清的数值标「无法确认」。\n'
    + '10. 表述要求：所有中文字段写完整学术句式（主谓宾齐全、术语准确），不要电报式短语堆砌；'
    + 'summary 用 150-250 字讲清"问题→方法→结果→意义"。'
    + '输出语言：' + langOf(language) + '。\n'
  if (focus.trim() !== '') sys += '读者特别关注：' + focus.trim() + '。\n'
  return sys
}

function paperChunkSystem(language: 'zh' | 'en' | 'auto', focus: string): string {
  let sys = '你是学术论文精读分析师。请从论文片段中提取核心内容，严格只输出一个 JSON 对象（不要任何解释或 Markdown 代码块），字段如下：\n'
    + SECTION_SCHEMA + '\n'
    + '论文片段特化：arguments 优先收录①方法设计选择（claim=选择，evidence=动机/消融证据，quote=原文关键句，source=页码或表号）'
    + '②实验数值结论（完整保留数值、基准、指标与表号）；③负结果与失效案例照录。'
    + 'caveats 收录本段出现的局限/负结果/适用边界（没有则空数组）。\n'
    + '引用溯源：若片段含【第N页】标记，source 必须注明对应页码。\n'
    + '输出语言：' + langOf(language) + '。\n'
  if (focus.trim() !== '') sys += '读者特别关注：' + focus.trim() + '。\n'
  return sys
}

/* ---------- sanitize ---------- */

function sectionUser(text: string, index: number, total: number): string {
  if (total > 1) return '【第 ' + (index + 1) + ' / ' + total + ' 部分】\n\n' + text
  return '以下是待精读的内容：\n\n' + text
}

interface ChunkDigest {
  title: string
  summary: string
  thesis: string
  arguments: SectionArgument[]
  concepts: Array<{ term: string; explanation: string }>
  quotes: Array<{ text: string; context: string; source: string }>
  caveats: string[]
}

function sanitizeQuick(parsed: unknown): { title: string; summary: string; thesis: string; arguments: SectionArgument[]; concepts: Array<{ term: string; explanation: string }>; quotes: Array<{ text: string; context: string; source: string }>; caveats: string[]; questions: string[] } {
  const p = isRecord(parsed) ? parsed : {}
  return {
    title: str(p.title, '未命名内容'),
    summary: str(p.summary, ''),
    thesis: str(p.thesis, ''),
    arguments: arr(p.arguments).slice(0, 8).map((it) => {
      const o = isRecord(it) ? it : { claim: String(it) }
      return { claim: str(o.claim, ''), evidence: str(o.evidence, ''), quote: str(o.quote, ''), source: str(o.source, '') }
    }).filter((a) => a.claim !== ''),
    concepts: arr(p.concepts).slice(0, 8).map((it) => {
      const o = isRecord(it) ? it : { term: String(it) }
      return { term: str(o.term, ''), explanation: str(o.explanation, '') }
    }).filter((c) => c.term !== ''),
    quotes: arr(p.quotes).slice(0, 4).map((it) => {
      const o = isRecord(it) ? it : { text: String(it) }
      return { text: str(o.text, ''), context: str(o.context, ''), source: str(o.source, '') }
    }).filter((q) => q.text !== ''),
    caveats: arr(p.caveats).slice(0, 5).map((c) => String(c)).filter((c) => c !== ''),
    questions: arr(p.questions).slice(0, 5).map((q) => String(q)).filter((q) => q !== ''),
  }
}

function sanitizePaper(parsed: unknown): { title: string; summary: string; coreQuestion: string; coreConclusions: string[]; items: MapItem[]; dataPoints: DataPoint[]; caveats: string[]; recallQuestions: string[]; figures: Array<{ ref: string; caption: string; meaning: string }>; concepts: Array<{ term: string; explanation: string }>; quotes: Array<{ text: string; context: string; source: string }>; mindmap?: MindNode } {
  const p = isRecord(parsed) ? parsed : {}
  const items: MapItem[] = arr(p.items).slice(0, 40).map((it): MapItem | null => {
    const o = isRecord(it) ? it : { claim: String(it) }
    const claim = str(o.claim, '')
    if (claim === '') return null
    return {
      type: str(o.type, '分论点'),
      claim,
      evidence: str(o.evidence, '原文未提供证据'),
      quote: str(o.quote, ''),
      source: str(o.source, ''),
      confidence: str(o.confidence, ''),
      relations: arr(o.relations).slice(0, 6).map((r) => {
        const ro = isRecord(r) ? r : { type: String(r) }
        return { to: str(ro.to, ''), type: str(ro.type, '支持') }
      }).filter((r) => r.to !== ''),
    }
  }).filter((x): x is MapItem => x !== null)
  const dataPoints: DataPoint[] = arr(p.dataPoints).slice(0, 30).map((d) => {
    const o = isRecord(d) ? d : { value: String(d) }
    return {
      value: str(o.value, ''), period: str(o.period, ''), subject: str(o.subject, ''),
      baseline: str(o.baseline, ''), source: str(o.source, ''), location: str(o.location, ''),
    }
  }).filter((d) => d.value !== '')
  return {
    title: str(p.title, '未命名论文'),
    summary: str(p.summary, ''),
    coreQuestion: str(p.coreQuestion, ''),
    coreConclusions: arr(p.coreConclusions).slice(0, 5).map((c) => String(c)).filter((c) => c !== ''),
    items,
    dataPoints,
    caveats: arr(p.caveats).slice(0, 10).map((c) => String(c)).filter((c) => c !== ''),
    recallQuestions: arr(p.recallQuestions).slice(0, 6).map((q) => String(q)).filter((q) => q !== ''),
    figures: arr(p.figures).slice(0, 20).map((f) => {
      const o = isRecord(f) ? f : { ref: String(f) }
      return { ref: str(o.ref, ''), caption: str(o.caption, ''), meaning: str(o.meaning, '') }
    }).filter((f) => f.ref !== ''),
    concepts: arr(p.concepts).slice(0, 8).map((it) => {
      const o = isRecord(it) ? it : { term: String(it) }
      return { term: str(o.term, ''), explanation: str(o.explanation, '') }
    }).filter((c) => c.term !== ''),
    quotes: arr(p.quotes).slice(0, 5).map((it) => {
      const o = isRecord(it) ? it : { text: String(it) }
      return { text: str(o.text, ''), context: str(o.context, ''), source: str(o.source, '') }
    }).filter((q) => q.text !== ''),
    mindmap: sanitizeMind(p.mindmap, 0),
  }
}

/** mindmap 递归清洗：深度 ≤4、每层子节点 ≤8、label ≤120 字；根节点空则整树丢弃 */
function sanitizeMind(node: unknown, depth: number): MindNode | undefined {
  if (depth > 4 || !isRecord(node)) return undefined
  const label = str(node.label, '').slice(0, 120)
  if (label === '') return undefined
  const children = arr(node.children).slice(0, 8)
    .map((c) => sanitizeMind(c, depth + 1))
    .filter((c): c is MindNode => c !== undefined)
  return { label, children }
}

/* ---------- input loading（本地文件：pdf / txt / md / html） ---------- */

async function loadFileText(ctx: HostContext, path: string, onProgress: ((line: string) => void) | null): Promise<{ text: string; source: string; figures: PdfFigureImg[] }> {
  const lower = path.toLowerCase()
  if (lower.endsWith('.pdf')) {
    if (!isBinaryFileService(ctx.fs)) throw new Error('文件服务不可用，无法读取 PDF')
    const { bytesToLatin1, extractPdfText } = createPdfTools(() => 0)
    const target = await ctx.fs.resolve(path) as never
    // F14:与上传上限(routes PDF_MAX_BYTES=50MiB)一致——30-50MiB 的合法 PDF
    // 此前可入库但精读必败
    const bytes = await ctx.fs.readBytes(target, undefined, 50 * 1024 * 1024)
    const latin = bytesToLatin1(bytes)
    let extracted = ''
    try {
      let lastPct = -1
      extracted = extractPdfText(latin, onProgress === null ? undefined : (info) => {
        if (info.done === 0) {
          onProgress('解析 PDF 中…（共 ' + info.total + ' 页）')
          return
        }
        const total = Math.max(1, info.total)
        const pct = Math.round((info.done / total) * 100)
        if (info.done >= total || pct >= lastPct + 10) {
          lastPct = pct
          onProgress('解析 PDF 中… ' + pct + '%（' + info.done + '/' + info.total + ' 页）')
        }
      })
    } catch (error) {
      throw new Error('PDF 解析失败：' + errorMessage(error))
    }
    if (extracted.trim() === '') throw new Error('PDF 中没有可提取的文本（可能是扫描版/图片型 PDF）')
    let figures: PdfFigureImg[] = []
    try {
      figures = extractPdfFigures(latin).images.slice(0, 12)
    } catch { /* 提图失败不影响精读 */ }
    return { text: extracted, source: path, figures }
  }
  if (/\.(txt|md|markdown|html|htm|json|log)$/i.test(lower)) {
    if (!isTextFileService(ctx.fs)) throw new Error('文件服务不可用，无法读取文件')
    const target = await ctx.fs.resolve(path) as never
    let content = await ctx.fs.readText(target)
    if (/\.(html|htm)$/i.test(lower)) content = content.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ')
    return { text: content, source: path, figures: [] }
  }
  throw new Error('暂不支持的文件类型：' + path + '（支持 .pdf / .txt / .md / .html）')
}

/* ---------- engine ---------- */

export interface ReadEngine {
  /** 同步执行到完成（加载+全管线；批量路由在外层自己包 job 用这个） */
  readSync(input: ReadInput, onProgress?: ((line: string) => void) | null, signal?: AbortLike): Promise<PaperOutcome | QuickOutcome>
  /** 单篇入口：paper 长文自动转官方后台任务并返回 jobId；短文前台完成 */
  read(input: ReadInput, opts?: { jobs?: JobsService; owner?: unknown; onProgress?: ((line: string) => void) | null; onResult?: (outcome: PaperOutcome | QuickOutcome) => Promise<void> | void }): Promise<ReadOutcome>
}

export function createReadEngine(ctx: HostContext): ReadEngine {
  const figureReader = createFigureReader(ctx)
  // 自校准/预算已裁剪：token 估算仅用于分段进度口径，粗估即可
  const { callModelJson, pickConfig } = (() => {
    const noop = () => undefined
    return createLlmRuntime({
      ctx: ctx as never,
      estimateTokens: (t) => Math.ceil(t.length * 0.6),
      llmCallStats: { calls: 0, ms: 0 },
      recordCalibration: noop as never,
    })
  })()

  async function runFlow(text: string, source: string, figures: PdfFigureImg[], input: ReadInput, onProgress: ((line: string) => void) | null, signal: AbortLike): Promise<PaperOutcome | QuickOutcome> {
    throwIfCancelled(signal)
    const started = Date.now()
    const cfg = await pickConfig()
    // 默认中文输出：中文科研工作流里英文论文的报告也要中文表述
    // （术语与原文摘录按提示词要求保留原文；显式传 language 才覆盖）
    const language = input.language ?? 'zh'
    const focus = input.focus ?? ''
    if (text.length > MAX_INPUT_CHARS) text = text.slice(0, MAX_INPUT_CHARS)

    if (input.mode === 'quick') {
      const limited = text.length > 30000 ? text.slice(0, 30000) : text
      if (onProgress !== null) onProgress('速读中…')
      const parsed = await callModelJson(cfg, quickSystem(language, focus), sectionUser(limited, 0, 1), 3000, signal)
      const s = sanitizeQuick(parsed)
      return { kind: 'quick', ...s, meta: { source, chars: limited.length, chunks: 1, mode: 'quick', durationMs: Date.now() - started, chunksText: [limited] } }
    }

    // paper：短论文单次；长论文章节感知分段→逐段→汇总（镜像上游 map 管线）
    // VLM 读图（阶段3）：对前 6 张图做视觉解读；首图探测失败/纯文本模型自动降级
    const figureDescList: string[] = []
    if (input.mode === 'paper' && input.vlm !== false && figures.length > 0 && figureReader.usable) {
      const top = figures.slice(0, 6)
      for (let i = 0; i < top.length; i++) {
        throwIfCancelled(signal)
        if (onProgress !== null) onProgress('VLM 读图 ' + (i + 1) + '/' + top.length + '…')
        const d = await figureReader.describeFigure(top[i]!, '', signal)
        throwIfCancelled(signal)
        if (!figureReader.usable) break
        figureDescList.push(d)
      }
    }
    const figureDescriptions = figureDescList.map((d, i) => '[图' + (i + 1) + '] ' + d).join('\n')
    if (text.length <= SINGLE_SHOT_CHARS) {
      if (onProgress !== null) onProgress('学术精读中…')
      const parsed = await callModelJson(cfg, paperSystem(language, focus, false),
        '以下是待整理的内容：\n\n' + text + '\n\n注意：若原文中出现【第N页】标记，source 和 location 字段请使用页码。'
        + (figureDescriptions !== '' ? '\n\n【图表视觉解读（VLM）】\n' + figureDescriptions : ''), 8000, signal)
      const s = sanitizePaper(parsed)
      return { kind: 'paper', ...s, meta: { source, chars: text.length, chunks: 1, mode: 'paper', durationMs: Date.now() - started, chunksText: [text], figureDescriptions: figureDescList } }
    }
    const chunks: ChunkDigest[] = []
    const gaps: number[] = []
    let parts = splitChunksPaper(text, CHUNK_CHARS)
    if (parts.length > MAX_PARTS) parts = parts.slice(0, MAX_PARTS)
    // 分段并发（自适应 2 路：API 套餐常有并发上限，2 为实测安全值）：分段互相独立。段失败不再报废整篇——记入 gaps
    // 继续（全文综合不依赖分段，缺口近乎无损；纯摘要综合时缺口=内容缺失）。
    // 闻到空结果（后端过载信号）立刻降到 1 路串行，别给半血后端加压。
    {
      const total = parts.length
      const digests: Array<ChunkDigest | undefined> = new Array(total)
      let next = 0
      let done = 0
      let target = Math.min(2, total)
      const active = { count: 0 }
      const worker = async (): Promise<void> => {
        for (;;) {
          if (signal.aborted) throw new Error('任务已取消')
          if (active.count >= target) return // 超出当前并发额度的工人退出（降档收缩；在干的工人会继续接活）
          if (next >= total) return
          const i = next++
          active.count++
          try {
            if (onProgress !== null) onProgress('学术精读第 ' + (i + 1) + '/' + total + ' 段…')
            const parsed = await callModelJson(cfg, paperChunkSystem(language, focus), sectionUser(parts[i]!, i, total), 5000, signal)
            const s = sanitizeQuick(parsed)
            digests[i] = { title: s.title, summary: s.summary, thesis: s.thesis, arguments: s.arguments, concepts: s.concepts, quotes: s.quotes, caveats: s.caveats }
            done++
            if (onProgress !== null) onProgress('完成 ' + done + '/' + total + ' 段')
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            if (signal.aborted) throw err
            gaps.push(i)
            console.error(`[dsh-scholar] 分段 ${i + 1}/${total} 提取失败（记缺口继续）:`, msg.slice(0, 120))
            if (msg.includes('空结果')) target = 1 // 后端过载：立刻降串行
          } finally {
            active.count--
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(2, total) }, () => worker()))
      for (const d of digests) if (d) chunks.push(d)
      if (chunks.length === 0) throw new Error('全部分段提取失败（后端不可用）')
    }
    // 汇总材料全量保留（旧引擎的做法）：slice 只防模型超发，不做二次压缩
    const condensed = chunks.map((c) => ({
      title: c.title, summary: c.summary, thesis: c.thesis,
      arguments: c.arguments,
      concepts: c.concepts,
      quotes: c.quotes,
      caveats: c.caveats,
    }))
    if (onProgress !== null) onProgress('论文汇总中…')
    // 综合直喂全文（≤20 万字）：分段摘要只作辅助索引——数字/表号以原文为准，
    // 解决"压缩材料重建数字易糊"的漏斗问题；超长文回退纯摘要综合。
    const gapNote = gaps.length > 0
      ? '\n\n【注意】第 ' + gaps.map((g) => g + 1).join('、') + ' 部分的分段提取失败缺失'
        + (text.length <= FULLTEXT_SYNTHESIS_CHARS ? '——请从全文中补全这些部分的内容。' : '——这些部分内容缺失，报告相应处如实处理。')
      : ''
    const digestPrompt = '全文共 ' + text.length + ' 字（超长未直喂），以下 JSON 数组是各部分已提取的要点：\n\n' + JSON.stringify(condensed)
      + (figureDescriptions !== '' ? '\n\n【图表视觉解读（VLM）】\n' + figureDescriptions : '') + gapNote
    const fullPrompt = text.length <= FULLTEXT_SYNTHESIS_CHARS
      ? '以下是论文全文（' + text.length + ' 字，以它为准）：\n\n' + text
        + '\n\n以下 JSON 数组是分段预提取的要点（仅作导航索引，与全文冲突时以全文为准）：\n' + JSON.stringify(condensed)
        + (figureDescriptions !== '' ? '\n\n【图表视觉解读（VLM）】\n' + figureDescriptions : '') + gapNote
      : digestPrompt
    // 四级综合降级链：全文单次（最优，交叉引用最连贯）→ 分半双次（各出一半字段，
    // 生成时间减半——后端半血时大生成最容易空返回，拆小是硬解）→ 摘要综合 →
    // 分段成果确定性拼装。保证重读永不空手而归，且尽量不落到"只见摘要"的档位。
    let s: ReturnType<typeof sanitizePaper>
    let synthMode = 'fulltext'
    if (input.light === true && text.length > SINGLE_SHOT_CHARS) {
      // 轻量档（用户显式选择，非降级）：直接摘要综合——旧引擎的调用模式，
      // 跳过全文大调用，快且 API 差时稳；精度略降（符号/交叉细节可能走样）
      if (onProgress !== null) onProgress('轻量档：摘要综合…')
      try {
        s = sanitizePaper(await callModelJson(cfg, paperSystem(language, focus, true), digestPrompt, 12000, signal))
        synthMode = 'light'
      } catch (err) {
        if (signal.aborted) throw err
        s = assembleFromChunks(chunks)
        synthMode = 'assembled'
      }
    } else
    try {
      s = sanitizePaper(await callModelJson(cfg, paperSystem(language, focus, true), fullPrompt, 12000, signal))
    } catch (err) {
      if (signal.aborted) throw err
      // 超上下文类错误：分半也喂全文（同样超），直接跳到摘要档省两次注定失败的调用
      const overflow = /context|too many tokens|exceed|超长|上下文/i.test(err instanceof Error ? err.message : String(err))
      if (overflow) {
        if (onProgress !== null) onProgress('全文超模型上下文，改用分段摘要综合…')
        try {
          s = sanitizePaper(await callModelJson(cfg, paperSystem(language, focus, true), digestPrompt, 12000, signal))
          synthMode = 'digest'
        } catch {
          s = assembleFromChunks(chunks)
          synthMode = 'assembled'
        }
      } else
      if (onProgress !== null) onProgress('全文汇总失败，改用分半综合（两次小生成）…')
      try {
        const partA = fullPrompt + '\n\n【分半综合·数据部分】本次只输出 items、dataPoints、figures 三个字段，其余字段一律不要输出。'
        const partB = fullPrompt + '\n\n【分半综合·叙述部分】本次只输出 summary、coreQuestion、coreConclusions、mindmap、concepts、quotes、caveats、recallQuestions 字段，items/dataPoints/figures 一律不要输出。'
        const a = sanitizePaper(await callModelJson(cfg, paperSystem(language, focus, true), partA, 10000, signal))
        if (onProgress !== null) onProgress('分半综合 1/2 完成，叙述部分…')
        const b = sanitizePaper(await callModelJson(cfg, paperSystem(language, focus, true), partB, 10000, signal))
        s = { ...b, items: a.items, dataPoints: a.dataPoints, figures: a.figures }
        synthMode = 'split'
      } catch (err2) {
        if (signal.aborted) throw err2
        if (onProgress !== null) onProgress('分半综合也失败，改用分段摘要综合…')
        try {
          s = sanitizePaper(await callModelJson(cfg, paperSystem(language, focus, true), digestPrompt, 12000, signal))
          synthMode = 'digest'
        } catch (err3) {
          if (signal.aborted) throw err3
          if (onProgress !== null) onProgress('摘要综合也失败，用分段成果直接拼装报告…')
          s = assembleFromChunks(chunks)
          synthMode = 'assembled'
        }
      }
    }
    return { kind: 'paper', ...s, meta: { source, chars: text.length, chunks: chunks.length, mode: 'paper', durationMs: Date.now() - started, chunksText: parts, figureDescriptions: figureDescList, synth: synthMode, ...(gaps.length > 0 ? { gaps: gaps.map((g) => g + 1) } : {}) } }
  }

/** 综合彻底失败时的兜底：把分段提取成果确定性拼装成 paper 结果（零 LLM）。
 *  质量次于模型综合，但保住几十分钟分段工作的产出——重读永不空手而归。 */
/** claim 相似度（ASCII 词 + 中文 bigram 的 Jaccard）：拼装档去重相邻段重复论点 */
function claimTokens(s: string): Set<string> {
  const t = new Set<string>()
  const norm = s.toLowerCase()
  for (const w of norm.matchAll(/[a-z0-9]+/g)) if (w[0]!.length > 2) t.add(w[0]!)
  for (let i = 0; i + 2 <= norm.length; i++) {
    const seg = norm.slice(i, i + 2)
    if (!/[a-z0-9]/.test(seg)) t.add(seg)
  }
  return t
}

function assembleFromChunks(chunks: ChunkDigest[]): ReturnType<typeof sanitizePaper> {
  const items: MapItem[] = []
  const seenClaims: Array<Set<string>> = []
  outer: for (const c of chunks) {
    for (const a of c.arguments.slice(0, 3)) {
      const toks = claimTokens(a.claim)
      for (const prev of seenClaims) {
        let inter = 0
        for (const x of toks) if (prev.has(x)) inter++
        if (toks.size > 0 && inter / Math.min(toks.size, prev.size) > 0.6) continue outer // 相邻段重复论点，跳过
      }
      seenClaims.push(toks)
      items.push({
        type: '分论点',
        claim: a.claim,
        evidence: a.evidence,
        quote: a.quote,
        source: a.source,
        confidence: '原文事实与数据',
        relations: [],
      })
    }
  }
  const conceptMap = new Map<string, { term: string; explanation: string }>()
  for (const c of chunks) for (const k of c.concepts) if (!conceptMap.has(k.term)) conceptMap.set(k.term, k)
  const quotes: Array<{ text: string; context: string; source: string }> = []
  for (const c of chunks) quotes.push(...c.quotes.slice(0, 1))
  const caveats = chunks.flatMap((c) => c.caveats).slice(0, 10)
  const title = chunks[0]?.title ?? '未命名论文'
  return {
    title,
    summary: chunks.map((c) => c.summary).filter(Boolean).join('；').slice(0, 320),
    coreQuestion: chunks[0]?.thesis ?? '',
    coreConclusions: chunks.slice(0, 3).map((c) => c.thesis).filter((t) => t !== '').slice(0, 3),
    items: items.slice(0, 30),
    dataPoints: [],
    caveats,
    recallQuestions: [],
    figures: [],
    concepts: [...conceptMap.values()].slice(0, 8),
    quotes: quotes.slice(0, 5),
    mindmap: {
      label: title.slice(0, 60),
      children: chunks.slice(0, 10).map((c) => ({
        label: c.title.slice(0, 40),
        children: c.arguments.slice(0, 2).map((a) => ({ label: a.claim.slice(0, 60), children: [] as MindNode[] })),
      })),
    },
  }
}

  async function readSyncInner(input: ReadInput, onProgress: ((line: string) => void) | null, signal: AbortLike): Promise<PaperOutcome | QuickOutcome> {
    const { text, source, figures } = await loadFileText(ctx, input.path, onProgress)
    const outcome = await runFlow(text, source, figures, input, onProgress, signal)
    if (figures.length > 0) outcome.meta.figuresImgs = figures
    return outcome
  }

  return {
    readSync: (input, onProgress = null, signal = { aborted: false }) => readSyncInner(input, onProgress, signal),
    async read(input, opts = {}): Promise<ReadOutcome> {
      const signal: { aborted: boolean } = { aborted: false }
      const jobs = opts.jobs ?? (ctx.get('jobs') as JobsService | undefined)
      let text = ''
      let source = input.path
      let figures: PdfFigureImg[] = []
      try {
        const loaded = await loadFileText(ctx, input.path, null)
        text = loaded.text
        source = loaded.source
        figures = loaded.figures
      } catch (err) {
        // 加载失败也走前台,把错误正常抛给调用方
        throw err
      }

      const isLong = input.mode === 'paper' && text.length > CHUNK_CHARS
      if (isLong && jobs !== undefined && typeof jobs.start === 'function') {
        const label = '学者精读「' + source.replace(/^.*[\\/]/, '') + '」· ' + Math.min(Math.ceil(text.length / CHUNK_CHARS), MAX_PARTS) + ' 段'
        const lines: string[] = []
        let cancelled = false
        let cancelReason = ''
        let resolveDone!: (value: { status: string; detail?: string }) => void
        const donePromise = new Promise<{ status: string; detail?: string }>((resolve) => { resolveDone = resolve })
        let finalResult: PaperOutcome | QuickOutcome | null = null
        try {
          const jobId = await jobs.start({
            kind: 'scholar-read',
            label,
            outputLimitBytes: 256 * 1024,
            owner: opts.owner,
            run: () => {
              void (async () => {
                try {
                  finalResult = await runFlow(text, source, figures, input, (line) => { if (line !== '') lines.push(line) }, signal)
                  lines.push('精读完成：' + finalResult.title)
                  // 后台完成即在任务内归档（工具路径的 paper_read 不再丢报告）
                  try {
                    if (opts.onResult !== undefined) await opts.onResult(finalResult)
                  } catch (err) {
                    lines.push('归档失败：' + errorMessage(err))
                  }
                  resolveDone({ status: 'completed' })
                } catch (err) {
                  const msg = errorMessage(err)
                  if (cancelled) {
                    lines.push('已取消：' + cancelReason)
                    resolveDone({ status: 'killed', detail: cancelReason })
                  } else {
                    lines.push('后台精读失败：' + msg)
                    resolveDone({ status: 'failed', detail: msg })
                  }
                }
              })()
              return {
                cancel(reason: unknown) {
                  cancelled = true
                  cancelReason = typeof reason === 'string' && reason !== '' ? reason : '已取消'
                  signal.aborted = true
                },
                done: donePromise,
                readOutput: () => { const out = lines.join('\n'); lines.length = 0; return out },
              }
            },
          })
          return { kind: 'background', jobId, label }
        } catch {
          // jobs 启动失败（owner 不被任何 controller 服务等）→ 前台降级直跑，
          // 宁可同步慢也不让整次精读报废
        }
      }
      const result = await runFlow(text, source, figures, input, opts.onProgress ?? null, signal)
      if (figures.length > 0) result.meta.figuresImgs = figures
      return { kind: 'result', result }
    },
  }
}
