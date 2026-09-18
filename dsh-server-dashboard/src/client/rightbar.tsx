/**
 * 官方右侧 Sidebar(0.1.5+)的「GPU 监控」页签:常驻紧凑仪表。
 *
 * 两阶段注册姿势与 dsh-scholar/dsh-trajectory 的 rightbar 相同:
 *  1. ctx.sidebarRightTabs.register(定义)(kind 由 openTab 打开)
 *  2. ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
 *       { name, key: 定义id, locale: NS }, Body))
 *
 * body 拉同一份 /dash/snapshots(与抽屉/状态丸同源),按主机一卡、每 GPU 一行:
 * 利用率/温度用 thresholds.ts 的统一阈值配色。旧宿主无 sidebarRightTabs
 * 服务时静默跳过,抽屉头部入口按钮同步隐藏。
 *
 * 注意:本文件从 './index' 导入 panelBus(点「打开完整看板」时唤起抽屉)——
 * ESM 循环引用安全:仅点击回调里解引用,不在模块求值期使用。
 */
import React from 'react';
import { TEMP_HOT, TEMP_WARM, UTIL_SATURATED } from './thresholds';
import { relTime } from './ui';
import { panelBus } from './index';
import type { ServerSnapshot } from './types';

const NS = 'serverDashboard';
/** 注册 id = 包名(tab 身份,也是 body 注册 key) */
const TAB_ID = 'dsh-server-dashboard';
export const GPU_TAB_KIND = 'dsh-server-dashboard.gpu';

/* ---------- openTab 服务句柄(apply 时注入,旧宿主为 null) ---------- */
let svc: { openTab(kind: string, options?: { params?: unknown }): void } | null = null;

/** 入口可用性(抽屉头部据此显示/隐藏「在右侧栏跟随」)。 */
export function rightbarAvailable(): boolean {
  return svc !== null;
}

/** 在右侧栏打开 GPU 监控页签;服务缺席时静默 no-op。 */
export function openGpuInRightbar(): void {
  try {
    svc?.openTab(GPU_TAB_KIND);
  } catch {
    /* 服务未挂载(无会话 seat)——忽略 */
  }
}

/* ---------- body ---------- */

interface SnapshotResponse {
  hosts: { id: string; name: string; pinned: boolean }[];
  snapshots: Record<string, ServerSnapshot>;
  refreshIntervalS?: number;
  staleMinutes?: number;
}

/** MiB → 紧凑 GiB 文本(小盘面省宽度) */
function gib(mib: number): string {
  return `${Math.round(mib / 1024)}G`;
}

function utilColor(util: number): string {
  if (util >= UTIL_SATURATED) return 'var(--dsw-alias-state-danger-primary, #e5484d)';
  if (util >= 20) return 'var(--dsw-alias-label-primary)';
  return 'var(--dsw-alias-label-caption)';
}

function tempColor(temp: number): string {
  if (temp >= TEMP_HOT) return 'var(--dsw-alias-state-danger-primary, #e5484d)';
  if (temp >= TEMP_WARM) return 'var(--dsw-alias-state-warn-primary, #f5a524)';
  return 'var(--dsw-alias-label-caption)';
}

function GpuTabBody({ t }: { t: (key: string, params?: Record<string, unknown>) => string }) {
  const [data, setData] = React.useState<SnapshotResponse | null>(null);
  const [err, setErr] = React.useState('');
  const [at, setAt] = React.useState(0);

  // 轮询周期:跟随宿主 refreshIntervalS,但夹在 [5s, 30s]——侧栏是常驻仪表,
  // 不必像抽屉那样高频,也不许低于 5s 打后台
  const periodS = Math.max(5, Math.min(30, data?.refreshIntervalS ?? 8));

  React.useEffect(() => {
    let alive = true;
    const load = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch('/dash/snapshots', {
          headers: { accept: 'application/json' },
          signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(30_000) : undefined,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as SnapshotResponse;
        if (!alive) return;
        setData(body);
        setAt(Date.now());
        setErr('');
      } catch (e) {
        if (alive) setErr(String(e instanceof Error ? e.message : e));
      }
    };
    void load();
    const timer = setInterval(() => void load(), periodS * 1000);
    return () => { alive = false; clearInterval(timer); };
  }, [periodS]);

  const hosts = data?.hosts ?? [];
  const offline = hosts.filter((h) => {
    const s = data?.snapshots?.[h.id];
    return !s || !s.ok;
  }).length;
  // 静默降级标记:拿到过数据后再次失败(轮询超时等),数据保留但已陈旧——
  // 底部状态行染警告色 + ⚠,悬停看具体错误;恢复成功即自动消隐
  const stale = !!err && !!data;

  return (
    <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8, minHeight: '100%', overflow: 'auto' }}>
      {err && !data && (
        <div style={{ fontSize: 11.5, color: 'var(--dsw-alias-state-danger-primary)', lineHeight: 1.6 }}>{err}</div>
      )}
      {hosts.length === 0 && !err && (
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-caption)', lineHeight: 1.7 }}>{t('rightbar.empty')}</div>
      )}
      {hosts.map((h) => <HostCard key={h.id} name={h.name} snap={data?.snapshots?.[h.id]} t={t} />)}
      {hosts.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2, flexWrap: 'wrap' }}>
          <span
            title={stale ? err : undefined}
            style={{ fontSize: 10.5, color: stale ? 'var(--dsw-alias-state-warn-primary, #f5a524)' : 'var(--dsw-alias-label-caption)' }}
          >
            {stale ? '⚠ ' : ''}{offline > 0 ? t('rightbar.offlineCount', { count: offline }) : at ? t('panel.updatedAt', { time: relTime(at, t) }) : ''}
          </span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={() => panelBus.set('open')}
            style={{ cursor: 'pointer', fontSize: 10.5, padding: '3px 9px', borderRadius: 7, border: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-secondary)' }}
          >
            {t('rightbar.openFull')}
          </button>
        </div>
      )}
    </div>
  );
}

function HostCard({ name, snap, t }: {
  name: string;
  snap: ServerSnapshot | undefined;
  t: (key: string, params?: Record<string, unknown>) => string;
}) {
  const [open, setOpen] = React.useState(false);
  const ok = !!snap?.ok;
  const base = snap?.base;
  // 占位 GPU 行过滤:部分主机 ok 但 nvidia-smi 拿不到数据(index null/无名/全零),
  // 这种行在紧凑条里只会是一排 "0% 0° 0G/0G" 噪音,折叠成一行「GPU 数据不可用」
  const gpus = (snap?.gpus ?? []).filter((g) => g.name || g.memoryTotalMiB > 0 || g.tempC > 0 || g.utilPercent > 0);
  const gpuUnavailable = ok && (snap?.gpus?.length ?? 0) > 0 && gpus.length === 0;
  const busy = gpus.filter((g) => g.utilPercent >= 20 || g.processes.length > 0).length;
  const expandable = ok && gpus.length > 0;

  return (
    <div style={{ borderRadius: 9, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', padding: '7px 9px' }}>
      <div
        onClick={() => expandable && setOpen((v) => !v)}
        style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, cursor: expandable ? 'pointer' : 'default', userSelect: 'none' }}
      >
        {expandable && (
          <span aria-hidden style={{
            flex: 'none', fontSize: 8, color: 'var(--dsw-alias-label-caption)',
            transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform .15s',
            display: 'inline-block', width: 8, textAlign: 'center',
          }}>▶</span>
        )}
        <span aria-hidden style={{
          width: 7, height: 7, borderRadius: 999, flex: 'none',
          background: ok ? 'var(--dsw-alias-state-success-primary, #30a46c)' : 'var(--dsw-alias-state-danger-primary, #e5484d)',
        }} />
        <span style={{ fontWeight: 600, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        <span style={{ flex: 1 }} />
        {ok && gpus.length > 0 && (
          <span style={{ fontSize: 10, color: 'var(--dsw-alias-label-caption)', flex: 'none' }}>{t('rightbar.busy', { n: busy, m: gpus.length })}</span>
        )}
        {!ok && <span style={{ fontSize: 10, color: 'var(--dsw-alias-state-danger-primary)', flex: 'none' }}>{t('rightbar.offline')}</span>}
      </div>
      {ok && base && (
        <div style={{ fontSize: 10.5, color: 'var(--dsw-alias-label-caption)', fontVariantNumeric: 'tabular-nums', marginBottom: gpus.length ? 4 : 0 }}>
          {t('rightbar.cpuMem', { cpu: Math.round(base.cpuPercent), mem: `${gib(base.memUsedMiB)}/${gib(base.memTotalMiB)}` })}
        </div>
      )}
      {ok && gpus.map((g) => (
        <React.Fragment key={g.index}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 11, fontVariantNumeric: 'tabular-nums', lineHeight: 1.7 }}>
            <span style={{ color: 'var(--dsw-alias-label-caption)', flex: 'none' }}>#{g.index}</span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-secondary)' }}>{g.name}</span>
            <span style={{ flex: 'none', color: utilColor(g.utilPercent), fontWeight: g.utilPercent >= UTIL_SATURATED ? 700 : 400 }}>{g.utilPercent}%</span>
            <span style={{ flex: 'none', color: tempColor(g.tempC) }}>{g.tempC}°</span>
            <span style={{ flex: 'none', color: 'var(--dsw-alias-label-caption)' }}>{gib(g.memoryUsedMiB)}/{gib(g.memoryTotalMiB)}</span>
          </div>
          {open && <GpuDetail g={g} t={t} />}
        </React.Fragment>
      ))}
      {ok && gpuUnavailable && (
        <div style={{ fontSize: 10.5, color: 'var(--dsw-alias-label-caption)', lineHeight: 1.6 }}>{t('rightbar.noGpu')}</div>
      )}
      {!ok && snap?.error && (
        <div style={{ fontSize: 10.5, color: 'var(--dsw-alias-label-caption)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={snap.error}>
          {snap.error}
        </div>
      )}
    </div>
  );
}

/** 展开态的每 GPU 明细:进程(谁在跑/显存)、指标最新值、日志最新一行 */
function GpuDetail({ g, t }: {
  g: NonNullable<ServerSnapshot['gpus']>[number];
  t: (key: string, params?: Record<string, unknown>) => string;
}) {
  const lastLog = [...(g.log?.lines ?? [])].reverse().find((l) => l.trim().length > 0);
  const series = (g.series ?? []).slice(0, 3).map((s) => ({ name: s.name, v: s.points.length ? s.points[s.points.length - 1].v : null }));
  return (
    <div style={{ margin: '1px 0 6px 16px', padding: '3px 0 3px 8px', borderLeft: '2px solid var(--dsw-alias-border-l2)' }}>
      {g.processes.length === 0 && (
        <div style={{ fontSize: 10.5, color: 'var(--dsw-alias-label-caption)', lineHeight: 1.6 }}>{t('rightbar.idle')}</div>
      )}
      {g.processes.map((p) => {
        // 解释器全路径在前、脚本+参数在尾:超长取尾部,悬停看全量
        const cmd = p.cmd || p.name;
        const shown = cmd.length > 46 ? `…${cmd.slice(-45)}` : cmd;
        return (
          <div
            key={p.pid}
            title={cmd}
            style={{ fontSize: 10.5, lineHeight: 1.6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--dsw-alias-label-secondary)' }}
          >
            <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-alias-label-primary)' }}>{gib(p.memoryMiB)}</span>
            {' '}{shown}
            <span style={{ color: 'var(--dsw-alias-label-caption)' }}>{` · ${p.user} · ${p.pid}`}</span>
          </div>
        );
      })}
      {series.length > 0 && (
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', margin: g.processes.length ? '3px 0 0' : 0 }}>
          {series.map((s) => (
            <span key={s.name} style={{ fontSize: 10, padding: '1px 7px', borderRadius: 999, background: 'var(--dsw-alias-bg-layer-2)',
              color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums' }}>
              {s.name} {s.v === null ? '—' : (Math.abs(s.v) >= 1000 ? Math.round(s.v) : Math.round(s.v * 1000) / 1000)}
            </span>
          ))}
        </div>
      )}
      {lastLog && (
        <div title={lastLog} style={{ fontSize: 10, color: 'var(--dsw-alias-label-caption)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.6, marginTop: series.length ? 0 : 2 }}>
          {lastLog.trim()}
        </div>
      )}
    </div>
  );
}

/* ---------- 注册(apply 时调用;旧宿主无该服务时静默跳过) ---------- */

export function registerDashboardRightbar(ctx: any): void {
  // ctx.inject 子插件:服务缺席时父插件(抽屉/入口)照常工作,旧宿主优雅降级。
  // package.json 的 dsh.client.inject 已声明 sidebar-right 模块保证图序。
  ctx.inject(['sidebarRightTabs', 'sidebarRight'], (ctx2: any) => {
    svc = ctx2.sidebarRight;
    const t = ctx2.locale.bind(NS);
    ctx2.effect(() => ctx2.sidebarRightTabs.register({
      id: TAB_ID,
      kind: GPU_TAB_KIND,
      title: () => t('rightbar.tabTitle'),
      guide: [{
        order: 62,
        title: () => t('rightbar.tabTitle'),
        description: () => t('rightbar.guideDesc'),
      }],
    }), 'server-dashboard: rightbar gpu tab type');
    ctx2.effect(() => ctx2.slots.inject('sidebar.right.pane.tab', () => ctx2.slots.register({
      name: 'sidebar.right.pane.tab',
      key: TAB_ID,
      locale: NS,
    }, GpuTabBody)), 'server-dashboard: rightbar gpu tab body');
    return () => { svc = null; };
  });
}
