import React, { useEffect, useMemo, useState } from 'react';
import type { TrajEntry, TrajGoal, TrajGoalLog, TrajHypothesis, TrajMetric, TrajNode, TrajProjectFile, TrajStatus } from '../shared/types';
import { TRAJ_STATUSES } from '../shared/types';
import type { DashProgress } from './dash';
import type { TFunc } from './nav';
import { Icon, Icons, relTime, SearchInput, statusColor, T, TrajStyles, truncate } from './ui';
import { NODE_KIND_LABELS, STATUS_LABELS } from './locales';

const HYP_STATUS_ZH: Record<string, string> = {
  active: '进行中', validated: '已证实', falsified: '已证否', superseded: '已替代', parked: '已搁置',
};
const TRACK_ZH: Record<string, string> = {
  mainline: '主线', branch: '探索分支', detour: '已偏离', returned: '已回归',
};
const TRACK_COLOR: Record<string, string> = {
  mainline: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
  branch: 'var(--dsw-alias-label-caption)',
  detour: 'var(--dsw-alias-state-warn-primary, #f5a524)',
  returned: 'var(--dsw-alias-state-success-primary, #30a46c)',
};
const HYP_STATUS_COLOR: Record<string, string> = {
  active: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
  validated: 'var(--dsw-alias-state-success-primary, #30a46c)',
  falsified: 'var(--dsw-alias-state-error-primary, #e5484d)',
  superseded: 'var(--dsw-alias-label-caption)',
  parked: 'var(--dsw-alias-state-warn-primary, #f5a524)',
};

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

/** v0.3 层 0:目标演化头部 — 当前目标 + 版本 + 演化历史折叠 */
function GoalHeader({ t, file, goalLog }: { t: TFunc; file: TrajProjectFile; goalLog: TrajGoalLog[] }) {
  const [showHistory, setShowHistory] = React.useState(false);
  const activeGoal = file.goals?.find((g) => g.status === 'active')
    ?? [...(file.goals ?? [])].sort((a, b) => b.version - a.version)[0];
  if (!activeGoal) return null;

  const supersededGoals = (file.goals ?? []).filter((g) => g.status === 'superseded');
  const pct = (() => {
    const hyps = (file.hypotheses ?? []).filter((h) => h.goalVersionId === activeGoal.id);
    if (!hyps.length) return 0;
    const done = hyps.filter((h) => h.status === 'validated').length;
    return Math.round((done / hyps.length) * 100);
  })();

  return (
    <div style={{
      borderRadius: 11, padding: '12px 14px', marginBottom: 10,
      border: '1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 35%, transparent)',
      background: 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 8%, transparent)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <Icon d={Icons.bulb} size={14} color={T.business} />
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em', color: T.business }}>
          {t('digest.question')} · v{activeGoal.version}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 12, fontWeight: 700 }}>{file.project.name}</span>
      </div>
      <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.6, color: 'var(--dsw-alias-label-primary)' }}>
        {activeGoal.text}
      </div>
      {/* 假设完成度 */}
      {(file.hypotheses ?? []).filter((h) => h.goalVersionId === activeGoal.id).length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <span style={{ fontSize: 10.5, color: T.secondary, flex: 'none', fontVariantNumeric: 'tabular-nums' }}>
            假设 {((file.hypotheses ?? []).filter((h) => h.goalVersionId === activeGoal.id && h.status === 'validated')).length}/{(file.hypotheses ?? []).filter((h) => h.goalVersionId === activeGoal.id).length} 证实
          </span>
          <span style={{ flex: 1, height: 5, borderRadius: 2.5, background: 'rgba(127,127,127,.18)', position: 'relative', overflow: 'hidden' }}>
            <span className="traj-bar" style={{ position: 'absolute', inset: 0, width: `${pct}%`, borderRadius: 2.5, background: `linear-gradient(90deg, ${T.success}, color-mix(in srgb, ${T.success} 70%, ${T.business}))` }} />
          </span>
          <span style={{ fontSize: 13, fontWeight: 800, color: T.success, fontVariantNumeric: 'tabular-nums' }}><CountUp value={pct} />%</span>
        </div>
      )}
      {/* 演化历史折叠 */}
      {(supersededGoals.length > 0 || goalLog.length > 3) && (
        <div style={{ marginTop: 8 }}>
          <button
            type="button"
            onClick={() => setShowHistory(!showHistory)}
            style={{
              border: 'none', background: 'none', cursor: 'pointer', padding: 0,
              fontSize: 10, color: T.business, display: 'inline-flex', alignItems: 'center', gap: 4,
            }}
          >
            <span style={{ display: 'inline-flex', transform: showHistory ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}><Icon d={Icons.chevronDown} size={10} /></span>
            目标演化({supersededGoals.length} 次修订 · {goalLog.length} 条日志)
          </button>
          {showHistory && (
            <div style={{ marginTop: 6, maxHeight: 200, overflow: 'auto', fontSize: 10.5, lineHeight: 1.6 }}>
              {goalLog.slice(0, 15).map((log) => (
                <div key={log.id} style={{ display: 'flex', gap: 6, padding: '2px 0', borderBottom: '1px solid rgba(127,127,127,.08)' }}>
                  <span style={{ color: T.caption, flex: 'none', minWidth: 42, fontVariantNumeric: 'tabular-nums' }}>
                    {new Date(log.ts).getMonth() + 1}/{new Date(log.ts).getDate()}
                  </span>
                  <span style={{ color: T.secondary, flex: 1 }}>{log.description}</span>
                </div>
              ))}
              {goalLog.length > 15 && <div style={{ color: T.caption, paddingTop: 4 }}>…另有 {goalLog.length - 15} 条</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** v0.3 层 1:假设卡 — 假设文本 + 状态/轨迹标签 + 下挂实验 */
function HypothesisCard({ t, hyp, nodes, progress, onOpen, onDelete, onDeleteEntry, onStatus, defaultOpen }: {
  t: TFunc;
  hyp: TrajHypothesis;
  nodes: TrajNode[];
  progress: Map<string, any>;
  onOpen: (n: TrajNode) => void;
  onDelete: (n: TrajNode) => void;
  onDeleteEntry?: (nodeId: string, entryId: string) => void;
  onStatus?: (n: TrajNode, s: TrajStatus) => void;
  defaultOpen?: boolean;
}) {
  const expNodes = nodes.filter((n) => n.hypothesisId === hyp.id);
  const trackC = TRACK_COLOR[hyp.track] ?? T.caption;
  const statusC = HYP_STATUS_COLOR[hyp.status] ?? T.caption;
  const isMainline = hyp.track === 'mainline';

  return (
    <div
      className="traj-stagger"
      data-dsh-part="hypothesis-card"
      style={{
        borderRadius: 10,
        border: `1px solid ${isMainline ? 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 25%, transparent)' : 'var(--dsw-alias-border-l2)'}`,
        borderLeft: `3px solid ${trackC}`,
        background: isMainline ? 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 4%, transparent)' : 'transparent',
        padding: '8px 10px', marginBottom: 8,
      }}
    >
      {/* 假设文本行 */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7 }}>
        <span style={{ fontSize: 11, color: trackC, flex: 'none', marginTop: 1 }}>◆</span>
        <span style={{ fontSize: 12.5, fontWeight: 600, flex: 1, minWidth: 0, lineHeight: 1.45, color: hyp.status === 'falsified' ? T.caption : 'var(--dsw-alias-label-primary)', textDecoration: hyp.status === 'falsified' ? 'line-through' : undefined }}>
          {hyp.text}
        </span>
        <span style={{
          fontSize: 9, color: statusC, flex: 'none', padding: '1px 6px', borderRadius: 999,
          background: `color-mix(in srgb, ${statusC} 13%, transparent)`, whiteSpace: 'nowrap',
        }}>
          {HYP_STATUS_ZH[hyp.status] ?? hyp.status}
        </span>
        <span style={{
          fontSize: 9, color: trackC, flex: 'none', padding: '1px 6px', borderRadius: 999,
          background: `color-mix(in srgb, ${trackC} 10%, transparent)`, whiteSpace: 'nowrap',
        }}>
          {TRACK_ZH[hyp.track] ?? hyp.track}
        </span>
      </div>
      {/* outcome 原因 */}
      {hyp.outcomeReason && (
        <div style={{ marginTop: 3, marginLeft: 18, fontSize: 10.5, color: T.secondary, lineHeight: 1.5 }}>
          {hyp.outcomeReason}
        </div>
      )}
      {/* 下挂实验列表 */}
      {expNodes.length > 0 && (
        <div style={{ marginTop: 6, marginLeft: 6 }}>
          {expNodes.map((node) => (
            <DigestNode
              key={node.id}
              node={node}
              progress={progress}
              t={t}
              onOpen={onOpen}
              onDelete={onDelete}
              onDeleteEntry={onDeleteEntry ? (entryId) => onDeleteEntry(node.id, entryId) : undefined}
              onStatus={onStatus}
              defaultOpen={defaultOpen}
            />
          ))}
        </div>
      )}
      {expNodes.length === 0 && (
        <div style={{ marginLeft: 18, marginTop: 4, fontSize: 10, color: T.caption, fontStyle: 'italic' }}>
          (尚无实验)
        </div>
      )}
    </div>
  );
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
  progress: Map<string, any>;
  onOpen: (node: TrajNode) => void;
  onDelete: (node: TrajNode) => void;
  onDeleteEntry: (nodeId: string, entryId: string) => void;
  onStatus?: (node: TrajNode, s: TrajStatus) => void;
}) {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<TrajStatus | 'all'>('all');

  const derived = useMemo(() => {
    if (!file) return null;
    const hyps = file.hypotheses ?? [];
    const activeGoal = file.goals?.find((g) => g.status === 'active');
    const currentHyps = (activeGoal ? hyps.filter((h) => h.goalVersionId === activeGoal.id) : hyps).filter((h) => h.status !== 'superseded');
    const statusCounts: Record<string, number> = { all: file.nodes.length };
    for (const s of TRAJ_STATUSES) statusCounts[s] = 0;
    for (const n of file.nodes) statusCounts[n.status] = (statusCounts[n.status] ?? 0) + 1;
    return {
      currentHyps,
      mainlineHyps: currentHyps.filter((h) => h.track === 'mainline'),
      branchHyps: currentHyps.filter((h) => h.track !== 'mainline'),
      statusCounts,
    };
  }, [file]);

  if (!file || !derived) return <ListSkeleton />;

  const q = query.trim().toLowerCase();
  const matchQ = (n: TrajNode) => !q || [n.title, n.detail ?? '', ...(n.tags ?? []),
    ...(n.entries ?? []).map((e) => `${e.title} ${e.data ?? ''}`)]
    .join('').toLowerCase().includes(q);
  const matchS = (n: TrajNode) => statusFilter === 'all' || n.status === statusFilter;
  const filterNodes = (nodes: TrajNode[]) => nodes.filter((n) => matchQ(n) && matchS(n));
  const filtered = q !== '' || statusFilter !== 'all';

  return (
    <div className="traj-scroll" data-dsh-plugin="dsh-trajectory" data-dsh-part="trajectory-list"
      style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '6px 12px 14px' }}>
      <TrajStyles />
      <GoalHeader t={t} file={file} goalLog={file.goalLog ?? []} />
      <div className="traj-noprint" style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
        <SearchInput value={query} onChange={setQuery} placeholder={t('digest.searchPh')} />
      </div>
      <div className="traj-noprint" style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        {(['all', ...TRAJ_STATUSES] as (TrajStatus | 'all')[]).map((s) => {
          const active = statusFilter === s;
          const count = derived.statusCounts[s] ?? 0;
          const color = s === 'all' ? T.secondary : statusColor(s);
          return (
            <button key={s} type="button" className="traj-press" onClick={() => setStatusFilter(s)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4, height: 19, padding: '0 7px',
                borderRadius: 999, border: '1px solid', cursor: 'pointer', fontSize: 9.5,
                borderColor: active ? color : 'var(--dsw-alias-border-l2)',
                background: active ? `color-mix(in srgb, ${color} 15%, transparent)` : 'transparent',
                color: active ? color : 'var(--dsw-alias-label-secondary)',
              }}>
              {s !== 'all' && <span style={{ width: 5, height: 5, borderRadius: 999, background: color }} />}
              {s === 'all' ? t('graph.all') : t(STATUS_LABELS[s])}
              <span style={{ opacity: 0.7 }}>{count}</span>
            </button>
          );
        })}
      </div>
      {derived.mainlineHyps.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, marginTop: 4 }}>
            <span aria-hidden style={{ width: 3.4, height: 11, borderRadius: 1.7, background: T.business }} />
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.06em', color: T.caption }}>主线假设</span>
          </div>
          {derived.mainlineHyps.map((hyp) => (
            <HypothesisCard key={hyp.id} t={t} hyp={hyp} nodes={filterNodes(file.nodes.filter((n) => n.hypothesisId === hyp.id))}
              progress={progress} onOpen={onOpen} onDelete={onDelete} onDeleteEntry={onDeleteEntry} onStatus={onStatus} />
          ))}
        </div>
      )}
      {derived.branchHyps.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, marginTop: 12 }}>
            <span aria-hidden style={{ width: 3.4, height: 11, borderRadius: 1.7, background: T.caption }} />
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.06em', color: T.caption }}>探索分支 / 偏离</span>
          </div>
          {derived.branchHyps.map((hyp) => (
            <HypothesisCard key={hyp.id} t={t} hyp={hyp} nodes={filterNodes(file.nodes.filter((n) => n.hypothesisId === hyp.id))}
              progress={progress} onOpen={onOpen} onDelete={onDelete} onDeleteEntry={onDeleteEntry} onStatus={onStatus} />
          ))}
        </div>
      )}
      {(() => {
        const activeHypIds = new Set([...derived.mainlineHyps, ...derived.branchHyps].map((h) => h.id));
        const unassigned = filterNodes(file.nodes.filter((n) => !n.hypothesisId || !activeHypIds.has(n.hypothesisId)));
        if (!unassigned.length) return null;
        return (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, marginTop: 12 }}>
              <span style={{ width: 3.4, height: 11, borderRadius: 1.7, background: T.caption }} />
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.06em', color: T.caption }}>未分类实验</span>
            </div>
            {unassigned.map((n) => (
              <DigestNode key={n.id} node={n} progress={progress} t={t} onOpen={onOpen} onDelete={onDelete}
                onDeleteEntry={onDeleteEntry ? (eid) => onDeleteEntry(n.id, eid) : undefined} onStatus={onStatus} />
            ))}
          </div>
        );
      })()}
      {filtered && !file.nodes.some((n) => matchQ(n) && matchS(n)) && (
        <div style={{ textAlign: 'center', color: T.caption, fontSize: 11.5, padding: '28px 0' }}>
          {t('digest.filterEmpty')}
          <button type="button" onClick={() => { setQuery(''); setStatusFilter('all'); }}
            style={{ marginLeft: 8, border: 'none', background: 'none', color: T.business, cursor: 'pointer', fontSize: 11, textDecoration: 'underline' }}>
            {t('graph.showAll')}
          </button>
        </div>
      )}
      {!filtered && file.nodes.filter((n) => n.status === 'todo').length > 0 && (
        <div style={{ marginTop: 14, paddingTop: 10, borderTop: '1px dashed var(--dsw-alias-border-l2)' }}>
          <div style={{ fontSize: 9.5, color: T.caption, marginBottom: 6 }}>{t('digest.todos')}</div>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {file.nodes.filter((n) => n.status === 'todo').map((n) => (
              <button key={n.id} type="button" onClick={() => onOpen(n)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid var(--dsw-alias-border-l2)',
                  background: 'transparent', borderRadius: 999, padding: '2px 9px', fontSize: 10,
                  color: T.secondary, cursor: 'pointer', maxWidth: 220, overflow: 'hidden',
                }}>
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



export function TrajStoryView({ t, file, progress, compact }: {
  t: TFunc;
  file: TrajProjectFile | null;
  progress: Map<string, any>;
  compact?: boolean;
}) {
  if (!file) return <div style={{ padding: 20, color: T.caption }}>{t('common.loading')}</div>;

  const goalLog = file.goalLog ?? [];
  const hyps = file.hypotheses ?? [];
  const activeGoal = file.goals?.find((g) => g.status === 'active')
    ?? [...(file.goals ?? [])].sort((a, b) => b.version - a.version)[0];
  const currentHyps = (activeGoal ? hyps.filter((h) => h.goalVersionId === activeGoal.id) : hyps).filter((h) => h.status !== 'superseded');
  const mainlineHyps = currentHyps.filter((h) => h.track === 'mainline');
  const branchHyps = currentHyps.filter((h) => h.track !== 'mainline');
  const todos = file.nodes.filter((n) => n.status === 'todo');
  const lg = !compact;

  return (
    <div className="traj-scroll" data-dsh-part="trajectory-story" style={compact
      ? { flex: 1, minHeight: 0, overflow: 'auto', padding: '10px 12px 24px', width: '100%' }
      : { flex: 1, minHeight: 0, overflow: 'auto', padding: '18px 30px 36px', maxWidth: 880, margin: '0 auto', width: '100%' }}>
      <TrajStyles />
      <GoalHeader t={t} file={file} goalLog={goalLog} />

      {mainlineHyps.map((hyp, i) => (
        <HypothesisCard key={hyp.id} t={t} hyp={hyp} nodes={file.nodes} progress={progress}
          onOpen={() => {}} onDelete={() => {}} />
      ))}

      {branchHyps.length > 0 && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, marginTop: 12 }}>
            <span aria-hidden style={{ width: 3.4, height: 11, borderRadius: 1.7, background: T.caption }} />
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.06em', color: T.caption }}>探索分支</span>
          </div>
          {branchHyps.map((hyp) => (
            <HypothesisCard key={hyp.id} t={t} hyp={hyp} nodes={file.nodes} progress={progress}
              onOpen={() => {}} onDelete={() => {}} />
          ))}
        </>
      )}

      {todos.length > 0 && (
        <div style={{ marginTop: 14, paddingTop: 10, borderTop: '1px dashed var(--dsw-alias-border-l2)' }}>
          <div style={{ fontSize: 9.5, color: T.caption, marginBottom: 6 }}>{t('digest.todos')}</div>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {todos.map((n) => (
              <span key={n.id} style={{
                display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid var(--dsw-alias-border-l2)',
                borderRadius: 999, padding: '2px 9px', fontSize: 10, color: T.secondary,
              }}>
                <span style={{ color: statusColor(n.status), fontSize: 9 }}>{GLYPH[n.kind] ?? '○'}</span>
                {truncate(n.title, 24)}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
