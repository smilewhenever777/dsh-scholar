/**
 * BibTeX 导出（纯客户端生成，不依赖 host）。
 *
 * 设计参考 Zotero/Better BibTeX 的常见形态：
 * - 引用键 `<firstauthor><year><firstword>`（如 rf2025spatial），非法字符剔除，
 *   纯中文标题无法提出 ASCII 词时回落到 arXiv id / 论文 id；
 * - venue 含会议词 → @inproceedings（booktitle=venue），否则 @article
 *   （arXiv 论文 journal = {arXiv preprint arXiv:<id>}）；
 * - title 外层加双大括号保住大小写（LaTeX 会自动小写化标题）。
 */
import type { Paper } from '../shared/types';

/** BibTeX 特殊字符转义（% & # _ 是 LaTeX 特殊字符；花括号成对转义防破坏字段） */
function escapeBib(s: string): string {
  return s
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([%&#_])/g, '\\$1')
    .replace(/([{}])/g, '{$1}');
}

/** 取作者姓氏用于引用键：ASCII 多词名取末词，中文/单词名取整体 */
function lastName(author: string | undefined): string {
  const a = (author ?? '').trim();
  if (!a) return '';
  // 纯 ASCII 且含空格（"First Last" / "First Middle Last"）→ 取末词
  if (/^[\x20-\x7e]+$/.test(a) && a.includes(' ')) return a.split(/\s+/).pop() ?? '';
  // 去掉中文名里的标点/空格，保留文字本身
  return a.replace(/[^\p{L}\p{N}]/gu, '');
}

/** 标题里第一个"有信息量"的词（跳过冠词/介词等停用词） */
function firstTitleWord(title: string): string {
  const STOP = new Set(['a', 'an', 'the', 'on', 'of', 'for', 'and', 'towards', 'toward', 'with', 'from', 'via', 'in', 'is', 'are']);
  for (const w of title.split(/[^\p{L}\p{N}]+/u)) {
    if (w.length < 2) continue;
    if (STOP.has(w.toLowerCase())) continue;
    return w;
  }
  return '';
}

/** 引用键：rf2025spatial；无 ASCII 词的中文标题回落 arXiv id 或论文 id */
export function bibtexKey(p: Paper): string {
  const ln = lastName(p.authors?.[0]);
  const word = firstTitleWord(p.title ?? '');
  const key = `${ln}${p.year ?? ''}${word}`.replace(/[^A-Za-z0-9]/g, '');
  if (key.replace(/^\d+/, '').length > 0) return key;
  // 整条键退化为纯数字（中文作者+中文标题场景）→ 用 id 兜底
  const fallback = (p.arxivId ?? p.id ?? 'paper').replace(/[^A-Za-z0-9]/g, '');
  return `paper${fallback}`.slice(0, 40);
}

/** venue 判定：含会议关键词 → 会议论文（@inproceedings） */
const CONF_RE = /(proceedings|conference|workshop|symposium|cvpr|iccv|eccv|neurips|nips|icml|iclr|aaai|ijcai|acm mm|icra|iros|cvprw)/i;

/** BibTeX 作者格式：ASCII "First Last" → "Last, First"；其余原样；and 连接 */
function bibAuthors(authors: string[]): string {
  return authors.map((a) => {
    const t = a.trim();
    if (/^[\x20-\x7e]+$/.test(t) && t.split(/\s+/).length >= 2) {
      const parts = t.split(/\s+/);
      return `${parts.pop()}, ${parts.join(' ')}`;
    }
    return t;
  }).filter(Boolean).join(' and ');
}

/** 单篇论文 → 一条 BibTeX entry（keyOverride 用于全库导出时的重复键消歧） */
export function paperToBibtex(p: Paper, keyOverride?: string): string {
  const key = keyOverride ?? bibtexKey(p);
  const isConf = !!(p.venue && CONF_RE.test(p.venue));
  const type = isConf ? 'inproceedings' : 'article';
  const lines: string[] = [];
  lines.push(`@${type}{${key},`);
  lines.push(`  title = {{${(p.title ?? '').replace(/[{}]/g, '')}}},`);
  if (p.authors?.length) lines.push(`  author = {${escapeBib(bibAuthors(p.authors))}},`);
  if (p.year) lines.push(`  year = {${p.year}},`);
  if (isConf) {
    lines.push(`  booktitle = {${escapeBib(p.venue ?? '')}},`);
  } else if (p.venue) {
    lines.push(`  journal = {${escapeBib(p.venue)}},`);
  } else if (p.arxivId) {
    lines.push(`  journal = {arXiv preprint arXiv:${p.arxivId}},`);
    lines.push(`  eprint = {${p.arxivId}},`);
    lines.push('  archivePrefix = {arXiv},');
  }
  if (p.doi) lines.push(`  doi = {${p.doi}},`);
  if (p.url) lines.push(`  url = {${p.url}},`);
  if (p.tags?.length) lines.push(`  keywords = {${p.tags.map(escapeBib).join(', ')}},`);
  lines.push('}');
  return lines.join('\n');
}

/** 全库 → .bib 文件内容（重复引用键追加 -1/-2 消歧） */
export function libraryToBibtex(papers: Paper[]): string {
  const seen = new Map<string, number>();
  return papers
    .map((p) => {
      let key = bibtexKey(p);
      const n = seen.get(key);
      if (n === undefined) {
        seen.set(key, 1);
      } else {
        seen.set(key, n + 1);
        key = `${key}-${n}`;
      }
      return paperToBibtex(p, key);
    })
    .join('\n\n');
}

/** 触发浏览器下载一个文本文件 */
export function downloadTextFile(filename: string, text: string, mime = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
