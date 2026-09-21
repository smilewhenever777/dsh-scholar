/**
 * PDF 图像 XObject 提取（阶段 2：图进报告）。
 *
 * 扫描文档对象流里的 /Subtype /Image：
 * - DCTDecode（JPEG）→ 原始字节直存（浏览器可显示）；
 * - FlateDecode / 无滤波 的 8bit 光栅 → 解压后按颜色空间（Gray/RGB/CMYK→RGB）编码 PNG；
 * - JPX/CCITT/Indexed/16bit/ImageMask → 跳过（计数透出）。
 * 尺寸过滤：边长 <60px 的小图标与 >3Mpx 的整页底图都不要；按面积取前 12 张、
 * 保持文档顺序返回（论文里图像对象顺序 ≈ Figure 顺序，供与图注配对）。
 * PNG 编码用 node:zlib deflate + 本地 CRC32（仅需 IHDR/IDAT/IEND 三块）。
 */
import { deflateSync, inflateSync } from 'node:zlib'

export interface PdfFigureImg {
  mime: 'image/jpeg' | 'image/png'
  b64: string
  w: number
  h: number
  obj: string
}

export interface FigureExtractStats {
  scanned: number
  skippedSmall: number
  skippedUnsupported: number
  kept: number
}

const MAX_FIGS = 12
const MIN_EDGE = 60
const MAX_AREA = 3_000_000
const MAX_BYTES_EACH = 1_500_000

/* ---------- PNG 编码（最小实现：filter 0 扫描行 + zlib IDAT） ---------- */

const CRC_TABLE: number[] = (() => {
  const t: number[] = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    t.push(c >>> 0)
  }
  return t
})()

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!)! >>> 0 & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** 8bit 原始光栅 → PNG（components: 1=Gray 3=RGB；CMYK 先转 RGB 再进这里） */
function encodePng(w: number, h: number, components: 1 | 3, raw: Uint8Array): Uint8Array {
  const stride = w * components
  const rows = new Uint8Array((stride + 1) * h)
  for (let y = 0; y < h; y++) {
    rows[y * (stride + 1)] = 0 // filter: None
    rows.set(raw.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, w)
  dv.setUint32(4, h)
  ihdr[8] = 8 // bit depth
  ihdr[9] = components === 1 ? 0 : 2 // color type: Gray / RGB
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const idat = deflateSync(rows, { level: 6 })
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(idat)), chunk('IEND', new Uint8Array(0))]
  const total = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) { out.set(p, off); off += p.length }
  return out
}

/* ---------- 对象扫描 ---------- */

function dictInt(dict: string, key: string): number | undefined {
  const m = new RegExp('\\/' + key + '\\s+(\\d+)').exec(dict)
  return m ? parseInt(m[1]!, 10) : undefined
}

function dictFilters(dict: string): string[] {
  const arr = /\/Filter\s*\[([^\]]*)\]/.exec(dict)
  if (arr) return (arr[1]!.match(/\/([A-Za-z0-9]+)/g) ?? []).map((s) => s.slice(1))
  const one = /\/Filter\s*\/([A-Za-z0-9]+)/.exec(dict)
  return one ? [one[1]!] : []
}

function colorComponents(dict: string): 1 | 3 | 4 | undefined {
  const cs = /\/ColorSpace\s*(\/[A-Za-z0-9]+|\[[\s\S]*?\])/.exec(dict)?.[1] ?? ''
  if (/DeviceGray|CalGray/i.test(cs)) return 1
  if (/DeviceRGB|CalRGB/i.test(cs)) return 3
  if (/DeviceCMYK/i.test(cs)) return 4
  if (/ICCBased/i.test(cs)) {
    const n = /\/N\s+(\d)/.exec(cs)
    const v = n ? parseInt(n[1]!, 10) : 3
    if (v === 1) return 1
    if (v === 3) return 3
    if (v === 4) return 4
  }
  return undefined // Indexed/Separation/Lab 等 → 不支持
}

function latin1ToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

/** F05:图像流解压输出上限(64MiB/流)——异常 PDF 不能靠压缩展开耗尽内存 */
const FIG_STREAM_MAX_OUTPUT = 64 * 1024 * 1024;

function inflateZlibRaw(data: Uint8Array, remaining: number): Uint8Array {
  return new Uint8Array(inflateSync(Buffer.from(data), { maxOutputLength: Math.min(FIG_STREAM_MAX_OUTPUT, remaining) }))
}

/** latin1 全文 → 图像列表（文档顺序）+ 统计。失败容错：单图错误不影响其他。 */
export function extractPdfFigures(latin1: string): { images: PdfFigureImg[]; stats: FigureExtractStats } {
  if (latin1.length > 50 * 1024 * 1024) throw new Error('PDF 文件超过 50 MiB')
  let remaining = 64 * 1024 * 1024, scanned = 0
  const started = Date.now()
  const stats: FigureExtractStats = { scanned: 0, skippedSmall: 0, skippedUnsupported: 0, kept: 0 }
  const found: Array<{ img: PdfFigureImg; area: number; seq: number }> = []
  const re = /(\d+)\s+\d+\s+obj\s*([\s\S]*?)endstream/g
  let m: RegExpExecArray | null
  let seq = 0
  while ((m = re.exec(latin1)) !== null) {
    if (++scanned > 50_000 || remaining <= 0 || Date.now() - started > 5000) break
    const objNum = m[1]!
    const body = m[2]!
    const dictPart = body.slice(0, body.indexOf('stream'))
    if (!/\/Subtype\s*\/Image/.test(dictPart)) continue
    if (/\/ImageMask\s+true/.test(dictPart)) { stats.skippedUnsupported++; continue }
    stats.scanned++
    const w = dictInt(dictPart, 'Width')
    const h = dictInt(dictPart, 'Height')
    const bpc = dictInt(dictPart, 'BitsPerComponent') ?? 8
    if (w === undefined || h === undefined) { stats.skippedUnsupported++; continue }
    if (w < MIN_EDGE || h < MIN_EDGE) { stats.skippedSmall++; continue }
    if (w * h > MAX_AREA) { stats.skippedSmall++; continue }
    const filters = dictFilters(dictPart)
    // 流数据起点：dictPart 之后 stream 关键字结尾
    const streamKw = body.indexOf('stream')
    if (streamKw < 0) { stats.skippedUnsupported++; continue }
    let dataStart = streamKw + 'stream'.length
    if (body[dataStart] === '\r' && body[dataStart + 1] === '\n') dataStart += 2
    else if (body[dataStart] === '\n') dataStart += 1
    let dataEnd = body.length
    if (body.endsWith('\n')) dataEnd--
    const data = latin1ToBytes(body.slice(dataStart, dataEnd))
    let img: PdfFigureImg | null = null
    try {
      if (filters.includes('DCTDecode')) {
        if (data.length > MAX_BYTES_EACH || data.length < 500) { stats.skippedSmall++; continue }
        img = { mime: 'image/jpeg', b64: Buffer.from(data).toString('base64'), w, h, obj: objNum }
        remaining -= data.length
      } else if (filters.includes('JPXDecode') || filters.includes('CCITTFaxDecode') || filters.includes('JBIG2Decode')) {
        stats.skippedUnsupported++
      } else if (filters.length === 0 || filters.every((f) => f === 'FlateDecode')) {
        const comps = colorComponents(dictPart)
        if (bpc !== 8 || comps === undefined) { stats.skippedUnsupported++; continue }
        const raw0 = filters.length > 0 ? inflateZlibRaw(data, remaining) : data
        remaining -= raw0.length
        if (remaining < 0) break
        let compsUse: 1 | 3 = comps === 4 ? 3 : comps
        let raw = raw0
        if (comps === 4) {
          // CMYK → RGB（naive：255-c*(1-k) 公式）
          const px = w * h
          const rgb = new Uint8Array(px * 3)
          for (let i = 0; i < px; i++) {
            const c = raw0[i * 4]!, mm = raw0[i * 4 + 1]!, y = raw0[i * 4 + 2]!, k = raw0[i * 4 + 3]!
            rgb[i * 3] = Math.max(0, 255 - Math.min(255, c + k))
            rgb[i * 3 + 1] = Math.max(0, 255 - Math.min(255, mm + k))
            rgb[i * 3 + 2] = Math.max(0, 255 - Math.min(255, y + k))
          }
          raw = rgb
        }
        if (raw.length < w * h * compsUse) { stats.skippedUnsupported++; continue }
        const png = encodePng(w, h, compsUse, raw)
        if (png.length > MAX_BYTES_EACH) { stats.skippedSmall++; continue }
        img = { mime: 'image/png', b64: Buffer.from(png).toString('base64'), w, h, obj: objNum }
      } else {
        stats.skippedUnsupported++
      }
    } catch (error) {
      stats.skippedUnsupported++
      if ((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') break
    }
    if (img !== null) {
      found.push({ img, area: w * h, seq: seq++ })
      // Retain only the top figures throughout scanning, not every decoded image.
      if (found.length > MAX_FIGS) {
        found.sort((a, b) => b.area - a.area)
        found.length = MAX_FIGS
      }
    }
  }
  // 面积 top-N（去掉图标后尽量保留大图），恢复文档顺序
  const picked = found.sort((a, b) => b.area - a.area).slice(0, MAX_FIGS).sort((a, b) => a.seq - b.seq)
  stats.kept = picked.length
  return { images: picked.map((p) => p.img), stats }
}
