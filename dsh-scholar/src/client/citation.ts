/**
 * 引用格式生成（纯客户端，与 bibtex.ts 同模式）。
 *
 * 支持两种文本引用格式 + venue 的 CCF 分级查询：
 * - GB/T 7714-2015（国内结题/报销的官方著录格式）：
 *   期刊  `LIU Z, TAN L, ZHANG C, et al. Title[J]. Venue, Year.`
 *   会议  `… Title[C]//Venue. Year.`
 *   预印本 `… Title[EB/OL]. (Year)[引用日期]. https://arxiv.org/abs/<id>.`
 * - APA 7（`Liu, Z., Tan, L., & Zhang, C. (Year). Title. Venue. https://doi.org/x`）
 * 字段限制：Paper 无卷/期/页码，期刊格式按"刊名, 年."收尾（补齐后可扩展）。
 */
import type { Paper } from '../shared/types';

/** 与 bibtex.ts 相同的会议判定口径 */
const CONF_RE = /(proceedings|conference|workshop|symposium|cvpr|iccv|eccv|neurips|nips|icml|iclr|aaai|ijcai|acm mm|icra|iros|cvprw)/i;

/** ASCII "First [Middle] Last" → 姓 + 名首字母；非 ASCII（中文等）返回 null 原样用 */
function splitName(a: string): { last: string; initials: string } | null {
  const t = a.trim();
  if (!t || !/^[\x20-\x7e]+$/.test(t) || !t.includes(' ')) return null;
  const parts = t.split(/\s+/);
  const last = parts.pop() as string;
  const initials = parts.map((w) => `${(w[0] ?? '').toUpperCase()}.`).join(' ');
  return { last, initials };
}

/* ---------- GB/T 7714 ---------- */

/** GB/T 作者：`LIU Z`（姓全大写 + 名首字母连写）；中文作者原样 */
function gbName(a: string): string {
  const s = splitName(a);
  if (!s) return a.trim();
  return `${s.last.toUpperCase()} ${s.initials.replace(/\./g, '')}`.trim();
}

/** GB/T 作者列表：≤3 全列；>3 前三 + ", et al"（中文作者用 ", 等"） */
function gbAuthors(authors: string[]): string {
  const list = authors.map(gbName).filter(Boolean);
  if (list.length === 0) return '';
  if (list.length <= 3) return list.join(', ');
  const zh = authors.some((a) => /[\u4e00-\u9fff]/.test(a));
  return `${list.slice(0, 3).join(', ')}, ${zh ? '等' : 'et al'}`;
}

/** GB/T 7714-2015 著录条目 */
export function gbCitation(p: Paper): string {
  const authors = gbAuthors(p.authors ?? []) || (p.authors ?? []).join(', ');
  const title = (p.title ?? '').trim().replace(/[.。]+$/, '');
  const year = p.year ? String(p.year) : '';
  const citeDate = new Date().toISOString().slice(0, 10);
  let body: string;
  if (p.venue && CONF_RE.test(p.venue)) {
    body = `${title}[C]//${p.venue}. ${year}.`;
  } else if (p.venue) {
    body = `${title}[J]. ${p.venue}, ${year}.`;
  } else if (p.arxivId) {
    body = `${title}[EB/OL]. (${year})[${citeDate}]. https://arxiv.org/abs/${p.arxivId}.`;
  } else {
    body = `${title}. ${year}.`;
  }
  let s = authors ? `${authors}. ${body}` : body;
  if (p.doi) s += ` DOI: ${p.doi}.`;
  else if (p.venue && p.arxivId && !p.doi) s += ` https://arxiv.org/abs/${p.arxivId}.`;
  return s;
}

/* ---------- APA 7 ---------- */

/** APA 作者：`Liu, Z.`（姓, 名首字母.） */
function apaName(a: string): string {
  const s = splitName(a);
  if (!s) return a.trim();
  return `${s.last}, ${s.initials}`;
}

/** APA 作者列表：& 连接末位；>20 人取前 19 + 省略号 + 末位（APA 7 规则） */
function apaAuthors(authors: string[]): string {
  const list = authors.map(apaName).filter(Boolean);
  if (list.length === 0) return '';
  if (list.length === 1) return list[0];
  if (list.length > 20) return `${list.slice(0, 19).join(', ')}, ... ${list[list.length - 1]}`;
  return `${list.slice(0, -1).join(', ')}, & ${list[list.length - 1]}`;
}

/** APA 7 参考文献条目 */
export function apaCitation(p: Paper): string {
  const authors = apaAuthors(p.authors ?? []) || (p.authors ?? []).join(', ');
  const title = (p.title ?? '').trim().replace(/[.。]+$/, '');
  const year = p.year ? `(${p.year})` : '(n.d.)';
  const source = p.venue || (p.arxivId ? 'arXiv' : '');
  const link = p.doi
    ? ` https://doi.org/${p.doi}`
    : p.arxivId ? ` https://arxiv.org/abs/${p.arxivId}` : '';
  const head = `${authors} ${year}. ${title}${source ? `. ${source}` : ''}.`;
  return `${head}${link}`.replace(/\.\.+/g, '.');
}

/* ---------- CCF 分级 ---------- */

/**
 * CCF 推荐目录（精选 CV/ML/机器人方向常用刊会；按 venue 正则匹配）。
 * 注意：ECCV/ICME/ICRA/IROS 是 B 类；ICLR 未收录于 CCF 目录（国内常按 A 对待，
 * 但为避免虚标此处不标）。新增刊会直接在表头追加。
 */
const CCF_VENUES: [RegExp, string][] = [
  // 期刊 A
  [/tpami|t-pami|pattern analysis and machine intelligence/i, 'CCF-A'],
  [/\bijcv\b|international journal of computer vision/i, 'CCF-A'],
  [/\btip\b|trans[a-z]*.*image processing/i, 'CCF-A'],
  // 会议 A
  [/\bcvpr\b/i, 'CCF-A'],
  [/\biccv\b/i, 'CCF-A'],
  [/\bneurips\b|\bnips\b/i, 'CCF-A'],
  [/\bicml\b/i, 'CCF-A'],
  [/\baaai\b/i, 'CCF-A'],
  [/\bijcai\b/i, 'CCF-A'],
  [/acm multimedia|\bacm mm\b/i, 'CCF-A'],
  [/\bsiggraph\b/i, 'CCF-A'],
  [/\bsigir\b/i, 'CCF-A'],
  // 会议 B
  [/\beccv\b/i, 'CCF-B'],
  [/\b(icme|icra|iros)\b/i, 'CCF-B'],
  // 期刊 B
  [/\btmm\b|trans[a-z]*.*multimedia/i, 'CCF-B'],
  [/tcsvt|t-csvt|trans[a-z]*.*circuits.*video/i, 'CCF-B'],
  [/pattern recognition letters/i, 'CCF-C'],
  [/^pattern recognition$|pattern recognition\b(?! letters)/i, 'CCF-B'],
  [/\btits\b|trans[a-z]*.*intelligent transportation/i, 'CCF-B'],
  [/tnnls|trans[a-z]*.*neural networks/i, 'CCF-B'],
  // 期刊 C
  [/\bneurocomputing\b/i, 'CCF-C'],
];

/** venue → CCF 分级（'CCF-A'|'CCF-B'|'CCF-C'），未收录返回 null */
export function venueTier(venue: string | undefined): string | null {
  const v = (venue ?? '').trim();
  if (!v) return null;
  for (const [re, tier] of CCF_VENUES) if (re.test(v)) return tier;
  return null;
}
