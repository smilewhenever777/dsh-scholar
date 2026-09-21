/**
 * 学者面板顶部横幅：后台精读实时进度。
 * 轮询 /scholar/read/status（running 1.5s / 空闲 4s），完成瞬间广播
 * window 事件 'scholar:read-done'——论文库与报告列表监听后自动刷新。
 */
import React, { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { Icon, Icons, T, truncate } from './ui';
import type { TFunc } from './nav';

interface RunPaper { title: string; state: 'pending' | 'running' | 'ok' | 'fail' }
interface RunState {
  id: number;
  mode: 'paper' | 'quick';
  total: number;
  skipped: number;
  startedAt: number;
  finishedAt: number | null;
  ok: number;
  fail: number;
  papers: RunPaper[];
  phase: string;
  /** 最后一次失败的原因（宿主截断 200 字） */
  error: string;
}

const DOT_COLOR: Record<RunPaper['state'], string> = {
  pending: 'var(--dsw-alias-border-l2)',
  running: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
  ok: 'var(--dsw-alias-state-success-primary, #34a853)',
  fail: T.danger,
};

export function ReadProgressBanner({ t }: { t: TFunc }) {
  const [run, setRun] = useState<RunState | null>(null);
  /** 用户手动关闭过的 run id（完成态横幅可关） */
  const [dismissed, setDismissed] = useState<number | null>(null);
  /** 已广播过 read-done 的 run id（防轮询重复触发） */
  const doneFiredRef = useRef(0);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const tick = async () => {
      let next = 4000;
      try {
        const r = await api<{ run: RunState | null }>('/scholar/read/status');
        if (!alive) return;
        setRun(r.run ?? null);
        if (r.run && !r.run.finishedAt) next = 1500;
        if (r.run?.finishedAt && doneFiredRef.current !== r.run.id) {
          doneFiredRef.current = r.run.id;
          window.dispatchEvent(new CustomEvent('scholar:read-done', { detail: { id: r.run.id } }));
        }
      } catch { /* 网络抖动保留上一帧，下拍再试 */ }
      if (alive) timer = window.setTimeout(tick, next);
    };
    void tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, []);

  if (!run || dismissed === run.id) return null;
  const done = run.finishedAt !== null;
  // F29:三态结果(供勾/叉图标与容器底色使用)
  const allFailed = done && run.fail > 0 && run.ok === 0;
  const someFailed = done && run.fail > 0 && run.ok > 0;
  const doneCount = run.ok + run.fail;
  const runningIdx = run.papers.findIndex((p) => p.state === 'running');
  const current = runningIdx >= 0 ? run.papers[runningIdx] : null;
  const pct = run.total > 0 ? Math.round((doneCount / run.total) * 100) : 100;
  const modeLabel = t(run.mode === 'quick' ? 'deepread.quickLabel' : 'deepread.paperLabel');
  const skipNote = run.skipped > 0 ? t('deepread.progressSkipped', { count: String(run.skipped) }) : '';

  return (
    <div
      data-dsh-plugin="dsh-scholar"
      data-dsh-part="read-progress"
      style={{
        flex: 'none', margin: '0 12px 6px', padding: '7px 10px 8px',
        borderRadius: 9, fontSize: 11.5, lineHeight: 1.5,
        border: `1px solid color-mix(in srgb, ${done
          ? 'var(--dsw-alias-state-success-primary, #34a853) 38%, transparent)'
          : 'var(--dsw-alias-state-business-primary, #4d6bfe) 40%, transparent)'}`,
        background: done
          ? 'color-mix(in srgb, var(--dsw-alias-state-success-primary, #34a853) 8%, transparent)'
          : 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 8%, transparent)',
        animation: 'schFadeUp .19s var(--sch-ease, ease-out)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <Icon
          d={done ? Icons.check : Icons.book}
          size={12}
          color={done ? 'var(--dsw-alias-state-success-primary, #34a853)' : 'var(--dsw-alias-state-business-primary, #4d6bfe)'}
        />
        <span style={{ fontWeight: 650 }}>
          {done
            ? t('deepread.progressDone', { ok: String(run.ok), fail: String(run.fail) })
            : t('deepread.progressRunning', { mode: modeLabel, done: String(doneCount), total: String(run.total) })}
        </span>
        {skipNote && <span style={{ color: T.caption, fontSize: 10.5 }}>{skipNote}</span>}
        <span style={{ flex: 1 }} />
        {!done && <span style={{ fontSize: 10.5, color: T.caption }}>{run.phase || '…'}</span>}
        {done && (
          <button
            type="button"
            aria-label={t('common.close')}
            onClick={() => setDismissed(run.id)}
            style={{ all: 'unset', cursor: 'pointer', color: T.caption, display: 'inline-flex', padding: 2 }}
          ><Icon d={Icons.close} size={11} /></button>
        )}
      </div>
      {/* 进度条：done/total；running 段以斜纹示意"进行中" */}
      <div style={{
        marginTop: 6, height: 4, borderRadius: 999, overflow: 'hidden',
        background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.14))',
      }}>
        <div style={{
          width: `${pct}%`, height: '100%', borderRadius: 999,
          background: done
            // F29:全部失败=危险色;部分失败=警告色;仅全部成功才绿
            ? (run.fail > 0 && run.ok === 0
                ? 'var(--dsw-alias-state-danger-primary, #e5484d)'
                : run.fail > 0
                  ? 'var(--dsw-alias-state-warn-primary, #f5a524)'
                  : 'var(--dsw-alias-state-success-primary, #34a853)')
            : 'linear-gradient(90deg, var(--dsw-alias-state-business-primary, #4d6bfe), color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 55%, #fff))',
          transition: 'width .45s var(--sch-ease, ease-out)',
        }} />
      </div>
      {/* 每篇状态点 + 当前篇标题 */}
      <div style={{ marginTop: 5, display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
        {run.papers.map((p, i) => (
          <span
            key={i}
            title={p.title}
            style={{
              width: 7, height: 7, borderRadius: 999, flex: 'none',
              background: DOT_COLOR[p.state],
              boxShadow: p.state === 'running' ? '0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 25%, transparent)' : undefined,
              animation: p.state === 'running' ? 'schPulse 1.1s ease-in-out infinite' : undefined,
            }}
          />
        ))}
        {current && (
          <span style={{ color: T.secondary, fontSize: 10.5, minWidth: 0 }}>
            {truncate(current.title, 44)}
          </span>
        )}
        {done && run.fail > 0 && (
          <span style={{ color: T.danger, fontSize: 10.5 }}>
            {run.papers.filter((p) => p.state === 'fail').map((p) => truncate(p.title, 30)).join('；')}
          </span>
        )}
      </div>
      {/* 失败原因：直接回答"为什么失败"，不用翻服务器日志 */}
      {done && run.fail > 0 && run.error && (
        <div
          data-dsh-part="read-progress-error"
          title={run.error}
          style={{ marginTop: 4, fontSize: 10.5, lineHeight: 1.55, color: T.danger, wordBreak: 'break-all' }}
        >
          {truncate(run.error, 160)}
        </div>
      )}
    </div>
  );
}
