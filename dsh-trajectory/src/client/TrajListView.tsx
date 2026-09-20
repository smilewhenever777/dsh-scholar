import React, { useEffect, useMemo, useState } from 'react';
import type { TrajEntry, TrajMetric, TrajNode, TrajProjectFile, TrajStatus } from '../shared/types';
import { TRAJ_STATUSES } from '../shared/types';
import type { DashProgress } from './dash';
import type { TFunc } from './nav';
import { Icon, Icons, relTime, SearchInput, statusColor, T, TrajStyles, truncate } from './ui';
import { NODE_KIND_LABELS, STATUS_LABELS } from './locales';

const GLYPH: Record<string, string> = {
  milestone: '★', idea: '◆', experiment: '▷', paper: '▣', writing: '✎', other: '○',
};

/** 数字渐升(reduced-motion 直接静态显示) */
function CountUp({ value, duration = 600 }: { value: number; duration?: number }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || duration <= 0) { setN(value); return; }
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / duration);
      setN(Math.round(value * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return <>{n}</>;
}

/** 加载骨架:研究问题卡 + 工具栏 + 三张节点卡的 shimmer 轮廓 */
function ListSkeleton() {
  return (
    <div data-dsh-part="trajectory-list" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '6px 12px 14px' }}>
      <TrajStyles />
      <div className="traj-skel" style={{ height: 92, borderRadius: 11, marginBottom: 12 }} />
      <div className="traj-skel" style={{ height: 22, width: '68%', marginBottom: 10 }} />
      {[0, 1, 2].map((i) => (
        <div key={i} className="traj-skel" style={{ height: 62, marginBottom: 8, opacity: 1 - i * 0.22 }} />
      ))}
    </div>
  );
}

const OPEN_ORDER: TrajStatus[] = ['in_progress', 'blocked', 'todo'];

/** 分支排序权重:未完成按 OPEN_ORDER,done/dropped 排最后 */
const openRank = (s: TrajStatus): number => {
  const i = OPEN_ORDER.indexOf(s);
  return i === -1 ? OPEN_ORDER.length : i;
};

type SortMode = 'mainline' | 'time';
type StatusFilter = TrajStatus | 'all';

const fmtDate = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
};

const fmtMD = (ts: number): string => `${new Date(ts).getMonth() + 1}/${new Date(ts).getDate()}`;

/** 数值显示:最多 4 位小数,去尾零。 */
const fmtNum = (v: number): string => Number(v.toFixed(4)).toString();

/** 节点的"故事时间":最新台账时间,无台账用 updatedAt。 */
const nodeTime = (n: TrajNode): number =>
  Math.max(n.updatedAt, ...(n.entries ?? []).map((e) => e.ts));

/** 自由文本里的带符号数值着色(+1.34pp 绿 / -2.31pp 红,金融惯例)。
 *  lookbehind 限定符号前是空白/括号/冒号/行首:防日期(2026-08-22)与
 *  数值区间(0.79-0.82)的连字符被误判为负差值。 */
const DELTA_RE = /(?<=[\s(;:]|^)[+-]\d+(?:\.\d+)?(?:\s*(?:pp|%))?/g;

function renderDeltaText(text: string): React.ReactNode {
  const parts = text.split(new RegExp(`(${DELTA_RE.source})`, 'g'));
  return parts.map((p, i) => {
    if (i % 2 === 1) {
      const neg = p.trimStart().startsWith('-');
      return (
        <span key={i} style={{ color: neg ? T.danger : T.success, fontWeight: 600 }}>{p}</span>
      );
    }
    return <span key={i}>{p}</span>;
  });
}

/** 结构化指标行:name | value | vs baseline | Δ着色 */
function MetricRows({ metrics }: { metrics: TrajMetric[] }) {
  return (
    <div style={{
      marginTop: 3, marginLeft: 39, borderRadius: 7, padding: '4px 8px',
      background: 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 5%, transparent)',
      border: '1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 18%, transparent)',
    }}>
      {metrics.map((m, i) => {
        const delta = m.baseline !== undefined ? m.value - m.baseline : null;
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 10.5, lineHeight: 1.7, fontVariantNumeric: 'tabular-nums' }}>
            <span style={{ flex: 1, minWidth: 0, color: T.secondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={m.name}>
              {m.name}
            </span>
            <span style={{ flex: 'none', color: 'var(--dsw-alias-label-primary)', fontWeight: 600, fontFamily: 'ui-monospace, Consolas, monospace' }}>
              {fmtNum(m.value)}{m.unit ?? ''}
            </span>
            {m.baseline !== undefined && (
              <span style={{ flex: 'none', color: T.caption, fontSize: 9.5, fontFamily: 'ui-monospace, Consolas, monospace' }}>
                vs {fmtNum(m.baseline)}
              </span>
            )}
            {delta !== null && (
              <span style={{ flex: 'none', fontWeight: 700, color: delta >= 0 ? T.success : T.danger, fontFamily: 'ui-monospace, Consolas, monospace' }}>
                {delta >= 0 ? '+' : ''}{fmtNum(delta)}{m.unit ?? ''}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** 台账行:日期 | 做了什么 | 数据(差值着色/结构化表) | 结论 | 删除 */
function EntryRow({ e, t, onDelete, present }: { e: TrajEntry; t: TFunc; onDelete?: () => void; present?: boolean }) {
  return (
    <div style={{
      padding: '6px 9px', marginTop: 5, borderRadius: 8,
      background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08))',
      border: '1px solid var(--dsw-alias-border-l2)',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
        <span style={{ fontSize: present ? 10.5 : 9.5, color: T.caption, flex: 'none', fontVariantNumeric: 'tabular-nums', minWidth: 32 }}>
          {fmtDate(e.ts)}
        </span>
        <span style={{ fontSize: present ? 12 : 11, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', lineHeight: 1.45, flex: 1, minWidth: 0 }}>
          {e.title}
        </span>
        {!present && (
          <button
            type="button"
            title={t('entry.delete')}
            onClick={(ev) => { ev.stopPropagation(); onDelete?.(); }}
            onMouseEnter={(ev) => { ev.currentTarget.style.color = T.danger; }}
            onMouseLeave={(ev) => { ev.currentTarget.style.color = T.caption; }}
            style={{
              border: 'none', background: 'none', cursor: 'pointer', flex: 'none',
              color: T.caption, display: 'inline-flex', padding: 2, alignSelf: 'center',
            }}
          >
            <Icon d={Icons.trash} size={11} />
          </button>
        )}
      </div>
      {e.metrics && e.metrics.length > 0 && <MetricRows metrics={e.metrics} />}
      {e.data && (
        <div style={{
          marginTop: 3, marginLeft: 39, fontSize: 10.5, lineHeight: 1.55,
          fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
          color: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
          wordBreak: 'break-word', whiteSpace: 'pre-wrap',
        }}>
          {renderDeltaText(e.data)}
        </div>
      )}
      {e.conclusion && (
        <div style={{ marginTop: 3, marginLeft: 39, fontSize: 10.5, lineHeight: 1.55, color: T.secondary, wordBreak: 'break-word' }}>
          <span style={{ color: T.caption }}>结论 </span>{e.conclusion}
        </div>
      )}
    </div>
  );
}

/** scholar 深链:两个插件都是我们的,CustomEvent 约定直开论文/卡片。 */
function openInScholar(refs: TrajNode['refs']): void {
  if (!refs) return;
  window.dispatchEvent(new CustomEvent('dsh-scholar-nav', {
    detail: { paperId: refs.paperId ?? null, cardId: refs.cardId ?? null },
  }));
}

/** 节点卡(梳理视图):标题/状态/进度 + 快捷流转 + 实验台账 */
function DigestNode({ node, progress, t, onOpen, onDelete, onDeleteEntry, onStatus, accent, defaultOpen, present }: {
  node: TrajNode;
  progress: Map<string, DashProgress>;
  t: TFunc;
  onOpen?: (n: TrajNode) => void;
  onDelete?: (n: TrajNode) => void;
  onDeleteEntry?: (entryId: string) => void;
  onStatus?: (n: TrajNode, s: TrajStatus) => void;
  accent?: string;
  defaultOpen?: boolean;
  /** 汇报模式:只读投影变体——无删除/流转/折叠,台账常开,字号微升 */
  present?: boolean;
}) {
  const [open, setOpen] = React.useState(defaultOpen ?? false);
  const prog = progress.get(node.id);
  const entries = [...(node.entries ?? [])].sort((a, b) => b.ts - a.ts);
  return (
    <div
      className="traj-card"
      data-dsh-part="digest-node"
      style={{
        borderRadius: 10, border: '1px solid var(--dsw-alias-border-l2)',
        borderLeft: accent ? `3px solid ${accent}` : undefined,
        background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.05))',
        padding: present ? '10px 12px' : '8px 10px', marginBottom: 8,
        cursor: present ? 'default' : 'pointer',
      }}
      onClick={present ? undefined : () => onOpen?.(node)}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ fontSize: present ? 11.5 : 10.5, color: statusColor(node.status), flex: 'none' }}>{GLYPH[node.kind] ?? '○'}</span>
        <span style={{ fontSize: present ? 14 : 12.5, fontWeight: 600, flex: 1, minWidth: 0, lineHeight: 1.4 }}>
          {node.status === 'dropped' ? <s style={{ color: T.caption }}>{node.title}</s> : node.title}
        </span>
        {/* 快捷流转:悬停浮现,最常用的状态推进免开弹窗(汇报模式隐藏) */}
        {!present && onStatus && node.status !== 'done' && node.status !== 'dropped' && (
          <span className="traj-quick" style={{ display: 'inline-flex', gap: 3, flex: 'none' }}>
            {node.status !== 'in_progress' && (
              <button
                type="button"
                title={t('digest.quickInprogress')}
                onClick={(e) => { e.stopPropagation(); onStatus(node, 'in_progress'); }}
                style={{ border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', borderRadius: 6, cursor: 'pointer', padding: '1px 5px', fontSize: 9, color: T.business }}
              >▶</button>
            )}
            <button
              type="button"
              title={t('digest.quickDone')}
              onClick={(e) => { e.stopPropagation(); onStatus(node, 'done'); }}
              style={{ border: '1px solid color-mix(in srgb, var(--dsw-alias-state-success-primary, #30a46c) 40%, transparent)', background: 'transparent', borderRadius: 6, cursor: 'pointer', padding: '1px 5px', fontSize: 9, color: T.success }}
            >✓</button>
          </span>
        )}
        <span style={{
          fontSize: present ? 10.5 : 9.5, color: statusColor(node.status), flex: 'none',
          padding: '1px 7px', borderRadius: 999,
          background: `color-mix(in srgb, ${statusColor(node.status)} 13%, transparent)`,
        }}>
          {t(STATUS_LABELS[node.status])}
        </span>
        {!present && (
          <button
            type="button"
            title={t('node.deleteConfirm')}
            onClick={(e) => { e.stopPropagation(); onDelete?.(node); }}
            onMouseEnter={(e) => { e.currentTarget.style.color = T.danger; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = T.caption; }}
            style={{
              border: 'none', background: 'none', cursor: 'pointer', flex: 'none',
              color: T.caption, display: 'inline-flex', padding: 2,
            }}
          >
            <Icon d={Icons.trash} size={12} />
          </button>
        )}
      </div>
      {/* meta 行:进度 / scholar 引用 / 时间 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3, marginLeft: 17, flexWrap: 'wrap' }}>
        <span style={{ fontSize: present ? 10.5 : 9.5, color: T.caption, flex: 'none' }}>
          {t(NODE_KIND_LABELS[node.kind])} · {relTime(node.updatedAt)}
        </span>
        {node.kind === 'experiment' && prog?.pct != null && (
          <span style={{ flex: 'none', maxWidth: 150, minWidth: 50, height: 4, borderRadius: 2, background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.25))', position: 'relative', overflow: 'hidden', display: 'inline-block' }}>
            <span style={{ position: 'absolute', inset: 0, width: `${prog.pct}%`, background: prog.stale ? T.warning : T.teal, borderRadius: 2 }} />
          </span>
        )}
        {node.kind === 'experiment' && prog && (
          <span style={{ fontSize: 9.5, color: prog.stale ? T.warning : T.teal, fontVariantNumeric: 'tabular-nums' }}>
            {prog.label || (prog.stale ? t('node.stale') : '')}
          </span>
        )}
        {(node.refs?.paperId || node.refs?.cardId) && (
          <button
            type="button"
            title={t('digest.openInScholar')}
            onClick={(e) => { e.stopPropagation(); openInScholar(node.refs); }}
            style={{
              border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', borderRadius: 999,
              cursor: 'pointer', padding: '1px 7px', fontSize: 9, color: T.business,
              display: 'inline-flex', alignItems: 'center', gap: 3, maxWidth: 180,
            }}
          >
            {node.refs?.paperId ? '▣' : '◆'} <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{truncate(node.refs?.paperLabel || node.refs?.cardLabel || node.refs?.paperId || node.refs?.cardId || '', 18)}</span>
          </button>
        )}
        {!present && entries.length > 0 && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
            style={{
              marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer',
              fontSize: 9.5, color: T.business, padding: 0, display: 'inline-flex', alignItems: 'center', gap: 3,
            }}
          >
            <Icon d={Icons.chevronDown} size={10} />
            {t('digest.entries', { n: entries.length })}
          </button>
        )}
      </div>
      {node.detail && (
        <div style={{ marginTop: 4, marginLeft: 17, fontSize: present ? 11.5 : 10.5, color: T.secondary, lineHeight: 1.55 }}>
          {node.detail}
        </div>
      )}
      {present ? (
        entries.map((e) => (
          <EntryRow key={e.id} e={e} t={t} present />
        ))
      ) : (
        <div className={`traj-fold${open ? ' traj-fold-open' : ''}`}>
          <div>
            {entries.map((e) => (
              <EntryRow key={e.id} e={e} t={t} onDelete={() => onDeleteEntry?.(e.id)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 清单页 = 项目梳理视图:研究问题(带主线进度头图)→ 搜索/筛选/排序工具栏
 * → 主线里程碑演变(带各节点实验台账)→ 分支工作 → 待办。
 * 「已发生的工作」是主角;未来计划弱化在底部。
 */
export function TrajListView({ t, file, progress, onOpen, onDelete, onDeleteEntry, onStatus }: {
  t: TFunc;
  file: TrajProjectFile | null;
  progress: Map<string, DashProgress>;
  onOpen: (node: TrajNode) => void;
  onDelete: (node: TrajNode) => void;
  /** 删除节点上的实验台账(带确认;调 DELETE /traj/nodes/:id/entries/:eid) */
  onDeleteEntry: (nodeId: string, entryId: string) => void;
  onStatus?: (node: TrajNode, s: TrajStatus) => void;
}) {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortMode, setSortMode] = useState<SortMode>('mainline');

  const derived = useMemo(() => {
    if (!file) return null;
    const byId = new Map(file.nodes.map((n) => [n.id, n]));
    const mainline = file.project.mainline.filter((id) => byId.has(id)).map((id) => byId.get(id)!);
    const mainlineSet = new Set(mainline.map((n) => n.id));
    const branches = file.nodes
      .filter((n) => !mainlineSet.has(n.id))
      .sort((a, b) => openRank(a.status) - openRank(b.status) || b.updatedAt - a.updatedAt);
    const doneMain = mainline.filter((n) => n.status === 'done').length;
    const statusCounts: Record<string, number> = { all: file.nodes.length };
    for (const s of TRAJ_STATUSES) statusCounts[s] = 0;
    for (const n of file.nodes) statusCounts[n.status] = (statusCounts[n.status] ?? 0) + 1;
    const boundExp = file.nodes.filter((n) => n.kind === 'experiment' && n.refs && (n.refs.logPath || n.refs.cmdPattern));
    const runningExp = boundExp.filter((n) => progress.has(n.id)).length;
    return {
      mainline, branches, statusCounts,
      doneMain, totalMain: mainline.length,
      pct: mainline.length ? Math.round((doneMain / mainline.length) * 100) : 0,
      entryCount: file.nodes.reduce((s, n) => s + (n.entries?.length ?? 0), 0),
      boundExp: boundExp.length, runningExp,
    };
  }, [file, progress]);

  if (!file || !derived) {
    return <ListSkeleton />;
  }

  const q = query.trim().toLowerCase();
  const matchQ = (n: TrajNode) => !q || [n.title, n.detail ?? '', ...(n.tags ?? []),
    ...(n.entries ?? []).map((e) => `${e.title} ${e.data ?? ''}`)]
    .join(' ').toLowerCase().includes(q);
  const matchS = (n: TrajNode) => statusFilter === 'all' || n.status === statusFilter;

  const orderedMainline = sortMode === 'time'
    ? [...derived.mainline].sort((a, b) => nodeTime(a) - nodeTime(b))
    : derived.mainline;
  const visMainline = orderedMainline.filter((n) => matchQ(n) && matchS(n));
  const visBranches = derived.branches.filter((n) => matchQ(n) && matchS(n));
  const filtered = q !== '' || statusFilter !== 'all';
  const statusOrder: TrajStatus[] = ['done', 'in_progress', 'blocked', 'todo', 'dropped'];

  return (
    <div className="traj-scroll" data-dsh-plugin="dsh-trajectory" data-dsh-part="trajectory-list" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '6px 12px 14px' }}>
      <TrajStyles />

      {/* 研究问题卡 + 主线进度头图(Linear/GitHub milestone 范式:自动计算完成度) */}
      <div style={{
        borderRadius: 11, padding: '10px 12px', marginBottom: 10,
        border: '1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 30%, transparent)',
        background: 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 7%, transparent)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
          <Icon d={Icons.bulb} size={13} color={T.business} />
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.08em', color: T.business }}>{t('digest.question')}</span>
        </div>
        <div style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.55, color: 'var(--dsw-alias-label-primary)' }}>
          {file.project.researchQuestion || file.project.description || t('digest.questionEmpty')}
        </div>
        {/* 主线完成度条 */}
        {derived.totalMain > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 7 }}>
            <span style={{ fontSize: 10, color: T.secondary, flex: 'none', fontVariantNumeric: 'tabular-nums' }}>
              {t('digest.progress', { done: derived.doneMain, total: derived.totalMain })}
            </span>
            <span style={{ flex: 1, height: 5, borderRadius: 2.5, background: 'rgba(127,127,127,.18)', position: 'relative', overflow: 'hidden' }}>
              <span className="traj-bar" style={{ position: 'absolute', inset: 0, width: `${derived.pct}%`, borderRadius: 2.5, background: `linear-gradient(90deg, ${T.success}, color-mix(in srgb, ${T.success} 70%, ${T.business}))` }} />
            </span>
            <span style={{ fontSize: 10, fontWeight: 700, color: T.success, flex: 'none', fontVariantNumeric: 'tabular-nums' }}><CountUp value={derived.pct} />%</span>
          </div>
        )}
        {/* 状态分布堆叠条 + 统计 */}
        <div style={{ display: 'flex', gap: 2, marginTop: 6, height: 4, borderRadius: 2, overflow: 'hidden' }}>
          {statusOrder.filter((s) => derived.statusCounts[s] > 0).map((s) => (
            <span key={s} style={{ flex: derived.statusCounts[s], background: statusColor(s), opacity: s === 'todo' ? 0.35 : 0.8 }} />
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 5, fontSize: 9.5, color: T.caption, fontVariantNumeric: 'tabular-nums', flexWrap: 'wrap', alignItems: 'center' }}>
          <span>{file.nodes.length} {t('digest.units.nodes')}</span>
          <span>{derived.entryCount} {t('digest.units.entries')}</span>
          {derived.boundExp > 0 && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <span style={{ width: 6, height: 6, borderRadius: 999, background: derived.runningExp > 0 ? T.teal : T.caption }} />
              {t('digest.binding', { running: derived.runningExp, bound: derived.boundExp })}
            </span>
          )}
        </div>
      </div>

      {/* 工具栏:搜索 + 排序 + 状态筛选 */}
      <div className="traj-noprint" style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
        <SearchInput value={query} onChange={setQuery} placeholder={t('digest.searchPh')} />
        <div style={{ display: 'flex', borderRadius: 7, border: '1px solid var(--dsw-alias-border-l2)', overflow: 'hidden', flex: 'none' }}>
          {(['mainline', 'time'] as SortMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setSortMode(m)}
              style={{
                border: 'none', cursor: 'pointer', padding: '3px 9px', fontSize: 10,
                background: sortMode === m ? 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 16%, transparent)' : 'transparent',
                color: sortMode === m ? T.business : T.secondary,
                fontWeight: sortMode === m ? 600 : 400,
              }}
            >{t(m === 'mainline' ? 'digest.sortMainline' : 'digest.sortTime')}</button>
          ))}
        </div>
      </div>
      <div className="traj-noprint" style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        {(['all', ...TRAJ_STATUSES] as StatusFilter[]).map((s) => {
          const active = statusFilter === s;
          const count = derived.statusCounts[s] ?? 0;
          const color = s === 'all' ? T.secondary : statusColor(s);
          return (
            <button
              key={s}
              type="button"
              className="traj-press"
              onClick={() => setStatusFilter(s)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4, height: 19, padding: '0 7px',
                borderRadius: 999, border: '1px solid', cursor: 'pointer', fontSize: 9.5,
                borderColor: active ? color : 'var(--dsw-alias-border-l2)',
                background: active ? `color-mix(in srgb, ${color} 15%, transparent)` : 'transparent',
                color: active ? color : 'var(--dsw-alias-label-secondary)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {s !== 'all' && <span style={{ width: 5, height: 5, borderRadius: 999, background: color }} />}
              {s === 'all' ? t('graph.all') : t(STATUS_LABELS[s])}
              <span style={{ opacity: 0.7 }}>{count}</span>
            </button>
          );
        })}
      </div>

      {/* 主线里程碑时间线 */}
      {visMainline.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <span aria-hidden style={{ width: 3.4, height: 11, borderRadius: 1.7, background: T.business }} />
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.06em', color: T.caption }}>
              {t(sortMode === 'time' ? 'digest.mainlineTime' : 'digest.mainlineEvo')}
            </span>
          </div>
          <div style={{ position: 'relative', paddingLeft: 26 }}>
            <span aria-hidden style={{
              position: 'absolute', left: 9, top: 8, bottom: 8, width: 2, borderRadius: 1,
              background: `color-mix(in srgb, ${T.business} 30%, transparent)`,
            }} />
            {visMainline.map((node, i) => {
              const done = node.status === 'done';
              const idx = file.project.mainline.indexOf(node.id);
              return (
                <div key={node.id} className="traj-stagger" style={{ position: 'relative', marginBottom: 10, ['--i' as string]: String(i) } as React.CSSProperties}>
                  <span aria-hidden className={`traj-pop${done ? ' traj-done-dot' : ''}`} style={{
                    position: 'absolute', left: -26, top: 4, width: 20, height: 20, borderRadius: 999,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: done ? T.success : node.status === 'in_progress' ? T.business : 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.2))',
                    color: '#fff', fontSize: 10, fontWeight: 700,
                    border: '2px solid var(--dsw-alias-bg-base)',
                    zIndex: 1, fontVariantNumeric: 'tabular-nums', ['--i' as string]: String(i),
                  } as React.CSSProperties}>
                    {done ? '✓' : (sortMode === 'time' ? '' : idx + 1)}
                  </span>
                  {/* 时间序:圆点下方显示日期刻度 */}
                  {sortMode === 'time' && (
                    <span style={{
                      position: 'absolute', left: -26, top: 26, width: 20, textAlign: 'center',
                      fontSize: 8, color: T.caption, fontVariantNumeric: 'tabular-nums',
                    }}>{fmtMD(nodeTime(node))}</span>
                  )}
                  <DigestNode node={node} progress={progress} t={t} onOpen={onOpen} onDelete={onDelete} onDeleteEntry={(eid) => onDeleteEntry(node.id, eid)} onStatus={onStatus} defaultOpen={!filtered} />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 分支工作 */}
      {visBranches.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, marginTop: 12 }}>
            <span aria-hidden style={{ width: 3.4, height: 11, borderRadius: 1.7, background: T.caption }} />
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.06em', color: T.caption }}>{t('digest.branches')}</span>
          </div>
          {visBranches.map((n) => (
            <DigestNode key={n.id} node={n} progress={progress} t={t} onOpen={onOpen} onDelete={onDelete} onDeleteEntry={(eid) => onDeleteEntry(n.id, eid)} onStatus={onStatus} />
          ))}
        </div>
      )}

      {/* 筛选空态 */}
      {filtered && visMainline.length === 0 && visBranches.length === 0 && (
        <div style={{ textAlign: 'center', color: T.caption, fontSize: 11.5, padding: '28px 0' }}>
          {t('digest.filterEmpty')}
          <button type="button" onClick={() => { setQuery(''); setStatusFilter('all'); }} style={{ marginLeft: 8, border: 'none', background: 'none', color: T.business, cursor: 'pointer', fontSize: 11, textDecoration: 'underline' }}>
            {t('graph.showAll')}
          </button>
        </div>
      )}

      {/* 待办(弱化;仅未筛选时展示) */}
      {!filtered && derived.statusCounts.todo > 0 && (
        <div style={{ marginTop: 14, paddingTop: 10, borderTop: '1px dashed var(--dsw-alias-border-l2)' }}>
          <div style={{ fontSize: 9.5, color: T.caption, marginBottom: 6 }}>{t('digest.todos')}</div>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {file.nodes.filter((n) => n.status === 'todo').map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => onOpen(n)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid var(--dsw-alias-border-l2)',
                  background: 'transparent', borderRadius: 999, padding: '2px 9px', fontSize: 10,
                  color: T.secondary, cursor: 'pointer', maxWidth: 220, overflow: 'hidden',
                }}
              >
                <span style={{ color: statusColor(n.status), fontSize: 9 }}>{GLYPH[n.kind] ?? '○'}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{truncate(n.title, 24)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {file.nodes.length === 0 && (
        <div style={{ textAlign: 'center', color: T.caption, fontSize: 11.5, padding: '40px 0' }}>
          {t('common.empty')}
        </div>
      )}
    </div>
  );
}

/* ---------- 汇报模式(story):复用清单页的视觉语言(问题卡/时间线/节点卡/台账),
   只读投影变体——有层次有条理,组会投屏与抽屉「汇报」页签共用 ---------- */

export function TrajStoryView({ t, file, progress, compact }: {
  t: TFunc;
  file: TrajProjectFile | null;
  progress: Map<string, DashProgress>;
  /** 抽屉内窄幅渲染:收紧留白 */
  compact?: boolean;
}) {
  if (!file) return <div style={{ padding: 20, color: T.caption }}>{t('common.loading')}</div>;
  const lg = !compact;

  const byId = new Map(file.nodes.map((n) => [n.id, n]));
  const mainline = file.project.mainline.filter((id) => byId.has(id)).map((id) => byId.get(id)!);
  const mainlineSet = new Set(mainline.map((n) => n.id));
  const branches = file.nodes
    .filter((n) => !mainlineSet.has(n.id))
    .sort((a, b) => openRank(a.status) - openRank(b.status) || b.updatedAt - a.updatedAt);
  const doneMain = mainline.filter((n) => n.status === 'done').length;
  const pct = mainline.length ? Math.round((doneMain / mainline.length) * 100) : 0;
  const entryCount = file.nodes.reduce((s, n) => s + (n.entries?.length ?? 0), 0);
  const statusCounts: Record<string, number> = {};
  for (const s of TRAJ_STATUSES) statusCounts[s] = 0;
  for (const n of file.nodes) statusCounts[n.status] = (statusCounts[n.status] ?? 0) + 1;
  const statusOrder: TrajStatus[] = ['done', 'in_progress', 'blocked', 'todo', 'dropped'];
  const boundExp = file.nodes.filter((n) => n.kind === 'experiment' && n.refs && (n.refs.logPath || n.refs.cmdPattern));
  const runningExp = boundExp.filter((n) => progress.has(n.id)).length;
  const blockers = file.nodes.filter((n) => n.status === 'blocked');
  const todos = file.nodes.filter((n) => n.status === 'todo');

  const SectionHead = ({ label, accent, top }: { label: string; accent?: string; top?: boolean }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, marginTop: top ? 14 : 12 }}>
      <span aria-hidden style={{ width: 3.4, height: 11, borderRadius: 1.7, background: accent ?? T.caption }} />
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.06em', color: T.caption }}>{label}</span>
    </div>
  );

  return (
    <div className="traj-scroll" data-dsh-part="trajectory-story" style={compact
      ? { flex: 1, minHeight: 0, overflow: 'auto', padding: '10px 12px 24px', width: '100%' }
      : { flex: 1, minHeight: 0, overflow: 'auto', padding: '18px 30px 36px', maxWidth: 880, margin: '0 auto', width: '100%' }}>
      <TrajStyles />

      {/* 研究问题卡(与清单同款:问题 + 进度头图 + 状态分布) */}
      <div style={{
        borderRadius: 11, padding: lg ? '12px 14px' : '10px 12px', marginBottom: 10,
        border: '1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 30%, transparent)',
        background: 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 7%, transparent)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
          <Icon d={Icons.bulb} size={lg ? 14 : 13} color={T.business} />
          <span style={{ fontSize: lg ? 11 : 10, fontWeight: 700, letterSpacing: '.08em', color: T.business }}>{t('digest.question')}</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: lg ? 12 : 10.5, fontWeight: 700, color: 'var(--dsw-alias-label-primary)' }}>{file.project.name}</span>
        </div>
        <div style={{ fontSize: lg ? 14 : 12.5, fontWeight: 600, lineHeight: 1.6, color: 'var(--dsw-alias-label-primary)' }}>
          {file.project.researchQuestion || file.project.description || t('digest.questionEmpty')}
        </div>
        {mainline.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <span style={{ fontSize: lg ? 11.5 : 10, color: T.secondary, flex: 'none', fontVariantNumeric: 'tabular-nums' }}>
              {t('digest.progress', { done: doneMain, total: mainline.length })}
            </span>
            <span style={{ flex: 1, height: lg ? 6 : 5, borderRadius: 3, background: 'rgba(127,127,127,.18)', position: 'relative', overflow: 'hidden' }}>
              <span className="traj-bar" style={{ position: 'absolute', inset: 0, width: `${pct}%`, borderRadius: 3, background: `linear-gradient(90deg, ${T.success}, color-mix(in srgb, ${T.success} 70%, ${T.business}))` }} />
            </span>
            {lg && <span style={{ fontSize: 14, fontWeight: 800, color: T.success, flex: 'none', fontVariantNumeric: 'tabular-nums' }}><CountUp value={pct} />%</span>}
          </div>
        )}
        <div style={{ display: 'flex', gap: 2, marginTop: 7, height: 4, borderRadius: 2, overflow: 'hidden' }}>
          {statusOrder.filter((s) => statusCounts[s] > 0).map((s) => (
            <span key={s} style={{ flex: statusCounts[s], background: statusColor(s), opacity: s === 'todo' ? 0.35 : 0.8 }} />
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 5, fontSize: lg ? 10.5 : 9.5, color: T.caption, fontVariantNumeric: 'tabular-nums', flexWrap: 'wrap', alignItems: 'center' }}>
          <span>{file.nodes.length} {t('digest.units.nodes')}</span>
          <span>{entryCount} {t('digest.units.entries')}</span>
          {boundExp.length > 0 && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <span style={{ width: 6, height: 6, borderRadius: 999, background: runningExp > 0 ? T.teal : T.caption }} />
              {t('digest.binding', { running: runningExp, bound: boundExp.length })}
            </span>
          )}
        </div>
      </div>

      {/* 主线演变:与清单同款时间线(脊柱 + 编号圆点 + 节点卡 + 台账常开) */}
      {mainline.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          <SectionHead label={t('digest.mainlineEvo')} accent={T.business} top={false} />
          <div style={{ position: 'relative', paddingLeft: 26 }}>
            <span aria-hidden style={{
              position: 'absolute', left: 9, top: 8, bottom: 8, width: 2, borderRadius: 1,
              background: `color-mix(in srgb, ${T.business} 30%, transparent)`,
            }} />
            {mainline.map((node, i) => {
              const done = node.status === 'done';
              return (
                <div key={node.id} className="traj-stagger" style={{ position: 'relative', marginBottom: 10, ['--i' as string]: String(i) } as React.CSSProperties}>
                  <span aria-hidden className={`traj-pop${done ? ' traj-done-dot' : ''}`} style={{
                    position: 'absolute', left: -26, top: 4, width: 20, height: 20, borderRadius: 999,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: done ? T.success : node.status === 'in_progress' ? T.business : 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.2))',
                    color: '#fff', fontSize: 10, fontWeight: 700,
                    border: '2px solid var(--dsw-alias-bg-base)',
                    zIndex: 1, fontVariantNumeric: 'tabular-nums', ['--i' as string]: String(i),
                  } as React.CSSProperties}>
                    {done ? '✓' : i + 1}
                  </span>
                  <DigestNode node={node} progress={progress} t={t} present />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 分支工作(与清单同款卡) */}
      {branches.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          <SectionHead label={t('digest.branches')} />
          {branches.map((n) => (
            <DigestNode key={n.id} node={n} progress={progress} t={t} present />
          ))}
        </div>
      )}

      {/* 当前卡点(琥珀警示条卡) */}
      {blockers.length > 0 && (
        <div>
          <SectionHead label={t('story.blockers')} accent={T.warning} />
          {blockers.map((n) => (
            <div key={n.id} style={{
              borderRadius: 10, border: '1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f5a524) 35%, transparent)',
              borderLeft: `3px solid ${T.warning}`,
              background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f5a524) 6%, transparent)',
              padding: '8px 12px', marginBottom: 8,
            }}>
              <div style={{ fontSize: lg ? 13 : 12, fontWeight: 600, lineHeight: 1.4 }}>
                <span style={{ color: T.warning, marginRight: 6 }}>●</span>{n.title}
              </div>
              {n.detail && <div style={{ fontSize: lg ? 11.5 : 10.5, color: T.secondary, lineHeight: 1.55, marginTop: 3 }}>{n.detail}</div>}
            </div>
          ))}
        </div>
      )}

      {/* 下一步(弱化 chips,与清单同款) */}
      {todos.length > 0 && (
        <div style={{ marginTop: 14, paddingTop: 10, borderTop: '1px dashed var(--dsw-alias-border-l2)' }}>
          <div style={{ fontSize: 9.5, color: T.caption, marginBottom: 6 }}>{t('digest.todos')}</div>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {todos.map((n) => (
              <span key={n.id} style={{
                display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid var(--dsw-alias-border-l2)',
                background: 'transparent', borderRadius: 999, padding: '2px 9px', fontSize: 10,
                color: T.secondary, maxWidth: 220, overflow: 'hidden',
              }}>
                <span style={{ color: statusColor(n.status), fontSize: 9 }}>{GLYPH[n.kind] ?? '○'}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{truncate(n.title, 24)}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {file.nodes.length === 0 && (
        <div style={{ textAlign: 'center', color: T.caption, fontSize: 11.5, padding: '40px 0' }}>
          {t('common.empty')}
        </div>
      )}
    </div>
  );
}
