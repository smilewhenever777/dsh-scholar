import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { IdeaCard, Paper, PaperCollection } from '../shared/types';
import { api, loadSavedFilters, qs, saveFilters } from './api';
import { navBus, useNav, type TFunc } from './nav';
import { openPaperInRightbar, rightbarAvailable } from './rightbar';
import {
  Btn, Chip, EmptyState, Field, FilterChip, Icon, Icons, IconButton, Input, Meta, Modal, SchStyles,
  Section, SearchInput, Select, Stars, T, Textarea, truncate,
} from './ui';

/** preset swatches for collection colors */
const COL_COLORS = ['#4d6bfe', '#30a46c', '#f5a524', '#e5484d', '#7c5cff', '#0d9488'];

/** 筛选/排序状态按 tab 存 sessionStorage 的键 */
const FILTERS_KEY = 'dsh-scholar:papers:filters';

/** 列表请求序号:慢的旧响应回来时若已有更新的请求,直接丢弃,防止旧结果覆盖新结果 */
let loadSeq = 0;

const has = (v: string | undefined): boolean => !!v;

/** P0-4:url 字段可能存任意字符串(agent 输入),只有 http(s) 才可点击 */
function isHttpUrl(u: string): boolean {
  return /^https?:\/\//i.test(u);
}

/** 精读报告列表（deepread 产物经 paper_save_report 归档后在此展示） */
function PaperReports({ paperId, t }: { paperId: string; t: TFunc }) {
  const [reports, setReports] = useState<{ file: string; size: number; savedAt: number }[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setFailed(false);
    api<{ reports: { file: string; size: number; savedAt: number }[] }>(`/scholar/papers/${encodeURIComponent(paperId)}/reports`)
      .then((r) => { if (alive) setReports(r.reports ?? []); })
      .catch(() => {
        // 静默吞错会让人误以为"没有报告"——失败时明确显示加载失败
        if (alive) setFailed(true);
      });
    return () => { alive = false; };
  }, [paperId]);
  if (failed) {
    return (
      <Section title={t('paper.reports')} icon={<Icon d={Icons.doc} size={11} color={T.business} />} accent={T.business}>
        <div style={{ color: T.danger, fontSize: 11.5 }}>{t('paper.reportsFailed')}</div>
      </Section>
    );
  }
  if (!reports || reports.length === 0) return null;
  return (
    <Section title={t('paper.reports')} icon={<Icon d={Icons.doc} size={11} color={T.business} />} accent={T.business}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {reports.map((r) => (
          <a
            key={r.file}
            href={`/scholar/papers/${encodeURIComponent(paperId)}/reports/${encodeURIComponent(r.file)}`}
            target="_blank"
            rel="noreferrer noopener"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: T.business, textDecoration: 'none' }}
          >
            <Icon d={Icons.external} size={11} />
            <span>{new Date(r.savedAt).toLocaleString()}</span>
            <span style={{ color: T.caption }}>({Math.round(r.size / 1024)} KB)</span>
          </a>
        ))}
      </div>
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
  /** 非致命降级(collections/config 加载失败)的提示条 */
  const [degraded, setDegraded] = useState('');
  const shownError = actionError || loadError;
  const [selected, setSelected] = useState<Paper | null>(null);
  const [related, setRelated] = useState<IdeaCard[]>([]);
  const [form, setForm] = useState<{ mode: 'new' | 'edit'; paper: Paper } | null>(null);
  /** 表单脏数据保护:任一字段改过即置位,关闭前 confirm */
  const [formDirty, setFormDirty] = useState(false);
  const [defaultTags, setDefaultTags] = useState<string[]>([]);
  /** PDF 上传中:入口禁用 + 显示"上传中…" */
  const [uploadingPdf, setUploadingPdf] = useState(false);

  // 恢复上次的筛选/排序(同 tab 会话级持久)
  const [saved] = useState(() => loadSavedFilters<{
    q: string; tag: string; yearFrom: string; yearTo: string; importance: string; col: string; sort: string;
  }>(FILTERS_KEY));
  const [q, setQ] = useState(saved.q ?? '');
  const [tag, setTag] = useState(saved.tag ?? '');
  const [yearFrom, setYearFrom] = useState(saved.yearFrom ?? '');
  const [yearTo, setYearTo] = useState(saved.yearTo ?? '');
  const [importance, setImportance] = useState(saved.importance ?? '');
  const [col, setCol] = useState(saved.col ?? '');
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
        `/scholar/papers${qs({ q: debouncedQ, tag, yearFrom, yearTo, importance, collection: col || undefined, sort })}`,
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
  }, [debouncedQ, tag, yearFrom, yearTo, importance, col, sort]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadCols(); }, [loadCols]);

  // 筛选/排序变化即落盘(会话级)
  useEffect(() => {
    saveFilters(FILTERS_KEY, { q, tag, yearFrom, yearTo, importance, col, sort });
  }, [q, tag, yearFrom, yearTo, importance, col, sort]);

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

  const openPaper = useCallback(async (id: string) => {
    try {
      const detail = await api<{ paper: Paper }>(`/scholar/papers/${encodeURIComponent(id)}`);
      const cards = await api<{ cards: IdeaCard[] }>(`/scholar/cards${qs({ paperId: id })}`);
      setSelected(detail.paper);
      setRelated(cards.cards);
      setActionError('');
    } catch (e) {
      setSelected(null);
      setActionError(e instanceof Error ? e.message : String(e));
    }
  }, []);

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
        setSelected(res.paper);
      }
      setForm(null);
      setFormDirty(false);
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  const removePaper = async (id: string) => {
    if (!window.confirm(t('common.confirmDelete'))) return;
    try {
      await api(`/scholar/papers/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setSelected(null);
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  const quickImportance = async (paper: Paper, importance: number) => {
    const next = { ...paper, importance };
    try {
      const res = await api<{ paper: Paper }>(`/scholar/papers/${encodeURIComponent(paper.id)}`, {
        method: 'PUT',
        body: JSON.stringify({
          title: next.title, authors: next.authors, year: next.year, venue: next.venue,
          arxivId: next.arxivId, doi: next.doi, url: next.url, abstract: next.abstract,
          summary: next.summary, tags: next.tags, importance, notes: next.notes,
        }),
      });
      setSelected(res.paper);
    } catch (e) {
      // keep the old value, but surface why
      setActionError(e instanceof Error ? e.message : String(e));
    }
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
          <Btn onClick={() => setSelected(null)}><Icon d={Icons.back} size={12} /> {t('common.back')}</Btn>
          <span style={{ flex: 1 }} />
          {rightbarAvailable() && (
            <IconButton label={t('rightbar.open')} onClick={() => openPaperInRightbar(selected.id)} icon={<Icon d={Icons.external} size={14} />} />
          )}
          <IconButton label={t('common.edit')} onClick={() => setForm({ mode: 'edit', paper: { ...selected } })} icon={<Icon d={Icons.edit} size={14} />} />
          <IconButton label={t('common.delete')} color={T.danger} onClick={() => void removePaper(selected.id)} icon={<Icon d={Icons.trash} size={14} />} />
          <Chip label={selected.source === 'agent' ? t('paper.sourceAgent') : t('paper.sourceManual')} />
        </div>

        <div style={{ fontWeight: 700, fontSize: 14, lineHeight: 1.5, letterSpacing: '.005em' }}>{selected.title}</div>
        <div style={{ marginTop: 7, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <Stars value={selected.importance ?? 0} onChange={(v) => void quickImportance(selected, v)} />
          {selected.tags.map((tg) => <Chip key={tg} label={tg} />)}
        </div>

        <Section style={{ marginTop: 10 }}>
          <Meta k={t('paper.authors')} v={selected.authors.join(', ')} />
          <Meta k={t('paper.form.year')} v={selected.year && String(selected.year)} />
          <Meta k={t('paper.venue')} v={selected.venue} />
          <Meta k="arXiv" v={selected.arxivId} />
          <Meta k="DOI" v={selected.doi} />
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
              // P0-4:非 http(s) 协议(如 javascript:)降级为纯文本,不可点击
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
        </Section>

        {selected.summary && (
          <Section title={t('paper.summary')} icon={<Icon d={Icons.sparkle} size={11} color={T.business} />} accent={T.business}>
            <div style={{ lineHeight: 1.65 }}>{selected.summary}</div>
          </Section>
        )}
        {selected.abstract && (
          <Section title={t('paper.abstract')}>
            <div style={{ lineHeight: 1.65, color: T.secondary }}>{selected.abstract}</div>
          </Section>
        )}
        {has(selected.notes) && (
          <Section title={t('paper.notes')}>
            <div style={{ lineHeight: 1.6, color: T.secondary, whiteSpace: 'pre-wrap' }}>{selected.notes}</div>
          </Section>
        )}
        <PaperReports paperId={selected.id} t={t} />

        <div style={{ marginTop: 12, borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 7 }}>
            <span style={{ fontSize: 11, fontWeight: 600 }}>{t('paper.relatedCards')}</span>
            <span style={{ flex: 1 }} />
            <Btn onClick={() => navBus.go('cards', undefined, undefined, selected.id)}>
              <Icon d={Icons.plus} size={11} /> {t('paper.addCard')}
            </Btn>
          </div>
          {related.length === 0 && <div style={{ color: T.caption, fontSize: 11, lineHeight: 1.6 }}>{t('paper.noRelatedCards')}</div>}
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
      </div>
    );
  }

  const filtersActive = !!(tag || importance || yearFrom || yearTo);

  /* ---------- list ---------- */
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <SchStyles />
      {/* collection chips row */}
      <div className="sch-scroll" style={{
        padding: '8px 10px 0', display: 'flex', gap: 5, alignItems: 'center',
        overflowX: 'auto', overflowY: 'hidden', flexWrap: 'nowrap', flex: 'none',
      }}>
        <Chip label={t('col.all')} active={col === ''} onClick={() => setCol('')} />
        {cols.map((c) => (
          <span key={c.id} style={{ position: 'relative', display: 'inline-flex', flex: 'none' }}>
            <Chip
              label={c.name}
              color={c.color}
              active={col === c.id}
              onClick={() => setCol(col === c.id ? '' : c.id)}
            />
          </span>
        ))}
        <IconButton label={t('col.manage')} size={20} onClick={() => setColModal(true)} icon={<Icon d={Icons.plus} size={11} />} />
      </div>

      {/* toolbar */}
      <div style={{ padding: '8px 10px 6px', display: 'flex', gap: 6, alignItems: 'center' }}>
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
        <Btn tone="primary" onClick={() => { setSelected(null); setFormDirty(false); setForm({ mode: 'new', paper: emptyPaper() }); }}>
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
          <Input type="number" min={1900} max={2100} placeholder={t('paper.yearFrom')} value={yearFrom} onChange={(e) => setYearFrom(e.target.value)} style={{ width: 70 }} />
          <span style={{ color: T.caption }}>–</span>
          <Input type="number" min={1900} max={2100} placeholder={t('paper.yearTo')} value={yearTo} onChange={(e) => setYearTo(e.target.value)} style={{ width: 70 }} />
        </div>
      )}

      {filtersActive && (
        <div style={{ padding: '0 10px 7px', display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
          {tag && <FilterChip label={`${t('card.category') === '' ? '' : '#'}${tag}`} onRemove={() => setTag('')} />}
          {importance && <FilterChip label={`★ ≥ ${importance}`} onRemove={() => setImportance('')} />}
          {(yearFrom || yearTo) && <FilterChip label={`${yearFrom || '…'} – ${yearTo || '…'}`} onRemove={() => { setYearFrom(''); setYearTo(''); }} />}
        </div>
      )}

      {shownError && <div style={{ color: T.danger, padding: '2px 12px 6px', fontSize: 11 }}>{shownError}</div>}
      {degraded && !shownError && (
        <div style={{ color: T.warning, padding: '2px 12px 6px', fontSize: 11 }}>{degraded}</div>
      )}

      <div className="sch-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 10px 12px' }}>
        {!loading && papers.length === 0 && !shownError && (
          q || filtersActive ? (
            <EmptyState icon={<Icon d={Icons.search} size={34} />} title={t('common.empty')} />
          ) : (
            <EmptyState
              icon={<Icon d={Icons.book} size={38} />}
              title={t('common.empty')}
              hint={t('paper.aiHint')}
              action={<Btn tone="primary" onClick={() => { setSelected(null); setFormDirty(false); setForm({ mode: 'new', paper: emptyPaper() }); }}><Icon d={Icons.plus} size={12} /> {t('paper.add')}</Btn>}
            />
          )
        )}
        {loading && papers.length === 0 && (
          <div aria-hidden>
            {[70, 62, 56].map((h, i) => <div key={i} className="sch-skeleton" style={{ height: h }} />)}
          </div>
        )}
        <div key={`${debouncedQ}|${sort}|${tag}|${yearFrom}|${yearTo}|${importance}`} className="sch-fade sch-list">
          {papers.map((p) => {
            const accentBar = (p.collectionIds ?? [])
              .map((cid) => cols.find((c) => c.id === cid)?.color)
              .find(Boolean);
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
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                <span style={{
                  flex: 1, fontWeight: 600, fontSize: 13.2, lineHeight: 1.42, letterSpacing: '.003em',
                  display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                }}>{p.title}</span>
                <Stars value={p.importance ?? 0} size={10} />
              </div>
              {(p.authors.length > 0 || p.year || p.venue) && (
                <div style={{ fontSize: 11, color: T.secondary, marginTop: 5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.authors.slice(0, 3).join(', ')}{p.authors.length > 3 ? ' et al.' : ''}
                  {p.year && <span style={{ color: T.caption, fontVariantNumeric: 'tabular-nums' }}> · {p.year}</span>}
                  {p.venue && <span style={{ color: T.caption }}> · {p.venue}</span>}
                  {p.source === 'agent' && <Icon d={Icons.sparkle} size={9} color={T.business} />}
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
          })}
        </div>
      </div>

      {/* collection manage modal */}
      {colModal && (
        <CollectionsModal
          t={t}
          onClose={() => setColModal(false)}
          onChanged={() => { void loadCols(); void load(); }}
        />
      )}
    </div>
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
    id: '', title: '', authors: [], tags: [], source: 'manual',
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
