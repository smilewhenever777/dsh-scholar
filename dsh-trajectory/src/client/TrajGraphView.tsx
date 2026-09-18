import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TrajEdge, TrajNode, TrajProjectFile, TrajStatus } from '../shared/types';
import { TRAJ_STATUSES } from '../shared/types';
import type { DashProgress } from './dash';
import type { TFunc } from './nav';
import {
  Btn, edgeColor, EmptyState, Icon, IconButton, Icons, kindColor, MAINLINE_ACCENT, SearchInput,
  statusColor, T, TrajStyles, truncate,
} from './ui';
import { EDGE_KIND_LABELS, NODE_KIND_LABELS, STATUS_LABELS } from './locales';

/* ---------- geometry constants (v2: 大信息卡 + 画布感) ---------- */
const NODE_W = 230;
const NODE_H = 96;
const COL_W = NODE_W + 70;
const LANE_H = 120;
const ROW_H = NODE_H + 36; // 竖排主线行距
const LANE_X = NODE_W + 40; // 竖排分支横向间距
const PAD_X = 50;
const PAD_Y = 40;
const SPINE_BAND = NODE_H + 20;

interface Pos { x: number; y: number }

/** 状态筛选:'all' + 各状态 */
export type StatusFilter = TrajStatus | 'all';

/**
 * Deterministic layered DAG layout:
 *  - mainline nodes occupy fixed columns on the y=0 spine (order = project.mainline)
 *  - branch nodes relax to layer(s)+1 over dependency edges (longest path,
 *    cycle-guarded), then stack around the spine alternating above/below,
 *    ordered within a column by the barycenter of their parents' y.
 */
function layoutDag(file: TrajProjectFile, dragOffsets: Map<string, Pos>): { pos: Map<string, Pos>; extent: { w: number; h: number } } {
  const nodes = file.nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const mainline = file.project.mainline.filter((id) => byId.has(id));
  const spineRank = new Map(mainline.map((id, i) => [id, i]));

  // 1) layers (x columns)
  const layer = new Map<string, number>();
  for (const id of mainline) layer.set(id, spineRank.get(id)!);
  // 推进上限 = 节点数:历史成环数据(写入侧已拒绝新建)不会把层号甩到 n+2 的极远处
  const cap = nodes.length;
  for (let iter = 0; iter < nodes.length; iter++) {
    let changed = false;
    for (const e of file.edges) {
      if (!byId.has(e.source) || !byId.has(e.target)) continue;
      if (spineRank.has(e.target)) continue; // spine fixed
      const ls = layer.get(e.source);
      const want = (ls ?? 0) + 1;
      const cur = layer.get(e.target) ?? 0;
      if (want > cur && want <= cap) {
        layer.set(e.target, want);
        changed = true;
      }
    }
    if (!changed) break; // 一整轮无任何层变化即收敛(防环震荡/多余遍历)
  }

  // 2) positions(竖排:主线沿 y 轴自上而下,分支沿 x 轴左右展开)
  const pos = new Map<string, Pos>();
  for (const n of nodes) {
    const l = layer.get(n.id) ?? 0;
    pos.set(n.id, { x: 0, y: PAD_X + l * ROW_H });
  }
  for (const id of mainline) {
    const p = pos.get(id)!;
    p.x = 0;
  }

  // 3) branch lanes per column, ordered by parents' barycenter, stacked alternating around spine
  const parents = new Map<string, string[]>();
  for (const e of file.edges) {
    if (!byId.has(e.source) || !byId.has(e.target) || spineRank.has(e.target)) continue;
    if (!parents.has(e.target)) parents.set(e.target, []);
    parents.get(e.target)!.push(e.source);
  }
  const columns = new Map<number, TrajNode[]>();
  for (const n of nodes) {
    if (spineRank.has(n.id)) continue;
    const l = layer.get(n.id) ?? 0;
    if (!columns.has(l)) columns.set(l, []);
    columns.get(l)!.push(n);
  }
  const yOf = (id: string): number => pos.get(id)?.y ?? 0;
  let maxLane = 0;
  for (const [, col] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    col.sort((a, b) => {
      const pa = parents.get(a.id) ?? [];
      const pb = parents.get(b.id) ?? [];
      const ba = pa.reduce((s, id) => s + yOf(id), 0) / Math.max(1, pa.length);
      const bb = pb.reduce((s, id) => s + yOf(id), 0) / Math.max(1, pb.length);
      return ba - bb || a.createdAt - b.createdAt;
    });
    const slots = [1, -1, 2, -2, 3, -3, 4, -4, 5, -5];
    col.forEach((n, i) => {
      // 槽位公式:先按固定表交替占位(±1…±5);第 11 个起按符号交替、绝对值递增续排,
      // 第二行起天然带行偏移且与首行不重叠(旧公式 i≥13 时会撞回首行槽位)
      const slot = i < slots.length
        ? slots[i]
        : (i % 2 === 0 ? 1 : -1) * (Math.floor(i / 2) + 1);
      maxLane = Math.max(maxLane, Math.abs(slot));
      pos.get(n.id)!.x = slot * LANE_X;
    });
  }

  // 4) user drag offsets (visual only, session-scoped)
  for (const [id, off] of dragOffsets) {
    const p = pos.get(id);
    if (p) { p.x += off.x; p.y += off.y; }
  }

  const maxLayer = Math.max(0, ...[...layer.values()]);
  return {
    pos,
    extent: { w: (maxLane + 1) * 2 * LANE_X + PAD_X * 2, h: PAD_Y * 2 + maxLayer * ROW_H + NODE_H },
  };
}

const KIND_GLYPH: Record<string, string> = {
  milestone: '★', idea: '◆', experiment: '▷', paper: '▣', writing: '✎', other: '○',
};

function nodeMatches(n: TrajNode, f: string): boolean {
  const s = f.toLowerCase();
  return n.title.toLowerCase().includes(s) || (n.tags ?? []).some((x) => x.toLowerCase().includes(s));
}

export function TrajGraphView({ t, file, progress, filter, onFilter, statusFilter, onStatusFilter, selectedId, onSelect, onEdit, onAdd, onStatus, onDelete, onToggleMainline, onFullPage }: {
  t: TFunc;
  file: TrajProjectFile | null;
  progress: Map<string, DashProgress>;
  filter: string;
  onFilter: (v: string) => void;
  statusFilter: StatusFilter;
  onStatusFilter: (v: StatusFilter) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onEdit: (node: TrajNode) => void;
  onAdd: () => void;
  onStatus: (node: TrajNode, s: TrajStatus) => void;
  onDelete: (node: TrajNode) => void;
  onToggleMainline: (node: TrajNode) => void;
  /** 进入全页视图(可省:清单/内嵌场景) */
  onFullPage?: () => void;
}) {
  const [size, setSize] = useState({ w: 380, h: 300 });
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [dragNode, setDragNode] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);
  const [dragTick, setDragTick] = useState(0); // 节点拖拽期间递增,驱动 pos memo 重算
  const dragOrigin = useRef<{ mx: number; my: number; px: number; py: number } | null>(null);
  const panOrigin = useRef({ x: 0, y: 0, vx: 0, vy: 0 });
  const dragOffsets = useRef(new Map<string, Pos>());
  const svgRef = useRef<SVGSVGElement>(null);
  const fitScaleRef = useRef(1);
  /** fitView 待执行标志:挂载后首次布局 / 项目切换时置位,布局就绪后消费一次 */
  const fitOnLoad = useRef(true);

  /* measure container */
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setSize({ w: r.width, h: r.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* layout (recomputed on data change; drag offsets persist across data refreshes
     via the ref but reset when the project changes) */
  const projectId = file?.project.id ?? null;
  useEffect(() => {
    dragOffsets.current = new Map();
    fitOnLoad.current = true; // 切换项目:重置拖拽偏移 + 重新适配视图
  }, [projectId]);

  // dragTick 入 deps:节点拖拽改的是 dragOffsets(ref,引用不变),靠 tick 强制重算;
  // 不再原地改 memo 结果(mutate-memo 反模式)
  const { pos, extent } = useMemo(
    () => (file ? layoutDag(file, dragOffsets.current) : { pos: new Map<string, Pos>(), extent: { w: 400, h: 240 } }),
    [file, dragTick],
  );

  const byId = useMemo(() => new Map((file?.nodes ?? []).map((n) => [n.id, n])), [file]);
  const mainlineList = useMemo(() => (file?.project.mainline ?? []).filter((id) => byId.has(id)), [file]);
  const mainlineSet = useMemo(() => new Set(mainlineList), [mainlineList]);
  const spineConsecutive = useMemo(() => {
    const out: [string, string][] = [];
    for (let i = 0; i + 1 < mainlineList.length; i++) out.push([mainlineList[i], mainlineList[i + 1]]);
    return out;
  }, [mainlineList]);
  const directEdge = useCallback((a: string, b: string) =>
    (file?.edges ?? []).some((e) => e.source === a && e.target === b), [file]);

  /* 状态筛选计数 */
  const statusCounts = useMemo(() => {
    const c: Record<string, number> = { all: file?.nodes.length ?? 0 };
    for (const s of TRAJ_STATUSES) c[s] = 0;
    for (const n of file?.nodes ?? []) c[n.status] = (c[n.status] ?? 0) + 1;
    return c;
  }, [file]);

  /* filter → dim non-matching (layout stays stable) */
  const matchSet = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f || !file) return null;
    return new Set(file.nodes.filter((n) => nodeMatches(n, f)).map((n) => n.id));
  }, [filter, file]);

  /* status filter → hide non-matching entirely (layout recomputed on subset) */
  const displayFile = useMemo<TrajProjectFile | null>(() => {
    if (!file || statusFilter === 'all') return file;
    return {
      ...file,
      nodes: file.nodes.filter((n) => n.status === statusFilter),
      edges: file.edges.filter((e) => {
        const a = byId.get(e.source);
        const b = byId.get(e.target);
        return a?.status === statusFilter && b?.status === statusFilter;
      }),
    };
  }, [file, statusFilter, byId]);

  // 筛选视图的布局同样叠加 dragOffsets(修复状态筛选激活时拖拽视觉失效)
  const displayPos = useMemo(
    () => (displayFile ? layoutDag(displayFile, dragOffsets.current).pos : new Map<string, Pos>()),
    [displayFile, dragTick],
  );
  // When status filter is active, display positions replace full positions for
  // rendered coordinates (drag offsets apply in both views via dragOffsets).
  const renderPos = statusFilter === 'all' ? pos : displayPos;

  /* highlight: hover/selected node + 1-hop */
  const focusId = hoverId ?? selectedId;
  const highlight = useMemo(() => {
    if (!focusId || !displayFile) return null;
    const nodes = new Set<string>([focusId]);
    const edges = new Set<number>();
    displayFile.edges.forEach((e, i) => {
      if (e.source === focusId || e.target === focusId) {
        nodes.add(e.source); nodes.add(e.target); edges.add(i);
      }
    });
    return { nodes, edges };
  }, [focusId, displayFile]);

  /* 客户端环检测(写入侧已拒绝新建成环边;此处兜底历史数据):
     每条边单独判断——从 target 沿现有边 DFS 能回到 source 即该边落在环上 */
  const cycleEdgeCount = useMemo(() => {
    if (!file || file.edges.length === 0) return 0;
    const adj = new Map<string, string[]>();
    for (const e of file.edges) {
      const list = adj.get(e.source);
      if (list) list.push(e.target);
      else adj.set(e.source, [e.target]);
    }
    let count = 0;
    for (const e of file.edges) {
      const seen = new Set<string>([e.target]);
      const stack = [e.target];
      let hit = e.target === e.source;
      while (!hit && stack.length) {
        const cur = stack.pop()!;
        for (const next of adj.get(cur) ?? []) {
          if (next === e.source) { hit = true; break; }
          if (!seen.has(next)) { seen.add(next); stack.push(next); }
        }
      }
      if (hit) count++;
    }
    return count;
  }, [file]);

  const fitView = useCallback(() => {
    if (!size.w || !size.h || !extent.w) return;
    const scale = Math.max(0.55, Math.min(2.2, Math.min((size.w - 24) / extent.w, (size.h - 24) / extent.h)));
    fitScaleRef.current = scale;
    setView({ x: size.w / 2, y: size.h / 2, scale });
  }, [size.w, size.h, extent.w, extent.h]);

  /* fitView 只在三种情况下执行:挂载后首次布局、切换项目、手动点击 fit 按钮。
     数据轮询刷新(新 pos 引用)不得触发,否则用户平移/缩放每 10s 被重置。 */
  useEffect(() => {
    if (!fitOnLoad.current) return;
    if (!size.w || !size.h || !extent.w) return; // 等待容器量测/布局就绪
    fitOnLoad.current = false;
    fitView();
  }, [fitView, size.w, size.h, extent.w, extent.h]);

  /* 主线描线动画:边按 dashoffset 从全长画到 0(按渲染序递进)。
   * 仅在项目/规模变化时重放(数据轮询刷新不重动);reduced-motion 直接跳过。 */
  const drawKeyRef = useRef('');
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !displayFile) return;
    const key = `${displayFile.project.id}:${displayFile.nodes.length}:${displayFile.edges.length}`;
    if (drawKeyRef.current === key) return;
    drawKeyRef.current = key;
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const els = svg.querySelectorAll<SVGGeometryElement>('.traj-edge');
    let i = 0;
    els.forEach((el) => {
      let len = 0;
      try { len = el.getTotalLength(); } catch { len = 0; }
      if (!Number.isFinite(len) || len <= 0) len = 60;
      el.style.strokeDasharray = String(len);
      el.style.strokeDashoffset = String(len);
      el.classList.add('traj-draw');
      el.style.transitionDelay = `${Math.min(i * 26, 260)}ms`;
      i++;
    });
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => {
      els.forEach((el) => { el.style.strokeDashoffset = '0'; });
      // 脊柱连接线本应是 4/5 虚线:描线结束后还原其 dash 样式并摘除过渡
      setTimeout(() => {
        svg.querySelectorAll<SVGLineElement>('line.traj-edge').forEach((el) => {
          el.style.strokeDasharray = '4 5';
          el.style.transitionDelay = '';
          el.classList.remove('traj-draw');
        });
      }, 1000);
    }));
    return () => cancelAnimationFrame(raf);
  }, [displayFile]);

  const selected = selectedId ? byId.get(selectedId) ?? null : null;
  const selectedEdges = useMemo(() => {
    if (!file || !selectedId) return [] as TrajEdge[];
    return file.edges.filter((e) => e.source === selectedId || e.target === selectedId);
  }, [file, selectedId]);

  const onWheel = (e: React.WheelEvent) => {
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    setView((v) => ({ ...v, scale: Math.max(0.3, Math.min(2.5, v.scale * factor)) }));
  };
  const onPointerDownBg = (e: React.PointerEvent) => {
    if (dragNode) return;
    onSelect(null);
    setPanning(true);
    panOrigin.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragNode && dragOrigin.current) {
      const dx = (e.clientX - dragOrigin.current.mx) / view.scale;
      const dy = (e.clientY - dragOrigin.current.my) / view.scale;
      dragOffsets.current.set(dragNode, { x: dragOrigin.current.px + dx, y: dragOrigin.current.py + dy });
      setDragTick((v) => v + 1); // 触发 pos/displayPos memo 重算(不原地改 memo 结果)
      return;
    }
    if (panning) {
      setView({
        ...view,
        x: panOrigin.current.vx + (e.clientX - panOrigin.current.x),
        y: panOrigin.current.vy + (e.clientY - panOrigin.current.y),
      });
    }
  };
  const onPointerUp = () => { setDragNode(null); dragOrigin.current = null; setPanning(false); };

  if (!file) {
    return (
      <div style={{ flex: 1, minHeight: 0, padding: 14, fontSize: 12, color: T.caption }}>
        {t('common.loading')}
      </div>
    );
  }

  const zoomRatio = view.scale / (fitScaleRef.current || 1);
  const labelOpacity = Math.max(0.35, Math.min(1, (zoomRatio - 0.25) / 0.18));
  const dim = (id: string): number => {
    if (matchSet && !matchSet.has(id)) return 0.08;
    if (highlight && !highlight.nodes.has(id)) return 0.12;
    return 1;
  };

  // displayFile 可空(状态过滤无命中时 memo 返回 null)——提前退守
  if (!displayFile) return null;

  const showEmpty = displayFile.nodes.length === 0;
  const spineNodes = mainlineList.map((id) => byId.get(id)!).filter(Boolean);

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <TrajStyles />
      {/* toolbar */}
      <div className="traj-noprint" style={{ padding: '4px 10px 6px', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <SearchInput value={filter} onChange={onFilter} placeholder={t('graph.filterPh')} />
        <IconButton label={t('graph.fit')} onClick={fitView} icon={<Icon d={Icons.frame} size={13} />} />
        {onFullPage && (
          <IconButton label={t('graph.fullpage')} onClick={onFullPage} icon={<Icon d={Icons.expand} size={13} />} />
        )}
        {cycleEdgeCount > 0 && (
          <span
            title={t('graph.cycleWarnHint')}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4, height: 20, padding: '0 8px', flex: 'none',
              borderRadius: 999, fontSize: 10,
              border: `1px solid color-mix(in srgb, ${T.warning} 45%, transparent)`,
              background: `color-mix(in srgb, ${T.warning} 12%, transparent)`,
              color: T.warning, fontVariantNumeric: 'tabular-nums',
            }}
          >
            ⚠ {t('graph.cycleWarn', { n: cycleEdgeCount })}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span style={{
          fontSize: 10, color: T.secondary, padding: '2px 8px', borderRadius: 999, flex: 'none',
          background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))',
          fontVariantNumeric: 'tabular-nums',
        }}>
          {t('graph.nodes', { nodes: file.nodes.length, edges: file.edges.length })}
        </span>
      </div>

      {/* status filter chips (Linear 风格:chip + 计数) */}
      <div style={{ padding: '0 10px 6px', display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
        {(['all', ...TRAJ_STATUSES] as StatusFilter[]).map((s) => {
          const active = statusFilter === s;
          const count = statusCounts[s] ?? 0;
          const color = s === 'all' ? T.secondary : statusColor(s);
          return (
            <button
              key={s}
              type="button"
              onClick={() => onStatusFilter(s)}
              className="traj-press"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4, height: 20, padding: '0 8px',
                borderRadius: 999, border: '1px solid', cursor: 'pointer', fontSize: 10,
                borderColor: active ? color : 'var(--dsw-alias-border-l2)',
                background: active ? `color-mix(in srgb, ${color} 16%, transparent)` : 'transparent',
                color: active ? color : 'var(--dsw-alias-label-secondary)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {s !== 'all' && <span style={{ width: 6, height: 6, borderRadius: 999, background: color }} />}
              {s === 'all' ? t('graph.all') : t(STATUS_LABELS[s])}
              <span style={{ opacity: 0.7 }}>{count}</span>
            </button>
          );
        })}
      </div>

      {showEmpty && (
        <EmptyState
          icon={<Icon d={Icons.traj} size={38} />}
          title={statusFilter === 'all' ? t('graph.empty') : t('common.empty')}
          hint={statusFilter === 'all' ? t('graph.emptyHint') : undefined}
          action={statusFilter === 'all'
            ? <Btn tone="soft" onClick={onAdd}><Icon d={Icons.plus} size={12} /> {t('graph.add')}</Btn>
            : <Btn onClick={() => onStatusFilter('all')}>{t('graph.showAll')}</Btn>}
        />
      )}

      {!showEmpty && (
        <div
          data-dsh-plugin="dsh-trajectory"
          data-dsh-part="trajectory-graph"
          style={{
            flex: 1, minHeight: 0, position: 'relative', margin: '0 10px 8px',
            border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12,
            overflow: 'hidden',
            background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.04))',
          }}
        >
          <svg
            ref={svgRef}
            width="100%"
            height="100%"
            style={{ display: 'block', touchAction: 'none', cursor: panning ? 'grabbing' : 'grab' }}
            onWheel={onWheel}
            onPointerDown={onPointerDownBg}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={() => setHoverId(null)}
          >
            <defs>
              {/* 画布点阵(Heptabase/tldraw 质感) */}
              <pattern id="traj-dots" width="22" height="22" patternUnits="userSpaceOnUse">
                <circle cx="1.2" cy="1.2" r="1.1" fill="var(--dsw-alias-label-primary, #888)" opacity="0.06" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#traj-dots)" />
            <g transform={`translate(${view.x - (view.scale * extent.w) / 2},${view.y - (view.scale * extent.h) / 2}) scale(${view.scale})`}>
              {/* 主线脊柱带:贯穿的圆角 accent 带,路线图的「阶段轨道」 */}
              {spineNodes.length > 0 && (() => {
                const xs = spineNodes.map((n) => renderPos.get(n.id)).filter(Boolean) as Pos[];
                if (!xs.length) return null;
                const y1 = Math.min(...xs.map((p) => p.y)) - NODE_H / 2 - 14;
                const y2 = Math.max(...xs.map((p) => p.y)) + NODE_H / 2 + 14;
                const dimmed = highlight ? 0.35 : 1;
                return (
                  <g opacity={dimmed}>
                    <rect
                      x={-SPINE_BAND / 2} y={y1} width={SPINE_BAND} height={Math.max(40, y2 - y1)} rx={SPINE_BAND / 2}
                      fill={`color-mix(in srgb, ${MAINLINE_ACCENT} 10%, transparent)`}
                      stroke={`color-mix(in srgb, ${MAINLINE_ACCENT} 35%, transparent)`}
                      strokeWidth={1}
                    />
                    {/* 起止端点装饰 */}
                    <circle cx={0} cy={y1 + 10} r={3} fill={MAINLINE_ACCENT} opacity={0.7} />
                    <circle cx={0} cy={y2 - 10} r={3} fill={MAINLINE_ACCENT} opacity={0.35} />
                  </g>
                );
              })()}

              {/* spine connectors between consecutive mainline nodes without a direct edge */}
              {spineConsecutive.map(([a, b]) => {
                if (directEdge(a, b)) return null;
                const pa = renderPos.get(a); const pb = renderPos.get(b);
                if (!pa || !pb) return null;
                const midY = (pa.y + NODE_H / 2 + pb.y - NODE_H / 2) / 2;
                return (
                  <g key={`spine-${a}-${b}`}>
                    <line className="traj-edge" x1={pa.x} y1={pa.y + NODE_H / 2} x2={pb.x} y2={pb.y - NODE_H / 2}
                      stroke={MAINLINE_ACCENT} strokeWidth={1.8} strokeDasharray="4 5" opacity={0.6} />
                    <text x={pa.x + 8} y={midY} fontSize={9} fill={`color-mix(in srgb, ${MAINLINE_ACCENT} 70%, var(--dsw-alias-label-caption))`}
                      fontWeight={500} opacity={labelOpacity}>
                      主线
                    </text>
                  </g>
                );
              })}

              {/* edges: 带类型标签 + 可区分的线型 */}
              {displayFile.edges.map((e, i) => {
                const a = renderPos.get(e.source);
                const b = renderPos.get(e.target);
                if (!a || !b) return null;
                const x1 = a.x; const y1 = a.y + NODE_H / 2;
                const x2 = b.x; const y2 = b.y - NODE_H / 2 - 3;
                const color = edgeColor(e.kind);
                const isSpineEdge = mainlineSet.has(e.source) && mainlineSet.has(e.target)
                  && spineConsecutive.some(([s, tt]) => s === e.source && tt === e.target);
                const lit = !highlight || highlight.edges.has(i);
                const opacity = !lit ? 0.05 : matchSet && !(matchSet.has(e.source) && matchSet.has(e.target)) ? 0.08 : isSpineEdge ? 0.95 : 0.65;
                const sw = isSpineEdge ? 3.2 : lit && highlight ? 2.4 : 1.8;
                // 线型:enables=实线 / feeds=长虚线 / composes=双线(粗+旁边细线)
                const dash = e.kind === 'feeds' ? '10 5' : undefined;
                const c1y = y1 + Math.max(28, (y2 - y1) * 0.45);
                const c2y = y2 - Math.max(28, (y2 - y1) * 0.45);
                const ang = Math.atan2(y2 - y1, x2 - x1);
                const s = 5.5;
                const px = Math.cos(ang + Math.PI / 2); const py = Math.sin(ang + Math.PI / 2);
                // 标签位置:边中点,偏移避让线
                const mx = (x1 + x2) / 2;
                const my = (y1 + y2) / 2;
                const label = t(EDGE_KIND_LABELS[e.kind]);
                const labelW = label.length * 11 + 12;
                const isVertical = Math.abs(x2 - x1) < 5;
                return (
                  <g key={e.id} opacity={opacity}>
                    <path className="traj-edge" d={`M ${x1} ${y1} C ${x1} ${c1y}, ${x2} ${c2y}, ${x2} ${y2}`} fill="none"
                      stroke={color} strokeWidth={sw} strokeLinecap="round"
                      strokeDasharray={dash} />
                    {/* composes 双线效果:旁边一根细线 */}
                    {e.kind === 'composes' && (
                      <path d={`M ${x1 + 5} ${y1} C ${x1 + 5} ${c1y}, ${x2 + 5} ${c2y}, ${x2 + 5} ${y2}`} fill="none"
                        stroke={color} strokeWidth={1} opacity={0.5} />
                    )}
                    <polygon
                      points={`${x2 + Math.cos(ang) * s},${y2 + Math.sin(ang) * s} ${x2 - px * s * 0.65},${y2 - py * s * 0.65} ${x2 + px * s * 0.65},${y2 + py * s * 0.65}`}
                      fill={color}
                    />
                    {/* 类型标签:胶囊 */}
                    <g transform={`translate(${mx},${my})`}>
                      <rect x={-labelW / 2} y={-9} width={labelW} height={17} rx={8.5}
                        fill={`color-mix(in srgb, ${color} 14%, var(--dsw-alias-bg-base, #161616))`}
                        stroke={`color-mix(in srgb, ${color} 40%, transparent)`}
                        strokeWidth={0.8} />
                      <text x={0} y={3.5} textAnchor="middle" fontSize={10} fontWeight={600} fill={color}>
                        {label}
                      </text>
                    </g>
                  </g>
                );
              })}

              {/* nodes: 大信息卡 */}
              {displayFile.nodes.map((node, idx) => {
                const p = renderPos.get(node.id);
                if (!p) return null;
                const isSel = node.id === selectedId;
                const staggerI = Math.min(idx, 12);
                const onSpine = mainlineSet.has(node.id);
                const spineIdx = onSpine ? mainlineList.indexOf(node.id) : -1;
                const prog = progress.get(node.id);
                const op = dim(node.id);
                const done = node.status === 'done';
                const blocked = node.status === 'blocked';
                const dropped = node.status === 'dropped';
                const cardFill = done
                  ? `color-mix(in srgb, ${T.success} 7%, var(--dsw-alias-bg-layer-2, #222))`
                  : 'var(--dsw-alias-bg-layer-2, #222)';
                return (
                  <g
                    key={node.id + ':' + idx}
                    className="traj-stagger"
                    style={{ ['--i' as string]: String(staggerI) } as React.CSSProperties}
                  >
                  <g
                    transform={`translate(${p.x},${p.y})`}
                    style={{ cursor: 'pointer', opacity: dropped ? op * 0.55 : op }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      onSelect(node.id);
                      setDragNode(node.id);
                      const off = dragOffsets.current.get(node.id) ?? { x: 0, y: 0 };
                      dragOrigin.current = { mx: e.clientX, my: e.clientY, px: off.x, py: off.y };
                    }}
                    onPointerEnter={(e) => { e.stopPropagation(); setHoverId(node.id); }}
                    onPointerLeave={() => setHoverId((cur) => (cur === node.id ? null : cur))}
                  >
                    {/* 卡片阴影/选中光环 */}
                    <rect
                      x={-NODE_W / 2 - 3} y={-NODE_H / 2 - 3} width={NODE_W + 6} height={NODE_H + 6} rx={13}
                      fill="none"
                      stroke={isSel ? MAINLINE_ACCENT : 'transparent'}
                      strokeWidth={isSel ? 2.2 : 0}
                      opacity={0.55}
                    />
                    {/* 卡体 */}
                    <rect
                      x={-NODE_W / 2} y={-NODE_H / 2} width={NODE_W} height={NODE_H} rx={11}
                      fill={cardFill}
                      stroke={isSel ? T.business : onSpine ? `color-mix(in srgb, ${MAINLINE_ACCENT} 55%, transparent)` : 'var(--dsw-alias-border-l2)'}
                      strokeWidth={isSel ? 2.2 : onSpine ? 1.5 : 1.2}
                      style={{ filter: 'drop-shadow(0 2px 5px rgba(0,0,0,.22))' }}
                    />
                    {/* blocked 左侧警示条 */}
                    {blocked && (
                      <rect x={-NODE_W / 2} y={-NODE_H / 2} width={4.5} height={NODE_H} rx={2.2} fill={T.warning} />
                    )}
                    {/* milestone 编号 chip(阶段感) */}
                    {onSpine && spineIdx >= 0 && (
                      <>
                        <circle cx={-NODE_W / 2 + 17} cy={-NODE_H / 2 + 17} r={11} fill={MAINLINE_ACCENT} />
                        <text x={-NODE_W / 2 + 17} y={-NODE_H / 2 + 21} fontSize={13} fontWeight={700} textAnchor="middle" fill="#fff">
                          {spineIdx + 1}
                        </text>
                      </>
                    )}
                    {/* Row1: kind glyph + status pill */}
                    {!onSpine && (
                      <text x={-NODE_W / 2 + 12} y={-NODE_H / 2 + 21} fontSize={13} fill={kindColor(node.kind)}>{KIND_GLYPH[node.kind] ?? '○'}</text>
                    )}
                    <text
                      x={(onSpine ? -NODE_W / 2 + 33 : -NODE_W / 2 + 28)}
                      y={-NODE_H / 2 + 16} fontSize={11} fill={kindColor(node.kind)}
                      opacity={labelOpacity}
                    >
                      {t(NODE_KIND_LABELS[node.kind])}
                    </text>
                    <rect
                      x={NODE_W / 2 - 10 - Math.max(36, t(STATUS_LABELS[node.status]).length * 12)}
                      y={-NODE_H / 2 + 7}
                      width={Math.max(30, t(STATUS_LABELS[node.status]).length * 10.5) + 8}
                      height={18} rx={9}
                      fill={`color-mix(in srgb, ${statusColor(node.status)} 15%, transparent)`}
                    />
                    <circle
                      cx={NODE_W / 2 - 10 - Math.max(36, t(STATUS_LABELS[node.status]).length * 12) + 9}
                      cy={-NODE_H / 2 + 17} r={3.2} fill={statusColor(node.status)}
                    />
                    <text
                      x={NODE_W / 2 - 10 - Math.max(36, t(STATUS_LABELS[node.status]).length * 12) + 16}
                      y={-NODE_H / 2 + 21} fontSize={11} fontWeight={600} fill={statusColor(node.status)}
                      opacity={labelOpacity}
                    >
                      {t(STATUS_LABELS[node.status])}
                    </text>
                    {/* Row2: 标题(两行;按节点卡显示宽截断,中文 16 字会溢出 176px 卡宽) */}
                    <text x={-NODE_W / 2 + 11} y={-NODE_H / 2 + 44} fontSize={14} fontWeight={600}
                      fill="var(--dsw-alias-label-primary)"
                      opacity={labelOpacity}
                      style={{ textDecoration: dropped ? 'line-through' : undefined }}
                    >
                      {truncate(node.title, 20)}
                    </text>
                    {node.title.length > 14 && (
                      <text x={-NODE_W / 2 + 11} y={-NODE_H / 2 + 61} fontSize={14} fontWeight={600}
                        fill="var(--dsw-alias-label-primary)" opacity={labelOpacity}
                        style={{ textDecoration: dropped ? 'line-through' : undefined }}
                      >
                        {truncate(node.title.slice(20), 20)}
                      </text>
                    )}
                    {/* Row3: 进度条 / 引用图标 / 完成勾 */}
                    {node.kind === 'experiment' ? (
                      <>
                        <rect x={-NODE_W / 2 + 11} y={NODE_H / 2 - 16} width={NODE_W - 24} height={5.5} rx={2.75}
                          fill="var(--dsw-alias-bg-layer-1, rgba(127,127,127,.18))" />
                        {prog?.pct != null && (
                          <rect x={-NODE_W / 2 + 11} y={NODE_H / 2 - 13} width={Math.max(3, ((NODE_W - 24) * prog.pct) / 100)} height={5.5} rx={2.75}
                            fill={prog.stale ? T.warning : T.teal} />
                        )}
                        <text x={NODE_W / 2 - 11} y={NODE_H / 2 - 4} fontSize={11} textAnchor="end"
                          fill={prog ? (prog.stale ? T.warning : T.teal) : T.caption}
                          opacity={labelOpacity}
                          style={{ fontVariantNumeric: 'tabular-nums' }}
                        >
                          {prog ? (prog.stale ? `${t('node.stale')}` : (prog.label || t('node.progress'))) : t('node.notRunning')}
                        </text>
                      </>
                    ) : done ? (
                      <text x={-NODE_W / 2 + 11} y={NODE_H / 2 - 6} fontSize={11.5} fill={T.success} opacity={labelOpacity}>✓ {t('status.done')}</text>
                    ) : blocked ? (
                      <text x={-NODE_W / 2 + 11} y={NODE_H / 2 - 6} fontSize={11.5} fill={T.warning} opacity={labelOpacity}>⚠ {t('status.blocked')}</text>
                    ) : (node.refs?.cardId || node.refs?.paperId) ? (
                      <text x={-NODE_W / 2 + 11} y={NODE_H / 2 - 6} fontSize={11} fill={T.caption} opacity={labelOpacity}>
                        {node.refs?.cardId ? '◆ ' : ''}{node.refs?.paperId ? '▣ ' : ''}{truncate(node.refs?.paperLabel || node.refs?.cardLabel || node.refs?.paperId || node.refs?.cardId || '', 20)}
                      </text>
                    ) : null}
                  </g>
                  </g>
                );
              })}
            </g>
          </svg>

          {/* legend */}
          <div style={{
            position: 'absolute', left: 10, bottom: 10, display: 'flex', gap: 8, flexWrap: 'wrap',
            fontSize: 9.5, color: T.caption, borderRadius: 8, padding: '5px 9px', pointerEvents: 'none',
            background: 'color-mix(in srgb, var(--dsw-alias-bg-base, #161616) 78%, transparent)',
            border: '1px solid var(--dsw-alias-border-l2)',
            backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
          }}>
            {(['enables', 'feeds', 'composes'] as const).map((k) => (
              <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 10, height: 2, borderRadius: 1, background: edgeColor(k), display: 'inline-block' }} />
                {t(EDGE_KIND_LABELS[k])}
              </span>
            ))}
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 12, height: 0, borderTop: `2px dashed ${MAINLINE_ACCENT}`, display: 'inline-block' }} />
              {t('graph.mainline')}
            </span>
          </div>

          {/* selected node info card */}
          {selected && (
            <div className="traj-fade" style={{
              position: 'absolute', right: 10, top: 10, width: 276,
              background: 'color-mix(in srgb, var(--dsw-alias-bg-base, #161616) 88%, transparent)',
              backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
              border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12,
              padding: '10px 12px', fontSize: 11,
              boxShadow: 'var(--dsw-shadow-lv2, 0 8px 24px rgba(0,0,0,.3))',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span aria-hidden style={{ fontSize: 10, color: kindColor(selected.kind), flex: 'none' }}>{KIND_GLYPH[selected.kind] ?? '○'}</span>
                <span style={{ fontWeight: 600, flex: 1, lineHeight: 1.35 }}>{selected.title}</span>
                <IconButton label={t('common.close')} size={17} onClick={() => onSelect(null)} icon={<Icon d={Icons.close} size={9} />} />
              </div>
              <div style={{ marginTop: 3, display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 9.5, color: kindColor(selected.kind) }}>{t(NODE_KIND_LABELS[selected.kind])}</span>
                <span style={{ fontSize: 9.5, color: T.caption }}>·</span>
                <span style={{ fontSize: 9.5, color: statusColor(selected.status) }}>{t(STATUS_LABELS[selected.status])}</span>
                {mainlineSet.has(selected.id) && (
                  <span style={{ fontSize: 9.5, color: MAINLINE_ACCENT }}>· ★{t('node.spine')}</span>
                )}
                {(() => {
                  const prog = progress.get(selected.id);
                  if (!prog) return null;
                  return (
                    <span style={{ fontSize: 9.5, color: prog.stale ? T.warning : T.teal }}>
                      · {prog.stale ? `${t('node.stale')} ` : ''}{prog.label || (prog.running ? t('node.progress') : t('node.notRunning'))}
                    </span>
                  );
                })()}
              </div>

              {/* status quick-set */}
              <div style={{ display: 'flex', gap: 3, marginTop: 7 }}>
                {(['todo', 'in_progress', 'blocked', 'done', 'dropped'] as TrajStatus[]).map((s) => {
                  const active = selected.status === s;
                  return (
                    <button
                      key={s}
                      type="button"
                      title={t(STATUS_LABELS[s])}
                      onClick={() => onStatus(selected, s)}
                      className="traj-press"
                      style={{
                        flex: 1, height: 18, borderRadius: 5, border: 'none', cursor: 'pointer', fontSize: 9,
                        background: active ? statusColor(s) : 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.12))',
                        color: active ? '#fff' : 'var(--dsw-alias-label-secondary)',
                        fontWeight: active ? 700 : 400,
                      }}
                    >
                      {t(STATUS_LABELS[s])}
                    </button>
                  );
                })}
              </div>

              {selected.detail && (
                <div style={{ marginTop: 6, fontSize: 10.5, color: T.secondary, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
                  {selected.detail}
                </div>
              )}

              {(selected.refs?.cardId || selected.refs?.paperId || selected.refs?.logPath || selected.refs?.cmdPattern) && (
                <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--dsw-alias-border-l2)' }}>
                  {selected.refs?.cardId && (
                    <button type="button" onClick={() => window.dispatchEvent(new CustomEvent('dsh-scholar-nav', { detail: { cardId: selected.refs?.cardId } }))}
                      title={t('digest.openInScholar')} style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', background: 'none', cursor: 'pointer', fontSize: 10, color: T.business, marginTop: 2, padding: 0 }}>
                      ◆ {selected.refs.cardLabel || selected.refs.cardId} ⇗
                    </button>
                  )}
                  {selected.refs?.paperId && (
                    <button type="button" onClick={() => window.dispatchEvent(new CustomEvent('dsh-scholar-nav', { detail: { paperId: selected.refs?.paperId } }))}
                      title={t('digest.openInScholar')} style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', background: 'none', cursor: 'pointer', fontSize: 10, color: T.business, marginTop: 2, padding: 0 }}>
                      ▣ {selected.refs.paperLabel || selected.refs.paperId} ⇗
                    </button>
                  )}
                  {(selected.refs?.logPath || selected.refs?.cmdPattern) && (
                    <div style={{ fontSize: 10, color: T.caption, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={selected.refs?.logPath ?? selected.refs?.cmdPattern}>
                      ▷ {selected.refs?.logPath ?? selected.refs?.cmdPattern}
                    </div>
                  )}
                </div>
              )}

              <div style={{ display: 'flex', gap: 5, marginTop: 8 }}>
                <Btn tone="soft" onClick={() => onToggleMainline(selected)}>
                  {mainlineSet.has(selected.id) ? `− ${t('graph.mainline')}` : `+ ${t('graph.mainline')}`}
                </Btn>
                <Btn onClick={() => onEdit(selected)}><Icon d={Icons.edit} size={11} /> {t('common.edit')}</Btn>
                <Btn tone="danger" onClick={() => onDelete(selected)}><Icon d={Icons.trash} size={11} /></Btn>
              </div>
            </div>
          )}
        </div>
      )}
      <div style={{ fontSize: 9.5, color: T.caption, padding: '0 12px 6px', userSelect: 'none' }}>
        {t('graph.dragHint')}
      </div>
    </div>
  );
}
