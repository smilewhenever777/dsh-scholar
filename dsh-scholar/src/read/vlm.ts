/**
 * VLM 读图（阶段 3）：把 PDF 抽出的图喂给多模态模型做视觉解读。
 *
 * 通道：ctx.attachments.saveImage(bytes) → ImageAttachmentRef → 消息内容块
 * {type:'image', attachment} → ctx.llm.stream。宿主对纯文本模型会把图片块投影成
 * 占位文本——首图探测到占位/空洞回答即中止并标记 unusable（后续图不再烧 token）。
 */
import { createLlmRuntime } from './llm.js'
import { errorMessage, isRecord, type HostContext, type ModelSelection } from './types.js'
import type { PdfFigureImg } from './figures.js'

interface AttachmentStoreLike {
  saveImage(input: { data: Uint8Array; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; name?: string }): Promise<unknown>
}

interface AttachmentRefLike {
  attachmentId: unknown
  mediaType: string
  width?: number
  height?: number
  name?: string
}

export interface FigureReader {
  /** 单图视觉解读；unusable（模型看不到图/附件服务缺失）时返回 '' */
  describeFigure(img: PdfFigureImg, hint: string): Promise<string>
  readonly usable: boolean
}

function b64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

export function createFigureReader(ctx: HostContext): FigureReader {
  const { pickConfig } = createLlmRuntime({
    ctx: ctx as never,
    estimateTokens: (t) => Math.ceil(t.length * 0.6),
    llmCallStats: { calls: 0, ms: 0 },
    recordCalibration: (() => undefined) as never,
  })

  const store = (ctx as { attachments?: AttachmentStoreLike }).attachments
  let usable = typeof store?.saveImage === 'function'
  let probed = false

  async function streamText(cfg: ModelSelection, system: string, content: unknown[], maxTokens: number): Promise<string> {
    const options = {
      provider: cfg.provider,
      model: cfg.model,
      system,
      messages: [{ role: 'user', content }],
      temperature: 0.2,
      maxTokens,
    }
    let text = ''
    let failure: string | null = null
    const llm = (ctx as { llm?: { stream(o: unknown): AsyncIterable<unknown> } }).llm
    if (!llm) throw new Error('llm 服务不可用')
    for await (const chunk of llm.stream(options)) {
      if (isRecord(chunk) && chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (isRecord(chunk) && chunk.type === 'finish') {
        const reason = chunk.reason as { kind?: string; failure?: { message?: string } } | undefined
        if (reason && (reason.kind === 'error' || reason.kind === 'aborted')) {
          const f = reason.failure as { message?: string; code?: string } | undefined
          failure = f?.message ?? f?.code ?? '模型调用失败'
        }
      }
    }
    if (failure !== null) throw new Error('模型调用失败：' + failure)
    return text
  }

  /** 纯文本模型的图片占位/空洞回答探测：首图结果可疑即全局降级 */
  function looksUnusable(answer: string): boolean {
    const t = answer.trim()
    if (t.length < 12) return true
    if (/^\[.*(图片|图像|image|attachment|im age)/i.test(t)) return true
    if (/无法查看|无法看到|看不到图|仅支持文本|未能成功传入|不能接收图片|无法接收图片|只支持文本|文本输入/.test(t)) return true
    return false
  }

  return {
    get usable() { return usable },
    async describeFigure(img: PdfFigureImg, hint: string): Promise<string> {
      if (!usable) return ''
      try {
        const ref = (await store!.saveImage({
          data: b64ToBytes(img.b64),
          mediaType: img.mime,
          name: `paper-figure-${img.obj}.${img.mime === 'image/jpeg' ? 'jpg' : 'png'}`,
        })) as AttachmentRefLike
        if (!isRecord(ref) || ref.attachmentId === undefined) throw new Error('附件引用无效')
        const cfg = await pickConfig()
        const answer = await streamText(cfg,
          '你是论文配图解读助手。看用户给出的论文图片（架构图/结果可视化/示例等），用简体中文客观描述：'
          + '图里展示什么（结构、数据流、模块连接或数据趋势），2-4 句；只描述确实可见的内容，看不清的明说，不猜测。',
          [
            { type: 'text', text: (hint ? '图注线索：' + hint + '\n' : '') + '请描述这张论文配图。' },
            { type: 'image', attachment: ref },
          ],
          500)
        if (!probed) {
          probed = true
          if (looksUnusable(answer)) {
            usable = false
            return ''
          }
        }
        return answer.trim()
      } catch (err) {
        if (!probed) {
          probed = true
          usable = false
        }
        console.warn('[dsh-scholar] VLM 读图失败（已降级为不解读）:', errorMessage(err))
        return ''
      }
    },
  }
}
