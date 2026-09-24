/**
 * 目录浏览器(项目工作区路径选择器的后端)。
 *
 * 为什么存在:浏览器安全模型不允许网页从"选择文件夹"对话框拿到磁盘绝对路径,
 * 而创建项目需要绝对路径——由本机后端列出目录、前端逐级点选回填,
 * 即 Jupyter/qBittorrent 式路径选择(接口仅在 loopback 守卫之后可达)。
 *
 * 规则与 canonicalProjectRoot 对齐:
 * - 只列真实目录(readdir withFileTypes 的 isDirectory,符号链接不入列)
 * - 位于 DSH_HOME 内(或等于)的目录标 blocked,前端置灰不可选
 * - 空路径 → 根视图(Windows 盘符列表);不存在/非目录 → 404 语义
 */
import { readdirSync, statSync, realpathSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, dirname, resolve, relative, sep } from 'node:path';
import { ServiceError } from '../types.js';
import { dshHome } from '../store.js';

export interface BrowseEntry {
  name: string;
  path: string;
  /** 位于 DSH_HOME 内——不能作为工作区,前端置灰 */
  blocked: boolean;
}

export interface BrowseResult {
  /** 当前目录(规范实路径);'' 表示根视图(盘符/根) */
  path: string;
  /** 上一级;'' 表示回到根视图;null 表示已在最顶层(隐藏上级按钮) */
  parent: string | null;
  /** 当前目录自身是否位于 DSH_HOME 内(禁用"选择此目录") */
  blocked: boolean;
  /** 用户主目录(根视图的快捷入口) */
  home: string;
  /** 根视图可选项(Windows 为存在的盘符;POSIX 为 ['/']) */
  drives: string[];
  dirs: BrowseEntry[];
  /** 目录过多被截断(超过 500 项) */
  truncated: boolean;
}

const MAX_ENTRIES = 500;

function listRoots(): string[] {
  if (process.platform !== 'win32') return ['/'];
  const drives: string[] = [];
  for (let c = 65; c <= 90; c++) {
    const drive = `${String.fromCharCode(c)}:\\`;
    try {
      if (statSync(drive).isDirectory()) drives.push(drive);
    } catch { /* 盘符不存在 */ }
  }
  return drives;
}

/** 与 canonicalProjectRoot 相同的 DSH_HOME 包含判定(实路径 + relative 方向检查)。 */
function insideHome(target: string, home: string): boolean {
  try {
    const homeReal = existsSync(home) ? realpathSync(home) : resolve(home);
    const targetReal = realpathSync(target);
    const rel = relative(homeReal, targetReal);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  } catch {
    return false;
  }
}

export function browseDirs(rawPath: string | undefined): BrowseResult {
  const input = (rawPath ?? '').trim();
  const home = homedir();
  if (!input) {
    return { path: '', parent: null, blocked: false, home, drives: listRoots(), dirs: [], truncated: false };
  }
  if (!isAbsolute(input)) throw new ServiceError('VALIDATION', '路径必须是绝对路径', 422);
  let real: string;
  try {
    real = realpathSync(resolve(input));
    if (!statSync(real).isDirectory()) throw new Error('不是目录');
  } catch {
    throw new ServiceError('NOT_FOUND', '目录不存在或不可访问', 404);
  }
  const parent = dirname(real) === real ? '' : dirname(real);
  const dsh = dshHome();
  const names: string[] = [];
  try {
    for (const d of readdirSync(real, { withFileTypes: true })) {
      if (d.isDirectory()) names.push(d.name); // 符号链接(isSymbolicLink)不入列,避免环
    }
  } catch {
    throw new ServiceError('NOT_FOUND', '目录不可读(权限不足)', 404);
  }
  names.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true }));
  const truncated = names.length > MAX_ENTRIES;
  const dirs: BrowseEntry[] = names.slice(0, MAX_ENTRIES).map((name) => {
    const p = join(real, name);
    return { name, path: p, blocked: insideHome(p, dsh) };
  });
  return { path: real, parent, blocked: insideHome(real, dsh), home, drives: [], dirs, truncated };
}
