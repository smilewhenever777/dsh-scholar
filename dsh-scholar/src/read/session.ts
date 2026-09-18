/**
 * 阅读会话（交互式精读的状态层）：reads/<safeId>.json
 * - chunks：精读时保存的章节块（问答检索的原料；重读时刷新）
 * - qa：问答记录（重读保留——人的"反复"是有累积的）
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { safeName } from '../store.js';

export interface QAEntry {
  q: string
  a: string
  pages: string[]
  confidence: string
  sufficient: boolean
  at: number
}

export interface ReadingSession {
  paperId: string
  chunks: string[]
  qa: QAEntry[]
  updatedAt: number
}

export function sessionPath(dir: string, paperId: string): string {
  return join(dir, 'reads', `${safeName(paperId)}.json`)
}

export async function loadSession(dir: string, paperId: string): Promise<ReadingSession | null> {
  try {
    const raw = JSON.parse(await readFile(sessionPath(dir, paperId), 'utf8')) as ReadingSession
    if (!raw || !Array.isArray(raw.chunks) || raw.chunks.length === 0) return null
    return { ...raw, qa: Array.isArray(raw.qa) ? raw.qa : [] }
  } catch {
    return null
  }
}

/** 精读归档时调用：刷新章节块，保留历史问答 */
export async function saveSessionAfterRead(dir: string, paperId: string, chunks: string[]): Promise<void> {
  const prev = await loadSession(dir, paperId)
  const session: ReadingSession = {
    paperId,
    chunks,
    qa: prev?.qa ?? [],
    updatedAt: Date.now(),
  }
  await mkdir(join(dir, 'reads'), { recursive: true })
  const file = sessionPath(dir, paperId)
  const tmp = `${file}.${Date.now().toString(36)}.tmp`
  await writeFile(tmp, JSON.stringify(session, null, 2), 'utf8')
  const { rename } = await import('node:fs/promises')
  await rename(tmp, file)
}

export async function appendQA(dir: string, paperId: string, entry: QAEntry): Promise<void> {
  const s = await loadSession(dir, paperId)
  if (!s) throw new Error('该论文还没有精读会话（先精读一次才能追问）')
  s.qa.push(entry)
  s.updatedAt = Date.now()
  await mkdir(join(dir, 'reads'), { recursive: true })
  const file = sessionPath(dir, paperId)
  const tmp = `${file}.${Date.now().toString(36)}.tmp`
  await writeFile(tmp, JSON.stringify(s, null, 2), 'utf8')
  const { rename } = await import('node:fs/promises')
  await rename(tmp, file)
}
