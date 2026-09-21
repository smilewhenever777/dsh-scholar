import { queueMutation } from './mutationQueue';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IdeaCard, Paper, PaperCollection, ReadStatus } from '../shared/types';
import { READ_STATUSES } from '../shared/types';
import { api, loadSavedFilters, qs, saveFilters } from './api';
import { navBus, useNav, type TFunc } from './nav';
import { openPaperInRightbar, rightbarAvailable } from './rightbar';
import { downloadTextFile, libraryToBibtex, paperToBibtex } from './bibtex';
import { gbCitation, apaCitation, venueTier } from './citation';
import { DeepreadLauncher, deliverToComposer } from './DeepreadLauncher';
import { PaperAsk } from './PaperAsk';
import type { ScholarConfig } from '../shared/types';
import {
  Btn, Chip, EmptyState, Field, FilterChip, Icon, Icons, IconButton, Input, Meta, Modal, SchStyles,
  Section, SearchInput, Select, Stars, T, Textarea, truncate,
} from './ui';

/** preset swatches for collection colors */
const COL_COLORS = ['#4d6bfe', '#30a46c', '#f5a524', '#e5484d', '#7c5cff', '#0d9488'];

/** 筛选/排序状态按 tab 存 sessionStorage 的键 */
const FILTERS_KEY = 'dsh-scholar:papers:filters';

/** 保存的筛选（命名查询，Zotero saved searches）持久在 localStorage */
const SAVED_SEARCHES_KEY = 'dsh-scholar:papers:savedSearches';

/** 浏览足迹（最近在看，id 有序去重，上限 15）持久在 localStorage */
const RECENT_KEY = 'dsh-scholar:papers:recent';

function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}

/** 详情页"相关论文"区块的数据形状（host /scholar/papers/:id/related 的响应） */
interface RelatedWorkLite {
  openalexId: string;
  title: string;
  year?: number;
  venue?: string;
  doi?: string;
  arxivId?: string;
  citedBy: number;
  authors: string[];
  libraryPaperId?: string;
}
interface RelatedReportLite {
  openalexId?: string;
  similar: RelatedWorkLite[];
  citations: RelatedWorkLite[];
  references: RelatedWorkLite[];
  note?: string;
}

interface SavedSearch {
  id: string;
  name: string;
  f: { q: string; tag: string; yearFrom: string; yearTo: string; importance: string; readStatus: string; col: string; unfiled: boolean };
}

/** 阅读状态展示（ReadPaper 式 想读/在读/读过） */
const READ_STATUS_LABELS: Record<ReadStatus, string> = { want: 'paper.read.want', reading: 'paper.read.reading', done: 'paper.read.done' };

function readStatusColor(rs: ReadStatus | undefined): string {
  if (rs === 'reading') return T.business;
  if (rs === 'done') return T.success;
  return 'rgba(127,127,127,.85)';
}

/** venue 徽章：会议/期刊着色，无 venue 的 arXiv 论文给灰色 arXiv 标 */
function venueBadge(p: Paper): { label: string; color: string } | null {
  const v = (p.venue ?? '').trim();
  const clip = (s: string) => (s.length > 18 ? `${s.slice(0, 17)}…` : s);
  if (v) {
    if (/cvpr|iccv|eccv/i.test(v)) return { label: clip(v), color: '#e5484d' };
    if (/neurips|nips\b|icml|iclr/i.test(v)) return { label: clip(v), color: '#7c5cff' };
    if (/aaai|ijcai/i.test(v)) return { label: clip(v), color: '#f5a524' };
    if (/t-?pami|t-?ip|t-?mm|t-?csvt|journal|transactions/i.test(v)) return { label: clip(v), color: '#0d9488' };
    return { label: clip(v), color: T.business };
  }
  if (p.arxivId) return { label: 'arXiv', color: 'rgba(127,127,127,.8)' };
  return null;
}

/** 等宽字体（arXiv/DOI/引用条目） */
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

const CITATION_FORMATS = ['gb', 'apa', 'bibtex'] as const;
type CitationFmt = (typeof CITATION_FORMATS)[number];
const CIT_LABEL: Record<CitationFmt, string> = { gb: 'GB/T 7714', apa: 'APA 7', bibtex: 'BibTeX' };

/** 引用文本：gb/apa 走格式化器，bibtex 走生成器 */
function citationText(p: Paper, fmt: CitationFmt): string {
  if (fmt === 'bibtex') return paperToBibtex(p);
  return fmt === 'gb' ? gbCitation(p) : apaCitation(p);
}

/** 列表请求序号:慢的旧响应回来时若已有更新的请求,直接丢弃,防止旧结果覆盖新结果 */
let loadSeq = 0;

const has = (v: string | undefined): boolean => !!v;

/** P0-4:url 字段可能存任意字符串(agent 输入),只有 http(s) 才可点击 */
function isHttpUrl(u: string): boolean {
  return /^https?:\/\//i.test(u);
}

/** 精读报告列表（deepread 产物经 paper_save_report 归档后在此展示） */
function PaperReports({ paperId, notify, t }: { paperId: string; notify?: (msg: string) => void; t: TFunc }) {
  type ReportRow = { file: string; size: number; savedAt: number; mode?: 'paper' | 'quick' | 'compare' | '' };
  const [reports, setReports] = useState<ReportRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const refresh = useCallback(() => {
    let alive = true;
    setFailed(false);
    api<{ reports: ReportRow[] }>(`/scholar/papers/${encodeURIComponent(paperId)}/reports`)
      .then((r) => { if (alive) setReports(r.reports ?? []); })
      .catch(() => {
        // 静默吞错会让人误以为"没有报告"——失败时明确显示加载失败
        if (alive) setFailed(true);
      });
    return () => { alive = false; };
  }, [paperId]);
  useEffect(() => refresh(), [refresh]);
  // 后台精读完成 → 报告列表自动长出最新一份（不用手刷）
  useEffect(() => {
    const h = () => refresh();
    window.addEventListener('scholar:read-done', h);
    return () => window.removeEventListener('scholar:read-done', h);
  }, [refresh]);

  /** 从报告建卡：精读报告二次速读 → 提取创新点 → idea_card_create（经对话注入） */
  const cardsFromReport = async (file: string) => {
    try {
      const cfg = await api<{ config: ScholarConfig }>('/scholar/config');
      const path = `${cfg.config.paperDir.replace(/[\\/]+$/, '')}/reports/${file}`;
      deliverToComposer(
        `请基于这篇论文（id: ${paperId}）的精读报告提取创新点建卡：用 paper_read 工具速读报告文件（path 参数） ${path}（quick 模式），`
        + `focus=从报告结论中提取 1-3 条对我研究方向可迁移的创新点（结合上下文注入的研究方向），`
        + `然后 idea_card_create 建卡（关联论文 ${paperId}，evidence 引用报告中的具体数据与表号）。`,
        (r) => notify?.(t(r === 'sent' ? 'paper.deepreadSent' : r === 'filled' ? 'paper.deepreadFilled' : r === 'failed' ? 'paper.deepreadFailed' : 'paper.deepreadCopied')),
      );
    } catch (e) {
      notify?.(e instanceof Error ? e.message : String(e));
    }
  };

  if (failed) {
    return (
      <Section title={t('paper.reports')} icon={<Icon d={Icons.doc} size={11} color={T.business} />} accent={T.business}>
        <div style={{ color: T.danger, fontSize: 11.5 }}>{t('paper.reportsFailed')}</div>
      </Section>
    );
  }
  if (!reports || reports.length === 0) return null;
  return (
    <Section title={`${t('paper.reports')} · ${reports.length}`} icon={<Icon d={Icons.doc} size={11} color={T.business} />} accent={T.business}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {reports.map((r) => (
          <div
            key={r.file}
            className="sch-card"
            style={{
              display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5,
              border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 9,
              padding: '7px 10px', background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.04))',
            }}
          >
            {r.mode === 'paper' || r.mode === 'quick' || r.mode === 'compare' ? (
              <span
                data-dsh-part="report-mode"
                style={{
                  flex: 'none', fontSize: 10, fontWeight: 600, padding: '1px 7px', borderRadius: 999,
                  color: r.mode === 'paper' ? T.business : r.mode === 'quick' ? 'var(--dsw-alias-state-success-primary, #34a853)' : '#a885e8',
                  border: `1px solid ${r.mode === 'paper'
                    ? 'color-mix(in srgb, var(--dsh-alias-label-business, #4d6bfe) 45%, transparent)'
                    : r.mode === 'quick'
                      ? 'color-mix(in srgb, var(--dsw-alias-state-success-primary, #34a853) 45%, transparent)'
                      : 'rgba(168,133,232,.45)'}`,
                }}
              >{t(r.mode === 'paper' ? 'deepread.paperLabel' : r.mode === 'quick' ? 'deepread.quickLabel' : 'deepread.compareLabel')}</span>
            ) : (
              <Icon d={Icons.doc} size={13} color={T.business} />
            )}
            <button
              type="button"
              data-dsh-plugin="dsh-scholar"
              data-dsh-part="report-preview"
              className="sch-press"
              onClick={() => setPreview(r.file)}
              style={{
                display: 'inline-flex', alignItems: 'baseline', gap: 6, color: 'var(--dsw-alias-label-primary)',
                background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, minWidth: 0, flex: 1,
              }}
              title={t('paper.reportPreview')}
            >
              <span style={{ fontWeight: 550 }}>{new Date(r.savedAt).toLocaleDateString()}</span>
              <span style={{ color: T.caption, fontSize: 10.5 }}>{new Date(r.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              <span style={{ color: T.caption, fontSize: 10 }}>({Math.round(r.size / 1024)} KB)</span>
            </button>
            <IconButton
              label={t('paper.reportToCards')}
              onClick={() => void cardsFromReport(r.file)}
              icon={<Icon d={Icons.plus} size={11} />}
            />
            <a
              href={`/scholar/papers/${encodeURIComponent(paperId)}/reports/${encodeURIComponent(r.file)}`}
              target="_blank"
              rel="noreferrer noopener"
              title={t('paper.reportOpen')}
              style={{ display: 'inline-flex', color: T.caption, padding: '2px 0' }}
            >
              <Icon d={Icons.external} size={11} />
            </a>
            <IconButton
              label={t('paper.reportDelete')}
              color={T.danger}
              onClick={() => {
                if (!window.confirm(t('paper.reportDeleteConfirm'))) return;
                void (async () => {
                  try {
                    await api(`/scholar/papers/${encodeURIComponent(paperId)}/reports/${encodeURIComponent(r.file)}`, { method: 'DELETE' });
                    notify?.(t('paper.reportDeleted'));
                    refresh();
                  } catch (e) {
                    notify?.(e instanceof Error ? e.message : String(e));
                  }
                })();
              }}
              icon={<Icon d={Icons.trash} size={11} />}
            />
          </div>
        ))}
      </div>
      {preview && (
        <Modal title={t('paper.reportPreview')} onClose={() => setPreview(null)} width={720}>
          <iframe
            src={`/scholar/papers/${encodeURIComponent(paperId)}/reports/${encodeURIComponent(preview)}`}
            title={preview}
            style={{ width: '100%', height: '62vh', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, background: '#fff' }}
          />
        </Modal>
      )}
    </Section>
  );
}

/** 详情页"相关论文"区块：OpenAlex 相似/被引/引用，已在库标注 + 一键入库 */
function PaperRelated({ paperId, t, onAdded, notify }: {
  paperId: string;
  t: TFunc;
  /** 入库成功后刷新父级列表 */
  onAdded: () => void;
  notify: (text: string) => void;
}) {
  const [data, setData] = useState<RelatedReportLite | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<'similar' | 'citations' | 'references'>('citations');
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<Map<string, string>>(new Map()); // openalexId → libraryPaperId

  useEffect(() => {
    let alive = true;
    setData(null);
    setFailed(false);
    api<RelatedReportLite>(`/scholar/papers/${encodeURIComponent(paperId)}/related`)
      .then((r) => {
        if (!alive) return;
        setData(r);
        // 相似有结果时默认展示相似，否则被引
        setTab(r.similar?.length ? 'similar' : 'citations');
      })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [paperId]);

  if (failed) return null; // 网络不可达时整块隐藏，不打扰阅读
  if (!data) {
    return (
      <Section title={t('paper.related')} icon={<Icon d={Icons.graph} size={11} color={T.business} />} accent={T.business}>
        <div style={{ color: T.caption, fontSize: 11 }}>{t('paper.relatedLoading')}</div>
      </Section>
    );
  }

  const tabs = ([
    { key: 'similar', list: data.similar ?? [] },
    { key: 'citations', list: data.citations ?? [] },
    { key: 'references', list: data.references ?? [] },
  ] as { key: 'similar' | 'citations' | 'references'; list: RelatedWorkLite[] }[]).filter((x) => x.list.length > 0);
  const list = tabs.find((x) => x.key === tab)?.list ?? [];

  const addToLibrary = async (w: RelatedWorkLite) => {
    if (saving.has(w.openalexId)) return;
    setSaving((cur) => new Set(cur).add(w.openalexId));
    try {
      const res = await api<{ created: boolean; duplicate: boolean; paper: Paper }>('/scholar/papers', {
        method: 'POST',
        body: JSON.stringify({
          title: w.title, authors: w.authors, year: w.year, venue: w.venue,
          doi: w.doi ?? '', arxivId: w.arxivId ?? '', tags: [], notes: '', summary: '', abstract: '',
          url: '', importance: 3, readStatus: 'want',
        }),
      });
      setAdded((cur) => new Map(cur).set(w.openalexId, res.paper.id));
      notify(t('paper.addedToast', { title: w.title.slice(0, 30) }));
      onAdded();
    } catch (e) {
      notify(`${t('paper.addToLib')} ✗: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving((cur) => { const n = new Set(cur); n.delete(w.openalexId); return n; });
    }
  };

  return (
    <Section
      title={t('paper.related')}
      sub={t('paper.relatedSub')}
      icon={<Icon d={Icons.graph} size={11} color={T.business} />}
      accent={T.business}
    >
      {tabs.length === 0 ? (
        <div style={{ color: T.caption, fontSize: 11.5 }}>{data.note || t('paper.relatedEmpty')}</div>
      ) : (
        <div data-dsh-plugin="dsh-scholar" data-dsh-part="related-papers">
          <div style={{ display: 'flex', gap: 5, marginBottom: 7 }}>
            {tabs.map((x) => (
              <Chip
                key={x.key}
                label={`${{ similar: t('paper.relatedSimilar'), citations: t('paper.relatedCitations'), references: t('paper.relatedRefs') }[x.key]} ${x.list.length}`}
                active={tab === x.key}
                onClick={() => setTab(x.key)}
              />
            ))}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {list.map((w) => {
              const libId = w.libraryPaperId ?? added.get(w.openalexId);
              const inLib = !!libId;
              return (
                <div
                  key={w.openalexId}
                  data-dsh-part="related-item"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 9,
                    padding: '7px 9px', background: T.cardBg,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 11.5, fontWeight: 600, lineHeight: 1.4,
                      display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                    }}>{w.title}</div>
                    <div style={{ fontSize: 10, color: T.caption, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {w.year ?? '—'}{w.venue ? ` · ${truncate(w.venue, 22)}` : ''} · {t('paper.relatedCited', { count: w.citedBy })}
                    </div>
                  </div>
                  {inLib ? (
                    <span
                      data-dsh-part="related-inlib"
                      title={t('paper.inLibrary')}
                      onClick={() => libId && navBus.go('papers', libId)}
                      style={{
                        flex: 'none', fontSize: 10, color: T.success, cursor: 'pointer',
                        padding: '2px 8px', borderRadius: 999,
                        background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary, #30a46c) 12%, transparent)',
                        border: '1px solid color-mix(in srgb, var(--dsw-alias-state-success-primary, #30a46c) 30%, transparent)',
                      }}
                    >{t('paper.inLibrary')} ✓</span>
                  ) : (
                    <button
                      type="button"
                      data-dsh-part="related-add"
                      disabled={saving.has(w.openalexId)}
                      onClick={() => void addToLibrary(w)}
                      style={{
                        flex: 'none', fontSize: 10.5, cursor: 'pointer', padding: '2px 9px', borderRadius: 999,
                        color: T.business, background: 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 12%, transparent)',
                        border: '1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 35%, transparent)',
                      }}
                    >{saving.has(w.openalexId) ? '…' : `＋ ${t('paper.addToLib')}`}</button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Section>
  );
}

export function PaperLibraryView({ t }: { t: TFunc }) {
  const [papers, setPapers] = useState<Paper[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [cols, setCols] = useState<PaperCollection[]>([]);
  const [colModal, setColModal] = useState(false);
  const [loading, setLoading] = useState(true);
  /** list-fetch failures only — cleared by the next successful load */
  const [loadError, setLoadError] = useState('');
  /** per-action failures (open/edit/delete/jump) — NOT cleared by background loads */
  const [actionError, setActionError] = useState('');
  /** E03:关联卡片独立加载错误(与主详情错误分离) */
  const [cardsError, setCardsError] = useState('');
  /** 非致命降级(collections/config 加载失败)的提示条 */
  const [degraded, setDegraded] = useState('');
  const shownError = actionError || loadError;
  const [selected, setSelected] = useState<Paper | null>(null);
  /* 详情页弹层状态：PDF 全文 / 摘要折叠 / 精读面板（声明必须在 selected 之后） */
  const [pdfOpen, setPdfOpen] = useState(false);
  const [citeFmt, setCiteFmt] = useState<CitationFmt>('gb');
  const [absOpen, setAbsOpen] = useState(false);
  const [launchOpen, setLaunchOpen] = useState(false);
  const [related, setRelated] = useState<IdeaCard[]>([]);
  const [form, setForm] = useState<{ mode: 'new' | 'edit'; paper: Paper } | null>(null);
  /** 表单脏数据保护:任一字段改过即置位,关闭前 confirm */
  const [formDirty, setFormDirty] = useState(false);
  const [defaultTags, setDefaultTags] = useState<string[]>([]);
  /** PDF 上传中:入口禁用 + 显示"上传中…" */
  const [uploadingPdf, setUploadingPdf] = useState(false);
  /** 全量（未筛选）论文：分区计数 + BibTeX 全库导出用 */
  const [allPapers, setAllPapers] = useState<Paper[]>([]);
  /** 左侧分区栏开关 */
  const [railOpen, setRailOpen] = useState(true);
  /** 保存的筛选（命名查询） */
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>(() => {
    try { return JSON.parse(localStorage.getItem(SAVED_SEARCHES_KEY) ?? '[]') as SavedSearch[]; } catch { return []; }
  });
  /** 绿色成功提示（BibTeX 复制等），2.5s 自动消失 */
  const [notice, setNotice] = useState('');
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(''), 2500);
  }, []);
  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);

  /** 浏览足迹：最近在看（localStorage 持久，去重上限 15） */
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const pushRecent = useCallback((id: string) => {
    setRecent((cur) => {
      const next = [id, ...cur.filter((x) => x !== id)].slice(0, 15);
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* 存储异常降级为会话内 */ }
      return next;
    });
  }, []);

  // 恢复上次的筛选/排序(同 tab 会话级持久)
  const [saved] = useState(() => loadSavedFilters<{
    q: string; tag: string; yearFrom: string; yearTo: string; importance: string; col: string; sort: string; readStatus: string;
  }>(FILTERS_KEY));
  const [q, setQ] = useState(saved.q ?? '');
  const [tag, setTag] = useState(saved.tag ?? '');
  const [yearFrom, setYearFrom] = useState(saved.yearFrom ?? '');
  const [yearTo, setYearTo] = useState(saved.yearTo ?? '');
  const [importance, setImportance] = useState(saved.importance ?? '');
  const [readStatus, setReadStatus] = useState<ReadStatus | ''>(saved.readStatus ? (saved.readStatus as ReadStatus) : '');
  const [col, setCol] = useState(saved.col ?? '');
  const [unfiled, setUnfiled] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sort, setSort] = useState(saved.sort ?? 'createdAt');

  const debouncedQ = useDebounced(q, 250);

  const loadCols = useCallback(async () => {
    try {
      const r = await api<{ collections: PaperCollection[] }>('/scholar/collections');
      setCols(r.collections);
      // if the active filter targets a collection that no longer exists
      // (deleted in this or another view), fall back to "all" instead of
      // silently filtering against a ghost id
      setCol((cur) => (cur && !r.collections.some((c) => c.id === cur) ? '' : cur));
      setDegraded('');
    } catch (e) {
      // collections 加载失败不再静默:控制台留痕 + UI 提示条
      console.warn('dsh-scholar: collections load failed', e);
      setDegraded(t('common.partialLoadFailed'));
    }
  }, [t]);

  const load = useCallback(async () => {
    const seq = ++loadSeq;
    setLoading(true);
    try {
      const data = await api<{ papers: Paper[]; tags: string[] }>(
        `/scholar/papers${qs({ q: debouncedQ, tag, yearFrom, yearTo, importance, collection: col || undefined, unfiled: unfiled ? 1 : undefined, readStatus: readStatus || undefined, sort })}`,
      );
      if (seq !== loadSeq) return; // 已有更新的请求,丢弃过期响应
      setPapers(data.papers);
      setTags(data.tags);
      setLoadError('');
    } catch (e) {
      if (seq !== loadSeq) return;
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === loadSeq) setLoading(false);
    }
  }, [debouncedQ, tag, yearFrom, yearTo, importance, readStatus, col, unfiled, sort]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadCols(); }, [loadCols]);

  /** 全量论文（分区计数 / BibTeX 导出）；失败静默降级——计数缺失不阻塞浏览 */
  const loadAll = useCallback(async () => {
    try {
      const r = await api<{ papers: Paper[] }>('/scholar/papers?sort=year');
      setAllPapers(r.papers);
    } catch (e) {
      console.warn('dsh-scholar: full papers load failed', e);
    }
  }, []);
  useEffect(() => { void loadAll(); }, [loadAll]);

  // 筛选/排序变化即落盘(会话级)
  useEffect(() => {
    saveFilters(FILTERS_KEY, { q, tag, yearFrom, yearTo, importance, readStatus, col, sort });
  }, [q, tag, yearFrom, yearTo, importance, readStatus, col, sort]);

  // load default tags for the create form; config 晚到也会经 PaperForm 内的
  // effect 补上,不在打开表单的瞬间固化空数组
  useEffect(() => {
    void api<{ config: { defaultTags?: string[] } }>('/scholar/config')
      .then((r) => setDefaultTags(r.config.defaultTags ?? []))
      .catch((e) => {
        console.warn('dsh-scholar: config load failed', e);
        setDegraded(t('common.partialLoadFailed'));
      });
  }, [t]);

  // cross-view jump: open a specific paper (from graph / cards)
  const nav = useNav();
  useEffect(() => {
    if (nav.paperId) {
      void openPaper(nav.paperId);
      navBus.consumePaperId();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav.paperId]);

  const detailSeq = useRef(0);
  const detailTarget = useRef<string | null>(null);
  const cardsSeq = useRef(0);
  const leavePaper = () => { ++detailSeq.current; ++cardsSeq.current; detailTarget.current = null; setSelected(null); };
  useEffect(() => () => { ++detailSeq.current; ++cardsSeq.current; detailTarget.current = null; }, []);
  const loadCards = useCallback(async (id: string) => {
    const token = ++cardsSeq.current;
    try {
      const cards = await api<{ cards: IdeaCard[] }>(`/scholar/cards${qs({ paperId: id })}`);
      if (token !== cardsSeq.current || detailTarget.current !== id) return;
      setRelated(cards.cards ?? []); setCardsError('');
    } catch {
      if (token === cardsSeq.current && detailTarget.current === id) setCardsError(t('paper.cardsLoadFailed'));
    }
  }, [t]);
  const openPaper = useCallback(async (id: string, refresh = false) => {
    const token = ++detailSeq.current;
    const same = detailTarget.current === id;
    if (refresh && !same) return;
    detailTarget.current = id;
    if (!same) { setSelected(null); setRelated([]); setCardsError(''); }
    try {
      const detail = await api<{ paper: Paper }>(`/scholar/papers/${encodeURIComponent(id)}`);
      if (detailSeq.current !== token || detailTarget.current !== id) return;
      setSelected(detail.paper); setActionError(''); pushRecent(id);
    } catch (e) {
      if (detailSeq.current !== token) return;
      setActionError(e instanceof Error ? e.message : String(e));
      return;
    }
    await loadCards(id);
  }, [pushRecent, loadCards]);

  // 切换论文时重置详情弹层（必须在 selected/各 state 声明之后）
  useEffect(() => { setPdfOpen(false); setAbsOpen(false); setLaunchOpen(false); }, [selected?.id]);

  // 后台精读完成 → 刷新列表/全量缓存/打开中的详情（summary 已回填、报告已归档）
  useEffect(() => {
    const h = () => {
      void load();
      void loadAll();
      if (selected) void openPaper(selected.id, true);
    };
    window.addEventListener('scholar:read-done', h);
    return () => window.removeEventListener('scholar:read-done', h);
  }, [load, loadAll, openPaper, selected]);

  const savePaper = async (paper: Paper, isNew: boolean) => {
    const body = {
      title: paper.title,
      authors: paper.authors,
      year: paper.year,
      venue: paper.venue,
      arxivId: paper.arxivId,
      doi: paper.doi,
      url: paper.url,
      abstract: paper.abstract,
      summary: paper.summary,
      tags: paper.tags,
      importance: paper.importance,
      readStatus: paper.readStatus,
      notes: paper.notes,
      collectionIds: paper.collectionIds ?? [],
    };
    try {
      if (isNew) {
        const res = await api<{ created: boolean; duplicate?: boolean; paper: Paper }>('/scholar/papers', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        if (res.duplicate) setActionError(`${t('paper.duplicateHint')}: ${res.paper.title}`);
      } else {
        const res = await api<{ paper: Paper }>(`/scholar/papers/${encodeURIComponent(paper.id)}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        });
        setSelected(cur => cur?.id === paper.id ? res.paper : cur);
      }
      setForm(null);
      setFormDirty(false);
      await Promise.all([load(), loadAll()]);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  const removePaper = async (id: string) => {
    if (!window.confirm(t('common.confirmDelete'))) return;
    try {
      await api(`/scholar/papers/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (detailTarget.current === id) leavePaper();
      await Promise.all([load(), loadAll()]);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  const quickPatch = (paper: Paper, patch: Partial<Pick<Paper, 'importance' | 'readStatus'>>) =>
    queueMutation('paper:' + paper.id, async () => {
      try {
        const res = await api<{ paper: Paper }>(`/scholar/papers/${encodeURIComponent(paper.id)}`, { method: 'PUT', body: JSON.stringify(patch) });
        // A response may contain other fields from an earlier server snapshot.
        const fields = Object.fromEntries(Object.keys(patch).map(key => [key, res.paper[key as keyof Paper]]));
        const update = (p: Paper) => p.id === paper.id ? { ...p, ...fields } : p;
        setPapers(cur => cur.map(update)); setAllPapers(cur => cur.map(update));
        setSelected(cur => cur ? update(cur) : cur);
      } catch (e) { setActionError(e instanceof Error ? e.message : String(e)); }
    });
  const quickImportance = (paper: Paper, importance: number) => quickPatch(paper, { importance });
  const quickReadStatus = (paper: Paper, readStatus: ReadStatus) => quickPatch(paper, { readStatus });

  /** 复制单篇 BibTeX 到剪贴板 */
  const copyBibtex = async (paper: Paper) => {
    try {
      await navigator.clipboard.writeText(paperToBibtex(paper));
      showNotice(t('paper.bibtexCopied'));
    } catch {
      setActionError(t('paper.bibtexCopyFail'));
    }
  };

  /** 全库导出 .bib（用全量列表，不受当前筛选影响） */
  const exportBibtex = () => {
    if (allPapers.length === 0) { setActionError(t('paper.bibtexEmpty')); return; }
    downloadTextFile('scholar-library.bib', libraryToBibtex(allPapers) + '\n', 'application/x-bibtex;charset=utf-8');
  };

  /* ---------- saved searches（命名筛选，Zotero smart collections 式） ---------- */
  const persistSavedSearches = (list: SavedSearch[]) => {
    setSavedSearches(list);
    try { localStorage.setItem(SAVED_SEARCHES_KEY, JSON.stringify(list)); } catch { /* 存满等异常降级为会话内 */ }
  };

  const saveCurrentSearch = () => {
    const name = window.prompt(t('paper.saveSearchPrompt'));
    if (!name || !name.trim()) return;
    persistSavedSearches([...savedSearches, {
      id: `ss_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name: name.trim(),
      f: { q, tag, yearFrom, yearTo, importance, readStatus, col, unfiled },
    }]);
  };

  const applySavedSearch = (ss: SavedSearch) => {
    setQ(ss.f.q); setTag(ss.f.tag); setYearFrom(ss.f.yearFrom); setYearTo(ss.f.yearTo);
    setImportance(ss.f.importance); setReadStatus(ss.f.readStatus as ReadStatus | ''); setCol(ss.f.col);
    setUnfiled(ss.f.unfiled === true); // 旧数据无此字段 → false
  };

  const removeSavedSearch = (id: string) => {
    persistSavedSearches(savedSearches.filter((s) => s.id !== id));
  };

  /** Upload / replace the PDF attached to a saved paper. */
  const uploadPdf = async (paper: Paper, file: File | null | undefined) => {
    if (!file || uploadingPdf) return;
    if (file.size > 50 * 1024 * 1024) { setActionError(t('paper.pdfSizeLimit')); return; }
    setUploadingPdf(true);
    try {
      await api(`/scholar/papers/${encodeURIComponent(paper.id)}/pdf`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
      });
      const fresh = await api<{ paper: Paper }>(`/scholar/papers/${encodeURIComponent(paper.id)}`);
      // 上传期间用户可能已返回列表——仅当仍停留在同一篇详情时才更新,
      // 避免"复活"已退出的详情页
      setSelected((cur) => (cur && cur.id === paper.id ? fresh.paper : cur));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploadingPdf(false);
    }
  };

  /** 关闭表单前若有未保存修改,先 confirm */
  const closeForm = () => {
    if (formDirty && !window.confirm(t('common.confirmDiscard'))) return;
    setForm(null);
    setFormDirty(false);
  };

  /** 年份分组（sort=year 时）：年份降序 + 粘性组头；无年份的沉底。
   *  注意必须位于所有条件 return 之前（Hooks 规则）——详情/表单视图同样会执行此 hook。 */
  const yearGroups = useMemo(() => {
    if (sort !== 'year') return null;
    const withYear = new Map<number, Paper[]>();
    const noYear: Paper[] = [];
    for (const p of papers) {
      if (p.year) {
        if (!withYear.has(p.year)) withYear.set(p.year, []);
        withYear.get(p.year)!.push(p);
      } else noYear.push(p);
    }
    const groups = [...withYear.entries()].sort((a, b) => b[0] - a[0]).map(([y, list]) => ({ y: String(y), list }));
    if (noYear.length) groups.push({ y: '', list: noYear });
    return groups;
  }, [papers, sort]);

  /** 键盘导航用的平铺顺序（分组视图=组序拼接）；同样必须在条件 return 之前 */
  const flatPapers = useMemo(() => (yearGroups ? yearGroups.flatMap((g) => g.list) : papers), [yearGroups, papers]);
  const flatIdxOf = useMemo(() => new Map(flatPapers.map((p, i) => [p.id, i])), [flatPapers]);
  /** 键盘选中下标（null=未启用）；仅列表视图生效 */
  const [cursorIdx, setCursorIdx] = useState<number | null>(null);

  // 列表变化后游标越界即复位（筛选/搜索导致）
  useEffect(() => {
    if (cursorIdx !== null && cursorIdx >= flatPapers.length) setCursorIdx(null);
  }, [flatPapers.length, cursorIdx]);

  // 键盘导航：列表视图 ↑↓ 移动、Enter 打开、Esc 清除；详情视图 Esc 返回
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement | null)?.isContentEditable) return;
      if (e.key === 'Escape') {
        if (selected || detailTarget.current) leavePaper();
        else setCursorIdx(null);
        return;
      }
      if (form || selected) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setCursorIdx((cur) => {
          const n = flatPapers.length;
          if (!n) return null;
          if (cur === null) return 0;
          return Math.max(0, Math.min(n - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)));
        });
      } else if (e.key === 'Enter') {
        if (cursorIdx !== null && flatPapers[cursorIdx]) {
          // 焦点若停在某个按钮上（如刚点过的卡片），Enter 还会触发按钮原生激活
          // → 两篇论文竞态打开；preventDefault 抑制原生点击，只走键盘游标
          e.preventDefault();
          void openPaper(flatPapers[cursorIdx].id);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [form, selected, flatPapers, cursorIdx, openPaper]);

  // 游标移动后滚动到可见（nearest 避免列表跳动）
  useEffect(() => {
    if (cursorIdx === null) return;
    const el = document.querySelectorAll('[data-dsh-part="paper-card"]')[cursorIdx];
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursorIdx]);

  /** 侧栏底部统计（全量口径）：年份分布 / 阅读状态 / top 标签 */
  const railStats = useMemo(() => {
    const byYear = new Map<number, number>();
    const rs: Record<'want' | 'reading' | 'done', number> = { want: 0, reading: 0, done: 0 };
    const tagCount = new Map<string, number>();
    for (const p of allPapers) {
      if (p.year) byYear.set(p.year, (byYear.get(p.year) ?? 0) + 1);
      // 手改磁盘等途径可能写入非法枚举——按 want 兜底，避免 NaN 计数
      const rsKey = (READ_STATUSES as readonly string[]).includes(p.readStatus ?? 'want') ? (p.readStatus ?? 'want') : 'want';
      rs[rsKey as 'want' | 'reading' | 'done']++;
      for (const tg of p.tags) tagCount.set(tg, (tagCount.get(tg) ?? 0) + 1);
    }
    const years = [...byYear.entries()].sort((a, b) => b[0] - a[0]).slice(0, 4);
    const topTags = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    return { years, maxYear: Math.max(1, ...years.map(([, n]) => n)), rs, topTags };
  }, [allPapers]);

  /* ---------- form (new / edit) ---------- */
  if (form) {
    return (
      <div className="sch-scroll sch-fade" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '10px 12px', fontSize: 12 }}>
        <SchStyles />
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
          <Btn onClick={closeForm}><Icon d={Icons.back} size={12} /> {t('common.back')}</Btn>
          <span style={{ fontWeight: 600, marginLeft: 10 }}>
            {form.mode === 'new' ? t('paper.new') : t('paper.edit')}
          </span>
        </div>
        <PaperForm
          initial={form.paper}
          defaultTags={form.mode === 'new' ? defaultTags : []}
          collections={cols}
          onSave={(p) => void savePaper(p, form.mode === 'new')}
          onCancel={closeForm}
          onTouch={() => setFormDirty(true)}
          t={t}
        />
        {shownError && <div style={{ color: T.danger, marginTop: 6 }}>{shownError}</div>}
      </div>
    );
  }

  /* ---------- detail ---------- */
  if (selected) {
    return (
      <div className="sch-scroll sch-fade" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '10px 12px 14px', fontSize: 12 }} key={selected.id}>
        <SchStyles />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
          <Btn onClick={leavePaper}><Icon d={Icons.back} size={12} /> {t('common.back')}</Btn>
          <span style={{ flex: 1 }} />
          {rightbarAvailable() && (
            <IconButton label={t('rightbar.open')} onClick={() => openPaperInRightbar(selected.id)} icon={<Icon d={Icons.sidebarRight} size={14} />} />
          )}
          <IconButton label={t('common.edit')} onClick={() => { ++detailSeq.current; ++cardsSeq.current; setForm({ mode: 'edit', paper: { ...selected } }); }} icon={<Icon d={Icons.edit} size={14} />} />
          <IconButton label={t('common.delete')} color={T.danger} onClick={() => void removePaper(selected.id)} icon={<Icon d={Icons.trash} size={14} />} />
          <Chip label={selected.source === 'agent' ? t('paper.sourceAgent') : t('paper.sourceManual')} />
        </div>

        {/* Hero 头区：标题 15.5px / 作者 ≤6+et al. / venue+CCF / 年份 / arXiv·DOI 等宽可点 / 标签 / 状态+星级 */}
        <div style={{ fontWeight: 700, fontSize: 15.5, lineHeight: 1.5, letterSpacing: '.005em' }}>{selected.title}</div>
        {selected.authors.length > 0 && (
          <div style={{ marginTop: 5, fontSize: 11, color: T.secondary, lineHeight: 1.55 }}>
            {selected.authors.length > 6
              ? selected.authors.slice(0, 6).join(', ') + ' et al.'
              : selected.authors.join(', ')}
          </div>
        )}
        <div style={{ marginTop: 7, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {(() => {
            const name = (selected.venue ?? '').trim();
            const tier = venueTier(selected.venue);
            if (!name && !selected.arxivId) return null;
            return (
              <span style={{
                fontSize: 10, fontWeight: 500, padding: '1px 7px', borderRadius: 6,
                color: T.secondary, background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.07))',
                border: '1px solid var(--dsw-alias-border-l2)',
                display: 'inline-flex', alignItems: 'center', gap: 5,
              }}>
                {name || (selected.arxivId ? 'arXiv' : '')}
                {tier && <span style={{ fontWeight: 700, color: 'var(--dsw-alias-label-primary)' }}>{tier}</span>}
              </span>
            );
          })()}
          {selected.year ? <span style={{ fontSize: 10.5, color: T.caption }}>{String(selected.year)}</span> : null}
          {selected.arxivId && (
            <a
              href={/^https?:/i.test(selected.arxivId) ? selected.arxivId : `https://arxiv.org/abs/${encodeURIComponent(selected.arxivId)}`}
              target="_blank" rel="noreferrer noopener"
              style={{ fontFamily: MONO, fontSize: 10.5, color: T.business }}
            >arXiv:{selected.arxivId}</a>
          )}
          {selected.doi && (
            <a
              href={/^https?:/i.test(selected.doi) ? selected.doi : `https://doi.org/${encodeURIComponent(selected.doi)}`}
              target="_blank" rel="noreferrer noopener"
              style={{ fontFamily: MONO, fontSize: 10.5, color: T.business, wordBreak: 'break-all' }}
            >DOI:{selected.doi}</a>
          )}
        </div>
        <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
          {selected.tags.map((tg) => <Chip key={tg} label={tg} />)}
        </div>
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Stars value={selected.importance ?? 0} onChange={(v) => void quickImportance(selected, v)} />
          <span style={{ flex: 1 }} />
          {(() => {
            /* 阅读状态分段控件：想读 → 在读 → 读过 */
            return (
              <div style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                <span style={{ fontSize: 10.5, color: T.caption, marginRight: 2 }}>{t('paper.readStatus')}</span>
                {READ_STATUSES.map((rs) => {
                  const active = (selected.readStatus ?? 'want') === rs;
                  const color = readStatusColor(rs);
                  return (
                    <button
                      key={rs}
                      type="button"
                      data-dsh-plugin="dsh-scholar"
                      data-dsh-part="read-status-btn"
                      onClick={() => { if (!active) void quickReadStatus(selected, rs); }}
                      style={{
                        fontSize: 11, padding: '2px 10px', borderRadius: 999, cursor: active ? 'default' : 'pointer',
                        border: `1px solid ${active ? `color-mix(in srgb, ${color} 55%, transparent)` : 'var(--dsw-alias-border-l2)'}`,
                        background: active ? `color-mix(in srgb, ${color} 16%, transparent)` : 'transparent',
                        color: active ? color : T.secondary,
                        fontWeight: active ? 600 : 400,
                      }}
                    >{t(READ_STATUS_LABELS[rs])}</button>
                  );
                })}
              </div>
            );
          })()}
        </div>

        {/* 主操作栏三级：精读（实底主钮）/ 论文全文 / 引用 */}
        <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 7 }}>
          <Btn
            tone="primary"
            data-dsh-part="detail-primary-read"
            onClick={() => setLaunchOpen(true)}
          ><Icon d={Icons.book} size={11} /> {t('paper.deepread')}</Btn>
          <Btn tone="soft" onClick={() => setPdfOpen(true)}>
            <Icon d={Icons.doc} size={11} /> {t('paper.fulltext')}
          </Btn>
          <Btn tone="soft" onClick={() => {
            // 引用区是内联展示：按钮滚动定位到引用条目（Section 是 div 不是 section，别用 closest('section')）
            document.querySelector('[data-dsh-part="citation-text"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }}>
            <Icon d={Icons.copy} size={11} /> {t('paper.cite')}
          </Btn>
          <span style={{ flex: 1 }} />
          <Btn tone="soft" onClick={() => void copyBibtex(selected)}>
            <Icon d={Icons.doc} size={11} /> {t('paper.bibtexCopy')}
          </Btn>
        </div>

        {selected.summary && (
          <Section title={t('paper.summary')} icon={<Icon d={Icons.sparkle} size={11} color={T.business} />} accent={T.business} style={{ marginTop: 10 }}>
            <div style={{ lineHeight: 1.65 }}>{selected.summary}</div>
          </Section>
        )}

        {/* 引用格式：GB/T 7714 / APA 7 / BibTeX，等宽条目点选全选 */}
        <Section title={t('paper.citation')} icon={<Icon d={Icons.copy} size={11} color={T.business} />} accent={T.business}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 7, flexWrap: 'wrap' }}>
            {CITATION_FORMATS.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setCiteFmt(f)}
                style={{
                  fontSize: 11, padding: '2px 10px', borderRadius: 7, cursor: 'pointer',
                  border: `1px solid ${citeFmt === f ? 'var(--dsw-alias-state-business-primary, #4d6bfe)' : 'var(--dsw-alias-border-l2)'}`,
                  color: citeFmt === f ? 'var(--dsw-alias-state-business-primary, #4d6bfe)' : T.secondary,
                  fontWeight: citeFmt === f ? 600 : 400,
                  background: 'transparent',
                }}
              >{CIT_LABEL[f]}</button>
            ))}
            <span style={{ flex: 1 }} />
            <Btn tone="soft" onClick={() => {
              void navigator.clipboard.writeText(citationText(selected, citeFmt))
                .then(() => showNotice(t('paper.citationCopied')))
                .catch(() => setActionError(t('paper.bibtexCopyFail')));
            }}><Icon d={Icons.copy} size={11} /> {t('paper.copyCitation')}</Btn>
          </div>
          <div
            data-dsh-part="citation-text"
            style={{
              fontFamily: MONO, fontSize: 11, lineHeight: 1.65, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))',
              border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: '8px 10px',
              userSelect: 'all', color: T.secondary,
            }}
          >{citationText(selected, citeFmt)}</div>
        </Section>

        {/* 摘要：3 行折叠 + 展开（带字数） */}
        {selected.abstract && (
          <Section title={t('paper.abstract')}>
            <div
              style={{
                lineHeight: 1.65, color: T.secondary,
                display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: absOpen ? 'unset' : 3,
                overflow: 'hidden',
              }}
            >{selected.abstract}</div>
            {selected.abstract.length > 160 && (
              <button
                type="button"
                data-dsh-part="abstract-toggle"
                onClick={() => setAbsOpen((v) => !v)}
                style={{ all: 'unset', cursor: 'pointer', fontSize: 10.5, color: T.business, marginTop: 4 }}
              >{t(absOpen ? 'paper.abstractCollapse' : 'paper.abstractExpand', { count: String(selected.abstract.length) })}</button>
            )}
          </Section>
        )}

        {/* Meta 瘦身：书目信息已在 Hero，这里只留分区/URL/PDF */}
        <Section style={{ marginTop: 2 }}>
          <Meta
            k={t('col.name')}
            v={(selected.collectionIds ?? []).length > 0 ? (
              <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                {(selected.collectionIds ?? []).map((cid) => {
                  const c = cols.find((x) => x.id === cid);
                  return c ? <Chip key={cid} label={c.name} color={c.color} /> : null;
                })}
              </span>
            ) : t('col.none')
            }
          />
          <Meta
            k="URL" v={selected.url ? (
              // 非http(s)协议降级为纯文本,不可点击
              isHttpUrl(selected.url) ? (
                <a href={selected.url} target="_blank" rel="noreferrer noopener" style={{ color: T.business, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }}>{truncate(urlLabel(selected.url), 46)}</span>
                  <Icon d={Icons.external} size={11} />
                </a>
              ) : (
                <span style={{ wordBreak: 'break-all' }}>{selected.url}</span>
              )
            ) : undefined}
          />
          <Meta
            k={t('paper.pdf')}
            v={
              selected.pdfPath ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <a href={`/scholar/papers/${encodeURIComponent(selected.id)}/pdf`} target="_blank" rel="noreferrer" style={{ color: T.business, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    {t('paper.pdfOpen')} <Icon d={Icons.external} size={11} />
                  </a>
                  <label style={{ cursor: uploadingPdf ? 'default' : 'pointer', color: T.caption, fontSize: 11, textDecorationLine: 'underline', opacity: uploadingPdf ? 0.55 : 1 }}>
                    {uploadingPdf ? t('paper.pdfUploading') : t('paper.pdfReplace')}
                    <input type="file" accept="application/pdf,.pdf" hidden disabled={uploadingPdf} onChange={(e) => { void uploadPdf(selected, e.target.files?.[0]); e.target.value = ''; }} />
                  </label>
                </span>
              ) : (
                <label style={{ cursor: uploadingPdf ? 'default' : 'pointer', color: T.business, fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 4, opacity: uploadingPdf ? 0.55 : 1 }}>
                  <Icon d={Icons.doc} size={11} /> {uploadingPdf ? t('paper.pdfUploading') : t('paper.pdfUpload')}
                  <input type="file" accept="application/pdf,.pdf" hidden disabled={uploadingPdf} onChange={(e) => { void uploadPdf(selected, e.target.files?.[0]); e.target.value = ''; }} />
                </label>
              )
            }
          />
        </Section>
        {has(selected.notes) && (
          <Section title={t('paper.notes')}>
            <div style={{ lineHeight: 1.6, color: T.secondary, whiteSpace: 'pre-wrap' }}>{selected.notes}</div>
          </Section>
        )}
        <PaperReports paperId={selected.id} t={t} notify={showNotice} />

        {/* 交互式追问：基于精读章节块，带页码出处 */}
        <PaperAsk key={selected.id} paperId={selected.id} t={t} />

        <PaperRelated
          paperId={selected.id}
          t={t}
          notify={showNotice}
          onAdded={() => { void load(); void loadAll(); }}
        />

        <div style={{ marginTop: 12, borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 7 }}>
            <span style={{ fontSize: 11, fontWeight: 600 }}>{t('paper.relatedCards')}</span>
            <span style={{ flex: 1 }} />
            <Btn onClick={() => navBus.go('cards', undefined, undefined, selected.id)}>
              <Icon d={Icons.plus} size={11} /> {t('paper.addCard')}
            </Btn>
          </div>
          {cardsError && (
            <div style={{ color: 'var(--dsw-alias-state-danger-primary)', fontSize: 11, lineHeight: 1.6, display: 'flex', gap: 8, alignItems: 'center' }}>
              <span>{cardsError}</span>
              <Btn onClick={() => { if (selected) void loadCards(selected.id); }}>
                <Icon d={Icons.refresh} size={10} /> {t('paper.retry')}
              </Btn>
            </div>
          )}
          {related.length === 0 && !cardsError && <div style={{ color: T.caption, fontSize: 11, lineHeight: 1.6 }}>{t('paper.noRelatedCards')}</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {related.map((c) => (
              <button
                key={c.id}
                type="button"
                data-dsh-plugin="dsh-scholar"
                data-dsh-part="idea-card-ref"
                className="sch-card sch-press"
                onClick={() => navBus.go('cards', undefined, c.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                  border: '1px solid var(--dsw-alias-border-l2)', background: T.cardBg, borderRadius: 9,
                  padding: '8px 10px', cursor: 'pointer', color: 'var(--dsw-alias-label-primary)',
                }}
              >
                <span aria-hidden style={{ width: 3, alignSelf: 'stretch', borderRadius: 2, background: T.caption, opacity: .5 }} />
                <span style={{ flex: 1, overflow: 'hidden' }}>
                  <span style={{ display: 'block', fontSize: 11.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</span>
                  <span style={{ display: 'block', fontSize: 10.5, color: T.secondary, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.insight}</span>
                </span>
                <Stars value={c.importance} size={9} />
              </button>
            ))}
          </div>
        </div>

        {/* PDF 全文弹窗：浏览器原生 iframe 渲染 + 新窗/下载；无 PDF=虚线上传区 */}
        {pdfOpen && (
          <Modal title={t('paper.fulltitleModal')} onClose={() => setPdfOpen(false)} width={720}>
            {selected.pdfPath ? (
              <>
                <iframe
                  src={`/scholar/papers/${encodeURIComponent(selected.id)}/pdf`}
                  title={selected.title}
                  style={{ width: '100%', height: '68vh', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, background: '#fff' }}
                />
                <div style={{ display: 'flex', gap: 7, marginTop: 8 }}>
                  <a
                    href={`/scholar/papers/${encodeURIComponent(selected.id)}/pdf`}
                    target="_blank" rel="noreferrer"
                    style={{ fontSize: 11.5, color: T.business, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  ><Icon d={Icons.external} size={11} /> {t('paper.fulltextWin')}</a>
                  <a
                    href={`/scholar/papers/${encodeURIComponent(selected.id)}/pdf`}
                    download={`${selected.id}.pdf`}
                    style={{ fontSize: 11.5, color: T.business, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  ><Icon d={Icons.doc} size={11} /> {t('paper.download')}</a>
                </div>
              </>
            ) : (
              <div style={{ padding: 18, textAlign: 'center' }}>
                <div style={{ fontSize: 11.5, color: T.caption, marginBottom: 10 }}>{t('paper.noPdfHint')}</div>
                <label
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6, cursor: uploadingPdf ? 'default' : 'pointer',
                    border: '1.5px dashed var(--dsw-alias-border-l2)', borderRadius: 10,
                    padding: '16px 26px', color: T.business, fontSize: 11.5, opacity: uploadingPdf ? 0.55 : 1,
                  }}
                >
                  <Icon d={Icons.doc} size={13} /> {uploadingPdf ? t('paper.pdfUploading') : t('paper.pdfUploadDrop')}
                  <input type="file" accept="application/pdf,.pdf" hidden disabled={uploadingPdf} onChange={(e) => { void uploadPdf(selected, e.target.files?.[0]); e.target.value = ''; }} />
                </label>
              </div>
            )}
          </Modal>
        )}

        {/* 精读启动面板（单/多篇、模式、透镜、上下文、focus） */}
        <DeepreadLauncher
          open={launchOpen}
          current={selected}
          allPapers={allPapers}
          onClose={() => setLaunchOpen(false)}
          notify={showNotice}
          t={t}
        />
      </div>
    );
  }

  const filtersActive = !!(tag || importance || yearFrom || yearTo || readStatus || unfiled);

  /** 单张论文卡（venue 徽章 + 阅读状态胶囊 + 分区色条） */
  const renderCard = (p: Paper, schI = 0) => {
    const accentBar = (p.collectionIds ?? [])
      .map((cid) => cols.find((c) => c.id === cid)?.color)
      .find(Boolean);
    const vb = venueBadge(p);
    const rs = p.readStatus ?? 'want';
    const rsColor = readStatusColor(rs);
    const isCursor = cursorIdx !== null && flatIdxOf.get(p.id) === cursorIdx;
    return (
      <button
        key={p.id}
        type="button"
        data-dsh-plugin="dsh-scholar"
        data-dsh-part="paper-card"
        className="sch-card sch-press"
        onClick={() => { setActionError(''); void openPaper(p.id); }}
        style={{
          display: 'block', width: '100%', textAlign: 'left',
          border: '1px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.05))',
          borderRadius: 12, padding: '12px 13px 11px', marginBottom: 10, cursor: 'pointer',
          color: 'var(--dsw-alias-label-primary)',
          boxShadow: accentBar ? `inset 3px 0 0 ${accentBar}` : undefined,
          outline: isCursor ? '2px solid var(--dsw-alias-state-business-primary, #4d6bfe)' : undefined,
          outlineOffset: -2,
          ['--sch-i' as string]: Math.min(schI, 20),
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
          <span style={{
            flex: 1, fontWeight: 600, fontSize: 13.2, lineHeight: 1.42, letterSpacing: '.003em',
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }}>{p.title}</span>
          <span style={{
            flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 9.5,
            padding: '1px 7px', borderRadius: 999, color: rsColor,
            background: `color-mix(in srgb, ${rsColor} 12%, transparent)`,
            border: `1px solid color-mix(in srgb, ${rsColor} 28%, transparent)`,
          }} title={t('paper.readStatus')}>
            <span aria-hidden style={{ width: 5, height: 5, borderRadius: 999, background: rsColor }} />
            {t(READ_STATUS_LABELS[rs])}
          </span>
          <Stars value={p.importance ?? 0} size={10} />
        </div>
        {(p.authors.length > 0 || p.year || vb) && (
          <div style={{ fontSize: 11, color: T.secondary, marginTop: 5, display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {p.authors.slice(0, 3).join(', ')}{p.authors.length > 3 ? ' et al.' : ''}
              {p.year && <span style={{ color: T.caption, fontVariantNumeric: 'tabular-nums' }}> · {p.year}</span>}
              {p.source === 'agent' && <Icon d={Icons.sparkle} size={9} color={T.business} />}
            </span>
            {vb && (
              <span style={{
                flex: 'none', fontSize: 9.5, fontWeight: 600, padding: '1px 7px', borderRadius: 6,
                color: vb.color,
                background: `color-mix(in srgb, ${vb.color} 13%, transparent)`,
                border: `1px solid color-mix(in srgb, ${vb.color} 32%, transparent)`,
              }}>{vb.label}</span>
            )}
          </div>
        )}
        {p.summary && (
          <div style={{ fontSize: 11.5, color: T.secondary, marginTop: 6, lineHeight: 1.55, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {p.summary}
          </div>
        )}
        {p.tags.length > 0 && (
          <div style={{ display: 'flex', gap: 4, marginTop: 7, flexWrap: 'wrap' }}>
            {p.tags.slice(0, 5).map((tg) => <Chip key={tg} label={tg} />)}
          </div>
        )}
      </button>
    );
  };

  /* ---------- list ---------- */
  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <SchStyles />
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'row' }}>
        {/* collection rail（Zotero 式分区导航 + 保存的筛选） */}
        {railOpen && (
          <div
            data-dsh-plugin="dsh-scholar"
            data-dsh-part="collection-rail"
            className="sch-scroll"
            style={{ width: 148, minHeight: 0, boxSizing: 'border-box', flex: 'none', borderRight: '1px solid var(--dsw-alias-border-l2)', padding: '8px 6px 10px', overflowY: 'auto' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', padding: '0 4px 5px' }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.05em', color: T.caption }}>{t('col.manage')}</span>
              <span style={{ flex: 1 }} />
              <IconButton label={t('col.new')} size={18} onClick={() => setColModal(true)} icon={<Icon d={Icons.plus} size={10} />} />
            </div>
            <RailItem label={t('paper.allPapers')} count={allPapers.length} active={col === '' && !unfiled} onClick={() => { setCol(''); setUnfiled(false); }} />
            <RailItem
              label={t('paper.unfiled')}
              count={allPapers.filter((p) => (p.collectionIds ?? []).length === 0).length}
              active={unfiled}
              dim
              onClick={() => { setCol(''); setUnfiled(!unfiled); }}
            />
            {cols.map((c) => (
              <RailItem
                key={c.id}
                label={c.name}
                color={c.color}
                count={allPapers.filter((p) => (p.collectionIds ?? []).includes(c.id)).length}
                active={col === c.id}
                onClick={() => { setUnfiled(false); setCol(col === c.id ? '' : c.id); }}
              />
            ))}

            <div style={{ display: 'flex', alignItems: 'center', padding: '12px 4px 5px' }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.05em', color: T.caption }}>{t('paper.savedSearches')}</span>
            </div>
            {savedSearches.map((ss) => (
              <div key={ss.id} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <button
                  type="button"
                  data-dsh-plugin="dsh-scholar"
                  data-dsh-part="saved-search"
                  onClick={() => applySavedSearch(ss)}
                  style={{
                    flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, textAlign: 'left',
                    padding: '5px 7px', borderRadius: 8, marginBottom: 1, cursor: 'pointer',
                    background: 'transparent', border: 'none', color: 'var(--dsw-alias-label-primary)', fontSize: 11.5,
                  }}
                >
                  <Icon d={Icons.search} size={10} color={T.caption} />
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ss.name}</span>
                </button>
                <button
                  type="button"
                  title={t('common.delete')}
                  onClick={() => removeSavedSearch(ss.id)}
                  style={{ flex: 'none', background: 'none', border: 'none', cursor: 'pointer', color: T.caption, padding: 2, display: 'inline-flex' }}
                >
                  <Icon d={Icons.close} size={9} />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={saveCurrentSearch}
              disabled={!(q || filtersActive || col)}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 6, marginTop: 3,
                padding: '5px 7px', borderRadius: 8, fontSize: 11, cursor: q || filtersActive || col ? 'pointer' : 'default',
                background: 'transparent', border: '1px dashed var(--dsw-alias-border-l2)',
                color: q || filtersActive || col ? T.business : T.caption,
              }}
            >
              <Icon d={Icons.plus} size={10} /> {t('paper.saveSearch')}
            </button>

            {/* 最近在看（浏览足迹，点击直达详情） */}
            {recent.length > 0 && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', padding: '12px 4px 5px' }}>
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.05em', color: T.caption }}>{t('paper.recent')}</span>
                </div>
                {recent.slice(0, 4).map((rid) => {
                  const rp = allPapers.find((p) => p.id === rid);
                  if (!rp) return null;
                  return (
                    <button
                      key={rid}
                      type="button"
                      data-dsh-plugin="dsh-scholar"
                      data-dsh-part="recent-item"
                      onClick={() => { setActionError(''); void openPaper(rid); }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
                        padding: '4px 7px', borderRadius: 8, marginBottom: 1, cursor: 'pointer',
                        background: 'transparent', border: 'none', color: T.secondary, fontSize: 11,
                      }}
                      title={rp.title}
                    >
                      <Icon d={Icons.doc} size={9} color={T.caption} />
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{rp.title}</span>
                    </button>
                  );
                })}
              </>
            )}

            {/* 库统计（全量口径） */}
            <div style={{ display: 'flex', alignItems: 'center', padding: '12px 4px 5px' }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.05em', color: T.caption }}>{t('paper.stats')}</span>
            </div>
            <div data-dsh-plugin="dsh-scholar" data-dsh-part="rail-stats" style={{ padding: '2px 4px 0', fontSize: 10, color: T.caption }}>
              <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 6 }}>
                {READ_STATUSES.map((rs2) => (
                  <span key={rs2} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    <span aria-hidden style={{ width: 5, height: 5, borderRadius: 999, background: readStatusColor(rs2) }} />
                    {t(READ_STATUS_LABELS[rs2])} {railStats.rs[rs2]}
                  </span>
                ))}
              </div>
              {railStats.years.map(([y, n]) => (
                <div key={y} style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3 }}>
                  <span style={{ width: 28, flex: 'none', fontVariantNumeric: 'tabular-nums' }}>{y}</span>
                  <span aria-hidden style={{
                    flex: 'none', height: 6, borderRadius: 3,
                    width: `${Math.round((n / railStats.maxYear) * 84)}px`,
                    background: 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 55%, transparent)',
                  }} />
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>{n}</span>
                </div>
              ))}
              {railStats.topTags.length > 0 && (
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 5 }}>
                  {railStats.topTags.map(([tg, n]) => (
                    <button
                      key={tg}
                      type="button"
                      title={`#${tg} · ${n}`}
                      onClick={() => setTag(tg === tag ? '' : tg)}
                      style={{
                        fontSize: 9.5, padding: '1px 7px', borderRadius: 999, cursor: 'pointer',
                        color: tg === tag ? T.business : T.caption,
                        background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12))',
                        border: 'none',
                      }}
                    >#{tg} {n}</button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Keep the list constrained to the panel so papers scroll independently of the collection rail. */}
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {/* toolbar */}
          <div style={{ padding: '8px 10px 6px', display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <IconButton
              label={t('paper.rail')}
              active={railOpen}
              onClick={() => setRailOpen(!railOpen)}
              icon={<Icon d={Icons.rail} size={13} />}
            />
            <SearchInput value={q} onChange={setQ} placeholder={t('paper.searchPh')} />
            <IconButton
              label={t('paper.filters')}
              active={filtersOpen || filtersActive}
              onClick={() => setFiltersOpen(!filtersOpen)}
              icon={<Icon d={Icons.filter} size={13} />}
            />
            <Select value={sort} onChange={(e) => setSort(e.target.value)} title={t('paper.sort')} style={{ flex: 'none' }}>
              <option value="createdAt">{t('paper.sortCreated')}</option>
              <option value="year">{t('paper.sortYear')}</option>
              <option value="title">{t('paper.sortTitle')}</option>
            </Select>
            <IconButton
              label={t('paper.bibtexExport')}
              onClick={exportBibtex}
              icon={<Icon d={Icons.download} size={13} />}
            />
            <Btn tone="primary" onClick={() => { leavePaper(); setFormDirty(false); setForm({ mode: 'new', paper: emptyPaper() }); }}>
              <Icon d={Icons.plus} size={12} /> {t('paper.add')}
            </Btn>
          </div>

          {(filtersOpen || filtersActive) && (
            <div className="sch-fade" style={{ padding: '0 10px 6px', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <Select value={tag} onChange={(e) => setTag(e.target.value)} title={t('paper.tagAll')} style={{ minWidth: 96 }}>
                <option value="">{t('paper.tagAll')}</option>
                {tags.map((tg) => <option key={tg} value={tg}>{tg}</option>)}
              </Select>
              <Select value={importance} onChange={(e) => setImportance(e.target.value)} title={t('paper.importanceAll')} style={{ minWidth: 92 }}>
                <option value="">{t('paper.importanceAll')}</option>
                {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{'★'.repeat(n)}</option>)}
              </Select>
              <Select value={readStatus} onChange={(e) => setReadStatus(e.target.value as ReadStatus | '')} title={t('paper.readStatusAll')} style={{ minWidth: 86 }}>
                <option value="">{t('paper.readStatusAll')}</option>
                {READ_STATUSES.map((rs) => <option key={rs} value={rs}>{t(READ_STATUS_LABELS[rs])}</option>)}
              </Select>
              <Input type="number" min={1900} max={2100} placeholder={t('paper.yearFrom')} value={yearFrom} onChange={(e) => setYearFrom(e.target.value)} style={{ width: 70 }} />
              <span style={{ color: T.caption }}>–</span>
              <Input type="number" min={1900} max={2100} placeholder={t('paper.yearTo')} value={yearTo} onChange={(e) => setYearTo(e.target.value)} style={{ width: 70 }} />
            </div>
          )}

          {filtersActive && (
            <div style={{ padding: '0 10px 7px', display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
              {tag && <FilterChip label={`#${tag}`} onRemove={() => setTag('')} />}
              {importance && <FilterChip label={`★ ≥ ${importance}`} onRemove={() => setImportance('')} />}
              {readStatus && <FilterChip label={t(READ_STATUS_LABELS[readStatus])} onRemove={() => setReadStatus('')} />}
              {unfiled && <FilterChip label={t('paper.unfiled')} onRemove={() => setUnfiled(false)} />}
              {(yearFrom || yearTo) && <FilterChip label={`${yearFrom || '…'} – ${yearTo || '…'}`} onRemove={() => { setYearFrom(''); setYearTo(''); }} />}
            </div>
          )}

          {shownError && <div style={{ color: T.danger, padding: '2px 12px 6px', fontSize: 11 }}>{shownError}</div>}
          {notice && !shownError && <div style={{ color: T.success, padding: '2px 12px 6px', fontSize: 11 }}>{notice}</div>}
          {degraded && !shownError && !notice && (
            <div style={{ color: T.warning, padding: '2px 12px 6px', fontSize: 11 }}>{degraded}</div>
          )}

          <div className="sch-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 10px 12px' }}>
            {!loading && papers.length === 0 && !shownError && (
              // 分区/筛选下 0 结果 = "没搜到"，不是"库是空的"——避免误导性的大空态
              q || filtersActive || col ? (
                <EmptyState icon={<Icon d={Icons.search} size={34} />} title={t('common.empty')} />
              ) : (
                <EmptyState
                  icon={<Icon d={Icons.book} size={38} />}
                  title={t('common.empty')}
                  hint={t('paper.aiHint')}
                  action={<Btn tone="primary" onClick={() => { leavePaper(); setFormDirty(false); setForm({ mode: 'new', paper: emptyPaper() }); }}><Icon d={Icons.plus} size={12} /> {t('paper.add')}</Btn>}
                />
              )
            )}
            {loading && papers.length === 0 && (
              <div aria-hidden>
                {[70, 62, 56].map((h, i) => <div key={i} className="sch-skeleton" style={{ height: h }} />)}
              </div>
            )}
            <div key={`${debouncedQ}|${sort}|${tag}|${yearFrom}|${yearTo}|${importance}|${readStatus}`} className="sch-fade sch-list">
              {yearGroups ? (
                /* 年份分组视图：粘性组头 + 组内卡片 */
                yearGroups.map((g) => (
                  <div key={g.y || '__none__'} data-dsh-plugin="dsh-scholar" data-dsh-part="year-group">
                    <div style={{
                      position: 'sticky', top: 0, zIndex: 2,
                      display: 'flex', alignItems: 'baseline', gap: 7, padding: '8px 2px 5px',
                      background: 'var(--dsw-alias-bg-base, #161616)',
                      borderBottom: '1px solid var(--dsw-alias-border-l2)',
                    }}>
                      <span style={{ fontWeight: 700, fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>{g.y || t('paper.yearUnknown')}</span>
                      <span style={{ fontSize: 10, color: T.caption }}>{t('paper.groupCount', { count: g.list.length })}</span>
                    </div>
                    {g.list.map((p, i) => renderCard(p, i))}
                  </div>
                ))
              ) : (
                papers.map((p, i) => renderCard(p, i))
              )}
            </div>
          </div>
        </div>
      </div>

      {/* collection manage modal */}
      {colModal && (
        <CollectionsModal
          t={t}
          onClose={() => setColModal(false)}
          onChanged={() => { void loadCols(); void load(); void loadAll(); }}
        />
      )}
    </div>
  );
}

/** 侧栏单行（分区/全部）：色点 + 名称 + 计数，选中态底色 */
function RailItem({ label, count, color, active, dim, onClick }: {
  label: string;
  count: number;
  color?: string;
  active?: boolean;
  /** 次要行（未分区）弱化 */
  dim?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-dsh-plugin="dsh-scholar"
      data-dsh-part="rail-item"
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
        padding: '5px 7px', borderRadius: 8, marginBottom: 1,
        background: active ? 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.14))' : 'transparent',
        border: 'none', cursor: 'pointer',
        color: dim ? T.secondary : 'var(--dsw-alias-label-primary)',
        fontSize: 11.5, fontWeight: active ? 600 : 400,
      }}
    >
      {color && <span aria-hidden style={{ width: 7, height: 7, borderRadius: 999, background: color, flex: 'none' }} />}
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <span style={{ fontSize: 10, color: T.caption, flex: 'none', fontVariantNumeric: 'tabular-nums' }}>{count}</span>
    </button>
  );
}

/* ---------- collections manager (create / rename / recolor / delete) ---------- */
function CollectionsModal({ t, onClose, onChanged }: {
  t: TFunc;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [cols, setCols] = useState<PaperCollection[]>([]);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState<string>(COL_COLORS[0]);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');

  const refresh = useCallback(async () => {
    try {
      const r = await api<{ collections: PaperCollection[] }>('/scholar/collections');
      setCols(r.collections);
    } catch (e) {
      // 保留旧列表,但不再无声——留痕 + 弹窗内提示,与"空列表"可区分
      console.warn('dsh-scholar: collections refresh failed', e);
      setErr(t('common.partialLoadFailed'));
    }
  }, [t]);

  useEffect(() => { void refresh(); }, [refresh]);

  const create = async () => {
    if (!newName.trim()) return;
    try {
      const res = await api<{ created: boolean }>("/scholar/collections", { method: "POST", body: JSON.stringify({ name: newName, color: newColor }) });
      setNewName("");
      setErr("");
      setNote(res.created ? "" : t("col.merged"));
      await refresh();
      onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  const saveEdit = async (id: string, patch: { name?: string; color?: string }) => {
    try {
      await api(`/scholar/collections/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) });
      setEditing(null);
      setErr('');
      await refresh();
      onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  const remove = async (id: string, name: string) => {
    if (!window.confirm(`${t('common.confirmDelete')}\n${name}\n${t('col.deleteHint')}`)) return;
    try {
      await api(`/scholar/collections/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setErr('');
      await refresh();
      onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <Modal title={t('col.manage')} onClose={onClose} width={440}>
      <div className="sch-fade">
        {/* create row */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 12 }}>
          <Input
            value={newName}
            placeholder={t('col.addPh')}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void create(); }}
          />
          <span style={{ display: 'inline-flex', gap: 3, flex: 'none' }}>
            {COL_COLORS.map((c) => (
              <button key={c} type="button" aria-label="color" onClick={() => setNewColor(c)} style={{
                width: 16, height: 16, borderRadius: 999, background: c,
                border: newColor === c ? '2px solid var(--dsw-alias-label-primary)' : 'none',
                cursor: 'pointer', padding: 0,
              }} />
            ))}
          </span>
          <Btn tone="primary" onClick={() => void create()} disabled={!newName.trim()}>
            <Icon d={Icons.plus} size={11} /> {t('col.new')}
          </Btn>
        </div>

        {err && <div style={{ color: T.danger, fontSize: 11, marginBottom: 8 }}>{err}</div>}
        {note && <div style={{ color: T.success, fontSize: 11, marginBottom: 8 }}>✓ {note}</div>}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {cols.length === 0 && (
            <div style={{ color: T.caption, fontSize: 11.5 }}>{t('common.empty')}</div>
          )}
          {cols.map((c) => (
            editing?.id === c.id ? (
              <div key={c.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <Input value={editing.name} autoFocus onChange={(e) => setEditing({ ...editing, name: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') void saveEdit(c.id, { name: editing.name }); }} />
                <Btn tone="primary" onClick={() => void saveEdit(c.id, { name: editing.name })}>{t('common.save')}</Btn>
                <Btn onClick={() => setEditing(null)}>{t('common.cancel')}</Btn>
              </div>
            ) : (
              <div key={c.id} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 9, padding: '6px 8px',
                background: T.cardBg,
              }}>
                <span aria-hidden style={{ width: 10, height: 10, borderRadius: 999, flex: 'none', background: c.color ?? 'var(--dsw-alias-label-caption)' }} />
                <span style={{ flex: 1, fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                <span style={{ display: 'inline-flex', gap: 2, flex: 'none' }}>
                  {COL_COLORS.map((color) => (
                    <button key={color} type="button" aria-label="recolor" onClick={() => void saveEdit(c.id, { color })} style={{
                      width: 12, height: 12, borderRadius: 999, cursor: 'pointer', padding: 0,
                      background: color, opacity: c.color === color ? 1 : 0.45,
                      border: c.color === color ? '1.5px solid var(--dsw-alias-label-primary)' : 'none',
                    }} />
                  ))}
                </span>
                <IconButton label={t('common.edit')} size={22} onClick={() => setEditing({ id: c.id, name: c.name })} icon={<Icon d={Icons.edit} size={13} />} />
                <IconButton label={t('common.delete')} size={22} color={T.danger} onClick={() => void remove(c.id, c.name)} icon={<Icon d={Icons.trash} size={13} />} />
              </div>
            )
          ))}
        </div>
      </div>
    </Modal>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setV(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return v;
}

function emptyPaper(): Paper {
  return {
    id: '', title: '', authors: [], tags: [], source: 'manual', readStatus: 'want',
    createdAt: Date.now(), updatedAt: Date.now(),
  };
}

function urlLabel(u: string): string {
  try { return new URL(u).host + (new URL(u).pathname !== '/' ? new URL(u).pathname : ''); } catch { return u; }
}

/* ---------- paper form ---------- */
function PaperForm({ initial, defaultTags, collections, onSave, onCancel, onTouch, t }: {
  initial: Paper;
  defaultTags: string[];
  collections: PaperCollection[];
  onSave: (p: Paper) => void;
  onCancel: () => void;
  /** 任一字段首次修改时回调(父组件的脏数据保护) */
  onTouch: () => void;
  t: TFunc;
}) {
  const [p, setP] = useState<Paper>({
    ...initial,
    tags: initial.tags.length > 0 ? initial.tags : defaultTags,
  });
  const [invalid, setInvalid] = useState('');
  const [src, setSrc] = useState('');
  const [fetching, setFetching] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [touched, setTouched] = useState(false);
  /** defaultTags 是否已应用(或无需应用)——避免 config 晚到时覆盖用户输入 */
  const appliedDefaults = useRef(initial.tags.length > 0);

  // defaultTags 竞态:config 在表单打开后才返回时,只要用户还没动过表单,
  // 就补应用一次;不在挂载时固化空数组
  useEffect(() => {
    if (appliedDefaults.current || touched || defaultTags.length === 0) return;
    appliedDefaults.current = true;
    setP((cur) => (cur.tags.length > 0 ? cur : { ...cur, tags: defaultTags }));
  }, [defaultTags, touched]);

  /** mark the draft dirty (parent guards accidental close) */
  const touch = () => {
    if (!touched) setTouched(true);
    onTouch();
  };

  /** toggle collection membership on the draft */
  const toggleCol = (id: string) => {
    touch();
    setP((cur) => {
      const curIds = cur.collectionIds ?? [];
      const next = curIds.includes(id) ? curIds.filter((x) => x !== id) : [...curIds, id];
      return { ...cur, collectionIds: next };
    });
  };

  const set = (patch: Partial<Paper>) => {
    touch();
    setP((cur) => ({ ...cur, ...patch }));
  };

  const splitList = (s: string): string[] => s.split(/[,，]/).map((x) => x.trim()).filter(Boolean);

  /** Pull metadata from an arXiv id/URL or DOI and merge it into the draft. */
  const grabMeta = async () => {
    if (!src.trim() || fetching) return;
    setFetching(true);
    setNote(null);
    try {
      const r = await api<{
        meta?: Partial<{
          title: string; authors: string[]; year?: number; venue?: string;
          arxivId?: string; doi?: string; url?: string; abstract?: string;
        }>;
        error?: string;
      }>(`/scholar/fetch?input=${encodeURIComponent(src.trim())}`);
      const m = r?.meta;
      if (!m || !m.title) throw new Error(r?.error ?? t('paper.fetchNoMeta'));
      touch(); // 自动填充的内容也是会丢失的草稿,同样计入脏数据
      setP((cur) => ({
        ...cur,
        title: m.title || cur.title,
        authors: m.authors?.length ? m.authors : cur.authors,
        year: m.year ?? cur.year,
        venue: m.venue ?? cur.venue,
        arxivId: m.arxivId ?? cur.arxivId,
        doi: m.doi ?? cur.doi,
        url: m.url ?? cur.url,
        abstract: m.abstract ?? cur.abstract,
      }));
      setNote({ ok: true, text: t('paper.fetchOk') });
      setSrc('');
    } catch (e) {
      setNote({ ok: false, text: `${t('paper.fetchFail')}: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setFetching(false);
    }
  };

  const save = () => {
    if (!p.title.trim()) { setInvalid(t('paper.form.title')); return; }
    onSave({ ...p, tags: splitList(p.tags.join(',')), authors: splitList(p.authors.join(',')) });
  };

  return (
    <div style={{ maxWidth: 520 }}>
      {/* source auto-fill row */}
      <Field label={t('paper.fetch')}>
        <div style={{ display: 'flex', gap: 6 }}>
          <Input
            value={src}
            placeholder={t('paper.fetchPh')}
            onChange={(e) => { setSrc(e.target.value); setNote(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') void grabMeta(); }}
          />
          <Btn tone="soft" disabled={fetching} onClick={() => void grabMeta()} style={{ flex: 'none' }}>
            <Icon d={fetching ? Icons.refresh : Icons.sparkle} size={12} className={fetching ? 'sch-spin' : undefined} />
            {fetching ? t('paper.fetching') : t('paper.fetch')}
          </Btn>
        </div>
        {note && (
          <div style={{ fontSize: 10.5, marginTop: 4, color: note.ok ? T.success : T.danger }}>{note.text}</div>
        )}
      </Field>

      <Field label={t('paper.form.title')}>
        <Input value={p.title} placeholder={t('paper.form.titlePh')} onChange={(e) => set({ title: e.target.value })} />
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 86px', gap: 8 }}>
        <Field label={t('paper.form.authors')}>
          <Input value={p.authors.join(', ')} onChange={(e) => set({ authors: splitList(e.target.value) })} />
        </Field>
        <Field label={t('paper.form.year')}>
          <Input type="number" min={1900} max={2100} value={p.year ?? ''} onChange={(e) => set({ year: e.target.value ? Number(e.target.value) : undefined })} />
        </Field>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px', gap: 8 }}>
        <Field label={t('paper.form.venue')}>
          <Input value={p.venue ?? ''} onChange={(e) => set({ venue: e.target.value })} />
        </Field>
        <Field label={t('paper.form.arxivId')}>
          <Input value={p.arxivId ?? ''} onChange={(e) => set({ arxivId: e.target.value })} />
        </Field>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Field label={t('paper.form.doi')}>
          <Input value={p.doi ?? ''} onChange={(e) => set({ doi: e.target.value })} />
        </Field>
        <Field label={t('paper.form.url')}>
          <Input value={p.url ?? ''} onChange={(e) => set({ url: e.target.value })} />
        </Field>
      </div>

      <Field label={t('paper.form.summary')}>
        <Textarea rows={2} value={p.summary ?? ''} onChange={(e) => set({ summary: e.target.value })} style={{ minHeight: 48 }} />
      </Field>

      <Field label={t('paper.form.abstract')}>
        <Textarea rows={3} value={p.abstract ?? ''} onChange={(e) => set({ abstract: e.target.value })} style={{ minHeight: 64 }} />
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px', gap: 8 }}>
        <Field label={t('paper.form.tags')}>
          <Input value={p.tags.join(', ')} onChange={(e) => set({ tags: splitList(e.target.value) })} />
        </Field>
        <Field label={t('paper.form.importance')}>
          <Select value={p.importance ?? 3} onChange={(e) => set({ importance: Number(e.target.value) })}>
            {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{'★'.repeat(n)}{'☆'.repeat(5 - n)}</option>)}
          </Select>
        </Field>
      </div>

      <Field label={t('paper.readStatus')}>
        <div style={{ display: 'flex', gap: 6 }}>
          {READ_STATUSES.map((rs) => {
            const active = (p.readStatus ?? 'want') === rs;
            const color = readStatusColor(rs);
            return (
              <button
                key={rs}
                type="button"
                onClick={() => set({ readStatus: rs })}
                style={{
                  fontSize: 11.5, padding: '3px 12px', borderRadius: 999, cursor: 'pointer',
                  border: `1px solid ${active ? `color-mix(in srgb, ${color} 55%, transparent)` : 'var(--dsw-alias-border-l2)'}`,
                  background: active ? `color-mix(in srgb, ${color} 16%, transparent)` : 'transparent',
                  color: active ? color : T.secondary,
                  fontWeight: active ? 600 : 400,
                }}
              >{t(READ_STATUS_LABELS[rs])}</button>
            );
          })}
        </div>
      </Field>

      <Field label={t('paper.form.notes')}>
        <Textarea rows={2} value={p.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} style={{ minHeight: 40 }} />
      </Field>

      <Field label={t('col.manage')}>
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          {collections.length === 0 && <span style={{ fontSize: 11, color: T.caption }}>{t('common.empty')}</span>}
          {collections.map((c) => {
            const active = (p.collectionIds ?? []).includes(c.id);
            const chipColor = active ? (c.color ?? T.business) : undefined;
            return <Chip key={c.id} label={c.name} color={chipColor} active={active} onClick={() => toggleCol(c.id)} />;
          })}
        </div>
      </Field>

      {invalid && <div style={{ color: T.danger, fontSize: 11, marginBottom: 6 }}>{invalid}</div>}

      <div style={{ display: 'flex', gap: 8, margin: '6px 0 10px' }}>
        <Btn tone="primary" onClick={save}>{t('common.save')}</Btn>
        <Btn onClick={onCancel}>{t('common.cancel')}</Btn>
      </div>
    </div>
  );
}
