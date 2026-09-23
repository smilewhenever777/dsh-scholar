/**
 * 执行者受控文件面(P3,§0.3/§9.2):
 *  - 读/列表仅限所领取的工作区,实路径(realpath)校验防符号链接逃逸;
 *  - 写仅限本派发报告目录 <ws>/dispatch-reports/<dispatchId>/,文件名白名单;
 *  - DSH_HOME(派发存储/服务 token 所在地)一律不可读;
 *  - 授权由 service 层 worker 门控承担(每次调用重查,冷恢复不缓存)。
 * 这是"受控入口",不是文件系统隔离的替代——不向子代理提供任意 shell/通用文件工具。
 */
import { closeSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { homedir } from 'node:os';

export const WORKER_FS_LIMITS = {
  maxReadBytes: 1024 * 1024,
  maxReportBytes: 2 * 1024 * 1024,
  maxListEntries: 500,
  maxFilenameLength: 120,
};

function dshHomeReal(): string | null {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  try {
    return realpathSync(home).replaceAll('\\', '/').toLowerCase();
  } catch {
    return null;
  }
}

/** 规范化为工作区内绝对路径;越界(含 .. 解析后逃逸)返回 null。 */
export function resolveInsideWs(wsRoot: string, target: string): string | null {
  const t = String(target ?? '').trim();
  if (!t) return null;
  const abs = (() => {
    const norm = t.replaceAll('\\', '/');
    if (/^[a-zA-Z]:\//.test(norm) || norm.startsWith('//') || norm.startsWith('/')) {
      return norm;
    }
    return join(wsRoot.replaceAll('\\', '/'), norm);
  })();
  const rootN = wsRoot.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  const absN = abs.replaceAll('\\', '/').toLowerCase();
  if (absN !== rootN && !absN.startsWith(rootN + '/')) return null;
  return abs;
}

/** 实路径校验:符号链接不得把目标带出工作区;DSH_HOME 一律不可达。 */
function guardRealPath(wsRoot: string, abs: string): string | null {
  let rootReal: string;
  let absReal: string;
  try {
    rootReal = realpathSync(wsRoot).replaceAll('\\', '/').toLowerCase();
  } catch {
    return null;
  }
  try {
    absReal = realpathSync(abs).replaceAll('\\', '/').toLowerCase();
  } catch {
    return null; // 不存在(读报错交给上层语义)
  }
  if (absReal !== rootReal && !absReal.startsWith(rootReal + '/')) return null;
  const homeReal = dshHomeReal();
  if (homeReal && (absReal === homeReal || absReal.startsWith(homeReal + '/'))) return null;
  return absReal;
}

export interface ReadResult {
  path: string;
  size: number;
  truncated: boolean;
  binary: boolean;
  content?: string;
  error?: string;
}

export function workerReadFile(wsRoot: string, target: string): ReadResult {
  const abs = resolveInsideWs(wsRoot, target);
  if (!abs) return { path: String(target), size: 0, truncated: false, binary: false, error: '路径越界:仅允许工作区内文件' };
  const real = guardRealPath(wsRoot, abs);
  if (!real) return { path: abs, size: 0, truncated: false, binary: false, error: '实路径越界(符号链接/敏感目录)或文件不存在' };
  let st;
  try {
    st = statSync(real);
  } catch {
    return { path: abs, size: 0, truncated: false, binary: false, error: '文件不存在或不可访问' };
  }
  if (!st.isFile()) return { path: abs, size: 0, truncated: false, binary: false, error: '不是普通文件' };
  // 同步短读(工具调用为短路径,文件面 ≤1MB)
  const head = Buffer.alloc(Math.min(8192, st.size));
  const fdHead = openSync(real, 'r');
  try {
    readSync(fdHead, head, 0, head.length, 0);
  } finally {
    closeSync(fdHead);
  }
  if (head.includes(0)) {
    return { path: abs, size: st.size, truncated: false, binary: true, error: '二进制文件,不提供内容' };
  }
  const limited = Math.min(st.size, WORKER_FS_LIMITS.maxReadBytes);
  const buf = Buffer.alloc(limited);
  const fdBody = openSync(real, 'r');
  try {
    readSync(fdBody, buf, 0, limited, 0);
  } finally {
    closeSync(fdBody);
  }
  return {
    path: abs,
    size: st.size,
    truncated: st.size > limited,
    binary: false,
    content: buf.toString('utf8'),
  };
}

export interface PreviewResult {
  path: string;
  size: number;
  truncated: boolean;
  kind: 'text' | 'html' | 'image' | 'pdf';
  mime?: string;
  content?: string;
  base64?: string;
  error?: string;
}

const MAX_PREVIEW_MEDIA_BYTES = 8 * 1024 * 1024;

/** 浏览器预览只接受具有匹配文件头的常见图片和 PDF，SVG 始终按文本处理。 */
function previewMediaType(head: Buffer): { kind: 'image' | 'pdf'; mime: string } | null {
  if (head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { kind: 'image', mime: 'image/png' };
  if (head.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return { kind: 'image', mime: 'image/jpeg' };
  if (head.subarray(0, 6).toString('ascii') === 'GIF87a' || head.subarray(0, 6).toString('ascii') === 'GIF89a') return { kind: 'image', mime: 'image/gif' };
  if (head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP') return { kind: 'image', mime: 'image/webp' };
  if (head.subarray(0, 5).toString('ascii') === '%PDF-') return { kind: 'pdf', mime: 'application/pdf' };
  return null;
}

export function workerPreviewFile(wsRoot: string, target: string): PreviewResult {
  const abs = resolveInsideWs(wsRoot, target);
  if (!abs) return { path: target, size: 0, truncated: false, kind: 'text', error: '路径越界:仅允许工作区内文件' };
  const real = guardRealPath(wsRoot, abs);
  if (!real) return { path: abs, size: 0, truncated: false, kind: 'text', error: '实路径越界(符号链接/敏感目录)或文件不存在' };
  let size: number;
  let head: Buffer;
  try {
    const st = statSync(real);
    if (!st.isFile()) return { path: abs, size: 0, truncated: false, kind: 'text', error: '不是普通文件' };
    size = st.size;
    const fd = openSync(real, 'r');
    try {
      head = Buffer.alloc(Math.min(size, 16));
      readSync(fd, head, 0, head.length, 0);
    } finally { closeSync(fd); }
  } catch {
    return { path: abs, size: 0, truncated: false, kind: 'text', error: '文件不存在或不可访问' };
  }
  const media = previewMediaType(head);
  if (media) {
    if (size > MAX_PREVIEW_MEDIA_BYTES) return { path: abs, size, truncated: false, kind: media.kind, error: '文件过大,无法在线预览(上限 8 MB)' };
    try {
      const fd = openSync(real, 'r');
      try {
        const current = fstatSync(fd);
        if (!current.isFile() || current.size !== size || current.size > MAX_PREVIEW_MEDIA_BYTES) {
          return { path: abs, size, truncated: false, kind: media.kind, error: '文件在读取时发生变化' };
        }
        const bytes = Buffer.alloc(size);
        let offset = 0;
        while (offset < size) {
          const n = readSync(fd, bytes, offset, size - offset, offset);
          if (!n) return { path: abs, size, truncated: false, kind: media.kind, error: '文件在读取时发生变化' };
          offset += n;
        }
        if (previewMediaType(bytes.subarray(0, 16))?.mime !== media.mime) {
          return { path: abs, size, truncated: false, kind: media.kind, error: '文件在读取时发生变化' };
        }
        return { path: abs, size, truncated: false, ...media, base64: bytes.toString('base64') };
      } finally { closeSync(fd); }
    } catch { return { path: abs, size, truncated: false, kind: media.kind, error: '文件不可访问' }; }
  }
  const text = workerReadFile(wsRoot, target);
  const kind = !text.truncated && /\.html?$/i.test(extname(target)) ? 'html' : 'text';
  return { path: text.path, size: text.size, truncated: text.truncated, kind, content: text.content, error: text.error };
}

export interface ListResult {
  path: string;
  entries: Array<{ name: string; isDir: boolean; size: number }>;
  error?: string;
}

export function workerListDir(wsRoot: string, target: string): ListResult {
  const abs = resolveInsideWs(wsRoot, target || '.');
  if (!abs) return { path: String(target), entries: [], error: '路径越界' };
  const real = guardRealPath(wsRoot, abs);
  if (!real) return { path: abs, entries: [], error: '实路径越界或目录不存在' };
  let names;
  try {
    names = readdirSync(real, { withFileTypes: true });
  } catch {
    return { path: abs, entries: [], error: '目录不存在或不可访问' };
  }
  const entries = names.slice(0, WORKER_FS_LIMITS.maxListEntries).map((d) => {
    let size = 0;
    try {
      if (d.isFile()) size = statSync(join(real, d.name)).size;
    } catch { /* 权限/竞争:保留条目,尺寸 0 */ }
    return { name: d.name, isDir: d.isDirectory(), size };
  });
  return { path: abs, entries, ...(names.length > WORKER_FS_LIMITS.maxListEntries ? { error: `条目过多,仅显示前 ${WORKER_FS_LIMITS.maxListEntries} 项` } as const : {}) };
}

/** 报告文件名白名单:无分隔符、无 ..、长度受限。 */
export function validReportFilename(filename: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(String(filename ?? '')) && !filename.includes('..');
}

export interface WriteReportResult {
  path: string;
  bytes: number;
  error?: string;
}

export function workerWriteReport(wsRoot: string, dispatchId: string, filename: string, content: string): WriteReportResult {
  if (!validReportFilename(filename)) {
    return { path: '', bytes: 0, error: '文件名不合法(仅字母数字._-,不含路径)' };
  }
  const body = typeof content === 'string' ? content : String(content ?? '');
  if (Buffer.byteLength(body, 'utf8') > WORKER_FS_LIMITS.maxReportBytes) {
    return { path: '', bytes: 0, error: `内容超限(>${WORKER_FS_LIMITS.maxReportBytes} 字节)` };
  }
  const dirAbs = resolveInsideWs(wsRoot, `dispatch-reports/${dispatchId}`);
  if (!dirAbs) return { path: '', bytes: 0, error: '报告目录构造失败' };
  try {
    mkdirSync(dirAbs, { recursive: true });
  } catch {
    return { path: '', bytes: 0, error: '报告目录创建失败' };
  }
  // 目录可能由符号链接前缀引入:实路径复核
  if (!guardRealPath(wsRoot, dirAbs)) return { path: '', bytes: 0, error: '报告目录实路径越界' };
  const file = join(dirAbs, filename);
  try {
    writeFileSync(file, body, 'utf8');
  } catch {
    return { path: '', bytes: 0, error: '写入失败' };
  }
  return { path: file, bytes: Buffer.byteLength(body, 'utf8') };
}
