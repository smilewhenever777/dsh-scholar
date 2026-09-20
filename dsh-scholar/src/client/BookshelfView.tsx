import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CardCategory, CardStatus, IdeaCard, Paper } from '../shared/types';
import { api, loadSavedFilters, qs, saveFilters } from './api';
import { downloadTextFile } from './bibtex';
import { navBus, useNav, type TFunc } from './nav';
import {
  Btn, categoryColor, Chip, EmptyState, Field, FilterChip, Icon, Icons, IconButton, Input,
  Modal, SchStyles, SearchInput, Select, Stars, statusColor, T, Textarea, truncate, Z,
} from './ui';
import { CATEGORY_LABELS, STATUS_LABELS } from './locales';

const CATEGORIES: CardCategory[] = ['method', 'theory', 'dataset', 'evaluation', 'engineering', 'other'];
const STATUSES: CardStatus[] = ['pending', 'validated', 'adopted', 'dropped'];

/** 筛选/排序状态按 tab 存 sessionStorage 的键 */
const FILTERS_KEY = 'dsh-scholar:cards:filters';

/** 列表请求序号:旧响应晚归时丢弃,防止旧结果覆盖新结果 */
let cardsLoadSeq = 0;

interface CardDraft {
  id?: string;
  title: string;
  insight: string;
  paperId?: string;
  category: CardCategory;
  tags: string[];
  importance: number;
  status: CardStatus;
  notes?: string;
  relatedCardIds?: string[];
  plain?: string;
  steps?: string[];
  evidence?: string;
}

/** 身份胶囊:语义色 + 同色淡底/描边,卡片与列表共用的"一色一义"单元 */
function Pill({ color, children, title }: { color: string; children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      style={{
        flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 4,
        fontSize: 10, fontWeight: 650, letterSpacing: '.02em', color,
        background: `color-mix(in srgb, ${color} 17%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 32%, transparent)`,
        borderRadius: 999, padding: '2px 8px',
      }}
    >
      {children}
    </span>
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

export function BookshelfView({ t }: { t: TFunc }) {
  const [cards, setCards] = useState<IdeaCard[]>([]);
  /** full card list (unfiltered) — relation lookups, related-toggle, random pick */
  const [allCards, setAllCards] = useState<IdeaCard[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [papers, setPapers] = useState<Paper[]>([]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  /** 保存失败下沉到 CardForm 内部显示(与 invalid 同位),不再被 Modal 遮罩挡住 */
  const [saveError, setSaveError] = useState('');
  /** 非致命降级(loadAll 失败)的提示条 */
  const [degraded, setDegraded] = useState('');
  const [modal, setModal] = useState<{ card: IdeaCard; editing: boolean } | null>(null);
  const [creating, setCreating] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  /** paperId prefilled by "记一张卡片" on the paper detail page */
  const [prefillPaperId, setPrefillPaperId] = useState<string | null>(null);
  /** 表单脏数据保护 */
  const [creatingDirty, setCreatingDirty] = useState(false);
  const [editDirty, setEditDirty] = useState(false);
  /** 随机回顾:排除上一次的 pick,避免连抽同一张 */
  const [lastPickId, setLastPickId] = useState<string | null>(null);
  /** 内联 toast(复制反馈等),2.5s 自动消失 */
  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 恢复上次的筛选/排序(同 tab 会话级持久)
  const [saved] = useState(() => loadSavedFilters<{
    q: string; category: string; status: string; importance: string; tag: string; paperFilter: string; sort: string;
  }>(FILTERS_KEY));
  const [q, setQ] = useState(saved.q ?? '');
  const [category, setCategory] = useState(saved.category ?? '');
  const [status, setStatus] = useState(saved.status ?? '');
  const [importance, setImportance] = useState(saved.importance ?? '');
  const [tag, setTag] = useState(saved.tag ?? '');
  const [paperFilter, setPaperFilter] = useState(saved.paperFilter ?? '');
  const [sort, setSort] = useState(saved.sort ?? 'createdAt');
  const [viewMode, setViewMode] = useState<'group' | 'kanban' | 'table' | 'grid' | 'list'>('group');
  /** 表格视图的本地排序（点击表头切换；只影响 table 视图） */
  const [tableSort, setTableSort] = useState<{ key: string; dir: 1 | -1 }>({ key: 'updatedAt', dir: -1 });
  /** 看板拖拽：正在拖的卡片 id + 当前悬停目标列 */
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropCol, setDropCol] = useState<CardStatus | null>(null);
  /** 刚落位的卡片：播放 sch-dropped 弹簧脉冲后清除 */
  const [droppedId, setDroppedId] = useState<string | null>(null);

  const debouncedQ = useDebounced(q, 250);

  const showToast = useCallback((text: string) => {
    setToast(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2500);
  }, []);
  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  const load = useCallback(async () => {
    const seq = ++cardsLoadSeq;
    setLoading(true);
    try {
      const data = await api<{ cards: IdeaCard[]; tags: string[] }>(
        `/scholar/cards${qs({ q: debouncedQ, category, status, importance, tag, paperId: paperFilter || undefined, sort })}`,
      );
      if (seq !== cardsLoadSeq) return; // 已有更新的请求,丢弃过期响应
      setCards(data.cards);
      setTags(data.tags);
      setError('');
    } catch (e) {
      if (seq !== cardsLoadSeq) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === cardsLoadSeq) setLoading(false);
    }
  }, [debouncedQ, category, status, importance, tag, paperFilter, sort]);

  useEffect(() => { void load(); }, [load]);

  // 筛选/排序变化即落盘(会话级)
  useEffect(() => {
    saveFilters(FILTERS_KEY, { q, category, status, importance, tag, paperFilter, sort });
  }, [q, category, status, importance, tag, paperFilter, sort]);

  const loadAll = useCallback(async () => {
    try {
      const [c, p] = await Promise.all([
        api<{ cards: IdeaCard[] }>(`/scholar/cards${qs({ sort: 'title' })}`),
        api<{ papers: Paper[] }>(`/scholar/papers${qs({ sort: 'title' })}`),
      ]);
      setAllCards(c.cards);
      setPapers(p.papers);
      setDegraded('');
    } catch (e) {
      // 静默吞错会让关联卡片/来源论文标题莫名缺失——留痕 + 提示条
      console.warn('dsh-scholar: cards/papers lookup load failed', e);
      setDegraded(t('common.partialLoadFailed'));
    }
  }, [t]);

  useEffect(() => { void loadAll(); }, [loadAll]);

  // cross-view capture: paper detail's "记一张卡片" opens the create form prefilled
  const nav = useNav();
  useEffect(() => {
    if (nav.prefillPaperId) {
      setPrefillPaperId(nav.prefillPaperId);
      setCreating(true);
      navBus.consumePrefill();
    }
  }, [nav.prefillPaperId]);

  // cross-view jump: open a specific card
  useEffect(() => {
    if (nav.cardId) {
      void api<{ card: IdeaCard }>(`/scholar/cards/${encodeURIComponent(nav.cardId)}`)
        .then((r) => setModal({ card: r.card, editing: false }))
        .catch((e) => {
          // 跳转失败不再无声无息——留痕 + toast,用户知道点击没生效的原因
          console.warn('dsh-scholar: card detail load failed', e);
          showToast(t('common.partialLoadFailed'));
        });
      navBus.consumeCardId();
    }
  }, [nav.cardId, showToast, t]);

  /** Drop a card link whose source paper no longer exists (stale legacy data). */
  const withLivePaper = (card: IdeaCard): IdeaCard =>
    card.paperId && !papers.some((p) => p.id === card.paperId)
      ? { ...card, paperId: undefined }
      : card;

  const paperTitle = (id?: string): string => {
    if (!id) return '';
    return papers.find((p) => p.id === id)?.title ?? id;
  };

  const saveCard = async (draft: CardDraft) => {
    const body = {
      title: draft.title,
      insight: draft.insight,
      paperId: draft.paperId ?? '',
      category: draft.category,
      tags: draft.tags,
      importance: draft.importance,
      status: draft.status,
      notes: draft.notes ?? '',
      relatedCardIds: draft.relatedCardIds ?? [],
      plain: draft.plain ?? '',
      steps: draft.steps ?? [],
      evidence: draft.evidence ?? '',
    };
    try {
      if (draft.id) {
        const res = await api<{ card: IdeaCard }>(`/scholar/cards/${encodeURIComponent(draft.id)}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        });
        setModal((m) => (m ? { ...m, card: res.card, editing: false } : m));
      } else {
        const res = await api<{ card: IdeaCard; similar?: { id: string; title: string; score: number }[] }>('/scholar/cards', { method: 'POST', body: JSON.stringify(body) });
        setCreating(false);
        setPrefillPaperId(null);
        // 相似卡提醒（非阻塞）：防重复沉淀
        if (res.similar?.length) {
          showToast(t('card.similarWarn', { titles: res.similar.map((x) => truncate(x.title, 16)).join('；') }));
        }
        if (res.card) {
          const fresh = await api<{ card: IdeaCard }>(`/scholar/cards/${encodeURIComponent(res.card.id)}`).catch(() => null);
          if (fresh) setModal({ card: fresh.card, editing: false });
        }
      }
      setError('');
      setSaveError('');
      setCreatingDirty(false);
      setEditDirty(false);
      await Promise.all([load(), loadAll()]);
    } catch (e) {
      // 保存错误渲染进 CardForm 内部(与 invalid 同位),不再被 Modal 遮罩挡住
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  };

  const removeCard = async (id: string) => {
    if (!window.confirm(t('common.confirmDelete'))) return;
    try {
      await api(`/scholar/cards/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setModal(null);
      await Promise.all([load(), loadAll()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const applyStatus = async (card: IdeaCard, status: CardStatus) => {
    // adopted/dropped 是定论型流转,与删除同级——先确认
    if ((status === 'adopted' || status === 'dropped')
      && !window.confirm(t('card.confirmStatus', { status: t(STATUS_LABELS[status]) }))) return;
    try {
      await saveCard({ ...card, status });
    } catch { /* error shown by saveCard */ }
  };

  /** 关闭"新建卡片"弹窗(含脏数据确认) */
  const closeCreate = () => {
    if (creatingDirty && !window.confirm(t('common.confirmDiscard'))) return;
    setCreating(false);
    setPrefillPaperId(null);
    setCreatingDirty(false);
    setSaveError('');
  };

  /** 从编辑态退回详情(含脏数据确认) */
  const cancelEdit = () => {
    if (editDirty && !window.confirm(t('common.confirmDiscard'))) return;
    setModal((m) => (m ? { ...m, editing: false } : m));
    setEditDirty(false);
    setSaveError('');
  };

  /** 分组视图：按来源论文聚组（无来源 → 独立想法组），组按最新更新排序 */
  const groupedCards = useMemo(() => {
    const map = new Map<string, IdeaCard[]>();
    for (const c of cards) {
      const key = c.paperId || '__unfiled__';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(c);
    }
    const groups = [...map.entries()].map(([key, list]) => ({
      key,
      paper: papers.find((p) => p.id === key),
      list: [...list].sort((a, b) => b.updatedAt - a.updatedAt),
    }));
    groups.sort((a, b) => (b.list[0]?.updatedAt ?? 0) - (a.list[0]?.updatedAt ?? 0));
    return groups;
  }, [cards, papers]);

  const toggleGroup = (key: string) => {
    setCollapsedGroups((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const filtersActive = !!(category || status || importance || tag || paperFilter);
  const hasFilters = filtersOpen || filtersActive;

  /** export one card as markdown (for notes / proposals / sharing) */
  const copyMd = async (card: IdeaCard) => {
    const lines: string[] = [
      `## ${card.title}`,
      '',
      `- ${t(STATUS_LABELS[card.status])} · ${t(CATEGORY_LABELS[card.category])} · ${'★'.repeat(card.importance)}`,
    ];
    if (card.paperId) lines.push(`- ${t('paper.source')}: ${paperTitle(card.paperId)}`);
    lines.push('', card.insight);
    if (card.notes) lines.push('', `> ${card.notes.replace(/\n/g, '\n> ')}`);
    if (card.tags.length) lines.push('', card.tags.map((x) => '#' + x).join(' '));
    const md = lines.join('\n'); // 保留刻意加入的空行,不再 filter 掉
    try {
      await navigator.clipboard.writeText(md);
      showToast(t('card.copied'));
    } catch {
      showToast(`${t('card.copyMd')} ✗`);
    }
  };

  const randomReview = () => {
    let pool = (cards.length ? cards : allCards).filter((c) => c.status !== 'dropped');
    if (!pool.length) {
      showToast(t('card.randomEmpty'));
      return;
    }
    // 池里还有别的卡时排除上一次的 pick,避免连抽同一张
    if (pool.length > 1 && lastPickId) pool = pool.filter((c) => c.id !== lastPickId);
    const pick = pool[Math.floor(Math.random() * pool.length)];
    setLastPickId(pick.id);
    setModal({ card: pick, editing: false });
  };

  /* ---------- 与对话 AI 的桥（组合研究方向 / 实验计划） ---------- */

  /** 复制"把本卡 + 关联卡融合成新方向"的结构化提示——Heptabase 卡片重组的对话版 */
  const copyCombination = async (card: IdeaCard) => {
    const rels = (card.relatedCardIds ?? []).map((rid) => allCards.find((c) => c.id === rid)).filter(Boolean) as IdeaCard[];
    const fmt = (c: IdeaCard) => [
      `【${c.title}】`,
      c.plain ? `一句话：${c.plain}` : '',
      `核心：${c.insight}`,
      (c.steps ?? []).length ? `流程：${(c.steps ?? []).join(' → ')}` : '',
    ].filter(Boolean).join('\n');
    const prompt = [
      '请把以下 Idea 卡片组合成一个新的研究方向：',
      '',
      `== 主卡 ==\n${fmt(card)}`,
      ...rels.map((r, i) => `\n== 关联卡 ${i + 1} ==\n${fmt(r)}`),
      '',
      '输出要求：',
      '1. 融合后的研究想法（一句话标题 + 三句以内说明）',
      '2. 与主卡的差异点（新在哪里）',
      '3. 可行性初判（复用哪些现有组件/需要什么新数据）',
      '4. 建议先验证的一个最小实验',
    ].join('\n');
    try {
      await navigator.clipboard.writeText(prompt);
      showToast(t('card.combineCopied'));
    } catch {
      showToast(`${t('card.combine')} ✗`);
    }
  };

  /** 复制"基于本卡生成实验计划"的结构化提示——卡片终点从 adopted 延伸到实验 */
  const copyExperiment = async (card: IdeaCard) => {
    const paper = card.paperId ? papers.find((p) => p.id === card.paperId) : undefined;
    const prompt = [
      '请基于以下 Idea 卡片起草一份实验计划：',
      '',
      `## ${card.title}`,
      card.plain ? `一句话：${card.plain}` : '',
      `核心想法：${card.insight}`,
      card.evidence ? `证据：${card.evidence}` : '',
      (card.steps ?? []).length ? `已想好的流程：${(card.steps ?? []).join(' → ')}` : '',
      paper ? `来源论文：${paper.title}（${paper.year ?? ''} ${paper.venue ?? ''}）` : '',
      `分类：${t(CATEGORY_LABELS[card.category])} · 重要度 ${'★'.repeat(card.importance)}`,
      '',
      '输出要求：',
      '1. 实验目标与可检验假设（H1/H2）',
      '2. 数据集与评价指标建议（贴合用户研究领域惯例）',
      '3. 基线与对比方法选择',
      '4. 消融实验设计（逐个拆解核心组件）',
      '5. 预期结果、风险与回退方案',
      '6. 分阶段执行清单（每阶段预估 GPU 时）',
    ].filter(Boolean).join('\n');
    try {
      await navigator.clipboard.writeText(prompt);
      showToast(t('card.experimentCopied'));
    } catch {
      showToast(`${t('card.experiment')} ✗`);
    }
  };

  /** 全部卡片导出为 Markdown（按来源论文分组，含 plain/steps/evidence） */
  const exportAllMd = () => {
    if (allCards.length === 0) { showToast(t('common.empty')); return; }
    const byPaper = new Map<string, IdeaCard[]>();
    for (const c of allCards) {
      const k = c.paperId ?? '__unfiled__';
      if (!byPaper.has(k)) byPaper.set(k, []);
      byPaper.get(k)!.push(c);
    }
    const lines: string[] = ['# Idea 卡片库导出', '', `> ${allCards.length} 张 · ${new Date().toLocaleString()}`, ''];
    for (const [k, list] of byPaper) {
      const p = papers.find((x) => x.id === k);
      lines.push(`## ${p ? p.title : t('card.noPaper')}`, '');
      for (const c of list) {
        lines.push(`### ${c.title}`, '');
        lines.push(`- ${t(STATUS_LABELS[c.status])} · ${t(CATEGORY_LABELS[c.category])} · ${'★'.repeat(c.importance)}`);
        if (c.plain) lines.push(`- 💡 ${c.plain}`);
        lines.push('', c.insight);
        if (c.evidence) lines.push('', `> ❝ ${c.evidence}`);
        if ((c.steps ?? []).length) lines.push('', `**流程**：${(c.steps ?? []).join(' → ')}`);
        lines.push('');
      }
    }
    downloadTextFile('scholar-ideas.md', lines.join('\n'), 'text/markdown;charset=utf-8');
  };

  /* ---------- toolbar ---------- */
  const toolbar = (
    <div style={{ flex: 'none' }}>
      <div style={{ padding: '8px 10px 6px', display: 'flex', gap: 6, alignItems: 'center' }}>
        <SearchInput value={q} onChange={setQ} placeholder={t('card.searchPh')} />
        <IconButton
          label={t('paper.filters')}
          active={hasFilters}
          onClick={() => setFiltersOpen(!filtersOpen)}
          icon={<Icon d={Icons.filter} size={13} />}
        />
        <Select value={sort} onChange={(e) => setSort(e.target.value)} title={t('paper.sort')} style={{ flex: 'none', minWidth: 84 }}>
          <option value="createdAt">{t('paper.sortCreated')}</option>
          <option value="importance">{t('card.sortImportance')}</option>
          <option value="title">{t('paper.sortTitle')}</option>
        </Select>
        {/* random review (serendipity) + view switch */}
        <IconButton
          label={t('card.random')}
          onClick={randomReview}
          icon={<Icon d={Icons.refresh} size={13} />}
        />
        <IconButton
          label={t('card.exportMd')}
          onClick={exportAllMd}
          icon={<Icon d={Icons.download} size={13} />}
        />
        <span style={{
          display: 'inline-flex', borderRadius: 8, padding: 2, flex: 'none',
          background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))',
        }}>
          {(['group', 'kanban', 'table', 'grid', 'list'] as const).map((m) => (
            <IconButton
              key={m}
              label={m}
              size={22}
              active={viewMode === m}
              onClick={() => setViewMode(m)}
              icon={<Icon d={
                m === 'group' ? Icons.stack
                  : m === 'kanban' ? Icons.kanban
                    : m === 'table' ? Icons.table
                      : m === 'grid' ? Icons.grid
                        : Icons.list
              } size={12} />}
            />
          ))}
        </span>
        <Btn tone="primary" onClick={() => setCreating(true)}>
          <Icon d={Icons.plus} size={12} /> {t('card.add')}
        </Btn>
      </div>

      {filtersOpen && (
        <div className="sch-fade" style={{ padding: '0 10px 6px', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <Select value={category} onChange={(e) => setCategory(e.target.value)} title={t('card.categoryAll')} style={{ minWidth: 92 }}>
            <option value="">{t('card.categoryAll')}</option>
            {CATEGORIES.map((c) => <option key={c} value={c}>{t(CATEGORY_LABELS[c])}</option>)}
          </Select>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} title={t('card.statusAll')} style={{ minWidth: 86 }}>
            <option value="">{t('card.statusAll')}</option>
            {STATUSES.map((s) => <option key={s} value={s}>{t(STATUS_LABELS[s])}</option>)}
          </Select>
          <Select value={importance} onChange={(e) => setImportance(e.target.value)} title={t('paper.importanceAll')} style={{ minWidth: 88 }}>
            <option value="">{t('paper.importanceAll')}</option>
            {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{'★'.repeat(n)}</option>)}
          </Select>
          <Select value={tag} onChange={(e) => setTag(e.target.value)} title={t('paper.tagAll')} style={{ minWidth: 92 }}>
            <option value="">{t('paper.tagAll')}</option>
            {tags.map((tg) => <option key={tg} value={tg}>{tg}</option>)}
          </Select>
          <Select value={paperFilter} onChange={(e) => setPaperFilter(e.target.value)} title={t('card.paperAll')} style={{ minWidth: 120 }}>
            <option value="">{t('card.paperAll')}</option>
            {papers.map((p) => <option key={p.id} value={p.id}>{truncate(p.title, 36)}</option>)}
          </Select>
        </div>
      )}

      {filtersActive && (
        <div style={{ padding: '0 10px 7px', display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
          {category && <FilterChip label={t(CATEGORY_LABELS[category as CardCategory])} onRemove={() => setCategory('')} />}
          {status && <FilterChip label={t(STATUS_LABELS[status as CardStatus])} onRemove={() => setStatus('')} />}
          {importance && <FilterChip label={`★ ≥ ${importance}`} onRemove={() => setImportance('')} />}
          {tag && <FilterChip label={`#${tag}`} onRemove={() => setTag('')} />}
          {paperFilter && <FilterChip label={`📄 ${truncate(paperTitle(paperFilter), 24)}`} onRemove={() => setPaperFilter('')} />}
        </div>
      )}
    </div>
  );

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <SchStyles />
      {toolbar}
      {error && <div style={{ color: T.danger, padding: '2px 12px 6px', fontSize: 11 }}>{error}</div>}
      {degraded && !error && (
        <div style={{ color: T.warning, padding: '2px 12px 6px', fontSize: 11 }}>{degraded}</div>
      )}

      <div className="sch-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 10px 12px' }}>
        {!loading && cards.length === 0 && !error && (
          q || filtersActive ? (
            <EmptyState icon={<Icon d={Icons.search} size={34} />} title={t('common.empty')} />
          ) : (
            <EmptyState
              icon={<Icon d={Icons.bulb} size={38} />}
              title={t('common.empty')}
              hint={t('card.aiHint')}
            />
          )
        )}
        {loading && cards.length === 0 && (
          <div style={{ color: T.caption, padding: 12, fontSize: 11.5 }}>{t('common.loading')}</div>
        )}
        <div key={`${debouncedQ}|${sort}|${category}|${status}|${tag}|${importance}|${viewMode}|${tableSort.key}${tableSort.dir}`} className="sch-fade">
          {viewMode === 'group' && (
            <div className="sch-fade">
              {groupedCards.map((g) => {
                const collapsed = collapsedGroups.has(g.key);
                const unfiled = g.key === '__unfiled__';
                const title = unfiled ? t('card.groupUnfiled') : (g.paper ? g.paper.title : g.key);
                const statusCounts = new Map<CardStatus, number>();
                for (const c of g.list) statusCounts.set(c.status, (statusCounts.get(c.status) ?? 0) + 1);
                return (
                  <div key={g.key} style={{ marginBottom: 10 }}>
                    <div
                      className="sch-card"
                      onClick={() => toggleGroup(g.key)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 7, padding: '7px 9px',
                        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 9,
                        background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))', cursor: 'pointer',
                      }}
                    >
                      <Icon d={collapsed ? Icons.chevronRight : Icons.chevronDown} size={12} color={T.caption} />
                      <Icon d={Icons.doc} size={12} color={T.business} />
                      <span style={{
                        flex: 1, minWidth: 0, fontWeight: 600, fontSize: 12,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        color: 'var(--dsw-alias-label-primary)',
                      }} title={title}>
                        {truncate(title, unfiled ? 40 : 46)}
                      </span>
                      <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center', flex: 'none' }}>
                        {STATUSES.filter((st) => statusCounts.has(st)).map((st) => (
                          <span key={st} style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 9.5, color: T.caption }}>
                            <span aria-hidden style={{ width: 6, height: 6, borderRadius: 999, background: statusColor(st) }} />
                            {statusCounts.get(st)}
                          </span>
                        ))}
                      </span>
                      <span style={{ fontSize: 10, color: T.caption, flex: 'none' }}>{g.list.length}</span>
                      {!unfiled && (
                        <span
                          role="button"
                          title={t('card.viewPaper')}
                          onClick={(e) => { e.stopPropagation(); navBus.go('papers', g.key); }}
                          style={{ display: 'inline-flex', flex: 'none', cursor: 'pointer', color: T.caption }}
                        >
                          <Icon d={Icons.external} size={11} />
                        </span>
                      )}
                    </div>
                    <div className={`sch-collapse${collapsed ? ' sch-collapsed' : ''}`}>
                      <div className="sch-collapse-inner" style={{ marginLeft: 14, borderLeft: '2px solid var(--dsw-alias-border-l2)', paddingLeft: 8, paddingTop: 4 }}>
                        {g.list.map((c, ci) => (
                          <button
                            key={c.id}
                            type="button"
                            className="sch-card sch-press"
                            onClick={() => setModal({ card: c, editing: false })}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 7, width: '100%', textAlign: 'left',
                              border: 'none', background: 'none', cursor: 'pointer',
                              padding: '5px 6px', borderRadius: 7, color: 'var(--dsh-alias-label-primary)',
                              marginBottom: 2,
                              // stagger 序号（封顶防长列表等太久）
                              ['--sch-i' as string]: Math.min(ci, 18),
                            }}
                          >
                            <span aria-hidden style={{ width: 7, height: 7, borderRadius: 999, background: statusColor(c.status), flex: 'none' }} />
                            <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {c.title}
                            </span>
                            <span style={{ flex: 'none', fontSize: 9, fontWeight: 600, letterSpacing: '.02em', color: categoryColor(c.category) }}>
                              {t(CATEGORY_LABELS[c.category])}
                            </span>
                            <Stars value={c.importance} size={9} />
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {viewMode === 'kanban' && (
            <div
              data-dsh-plugin="dsh-scholar"
              data-dsh-part="kanban"
              className="sch-stagger"
              title={t('card.kanbanHint')}
              style={{ display: 'flex', gap: 8, alignItems: 'stretch', minHeight: 300 }}
            >
              {STATUSES.map((st) => {
                const colCards = cards.filter((c) => c.status === st);
                const isDrop = dropCol === st;
                return (
                  <div
                    key={st}
                    data-dsh-part="kanban-col"
                    data-status={st}
                    className={`sch-kanban-col${isDrop ? ' sch-drop-target' : ''}`}
                    onDragOver={(e) => { e.preventDefault(); setDropCol(st); }}
                    onDragLeave={() => setDropCol((cur) => (cur === st ? null : cur))}
                    onDrop={(e) => {
                      e.preventDefault();
                      const id = dragId;
                      setDragId(null);
                      setDropCol(null);
                      if (!id) return;
                      const c = cards.find((x) => x.id === id);
                      if (!c || c.status === st) return;
                      // adopted/dropped 是定论型流转，与状态按钮同级——先确认
                      if ((st === 'adopted' || st === 'dropped')
                        && !window.confirm(t('card.confirmStatus', { status: t(STATUS_LABELS[st]) }))) return;
                      setDroppedId(id);
                      setTimeout(() => setDroppedId((cur) => (cur === id ? null : cur)), 700);
                      void saveCard({ ...c, status: st });
                    }}
                    style={{
                      flex: '1 1 0', minWidth: 150, display: 'flex', flexDirection: 'column',
                      borderRadius: 10, padding: 6,
                      border: `1px solid ${isDrop ? 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 55%, transparent)' : 'var(--dsw-alias-border-l2)'}`,
                      background: isDrop ? 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 7%, transparent)' : 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.05))',
                      transition: 'border-color .12s, background .12s',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 4px 7px', fontSize: 10.5, color: T.caption, fontWeight: 600 }}>
                      <span aria-hidden style={{ width: 7, height: 7, borderRadius: 999, background: statusColor(st), flex: 'none' }} />
                      {t(STATUS_LABELS[st])}
                      <span style={{ flex: 1 }} />
                      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{colCards.length}</span>
                    </div>
                    <div className="sch-scroll sch-stagger" style={{ flex: 1, minHeight: 60, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 5 }}>
                      {colCards.map((c, ci) => (
                        <button
                          key={c.id}
                          type="button"
                          data-dsh-part="kanban-card"
                          draggable
                          onDragStart={() => setDragId(c.id)}
                          onDragEnd={() => { setDragId(null); setDropCol(null); }}
                          onClick={() => setModal({ card: c, editing: false })}
                          className={`sch-card sch-press${dragId === c.id ? ' sch-dragging' : ''}${droppedId === c.id ? ' sch-dropped' : ''}`}
                          style={{
                            textAlign: 'left', cursor: 'grab', border: '1px solid var(--dsw-alias-border-l2)',
                            background: T.cardBg, borderRadius: 9, padding: '8px 9px',
                            ['--sch-i' as string]: Math.min(ci, 14),
                            color: 'var(--dsh-alias-label-primary)',
                          }}
                        >
                          <div style={{ fontSize: 11.5, fontWeight: 650, lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                            {c.title}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 5 }}>
                            <span aria-hidden style={{ width: 5, height: 5, borderRadius: 999, background: categoryColor(c.category), flex: 'none' }} />
                            <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: '.02em', color: categoryColor(c.category) }}>
                              {t(CATEGORY_LABELS[c.category])}
                            </span>
                            {(c.steps ?? []).length > 0 && (
                              <span title={`${t('card.steps')} · ${(c.steps ?? []).length}`} style={{ fontSize: 9, color: T.caption }}>
                                ①{(c.steps ?? []).length > 1 ? `–${(c.steps ?? []).length}` : ''}
                              </span>
                            )}
                            {c.evidence && <span title={t('card.evidence')} style={{ fontSize: 9, color: T.purple ?? '#7c5cff', fontWeight: 700 }}>❝</span>}
                            <span style={{ flex: 1 }} />
                            {c.paperId && <Icon d={Icons.doc} size={9} color={T.caption} />}
                            <Stars value={c.importance} size={8} />
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {viewMode === 'table' && (
            <div data-dsh-plugin="dsh-scholar" data-dsh-part="card-table" style={{ border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10, overflow: 'hidden' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(140px,2.2fr) 62px 64px minmax(90px,1.2fr) 44px 72px', background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.07))', borderBottom: '1px solid var(--dsw-alias-border-l2)' }}>
                {([
                  { key: 'title', label: t('card.col.title') },
                  { key: 'category', label: t('card.col.category') },
                  { key: 'status', label: t('card.col.status') },
                  { key: 'paper', label: t('card.col.paper') },
                  { key: 'importance', label: t('card.col.importance') },
                  { key: 'updatedAt', label: t('card.col.updated') },
                ] as const).map((h) => (
                  <button
                    key={h.key}
                    type="button"
                    data-dsh-part="table-head"
                    onClick={() => setTableSort((cur) => ({ key: h.key, dir: cur.key === h.key && cur.dir === -1 ? 1 : -1 }))}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 3, padding: '6px 8px', fontSize: 10, fontWeight: 600,
                      color: T.caption, background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left',
                      letterSpacing: '.03em',
                    }}
                  >
                    {h.label}
                    <span style={{ opacity: tableSort.key === h.key ? 1 : 0, fontSize: 8 }}>{tableSort.dir === -1 ? '▼' : '▲'}</span>
                  </button>
                ))}
              </div>
              <div className="sch-stagger">
                {[...cards]
                  .sort((a, b) => {
                    const d = tableSort.dir;
                    switch (tableSort.key) {
                      case 'title': return d * a.title.localeCompare(b.title);
                      case 'category': return d * CATEGORY_LABELS[a.category].localeCompare(CATEGORY_LABELS[b.category]) || a.title.localeCompare(b.title);
                      case 'status': return d * (STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status)) || a.title.localeCompare(b.title);
                      case 'paper': {
                        const pa = a.paperId ? paperTitle(a.paperId) : 'zzz';
                        const pb = b.paperId ? paperTitle(b.paperId) : 'zzz';
                        return d * pa.localeCompare(pb) || a.title.localeCompare(b.title);
                      }
                      case 'importance': return d * (a.importance - b.importance) || a.title.localeCompare(b.title);
                      default: return d * (a.updatedAt - b.updatedAt);
                    }
                  })
                  .map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      data-dsh-plugin="dsh-scholar"
                      data-dsh-part="table-row"
                      onClick={() => setModal({ card: c, editing: false })}
                      className="sch-press"
                      style={{
                        display: 'grid', gridTemplateColumns: 'minmax(140px,2.2fr) 62px 64px minmax(90px,1.2fr) 44px 72px',
                        width: '100%', alignItems: 'center', gap: 4, padding: '5px 8px', textAlign: 'left',
                        background: 'transparent', border: 'none', borderBottom: '1px solid color-mix(in srgb, var(--dsw-alias-border-l2) 55%, transparent)',
                        cursor: 'pointer', color: 'var(--dsh-alias-label-primary)', fontSize: 11,
                      }}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                        <span aria-hidden style={{ width: 3, height: 14, borderRadius: 2, background: categoryColor(c.category), flex: 'none' }} />
                        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>{c.title}</span>
                      </span>
                      <span style={{ fontSize: 9.5, color: categoryColor(c.category), fontWeight: 600 }}>{t(CATEGORY_LABELS[c.category])}</span>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, color: T.secondary }}>
                        <span aria-hidden style={{ width: 6, height: 6, borderRadius: 999, background: statusColor(c.status), flex: 'none' }} />
                        {t(STATUS_LABELS[c.status])}
                      </span>
                      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10, color: T.caption }}>
                        {c.paperId ? truncate(paperTitle(c.paperId), 20) : t('card.noPaper')}
                      </span>
                      <Stars value={c.importance} size={9} />
                      <span style={{ fontSize: 9.5, color: T.caption, fontVariantNumeric: 'tabular-nums' }}>
                        {new Date(c.updatedAt).toLocaleDateString()}
                      </span>
                    </button>
                  ))}
              </div>
            </div>
          )}
          {viewMode === 'grid' && (
            <div className="sch-stagger" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(216px, 1fr))', gap: 10 }}>
              {cards.map((c, i) => {
                const cc = categoryColor(c.category);
                const sc = statusColor(c.status);
                const steps = c.steps ?? [];
                const shownSteps = Math.min(steps.length, 3);
                const srcTitle = c.paperId ? (paperOfTitle(c.paperId) || c.paperId) : '';
                return (
                  <button
                    key={c.id}
                    type="button"
                    data-dsh-plugin="dsh-scholar"
                    data-dsh-part="idea-card"
                    className="sch-card sch-press"
                    onClick={() => setModal({ card: c, editing: false })}
                    style={{
                      ['--sch-i' as string]: Math.min(i, 20),
                      textAlign: 'left', border: '1px solid var(--dsw-alias-border-l2)',
                      background: 'transparent',
                      borderRadius: 12, padding: 11, cursor: 'pointer', color: 'var(--dsh-alias-label-primary)',
                      display: 'flex', flexDirection: 'column', gap: 7, minHeight: 150,
                    }}
                  >
                    {/* 身份行:分类胶囊 + 优先级 */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Pill color={cc}>
                        <span aria-hidden style={{ width: 5, height: 5, borderRadius: 999, background: cc }} />
                        {t(CATEGORY_LABELS[c.category])}
                      </Pill>
                      <span style={{ flex: 1 }} />
                      <Stars value={c.importance} size={9} />
                    </div>
                    {/* 标题区:固定两行高度,网格纵向对齐 */}
                    <span style={{
                      fontWeight: 650, fontSize: 13, lineHeight: 1.45, minHeight: 38,
                      display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                    }}>
                      {c.title}
                    </span>
                    {/* 来源行:固定高度占位,无来源时保持纵向节奏一致 */}
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9.5, color: T.secondary, minHeight: 14, minWidth: 0 }}>
                      {srcTitle && (
                        <>
                          <Icon d={Icons.doc} size={10} color={T.secondary} />
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {truncate(srcTitle, 36)}
                          </span>
                        </>
                      )}
                    </span>
                    {/* 正文:plain 用绿色提示块(与详情弹窗同语言),否则 insight 两行 */}
                    <span style={{ flex: 1, minHeight: 46, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
                      {c.plain ? (
                        <span style={{
                          fontSize: 10.5, lineHeight: 1.55,
                          background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary, #30a46c) 9%, transparent)',
                          border: '1px solid color-mix(in srgb, var(--dsw-alias-state-success-primary, #30a46c) 24%, transparent)',
                          borderRadius: 8, padding: '5px 8px',
                          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                        }}>
                          💡 {c.plain}
                        </span>
                      ) : c.insight ? (
                        <span style={{
                          fontSize: 10.5, lineHeight: 1.5, color: T.secondary,
                          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                        }}>
                          {c.insight}
                        </span>
                      ) : null}
                    </span>
                    {/* 元信息行:步骤缩略流 + 证据标记 + 状态胶囊 */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      {shownSteps > 0 && (
                        <span style={{ display: 'inline-flex', alignItems: 'center' }} title={`${t('card.steps')} · ${steps.length}`}>
                          {steps.slice(0, 3).map((_, si) => (
                            <React.Fragment key={si}>
                              {si > 0 && (
                                <span aria-hidden style={{ width: 6, height: 1.5, background: 'var(--dsw-alias-border-l2)', margin: '0 2px', borderRadius: 1 }} />
                              )}
                              <span style={{
                                width: 16, height: 16, borderRadius: 999, flex: 'none',
                                fontSize: 9, lineHeight: '16px', textAlign: 'center', fontVariantNumeric: 'tabular-nums',
                                color: '#fff', fontWeight: 650,
                                background: si === shownSteps - 1 && steps.length <= 3
                                  ? 'var(--dsw-alias-state-success-primary, #30a46c)'
                                  : cc,
                              }}>{si + 1}</span>
                            </React.Fragment>
                          ))}
                          {steps.length > 3 && (
                            <span style={{ fontSize: 9, color: T.caption, marginLeft: 3, fontVariantNumeric: 'tabular-nums' }}>+{steps.length - 3}</span>
                          )}
                        </span>
                      )}
                      {c.evidence && (
                        <span
                          title={t('card.evidence')}
                          style={{
                            flex: 'none', display: 'inline-flex', alignItems: 'center',
                            fontSize: 11, fontWeight: 700, lineHeight: 1, color: T.purple ?? '#7c5cff',
                            background: `color-mix(in srgb, ${T.purple ?? '#7c5cff'} 18%, transparent)`,
                            border: `1px solid color-mix(in srgb, ${T.purple ?? '#7c5cff'} 34%, transparent)`,
                            borderRadius: 6, padding: '2px 6px',
                          }}
                        >❝</span>
                      )}
                      <span style={{ flex: 1 }} />
                      <Pill color={sc}>
                        <span aria-hidden style={{ width: 5, height: 5, borderRadius: 999, background: sc }} />
                        {t(STATUS_LABELS[c.status])}
                      </Pill>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
          {viewMode === 'list' && cards.map((c, i) => (
              <button
                key={c.id}
                type="button"
                data-dsh-plugin="dsh-scholar"
                data-dsh-part="idea-card"
                className="sch-card sch-press"
                onClick={() => setModal({ card: c, editing: false })}
                style={{
                  ['--sch-i' as string]: Math.min(i, 20),
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                  border: '1px solid var(--dsw-alias-border-l2)',
                  background: 'transparent', borderRadius: 9,
                  padding: '7px 11px', marginBottom: 6, cursor: 'pointer', color: 'var(--dsh-alias-label-primary)',
                }}
              >
                <span style={{ fontWeight: 650, fontSize: 12.5, flex: 'none', maxWidth: 230, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.title}
                </span>
                <span style={{ flex: 1, fontSize: 11, color: T.secondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.plain || c.insight}
                </span>
                <Pill color={categoryColor(c.category)}>{t(CATEGORY_LABELS[c.category])}</Pill>
                <Pill color={statusColor(c.status)}>
                  <span aria-hidden style={{ width: 5, height: 5, borderRadius: 999, background: statusColor(c.status) }} />
                  {t(STATUS_LABELS[c.status])}
                </Pill>
                <Stars value={c.importance} size={10} />
              </button>
            ))}
        </div>
      </div>

      {/* create modal (prefilled when coming from a paper detail) */}
      {creating && (
        <Modal title={t('card.new')} onClose={closeCreate}>
          <CardForm
            draft={{
              title: '', insight: '', category: 'method', tags: [], importance: 3, status: 'pending',
              paperId: prefillPaperId ?? undefined,
            }}
            papers={papers}
            cards={allCards}
            onSave={(d) => void saveCard(d)}
            onCancel={closeCreate}
            onTouch={() => setCreatingDirty(true)}
            error={saveError}
            t={t}
          />
        </Modal>
      )}

      {/* detail / edit modal */}
      {modal && (
        <Modal
          title={modal.editing ? t('card.edit') : t('card.detail')}
          onClose={() => { if (modal.editing) cancelEdit(); else setModal(null); }}
          width={520}
        >
          {modal.editing ? (
            <CardForm
              draft={withLivePaper(modal.card)}
              papers={papers}
              cards={allCards}
              onSave={(d) => void saveCard(d)}
              onCancel={cancelEdit}
              onTouch={() => setEditDirty(true)}
              error={saveError}
              t={t}
            />
          ) : (
            (() => {
              const src = modal.card.paperId ? papers.find((p) => p.id === modal.card!.paperId) : undefined;
              const accent = categoryColor(modal.card.category);
              return (
                <div>
                  {/* headline */}
                  <div className="sch-fade" key={modal.card.id + String(modal.card.updatedAt)}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <Chip label={t(CATEGORY_LABELS[modal.card.category])} color={accent} />
                      <Chip label={t(STATUS_LABELS[modal.card.status])} color={statusColor(modal.card.status)} />
                      <span style={{ flex: 1 }} />
                      <Stars value={modal.card.importance} onChange={(v) => void saveCard({ ...modal.card!, importance: v })} />
                    </div>
                    <div style={{ fontWeight: 700, fontSize: 14.5, marginTop: 11, lineHeight: 1.45 }}>{modal.card.title}</div>
                    <div style={{
                      marginTop: 8, fontSize: 12.5, lineHeight: 1.7, color: T.secondary,
                      whiteSpace: 'pre-wrap', borderLeft: `2px solid ${accent}`, paddingLeft: 9,
                    }}>
                      {modal.card.insight}
                    </div>
                    {modal.card.evidence && (
                      <div className="sch-fade" style={{
                        marginTop: 10, padding: '7px 10px', borderRadius: 9,
                        background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))',
                        borderLeft: `2px solid ${T.purple ?? '#7c5cff'}`,
                      }}>
                        <span style={{ fontSize: 10, fontWeight: 600, color: T.caption, letterSpacing: '.04em' }}>❝ {t('card.evidence')}</span>
                        <div style={{ fontSize: 11.5, lineHeight: 1.6, marginTop: 3, color: T.secondary, whiteSpace: 'pre-wrap' }}>
                          {modal.card.evidence}
                        </div>
                      </div>
                    )}
                    {modal.card.plain && (
                      <div className="sch-fade" style={{
                        marginTop: 12, padding: '8px 10px', borderRadius: 9,
                        background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary, #30a46c) 10%, transparent)',
                        border: '1px solid color-mix(in srgb, var(--dsw-alias-state-success-primary, #30a46c) 28%, transparent)',
                      }}>
                        <span style={{ fontSize: 10, fontWeight: 600, color: T.success, letterSpacing: '.04em' }}>💡 {t('card.plain')}</span>
                        <div style={{ fontSize: 12.5, lineHeight: 1.6, marginTop: 3 }}>{modal.card.plain}</div>
                      </div>
                    )}
                    {(modal.card.steps ?? []).length > 0 && (
                      <div style={{ marginTop: 12 }}>
                        <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: T.caption, marginBottom: 7 }}>
                          {t('card.steps')} · {(modal.card.steps ?? []).length}
                        </div>
                        <div style={{ position: 'relative', paddingLeft: 24 }}>
                          <span aria-hidden style={{ position: 'absolute', left: 10, top: 8, bottom: 8, width: 2, background: 'var(--dsw-alias-border-l2)' }} />
                          {(modal.card.steps ?? []).map((stepText, i) => (
                            <div key={i} style={{ position: 'relative', marginBottom: 6 }}>
                              <span aria-hidden style={{
                                position: 'absolute', left: -24, top: 1, width: 18, height: 18, borderRadius: 999,
                                background: i === (modal.card!.steps ?? []).length - 1 ? T.success : accent,
                                color: '#fff', fontSize: 9.5, textAlign: 'center', lineHeight: '18px',
                                fontVariantNumeric: 'tabular-nums', boxShadow: '0 0 0 2px var(--dsw-alias-bg-layer-2, #1e1e1e)',
                              }}>{i + 1}</span>
                              <div style={{
                                border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: '6px 9px',
                                background: T.cardBg, fontSize: 11.5, lineHeight: 1.5,
                                borderColor: i === (modal.card!.steps ?? []).length - 1
                                  ? 'color-mix(in srgb, var(--dsw-alias-state-success-primary, #30a46c) 40%, transparent)' : undefined,
                              }}>{stepText}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {hasNotes(modal.card.notes) && (
                      <div style={{ marginTop: 10, fontSize: 11.5, lineHeight: 1.55, color: T.secondary, whiteSpace: 'pre-wrap' }}>
                        <span style={{ color: T.caption }}>{t('paper.notes')}: </span>{modal.card.notes}
                      </div>
                    )}
                    {modal.card.tags.length > 0 && (
                      <div style={{ display: 'flex', gap: 4, marginTop: 10, flexWrap: 'wrap' }}>
                        {modal.card.tags.map((tg) => <Chip key={tg} label={tg} />)}
                      </div>
                    )}

                    {/* source paper */}
                    <div style={{ marginTop: 13, display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: T.caption }}>
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {modal.card.paperId
                          ? `${t('card.paper')}: ${src ? truncate(src.title, 40) : t('card.paperDeleted')}`
                          : t('card.noPaper')}
                      </span>
                      {src && (
                        <Btn tone="soft" onClick={() => navBus.go('papers', modal.card!.paperId)}>
                          <Icon d={Icons.link} size={11} /> {t('card.viewPaper')}
                        </Btn>
                      )}
                    </div>

                    {/* status flow */}
                    <div style={{ marginTop: 14, borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: 11 }}>
                      <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: T.caption, marginBottom: 7 }}>
                        {t('card.status')}
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {STATUSES.filter((s) => s !== modal.card!.status).map((s) => (
                          <Btn key={s} onClick={() => void applyStatus(modal.card!, s)}>
                            <span aria-hidden style={{ width: 6, height: 6, borderRadius: 999, background: statusColor(s), display: 'inline-block', marginRight: 2 }} />
                            {t(STATUS_LABELS[s])}
                          </Btn>
                        ))}
                      </div>
                    </div>

                    {/* related cards */}
                    {(modal.card.relatedCardIds ?? []).length > 0 && (
                      <div style={{ marginTop: 12 }}>
                        <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: T.caption, marginBottom: 6 }}>
                          {t('card.related')}
                        </div>
                        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                          {(modal.card.relatedCardIds ?? []).map((rid) => {
                            const rel = allCards.find((c) => c.id === rid);
                            if (!rel) return <Chip key={rid} label={t('card.relatedMissing')} />;
                            return (
                              <Chip
                                key={rid}
                                label={truncate(rel.title, 22)}
                                color={categoryColor(rel.category)}
                                onClick={() => setModal({ card: rel, editing: false })}
                              />
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* backlinks（反向引用：哪些卡关联了我） */}
                    {(() => {
                      const backlinks = allCards.filter((c) => c.id !== modal.card!.id && (c.relatedCardIds ?? []).includes(modal.card!.id));
                      if (!backlinks.length) return null;
                      return (
                        <div style={{ marginTop: 10 }}>
                          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: T.caption, marginBottom: 6 }}>
                            {t('card.backlinks')}
                          </div>
                          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                            {backlinks.map((b) => (
                              <Chip
                                key={b.id}
                                label={truncate(b.title, 22)}
                                color={categoryColor(b.category)}
                                onClick={() => setModal({ card: b, editing: false })}
                              />
                            ))}
                          </div>
                        </div>
                      );
                    })()}

                    <div style={{ display: 'flex', gap: 8, margin: '14px 0 4px', flexWrap: 'wrap' }}>
                      <Btn tone="primary" onClick={() => setModal({ card: modal.card!, editing: true })}>
                        <Icon d={Icons.edit} size={11} /> {t('common.edit')}
                      </Btn>
                      <Btn onClick={() => void copyMd(modal.card!)}>
                        <Icon d={Icons.doc} size={11} /> {t('card.copyMd')}
                      </Btn>
                      <Btn tone="soft" onClick={() => void copyCombination(modal.card!)} title={t('card.combineCopied')}>
                        <Icon d={Icons.link} size={11} /> {t('card.combine')}
                      </Btn>
                      <Btn tone="soft" onClick={() => void copyExperiment(modal.card!)} title={t('card.experimentCopied')}>
                        <Icon d={Icons.bulb} size={11} /> {t('card.experiment')}
                      </Btn>
                      <Btn tone="danger" onClick={() => void removeCard(modal.card!.id)}>
                        <Icon d={Icons.trash} size={11} /> {t('common.delete')}
                      </Btn>
                    </div>
                  </div>
                </div>
              );
            })()
          )}
        </Modal>
      )}

      {/* 内联 toast:复制成功/失败、随机回顾空池等反馈,2.5s 自动消失 */}
      {toast && createPortal(
        <div
          data-dsh-plugin="dsh-scholar"
          data-dsh-part="toast"
          style={{
            position: 'fixed', top: 18, left: '50%', transform: 'translateX(-50%)',
            zIndex: Z.float, pointerEvents: 'none',
            padding: '6px 14px', borderRadius: 999, fontSize: 11.5, whiteSpace: 'nowrap',
            background: 'color-mix(in srgb, var(--dsw-alias-bg-base, #161616) 92%, transparent)',
            border: '1px solid var(--dsw-alias-border-l2)',
            color: 'var(--dsw-alias-label-primary)',
            boxShadow: 'var(--dsw-shadow-lv2, 0 8px 24px rgba(0,0,0,.25))',
          }}
        >
          {toast}
        </div>,
        document.body,
      )}
    </div>
  );

  function paperOfTitle(id: string): string {
    return papers.find((p) => p.id === id)?.title ?? '';
  }
}

function hasNotes(n?: string): boolean {
  return typeof n === 'string' && n.length > 0;
}

/* ---------- card form ---------- */
function CardForm({ draft, papers, cards, onSave, onCancel, onTouch, error, t }: {
  draft: CardDraft;
  papers: Paper[];
  /** full card list for the related-toggle */
  cards: IdeaCard[];
  onSave: (d: CardDraft) => void;
  onCancel: () => void;
  /** 任一字段首次修改时回调(父组件的脏数据保护) */
  onTouch: () => void;
  /** 保存失败的错误,渲染在 invalid 同位(不被 Modal 遮罩挡住) */
  error?: string;
  t: TFunc;
}) {
  const [d, setD] = useState<CardDraft>(draft);
  const [invalid, setInvalid] = useState('');
  /** 关联卡搜索词：50+ 卡时全量 chips 不可用 */
  const [relQ, setRelQ] = useState('');
  /** steps 原文：受控值若直接 join+filter 会吃掉正在输入的换行，必须保存时再解析 */
  const [stepsText, setStepsText] = useState<string>((draft.steps ?? []).join('\n'));

  const splitList = (s: string): string[] => s.split(/[,，]/).map((x) => x.trim()).filter(Boolean);

  const touch = () => { onTouch(); };

  const toggleRelated = (id: string) => {
    touch();
    setD((cur) => {
      const curIds = cur.relatedCardIds ?? [];
      const next = curIds.includes(id) ? curIds.filter((x) => x !== id) : [...curIds, id];
      return { ...cur, relatedCardIds: next };
    });
  };

  const set = (patch: Partial<CardDraft>) => {
    touch();
    setD((cur) => ({ ...cur, ...patch }));
  };

  const save = () => {
    if (!d.title.trim()) { setInvalid(t('card.form.title')); return; }
    if (!d.insight.trim()) { setInvalid(t('card.form.insight')); return; }
    // steps 在保存时才从原文解析（编辑期保留空行/缩进，否则换行会被受控值吃掉）
    const steps = stepsText.split('\n').map((x) => x.trim()).filter(Boolean);
    onSave({ ...d, steps, tags: splitList(d.tags.join(',')) });
  };

  return (
    <div style={{ maxWidth: 520 }}>
      <Field label={t('card.form.title')}>
        <Input value={d.title} onChange={(e) => set({ title: e.target.value })} />
      </Field>

      <Field label={t('card.form.insight')}>
        <Textarea
          rows={5}
          value={d.insight}
          placeholder={t('card.form.insightPh')}
          onChange={(e) => set({ insight: e.target.value })}
          style={{ minHeight: 100 }}
        />
      </Field>

      <Field label={t('card.form.plain')}>
        <Textarea
          rows={2}
          value={d.plain ?? ''}
          placeholder={t('card.form.plainPh')}
          onChange={(e) => set({ plain: e.target.value })}
          style={{ minHeight: 44 }}
        />
      </Field>

      <Field label={t('card.form.steps')}>
        <Textarea
          rows={3}
          value={stepsText}
          placeholder={t('card.form.stepsPh')}
          onChange={(e) => { touch(); setStepsText(e.target.value); }}
          style={{ minHeight: 64 }}
        />
      </Field>

      <Field label={t('card.form.evidence')}>
        <Textarea
          rows={2}
          value={d.evidence ?? ''}
          placeholder={t('card.form.evidencePh')}
          onChange={(e) => set({ evidence: e.target.value })}
          style={{ minHeight: 44 }}
        />
      </Field>

      <Field label={t('card.form.paper')}>
        <Select value={d.paperId ?? ''} onChange={(e) => set({ paperId: e.target.value || undefined })}>
          <option value="">{t('card.noPaper')}</option>
          {papers.map((p) => <option key={p.id} value={p.id}>{truncate(p.title, 60)}</option>)}
        </Select>
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 96px', gap: 8 }}>
        <Field label={t('card.category')}>
          <Select value={d.category} onChange={(e) => set({ category: e.target.value as CardCategory })}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{t(CATEGORY_LABELS[c])}</option>)}
          </Select>
        </Field>
        <Field label={t('card.form.status')}>
          <Select value={d.status} onChange={(e) => set({ status: e.target.value as CardStatus })}>
            {STATUSES.map((s) => <option key={s} value={s}>{t(STATUS_LABELS[s])}</option>)}
          </Select>
        </Field>
        <Field label={t('card.importance')}>
          <Select value={d.importance} onChange={(e) => set({ importance: Number(e.target.value) })}>
            {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{'★'.repeat(n)}{'☆'.repeat(5 - n)}</option>)}
          </Select>
        </Field>
      </div>

      <Field label={t('card.form.tags')}>
        <Input value={d.tags.join(', ')} onChange={(e) => set({ tags: splitList(e.target.value) })} />
      </Field>

      <Field label={t('card.form.related')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <Input
            value={relQ}
            placeholder={t('card.relSearchPh')}
            onChange={(e) => setRelQ(e.target.value)}
            style={{ fontSize: 11.5 }}
          />
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {cards.filter((c) => c.id !== d.id).length === 0 && (
              <span style={{ fontSize: 11, color: T.caption }}>{t('common.empty')}</span>
            )}
            {cards
              .filter((c) => c.id !== d.id)
              .filter((c) => {
                const q = relQ.trim().toLowerCase();
                if (!q) return true;
                // 已选中的始终显示（不被搜索词过滤掉）
                return (d.relatedCardIds ?? []).includes(c.id) || c.title.toLowerCase().includes(q);
              })
              .map((c) => {
                const active = (d.relatedCardIds ?? []).includes(c.id);
                const chipColor = active ? (categoryColor(c.category)) : undefined;
                return <Chip key={c.id} label={truncate(c.title, 18)} color={chipColor} active={active} onClick={() => toggleRelated(c.id)} />;
              })}
          </div>
        </div>
      </Field>

      <Field label={t('paper.form.notes')}>
        <Textarea rows={2} value={d.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} style={{ minHeight: 40 }} />
      </Field>

      {(error || invalid) && (
        <div style={{ color: T.danger, fontSize: 11, marginBottom: 6 }}>{error || invalid}</div>
      )}

      <div style={{ display: 'flex', gap: 8, margin: '6px 0 4px' }}>
        <Btn tone="primary" onClick={save}>{t('common.save')}</Btn>
        <Btn onClick={onCancel}>{t('common.cancel')}</Btn>
      </div>
    </div>
  );
}
