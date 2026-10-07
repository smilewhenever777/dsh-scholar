/**
 * dsh-trajectory — 工作区文档扫描引擎(自动摄取,v0.4 方向 A)。
 *
 * 沙箱化只读扫描用户工作区目录,发现研究文档(*.md / *.csv / *.json),
 * 从文件名和内容中提取结构化元数据(日期/子系统/文档类型/结论/指标/Gate 判定),
 * 供 traj_scan 工具返回给 AI,AI 再深读关键文档后建 Goal/Hypothesis/Experiment。
 *
 * 安全:路径沙箱(必须在 workspace root 内)、只读、5MB 文件上限、200 文件上限。
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, relative, extname, basename, sep } from 'node:path';

export interface ScannedMetric {
  name: string;
  value: number;
  baseline?: number;
  unit?: string;
}

export interface ScannedDoc {
  /** 相对于工作区根的路径 */
  path: string;
  filename: string;
  /** 文件名中提取的子系统(e.g., "REF_STAGE5_D4") */
  subsystem?: string;
  /** 文件名中提取的文档类型(e.g., "RESULTS", "PROGRESS_REPORT") */
  docType?: string;
  /** 文件名中的日期 YYYY-MM-DD */
  date?: string;
  /** 从 "## 结论" / "## Verdict" 提取的第一段 */
  conclusion?: string;
  /** 从指标表提取的数值 */
  metrics?: ScannedMetric[];
  /** Gate 判定("PASS" / "FAIL" / "NOGO" / "GO") */
  gateVerdict?: string;
  /** 全部 section 标题(供 AI 判断哪些文档值得深读) */
  sectionTitles: string[];
}

const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.dsh', '.venv', 'venv',
  '.tox', '.mypy_cache', '.pytest_cache', 'dist', 'build', '.idea', '.vscode',
  'evidence', '.aris', 'attachment', 'attachments',
]);
/** 以这些前缀开头的目录名也排除 */
const EXCLUDE_DIR_PREFIXES = ['.pytest', '.cache', 'test_', '__', '.github'];
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_FILES = 200;
const VALID_EXTS = new Set(['.md', '.csv', '.json']);

/** 路径沙箱:确保 resolved path 在 workspace root 内。 */
export function sandboxPath(workspaceRoot: string, target: string): string {
  const resolved = resolve(workspaceRoot, target);
  const rel = relative(resolve(workspaceRoot), resolved);
  if (rel.startsWith('..') || rel.includes('..')) {
    throw new Error(`路径越界: ${target}`);
  }
  return resolved;
}

/** 从文件名提取元数据。支持多种命名模式。 */
export function parseFilename(name: string): { subsystem?: string; docType?: string; date?: string } {
  // 模式1: WEDETECT_REF_STAGE5_D4_RESULTS_20260904.md
  let m = /^([A-Z][A-Z0-9_]*?)_(RESULTS|IDEA_BRIEF|PROGRESS_REPORT|RESEARCH_REPORT|REPRODUCTION_PLAN|TASK_CONTRACT|ROUTE_CORRECTION|BOOTSTRAP|CONTRACT_DIAGNOSTIC|DIAGNOSTIC)_(\d{8})/.exec(name);
  if (m) {
    return { subsystem: m[1], docType: m[2], date: fmtDate(m[3]) };
  }
  // 模式2: RAGTRACK_DECISION_20260912.md
  m = /^RAGTRACK_([A-Z_]+?)_(\d{8})/.exec(name);
  if (m) {
    return { subsystem: 'RAGTRACK', docType: m[1], date: fmtDate(m[2]) };
  }
  // 模式3: 通用 — 尾部日期
  m = /(\d{8})/.exec(name);
  if (m) {
    const base = name.replace(/_\d{8}.*$/, '');
    return { subsystem: undefined, docType: undefined, date: fmtDate(m[1]) };
  }
  return {};
}

function fmtDate(yyyymmdd: string): string | undefined {
  if (yyyymmdd.length !== 8) return undefined;
  const y = yyyymmdd.slice(0, 4);
  const mo = yyyymmdd.slice(4, 6);
  const d = yyyymmdd.slice(6, 8);
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return undefined;
  return `${y}-${mo}-${d}`;
}

/** 从 Markdown 内容提取结构化信息。 */
export function parseContent(text: string): {
  conclusion?: string;
  metrics?: ScannedMetric[];
  gateVerdict?: string;
  sectionTitles: string[];
} {
  const sectionTitles: string[] = [];
  let conclusion: string | undefined;
  const metrics: ScannedMetric[] = [];

  // 提取 section 标题 + 结论段
  const lines = text.split('\n');
  let inConclusion = false;
  let conclusionLines: string[] = [];
  for (const line of lines) {
    const h2 = /^## (.+)/.exec(line);
    if (h2) {
      sectionTitles.push(h2[1].trim());
      const title = h2[1].trim().toLowerCase();
      inConclusion = title.includes('结论') || title.includes('verdict') || title.includes('conclusion');
      if (inConclusion) conclusionLines = [];
      continue;
    }
    if (inConclusion && conclusionLines.length < 5) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('---')) {
        conclusionLines.push(trimmed);
      }
    }
  }
  if (conclusionLines.length > 0) {
    conclusion = conclusionLines.join(' ').slice(0, 200);
  }

  // 提取 Gate 判定
  const gateMatch = /(?:Gate\s*\d+\s*判定|VERDICT|verdict)\s*[:：]?\s*['"]?(PASS|FAIL|NOGO|GO\b|通过|不通过)/i.exec(text);
  if (gateMatch) {
    const raw = gateMatch[1].toUpperCase();
    gateVerdictMap(raw);
  }
  // 也检查 JSON 里的 status
  if (text.includes('"status"')) {
    const statusMatch = /"status"\s*:\s*"(PASS|FAIL|NOGO)"/i.exec(text);
    if (statusMatch) {
      return { conclusion, metrics, gateVerdict: statusMatch[1].toUpperCase(), sectionTitles };
    }
  }

  // 提取 Markdown pipe-table 中的指标
  const tableRows = text.split('\n').filter((l) => l.startsWith('|') && l.includes('|'));
  for (const row of tableRows) {
    const cells = row.split('|').map((c) => c.trim()).filter(Boolean);
    if (cells.length < 2) continue;
    // 跳过表头和分隔线
    if (cells.every((c) => /^[-: ]+$/.test(c))) continue;
    if (cells[0] === '指标' || cells[0] === 'Metric' || cells[0] === 'metric') continue;
    // 查找数值 cell
    for (let i = 1; i < cells.length; i++) {
      const numMatch = /(\d+\.?\d*)\s*(%|pp)?/.exec(cells[i].replace(/\*/g, ''));
      if (numMatch && Number(numMatch[1]) > 0) {
        metrics.push({
          name: cells[0].slice(0, 50),
          value: Number(numMatch[1]),
          unit: numMatch[2] || undefined,
        });
        break;
      }
    }
    if (metrics.length >= 10) break; // 上限
  }

  return { conclusion, metrics, gateVerdict: gateVerdictMap(undefined), sectionTitles };
}

function gateVerdictMap(raw?: string): string | undefined {
  if (!raw) return undefined;
  const upper = raw.toUpperCase();
  if (upper.includes('PASS') || upper.includes('通过')) return 'PASS';
  if (upper.includes('FAIL') || upper.includes('不通过')) return 'FAIL';
  if (upper.includes('NOGO') || upper.includes('NO_GO')) return 'NOGO';
  return upper;
}

/** 递归扫描工作区目录,返回发现的研究文档。 */
export async function scanWorkspace(
  workspaceRoot: string,
  opts?: { since?: string; limit?: number },
): Promise<ScannedDoc[]> {
  const root = resolve(workspaceRoot);
  const limit = Math.min(opts?.limit ?? MAX_FILES, MAX_FILES);
  const since = opts?.since;
  const results: ScannedDoc[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (results.length >= limit) return;
    if (depth > 4) return; // 目录深度上限

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= limit) return;

      if (entry.isDirectory()) {
        if (EXCLUDE_DIRS.has(entry.name)) continue;
        if (EXCLUDE_DIR_PREFIXES.some((p) => entry.name.startsWith(p))) continue;
        await walk(join(dir, entry.name), depth + 1);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (!VALID_EXTS.has(ext)) continue;
        // 排除 package.json, tsconfig 等非研究文件
        if (['package.json', 'package-lock.json', 'tsconfig.json', 'pyproject.toml'].includes(entry.name)) continue;
        if (entry.name.startsWith('test_') || entry.name.startsWith('.')) continue;
        if (entry.name.startsWith('CONTRACT_') || entry.name.startsWith('DESIGN_')) continue;

        const filePath = join(dir, entry.name);
        try {
          const st = await stat(filePath);
          if (st.size > MAX_FILE_SIZE || st.size < 50) continue;

          const content = await readFile(filePath, 'utf8');
          // 内容质量门槛:至少 200 字且含 ## 标题,否则不是研究文档
          if (content.length < 200 || !content.includes('## ')) continue;
          const meta = parseFilename(entry.name);
          const parsed = parseContent(content);

          // since 过滤
          if (since && meta.date && meta.date < since) continue;

          results.push({
            path: relative(root, filePath).replace(/\\/g, '/'),
            filename: entry.name,
            ...meta,
            ...parsed,
          });
        } catch {
          // 读取失败跳过
        }
      }
    }
  }

  await walk(root, 0);

  // 按日期降序(最新在前)
  results.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  return results;
}

/** Token-lean 摘要(供 traj_scan 返回给 AI)。 */
export function docsToSummary(docs: ScannedDoc[], max = 60): Array<{
  path: string;
  date?: string;
  docType?: string;
  subsystem?: string;
  conclusion?: string;
  gate?: string;
}> {
  return docs.slice(0, max).map((d) => ({
    path: d.path,
    date: d.date,
    docType: d.docType,
    subsystem: d.subsystem,
    conclusion: d.conclusion?.slice(0, 60),
    gate: d.gateVerdict,
  }));
}


/* ═══════════ 实验输出目录扫描(v0.4 traj_scan_runs) ═══════════ */

const RUN_DIR_NAMES = ['runs', 'experiments', 'outputs', 'results', 'output'];
const RUN_DATE_RE = /(\d{8})/;

export interface ScannedRun {
  path: string;
  date?: string;
  status?: string;
}

/** 扫描 runs/、experiments/、outputs/ 等目录,发现实验运行。 */
export async function scanRunDirs(workspaceRoot: string): Promise<ScannedRun[]> {
  const root = resolve(workspaceRoot);
  const out: ScannedRun[] = [];

  for (const dirName of RUN_DIR_NAMES) {
    const dirPath = join(root, dirName);
    try {
      const st = await stat(dirPath);
      if (!st.isDirectory()) continue;
    } catch { continue; }

    // 递归两层:runs/<experiment>/<run_tag>/ 或 experiments/<Gate>/
    let level1;
    try { level1 = await readdir(dirPath, { withFileTypes: true }); } catch { continue; }

    for (const e1 of level1) {
      if (!e1.isDirectory()) continue;
      const e1Path = join(dirPath, e1.name);
      const e1Date = RUN_DATE_RE.exec(e1.name)?.[1];

      // 检查这层是否有 exit_code.txt / status / summary
      let hasRun = false;
      let status: string | undefined;
      try {
        const files = await readdir(e1Path);
        for (const f of files) {
          if (f === 'exit_code.txt' || f.includes('summary') || f.includes('metrics') || f === 'run_manifest.json') {
            hasRun = true;
            if (f === 'run_manifest.json') {
              try {
                const raw = JSON.parse(await readFile(join(e1Path, f), 'utf8'));
                status = raw?.status ?? raw?.result_scope;
              } catch { /* ignore */ }
            }
          }
        }
      } catch { /* ignore */ }

      if (hasRun) {
        out.push({
          path: relative(root, e1Path).split(sep).join('/'),
          date: e1Date ? fmtDate(e1Date) : undefined,
          status,
        });
        continue;
      }

      // 再往下一层(run_tag 子目录)
      if (out.length >= 50) break;
      try {
        const level2 = await readdir(e1Path, { withFileTypes: true });
        for (const e2 of level2) {
          if (!e2.isDirectory()) continue;
          const e2Path = join(e1Path, e2.name);
          const e2Date = RUN_DATE_RE.exec(e2.name)?.[1] ?? e1Date;
          try {
            const files = await readdir(e2Path);
            if (files.some((f) => f.includes('summary') || f.includes('exit_code') || f.includes('metrics'))) {
              out.push({
                path: relative(root, e2Path).split(sep).join('/'),
                date: e2Date ? fmtDate(e2Date) : undefined,
              });
            }
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }
  }

  out.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  return out.slice(0, 50);
}
