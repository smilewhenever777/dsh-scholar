import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GraphEdge, GraphNode, KnowledgeGraph } from '../shared/types';
import { api } from './api';
import { navBus, type TFunc } from './nav';
import { Btn, edgeColor, EmptyState, Icon, IconButton, Icons, SchStyles, SearchInput, Select, T, truncate } from './ui';
import { EDGE_KIND_LABELS } from './locales';

const EDGE_KINDS = ['proposes', 'improves', 'extends', 'builds_on', 'compares', 'uses'] as const;
const PAPER_H = 24;
const CONCEPT_BASE_R = 4.5;

interface Pos { x: number; y: number }

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setV(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return v;
}

/**
 * Lightweight force-directed layout (no third-party deps):
 * repulsion between all pairs + springs along edges + column gravity
 * (papers left, concepts right). Bounded iterations; fine for ≤ 500 nodes.
 */
function simulate(graph: KnowledgeGraph, width: number, height: number): Map<string, Pos> {
  const pos = new Map<string, Pos>();
  const vel = new Map<string, { vx: number; vy: number }>();
  const n = graph.nodes.length;
  if (n === 0) return pos;
  const pad = 70;
  const w = Math.max(200, width - pad * 2);
  const h = Math.max(200, height - pad * 2);
  const colPaper = pad + w * 0.24;
  const colConcept = pad + w * 0.76;
  for (const node of graph.nodes) {
    const col = node.kind === 'paper' ? colPaper : colConcept;
    pos.set(node.id, {
      x: col + (Math.random() - 0.5) * w * 0.35,
      y: pad + (Math.random() - 0.5) * h * 0.8 + h / 2,
    });
    vel.set(node.id, { vx: 0, vy: 0 });
  }
  const k = Math.sqrt((w * h) / n) * 0.85;
  const iterations = n > 350 ? 120 : 260;

  for (let iter = 0; iter < iterations; iter++) {
    const t = 1 - iter / iterations;
    // repulsion
    for (let i = 0; i < n; i++) {
      const a = graph.nodes[i];
      const pa = pos.get(a.id) as Pos;
      const va = vel.get(a.id) as { vx: number; vy: number };
      for (let j = i + 1; j < n; j++) {
        const b = graph.nodes[j];
        const pb = pos.get(b.id) as Pos;
        const dx = pa.x - pb.x;
        const dy = pa.y - pb.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) d2 = 1;
        const d = Math.sqrt(d2);
        const f = Math.min((k * k) / d2, k * 0.35);
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        va.vx += fx; va.vy += fy;
        const vb = vel.get(b.id) as { vx: number; vy: number };
        vb.vx -= fx; vb.vy -= fy;
      }
    }
    // springs
    for (const e of graph.edges) {
      const pa = pos.get(e.source);
      const pb = pos.get(e.target);
      if (!pa || !pb) continue;
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - k) * 0.05;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      const va = vel.get(e.source) as { vx: number; vy: number };
      const vb = vel.get(e.target) as { vx: number; vy: number };
      va.vx += fx; va.vy += fy;
      vb.vx -= fx; vb.vy -= fy;
    }
    // gravity to column + center
    for (const node of graph.nodes) {
      const p = pos.get(node.id) as Pos;
      const c = vel.get(node.id) as { vx: number; vy: number };
      const col = node.kind === 'paper' ? colPaper : colConcept;
      p.x += (col - p.x) * 0.015 * t;
      p.y += (height / 2 - p.y) * 0.005 * t;
      c.vx += (width / 2 - p.x) * 0.002;
      c.vy += (height / 2 - p.y) * 0.002;
    }
    // integrate
    for (const node of graph.nodes) {
      const p = pos.get(node.id) as Pos;
      const c = vel.get(node.id) as { vx: number; vy: number };
      p.x += c.vx * t;
      p.y += c.vy * t;
      c.vx *= 0.85;
      c.vy *= 0.85;
      p.x = Math.max(24, Math.min(width - 24, p.x));
      p.y = Math.max(24, Math.min(height - 24, p.y));
    }
  }
  return pos;
}

export function GraphView({ t }: { t: TFunc }) {
  const [graph, setGraph] = useState<KnowledgeGraph | null>(null);
  const [error, setError] = useState('');
  /** 非致命降级(unsynced 加载失败)的提示条 */
  const [degraded, setDegraded] = useState('');
  const [unsynced, setUnsynced] = useState<{ id: string; title: string }[]>([]);
  const [copied, setCopied] = useState(false);
  const [filter, setFilter] = useState('');
  const [depth, setDepth] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  /** 当前实际尺寸(fitView / 指针换算用);测量前为 0 */
  const [size, setSize] = useState({ w: 0, h: 0 });
  /** 最近一次 simulate 提交时的尺寸;null = 尚未测量(此时不模拟,消除挂载双模拟) */
  const layoutSizeRef = useRef<{ w: number; h: number } | null>(null);
  /** bump 才按新尺寸重排(settle 后宽度变化 ≥40px) */
  const [layoutKey, setLayoutKey] = useState(0);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const [dragNode, setDragNode] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);
  const [, setPositionsTick] = useState(0);
  const panOrigin = useRef({ x: 0, y: 0, vx: 0, vy: 0 });
  const svgRef = useRef<SVGSVGElement>(null);

  // 过滤输入防抖:每敲一字不再全量模拟
  const debouncedFilter = useDebounced(filter, 250);

  // svg 只在 graph 加载后才渲染,observer 需依赖 [graph] 才能真正挂上
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    let lastW = 0;
    let lastH = 0;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      const w = r.width;
      const h = r.height;
      if (w === lastW && h === lastH) return;
      if (!layoutSizeRef.current) {
        // 首次测量:以真实尺寸提交,只在此刻模拟一次
        layoutSizeRef.current = { w, h };
        setSize({ w, h });
        setLayoutKey((k) => k + 1);
      } else {
        // 拖动抽屉过程中:只按新旧宽度比例等比缩放现有坐标,不重算 simulate
        const rw = lastW ? w / lastW : 1;
        const rh = lastH ? h / lastH : 1;
        if (rw !== 1 || rh !== 1) {
          for (const p of posState.current.values()) {
            p.x *= rw;
            p.y *= rh;
          }
          setPositionsTick((v) => v + 1);
        }
        setSize({ w, h });
      }
      lastW = w;
      lastH = h;
      // resize 结束(150ms 无新事件)且宽度变化 ≥40px 才重算布局
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        const c = layoutSizeRef.current;
        if (!c) return;
        const r2 = el.getBoundingClientRect();
        if (r2.width <= 0 || r2.height <= 0) return;
        if (Math.abs(r2.width - c.w) >= 40 || Math.abs(r2.height - c.h) >= 40) {
          layoutSizeRef.current = { w: r2.width, h: r2.height };
          setSize({ w: r2.width, h: r2.height });
          setLayoutKey((k) => k + 1);
        }
      }, 150);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (settleTimer) clearTimeout(settleTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  useEffect(() => {
    void api<{ graph: KnowledgeGraph }>('/scholar/graph')
      .then((r) => { setGraph(r.graph); setError(''); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    void api<{ unsynced: { id: string; title: string }[] }>('/scholar/stats')
      .then((r) => { setUnsynced(r.unsynced ?? []); setDegraded(''); })
      .catch((e) => {
        // 静默吞错会让"未入图"横幅莫名消失——留痕 + 提示条
        console.warn('dsh-scholar: unsynced stats load failed', e);
        setDegraded(t('common.partialLoadFailed'));
      });
  }, [t]);

  // filter → local graph around ANY matching node (concept OR paper), BFS
  // depth-adjustable like Obsidian's local graph
  const display = useMemo<KnowledgeGraph | null>(() => {
    if (!graph) return null;
    const f = debouncedFilter.trim().toLowerCase();
    if (!f) return graph;
    const center = graph.nodes.find((n) => n.id.toLowerCase().includes(f) || n.label.toLowerCase().includes(f));
    if (!center) return { nodes: [], edges: [] };

    const adj = new Map<string, { other: string; e: GraphEdge; key: string }[]>();
    for (const e of graph.edges) {
      const key = `${e.source}|${e.kind}|${e.target}`;
      if (!adj.has(e.source)) adj.set(e.source, []);
      if (!adj.has(e.target)) adj.set(e.target, []);
      adj.get(e.source)!.push({ other: e.target, e, key });
      adj.get(e.target)!.push({ other: e.source, e, key });
    }
    const seen = new Set<string>([center.id]);
    const edges: GraphEdge[] = [];
    const edgeSeen = new Set<string>();
    let frontier = [center.id];
    for (let d = 0; d < depth; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const { other, e, key } of adj.get(id) ?? []) {
          if (!edgeSeen.has(key)) { edgeSeen.add(key); edges.push(e); }
          if (!seen.has(other)) { seen.add(other); next.push(other); }
        }
      }
      frontier = next;
    }
    return { nodes: graph.nodes.filter((n) => seen.has(n.id)), edges };
  }, [graph, debouncedFilter, depth]);

  const positions = useMemo(() => {
    const sz = layoutSizeRef.current;
    // 未测量前返回空布局(不模拟);测量后以提交尺寸计算
    if (!display || !sz) return new Map<string, Pos>();
    return simulate(display, sz.w, sz.h);
    // 重排触发器:display 变化(数据/防抖后的过滤/深度)或显式 layoutKey bump
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [display, layoutKey]);
  const posState = useRef(positions);
  posState.current = positions;

  // node degree → Obsidian-style size scaling (hubs read bigger)
  const degree = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of display?.edges ?? []) {
      m.set(e.source, (m.get(e.source) ?? 0) + 1);
      m.set(e.target, (m.get(e.target) ?? 0) + 1);
    }
    return m;
  }, [display]);

  const conceptR = useCallback((id: string) => CONCEPT_BASE_R + Math.min(4.5, (degree.get(id) ?? 0) * 0.8), [degree]);
  const paperW = useCallback((id: string) => Math.min(200, 130 + Math.min(60, (degree.get(id) ?? 0) * 9)), [degree]);

  const byId = useMemo(() => {
    const m = new Map<string, GraphNode>();
    for (const n of display?.nodes ?? []) m.set(n.id, n);
    return m;
  }, [display]);

  /** hover-first highlight: focus node + neighbors, everything else dims */
  const focusId = hoverId ?? selectedId;
  const highlight = useMemo(() => {
    if (!focusId || !display) return null;
    const nodes = new Set<string>([focusId]);
    const edges = new Set<number>();
    display.edges.forEach((e, i) => {
      if (e.source === focusId || e.target === focusId) { nodes.add(e.source); nodes.add(e.target); edges.add(i); }
    });
    return { nodes, edges };
  }, [focusId, display]);

  const [syncMsg, setSyncMsg] = useState('');

  /** One-click heuristic sync: tags → concept nodes + uses edges (no AI) */
  const runAutoSync = async () => {
    try {
      const r = await api<{ addedNodes: number; addedEdges: number }>('/scholar/graph/auto-sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const [g, st] = await Promise.all([
        api<{ graph: KnowledgeGraph }>('/scholar/graph'),
        api<{ unsynced: { id: string; title: string }[] }>('/scholar/stats'),
      ]);
      setGraph(g.graph);
      setUnsynced(st.unsynced ?? []);
      setSyncMsg(t('graph.autoSyncDone', { n: r.addedNodes, m: r.addedEdges }));
      setTimeout(() => setSyncMsg(''), 3500);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /** Copy a ready-to-paste prompt so the chat AI can sync new papers into the graph */
  const copySyncPrompt = async () => {
    // 有意使用中文:这段是发给中文对话模型的指令文本(非 UI 文案),保持中文语义最稳,勿 i18n
    const names = unsynced.slice(0, 6).map((u) => '「' + u.title + '」').join('、');
    const text = '请更新知识图谱：为这些新保存的论文补充概念节点与关系边（kg_extract）：' + names;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch { /* clipboard unavailable */ }
  };

  /** fit the whole graph into view (Obsidian-style recenter) */
  const fitScaleRef = useRef(1);
  const fitView = useCallback(() => {
    const arr = [...posState.current.values()];
    if (!arr.length || !size.w || !size.h) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of arr) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    // pad covers the widest node extent (paper rect half-width ~100px) plus margin
    const pad = 112;
    const bw = Math.max(100, maxX - minX);
    const bh = Math.max(100, maxY - minY);
    const scale = Math.max(0.25, Math.min(2.2, Math.min((size.w - pad * 2) / bw, (size.h - pad * 2) / bh)));
    fitScaleRef.current = scale;
    setView({
      x: size.w / 2 - scale * ((minX + maxX) / 2),
      y: size.h / 2 - scale * ((minY + maxY) / 2),
      scale,
    });
  }, [size.w, size.h]);

  // 仅在布局真正重算后(数据 / 防抖过滤 / 深度 / settle 重排)重新适配;
  // 拖动期间的纯等比缩放不重置用户的平移/缩放
  useEffect(() => {
    fitView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions]);

  const selected = selectedId ? byId.get(selectedId) ?? null : null;
  const selectedEdges = useMemo(() => {
    if (!display || !selectedId) return [];
    return display.edges.filter((e) => e.source === selectedId || e.target === selectedId);
  }, [display, selectedId]);

  // labels fade only when the user zooms OUT RELATIVE to the fitted view
  // (absolute scale is meaningless: small subgraphs fit below any threshold)
  const zoomRatio = view.scale / (fitScaleRef.current || 1);
  const labelOpacity = Math.max(0, Math.min(1, (zoomRatio - 0.45) / 0.3));

  // 滚轮缩放:React 的 onWheel 是 passive 事件,preventDefault 无效——
  // 用 ref 以非 passive 方式绑定,阻止页面滚动
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheelRaw = (ev: WheelEvent) => {
      ev.preventDefault();
      const factor = ev.deltaY > 0 ? 0.9 : 1.1;
      setView((v) => ({ ...v, scale: Math.max(0.25, Math.min(3, v.scale * factor)) }));
    };
    el.addEventListener('wheel', onWheelRaw, { passive: false });
    return () => el.removeEventListener('wheel', onWheelRaw);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  const onPointerDownBg = (e: React.PointerEvent) => {
    if (dragNode) return;
    setSelectedId(null);
    setPanning(true);
    panOrigin.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (dragNode) {
      const p = posState.current.get(dragNode);
      if (!p) return;
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return;
      const nx = (e.clientX - rect.left - view.x) / view.scale;
      const ny = (e.clientY - rect.top - view.y) / view.scale;
      p.x = nx;
      p.y = ny;
      // live physics (Obsidian-feel): springs pull direct neighbors along
      const moved = new Map(posState.current);
      const n = Math.max(1, moved.size);
      const k = Math.sqrt((size.w * size.h) / n) * 0.85;
      // 注意:内层遍历的边改名为 ed,避免遮蔽外层事件对象 e
      for (const ed of display?.edges ?? []) {
        let otherId: string | null = null;
        if (ed.source === dragNode) otherId = ed.target;
        else if (ed.target === dragNode) otherId = ed.source;
        if (!otherId) continue;
        const p2 = moved.get(otherId);
        if (!p2) continue;
        const dx = p.x - p2.x;
        const dy = p.y - p2.y;
        const d = Math.hypot(dx, dy) || 1;
        const pull = Math.max(-9, Math.min(9, (d - k) * 0.28));
        p2.x += (dx / d) * pull * 0.35;
        p2.y += (dy / d) * pull * 0.35;
      }
      posState.current = moved;
      setPositionsTick((v) => v + 1);
      return;
    }
    if (panning) {
      const dx = e.clientX - panOrigin.current.x;
      const dy = e.clientY - panOrigin.current.y;
      setView({ ...view, x: panOrigin.current.vx + dx, y: panOrigin.current.vy + dy });
    }
  };

  const onPointerUp = () => {
    setDragNode(null);
    setPanning(false);
  };

  if (!graph) {
    return (
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 14, fontSize: 12, color: T.caption, lineHeight: 1.6 }}>
        {error || t('common.loading')}
      </div>
    );
  }

  const showEmpty = display && display.nodes.length === 0;

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <SchStyles />
      {/* toolbar */}
      <div style={{ padding: '8px 10px 6px', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <SearchInput value={filter} onChange={(v) => { setFilter(v); setSelectedId(null); }} placeholder={t('graph.conceptFilterPh')} />
        {filter && (
          <Select value={depth} onChange={(e) => setDepth(Number(e.target.value))} title={t('graph.depth')} style={{ flex: 'none', minWidth: 62 }}>
            <option value={1}>{t('graph.hop', { n: 1 })}</option>
            <option value={2}>{t('graph.hop', { n: 2 })}</option>
          </Select>
        )}
        <IconButton label={t('graph.fit')} onClick={fitView} icon={<Icon d={Icons.frame} size={13} />} />

        <button
          type="button"
          onClick={() => void runAutoSync()}
          title={t('graph.autoSyncHint')}
          style={{
            display: 'inline-flex', alignItems: 'center', height: 26, flex: 'none',
            border: '1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 40%, transparent)',
            background: 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 12%, transparent)',
            color: T.business, borderRadius: 7, padding: '0 9px', cursor: 'pointer', fontSize: 11,
          }}
        >
          {syncMsg ? t('graph.autoSyncDoneShort') : t('graph.autoSync')}
        </button>
        <span style={{ flex: 1 }} />
        <span style={{
          fontSize: 10, color: T.secondary, padding: '2px 8px', borderRadius: 999, flex: 'none',
          background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))',
          fontVariantNumeric: 'tabular-nums',
        }}>
          {t('graph.nodes', { nodes: display?.nodes.length ?? 0, edges: display?.edges.length ?? 0 })}
        </span>
      </div>

      {error && (
        <div style={{ color: T.danger, padding: '0 12px 4px', fontSize: 11 }}>{error}</div>
      )}
      {degraded && !error && (
        <div style={{ color: T.warning, padding: '0 12px 4px', fontSize: 11 }}>{degraded}</div>
      )}

      {unsynced.length > 0 && !filter && (
        <div className="sch-fade" style={{
          margin: '0 10px 6px', padding: '6px 10px', borderRadius: 9, fontSize: 11,
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f5a524) 10%, transparent)',
          border: '1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f5a524) 30%, transparent)',
        }}>
          <span style={{ color: T.secondary, flex: '1 1 200px' }}>
            {t('graph.unsynced', { n: unsynced.length })} · {unsynced.slice(0, 3).map((u) => truncate(u.title, 18)).join('、')}{unsynced.length > 3 ? '…' : ''}
          </span>
          <button
            type="button"
            onClick={() => void runAutoSync()}
            style={{
              border: '1px solid var(--dsw-alias-state-business-primary, #4d6bfe)',
              background: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
              color: '#fff', borderRadius: 6, padding: '2px 10px', cursor: 'pointer', fontSize: 10.5,
              fontWeight: 600, flex: 'none',
            }}
          >
            {syncMsg || t('graph.autoSync')}
          </button>
          <button
            type="button"
            onClick={() => void copySyncPrompt()}
            style={{
              border: '1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 40%, transparent)',
              background: 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 12%, transparent)',
              color: T.business, borderRadius: 6, padding: '2px 8px', cursor: 'pointer', fontSize: 10.5, flex: 'none',
            }}
          >
            {copied ? t('graph.copied') : t('graph.copySync')}
          </button>
        </div>
      )}

      {showEmpty && (
        filter ? (
          <EmptyState icon={<Icon d={Icons.search} size={32} />} title={t('common.empty')} />
        ) : (
          <EmptyState
            icon={<Icon d={Icons.graph} size={38} />}
            title={t('common.empty')}
            hint={t('graph.empty')}
          />
        )
      )}

      {/* svg */}
      <div data-dsh-plugin="dsh-scholar" data-dsh-part="knowledge-graph" style={{ flex: 1, minHeight: 0, position: 'relative', margin: '2px 10px 10px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10, overflow: 'hidden' }}>
        <svg
          ref={svgRef}
          width="100%"
          height="100%"
          style={{ display: 'block', touchAction: 'none', cursor: panning ? 'grabbing' : 'grab' }}
          onPointerDown={onPointerDownBg}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => setHoverId(null)}
        >
          <g transform={`translate(${view.x},${view.y}) scale(${view.scale})`}>
            {display && display.edges.map((e, i) => {
              const a = posState.current.get(e.source);
              const b = posState.current.get(e.target);
              if (!a || !b) return null;
              const color = edgeColor(e.kind);
              const lit = !highlight || highlight.edges.has(i);
              const opacity = highlight ? (lit ? 0.95 : 0.06) : 0.45;
              const strokeWidth = lit ? (highlight ? 1.8 : 0.8) : 0.8;
              // direction arrow at target (Obsidian draws arrows for links);
              // they shrink with zoom naturally, so always draw lit edges
              const showArrow = lit;
              let arrow: React.ReactNode = null;
              if (showArrow) {
                const tn = byId.get(e.target);
                const backOff = tn?.kind === 'paper' ? PAPER_H / 2 + 3 : conceptR(e.target) + 3;
                const dx = b.x - a.x, dy = b.y - a.y;
                const d = Math.hypot(dx, dy) || 1;
                const ux = dx / d, uy = dy / d;
                const tx = b.x - ux * backOff, ty = b.y - uy * backOff;
                const s = 4.6;
                const px = -uy, py = ux;
                arrow = (
                  <polygon
                    points={`${tx + ux * s},${ty + uy * s} ${tx - px * s * 0.55},${ty - py * s * 0.55} ${tx + px * s * 0.55},${ty + py * s * 0.55}`}
                    fill={color}
                    opacity={opacity}
                  />
                );
              }
              return (
                <g key={i}>
                  <line
                    x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                    stroke={color}
                    strokeWidth={strokeWidth}
                    opacity={opacity}
                  />
                  {arrow}
                </g>
              );
            })}
            {display && display.nodes.map((node) => {
              const p = posState.current.get(node.id);
              if (!p) return null;
              const isSel = node.id === selectedId;
              const isPaper = node.kind === 'paper';
              const dim = highlight ? (highlight.nodes.has(node.id) ? 1 : 0.16) : 1;
              const d = degree.get(node.id) ?? 0;
              return (
                <g
                  key={node.id}
                  transform={`translate(${p.x},${p.y})`}
                  style={{ cursor: 'pointer', opacity: dim }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    setDragNode(node.id);
                    setSelectedId(node.id);
                    // 捕获指针:快速拖动出节点范围也能持续收到 move/up
                    (e.currentTarget as Element).setPointerCapture(e.pointerId);
                  }}
                  onPointerEnter={(e) => { e.stopPropagation(); setHoverId(node.id); }}
                  onPointerLeave={() => setHoverId((cur) => (cur === node.id ? null : cur))}
                >
                  {isPaper ? (
                    <>
                      <rect
                        x={-paperW(node.id) / 2} y={-PAPER_H / 2} width={paperW(node.id)} height={PAPER_H} rx={6}
                        fill="var(--dsw-alias-bg-layer-2, #222)"
                        stroke={isSel ? T.business : 'var(--dsw-alias-border-l2)'}
                        strokeWidth={isSel ? 1.8 : 1}
                      />
                      <text
                        x={0} y={3.5} textAnchor="middle" fontSize={9.5}
                        fill="var(--dsw-alias-label-primary)"
                        opacity={labelOpacity}
                      >
                        {truncate(node.label, Math.floor((paperW(node.id) - 16) / 6.2))}
                      </text>
                    </>
                  ) : (
                    <>
                      <circle r={conceptR(node.id)} fill={edgeColor('uses')} stroke={isSel ? '#fff' : 'none'} strokeWidth={1.2} />
                      <text
                        x={p.x > size.w * 0.72 ? -(conceptR(node.id) + 6) : conceptR(node.id) + 6}
                        y={3.5} fontSize={10}
                        textAnchor={p.x > size.w * 0.72 ? 'end' : 'start'}
                        fill={isSel ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)'}
                        fontWeight={isSel ? 600 : d >= 3 ? 500 : 400}
                        opacity={labelOpacity}
                      >
                        {truncate(node.label, 24)}
                      </text>
                    </>
                  )}
                </g>
              );
            })}
          </g>
        </svg>

        {/* legend */}
        <div style={{
          position: 'absolute', left: 8, bottom: 8, display: 'flex', gap: 8, flexWrap: 'wrap',
          fontSize: 9.5, color: T.caption, borderRadius: 8, padding: '5px 9px', pointerEvents: 'none',
          background: 'color-mix(in srgb, var(--dsw-alias-bg-base, #161616) 78%, transparent)',
          border: '1px solid var(--dsw-alias-border-l2)',
          backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
        }}>
          {EDGE_KINDS.map((k) => (
            <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 10, height: 2, borderRadius: 1, background: edgeColor(k), display: 'inline-block' }} />
              {t(EDGE_KIND_LABELS[k])}
            </span>
          ))}
        </div>

        {/* selected-node info */}
        {selected && (
          <div className="sch-fade" style={{
            position: 'absolute', right: 8, top: 8, left: 8, maxWidth: 300, marginLeft: 'auto',
            background: 'color-mix(in srgb, var(--dsw-alias-bg-base, #161616) 88%, transparent)',
            backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
            border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 11,
            padding: '9px 11px', fontSize: 11,
            boxShadow: 'var(--dsw-shadow-lv2, 0 8px 24px rgba(0,0,0,.3))',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span aria-hidden style={{
                width: 7, height: 7, borderRadius: selected.kind === 'paper' ? 2 : 999,
                background: selected.kind === 'paper' ? T.business : edgeColor('uses'), flex: 'none',
              }} />
              <span style={{ fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {selected.label}
              </span>
              <span style={{ fontSize: 9.5, color: T.caption, flex: 'none' }}>
                {selected.kind === 'paper' ? t('graph.paper') : t('graph.concept')}
              </span>
              <IconButton label={t('common.close')} size={17} onClick={() => setSelectedId(null)} icon={<Icon d={Icons.close} size={9} />} />
            </div>
            <div style={{ marginTop: 3, fontSize: 10, color: T.caption }}>
              {t('graph.degree', { n: selectedEdges.length })}
              {selected.kind === 'concept' && (
                <> · <button type="button" onClick={() => { setFilter(selected.label); setSelectedId(null); }} style={{ border: 'none', background: 'none', cursor: 'pointer', color: T.business, padding: 0, fontSize: 10, textDecorationLine: 'underline' }}>
                  {t('graph.focus')}
                </button></>
              )}
            </div>
            <div style={{ marginTop: 5, maxHeight: 110, overflow: 'auto' }}>
              {selectedEdges.map((e, i) => {
                const other = e.source === selected.id ? e.target : e.source;
                const otherNode = byId.get(other);
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: T.secondary, marginTop: 3 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 999, background: edgeColor(e.kind), flex: 'none' }} />
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {t(EDGE_KIND_LABELS[e.kind])} → {otherNode?.label ?? other}
                    </span>
                  </div>
                );
              })}
            </div>
            {selected.kind === 'paper' && (
              <div style={{ marginTop: 7 }}>
                <Btn tone="soft" onClick={() => navBus.go('papers', selected.id)}>
                  <Icon d={Icons.link} size={11} /> {t('graph.viewPaper')}
                </Btn>
              </div>
            )}
          </div>
        )}
      </div>
      <div style={{ fontSize: 9.5, color: T.caption, padding: '0 12px 8px', userSelect: 'none' }}>
        {t('graph.dragHint')}
      </div>
    </div>
  );
}
