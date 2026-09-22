#!/usr/bin/env node
/**
 * probe-runtime.mjs — P0 运行时语义探针驱动(DISPATCH-DESIGN-REVISED.md §1.3)。
 *
 * 它只做 HTTP 驱动与证据收集;全部判断依据来自插件侧 journal(含双通道生命周期事件
 * 与探针工具的来电记录),不用 mock 替代宿主行为。
 *
 * 用法:
 *   node scripts/probe-runtime.mjs --base http://127.0.0.1:3081 --ws <工作区绝对路径> --phase main
 *   node scripts/probe-runtime.mjs --base http://127.0.0.1:3081 --ws <同上> --phase post-restart
 * 输出:probe-report-<phase>-<ts>.json(默认写在本脚本旁的 probe-results/ 目录)
 */

/* ---------- 参数 ---------- */
function parseArgs() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    }
  }
  return out;
}
const args = parseArgs();
const BASE = String(args.base || 'http://127.0.0.1:3081').replace(/\/+$/, '');
const WS = String(args.ws || '');
const PHASE = String(args.phase || 'main');
const MAX_MS = Number(args.maxMs || 900_000);
/** P0 实测:sponsor 经工厂创建(ctx.agents.create)不带默认模型路由,必须显式传 agentOptions */
const PROVIDER = String(args.provider || 'glm');
const MODEL = String(args.model || 'glm-5.3');
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'probe-results');

if (!WS) { console.error('缺少 --ws(工作区绝对路径)'); process.exit(2); }

/* ---------- 报告骨架 + 全局看门狗 ---------- */
const report = {
  phase: PHASE, base: BASE, ws: WS,
  startedAt: new Date().toISOString(),
  steps: {},
};
const watchdog = setTimeout(() => {
  report.finishedAt = new Date().toISOString();
  report.watchdogTripped = true;
  writeReport();
  console.error('[probe] 全局看门狗超时,强制落盘退出');
  process.exit(1);
}, MAX_MS);
watchdog.unref?.();

function writeReport() {
  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, `probe-report-${PHASE}-${report.startedAt.replace(/[:.]/g, '-').slice(0, 19)}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`[probe] 报告已写入 ${file}`);
}

/* ---------- HTTP ---------- */
async function api(method, path, body, timeoutMs = 60_000) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text.slice(0, 500) }; }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${path}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

/* ---------- journal 轮询 ---------- */
let journalHighWater = 0;
async function fetchJournal() {
  const r = await api('GET', `/dispatch/probe/journal?sinceMs=${journalHighWater}&limit=4000`, undefined, 15_000);
  const recs = r.recs ?? [];
  if (recs.length) journalHighWater = recs[recs.length - 1].ms + 1;
  return recs;
}
/** 全量拉取(时间线取证用;不受增量水位影响)。 */
async function fetchJournalAll() {
  const r = await api('GET', '/dispatch/probe/journal?sinceMs=0&limit=4000', undefined, 15_000);
  return r.recs ?? [];
}
async function step(name, fn) {
  const t0 = Date.now();
  try {
    const data = await fn();
    report.steps[name] = { ok: true, ms: Date.now() - t0, data };
    console.log(`[probe] ✓ ${name} (${Date.now() - t0}ms)`);
    return data;
  } catch (err) {
    report.steps[name] = { ok: false, ms: Date.now() - t0, error: String(err?.message ?? err) };
    console.log(`[probe] ✗ ${name} — ${err?.message ?? err}`);
    return null;
  }
}
/** 轮询 journal 直到谓词命中(返回全部命中记录)或超时(返回已收集的命中)。 */
async function watch(pred, timeoutMs, label) {
  const hits = [];
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const recs = await fetchJournal().catch(() => []);
    for (const r of recs) if (pred(r)) hits.push(r);
    if (hits.length) return { hits, waitedMs: Date.now() - t0 };
    await sleep(2000);
  }
  console.log(`[probe] … 等待 ${label} 超时(${timeoutMs}ms)`);
  return { hits, waitedMs: Date.now() - t0, timeout: true };
}
const lifecycleFor = (childId, kind) => (r) =>
  (r.kind === `subagent/${kind}`) && r.data && String(r.data.id) === String(childId);
const identityFrom = (childId) => (r) =>
  r.kind === 'tool/identity' && r.data && String(r.data.callerSessionId) === String(childId);

/* ================================================================ */
/*                          main 阶段                                */
/* ================================================================ */
async function mainPhase() {
  /* 1. 环境 */
  const env = await step('env', () => api('GET', '/dispatch/probe/env', undefined, 15_000));
  if (!env) return;
  console.log(`    providers=${JSON.stringify(env.providers)} spawn=${env.spawnProviderPresent} agents=${env.services?.agents}`);

  /* 2. sponsor */
  const sponsor = await step('sponsor', () => api('POST', '/dispatch/probe/sponsor', { ws: WS }));
  if (!sponsor) return;
  console.log(`    sessionId=${sponsor.sessionId} via=${sponsor.via}`);

  /* 3. 委派审批/沙箱语义 */
  await step('policy', () => api('POST', '/dispatch/probe/policy', {}));

  /* 4. child1:正常最小任务(含预留 childId + toolFilter allow) */
  const c1 = `p0c1-${Date.now().toString(36)}`;
  const sponsorLogBefore = await api('GET', '/dispatch/probe/sponsorlog', undefined, 15_000).catch(() => null);
  const start1 = await step('child1-start', () => api('POST', '/dispatch/probe/start', {
    label: 'p0-normal',
    childId: c1,
    maxDepth: 1,
    modelProvider: PROVIDER,
    model: MODEL,
    toolAllow: ['dispatch_probe_identity'],
    prompt: '这是 P0 探针最小任务。请严格按顺序做三件事,不要做其他任何事:'
      + '1) 调用工具 dispatch_probe_identity 一次,记住它返回的 callerSessionId;'
      + '2) 尝试调用工具 dispatch_probe_sleep(参数 ms=2000)——它可能因工具过滤而不可用,失败就如实记录;'
      + '3) 用两三句话报告:callerSessionId 的值、sleep 是否可调用、你看到的现象。不要编造。',
  }));
  if (start1) {
    console.log(`    childId=${start1.childId} 预留匹配=${start1.reservedMatched} 接受耗时=${start1.elapsedMs}ms`);
    console.log(`    接受瞬间 listChildren=${JSON.stringify(start1.listAtAcceptance)}`);
    const end = await watch(lifecycleFor(c1, 'end'), 240_000, `child1 end(${c1})`);
    await step('child1-timeline', async () => {
      const recs = await fetchJournalAll();
      const timeline = recs.filter((r) =>
        (r.kind.startsWith('subagent/') && String(r.data?.id) === c1)
        || (r.kind === 'tool/identity' && String(r.data?.callerSessionId) === c1)
        || (r.kind === 'tool/sleep' && String(r.data?.callerSessionId) === c1))
        .map((r) => ({ ms: r.ms, t: r.t, channel: r.channel, kind: r.kind, data: r.data }));
      return { timeline, endObserved: end.hits.length > 0 };
    });
  }

  /* 5. sponsor 唤醒观察:child1 结束后 sponsor 会话日志是否增长(= 被回传消息唤醒推理) */
  await step('sponsor-wake-watch', async () => {
    const samples = [];
    const before = sponsorLogBefore?.stats?.[sponsor.sessionId] ?? null;
    samples.push({ at: 0, stat: before });
    for (let i = 1; i <= 9; i++) {
      await sleep(5000);
      const r = await api('GET', '/dispatch/probe/sponsorlog', undefined, 15_000).catch(() => null);
      samples.push({ at: i * 5, stat: r?.stats?.[sponsor.sessionId] ?? null });
    }
    const first = samples[0].stat;
    const last = samples[samples.length - 1].stat;
    return {
      samples,
      grew: !!(first && last && (last.size > first.size || last.mtimeMs > first.mtimeMs)),
    };
  });

  /* 6. child2:运行中中断(取消语义) */
  const c2 = `p0c2-${Date.now().toString(36)}`;
  const start2 = await step('child2-start', () => api('POST', '/dispatch/probe/start', {
    label: 'p0-midrun-interrupt',
    childId: c2,
    maxDepth: 1,
    modelProvider: PROVIDER,
    model: MODEL,
    toolAllow: ['dispatch_probe_identity', 'dispatch_probe_sleep'],
    prompt: '这是 P0 中断语义测试。请严格按顺序做:1) 立即调用工具 dispatch_probe_sleep(参数 ms=180000);'
      + '2) sleep 返回后调用 dispatch_probe_identity;3) 报告「睡醒了」。不要做其他任何事。',
  }));
  if (start2) {
    await watch(lifecycleFor(c2, 'start'), 120_000, `child2 start(${c2})`);
    await sleep(15_000); // 给模型留出发出 sleep 调用的时间
    const interrupted = await step('child2-interrupt', () => api('POST', '/dispatch/probe/interrupt', { childId: c2 }, 20_000));
    const end = await watch(lifecycleFor(c2, 'end'), 120_000, `child2 end(${c2})`);
    await step('child2-evidence', async () => {
      const recs = await fetchJournalAll();
      const rel = recs.filter((r) =>
        (r.kind.startsWith('subagent/') && String(r.data?.id) === c2)
        || (r.kind === 'tool/sleep' && String(r.data?.callerSessionId) === c2)
        || (r.kind === 'tool/identity' && String(r.data?.callerSessionId) === c2));
      const sleepRec = rel.find((r) => r.kind === 'tool/sleep');
      const identityAfterInterrupt = rel.find((r) => r.kind === 'tool/identity' && interrupted && r.ms > report.steps['child2-interrupt'].ms);
      return {
        interruptReceipt: interrupted?.receipt ?? null,
        sleepToolRecord: sleepRec?.data ?? null,
        identityCalledAfterInterrupt: !!identityAfterInterrupt,
        endEvent: end.hits[0]?.data ?? null,
        timeline: rel.map((r) => ({ ms: r.ms, kind: r.kind, channel: r.channel, data: r.data })),
      };
    });
  }

  /* 7. child3:接受后立刻中断(queued 取消语义——设计 §7.4 关键问题) */
  const c3 = `p0c3-${Date.now().toString(36)}`;
  const start3 = await step('child3-start', () => api('POST', '/dispatch/probe/start', {
    label: 'p0-rapid-interrupt',
    childId: c3,
    maxDepth: 1,
    modelProvider: PROVIDER,
    model: MODEL,
    toolAllow: ['dispatch_probe_identity'],
    prompt: '这是 P0 探针任务。请调用工具 dispatch_probe_identity 一次,然后报告「完成」。不要做其他任何事。',
  }));
  if (start3) {
    const interrupted = await step('child3-immediate-interrupt', () => api('POST', '/dispatch/probe/interrupt', { childId: c3 }, 20_000));
    const w = await watch((r) => lifecycleFor(c3, 'start')(r) || lifecycleFor(c3, 'end')(r) || identityFrom(c3)(r), 90_000, `child3 任何活动(${c3})`);
    report.steps['child3-outcome'] = {
      ok: true,
      data: {
        interruptReceipt: interrupted?.receipt ?? null,
        anyActivityWithin90s: w.hits.length > 0,
        activity: w.hits.map((r) => ({ ms: r.ms, kind: r.kind, channel: r.channel, data: r.data })),
        note: '90 秒内无活动 = 已接受未开始的工作未被执行;是否仍驻留(可被唤醒)见 child3-wake',
      },
    };
    console.log(`    90 秒内活动: ${w.hits.length} 条`);

    /* 8. child3 唤醒测试:parked 工作是否仍可被新消息恢复(设计 §0.3/§7.4) */
    const sendRes = await step('child3-wake-send', () => api('POST', '/dispatch/probe/send', {
      childId: c3,
      text: '如果你收到这条消息:请调用一次 dispatch_probe_identity,然后只回复「已唤醒」。',
    }, 30_000));
    if (sendRes?.ok) {
      const w2 = await watch((r) => lifecycleFor(c3, 'start')(r) || lifecycleFor(c3, 'end')(r) || identityFrom(c3)(r), 120_000, `child3 唤醒活动(${c3})`);
      report.steps['child3-wake-outcome'] = {
        ok: true,
        data: {
          anyActivity: w2.hits.length > 0,
          activity: w2.hits.map((r) => ({ ms: r.ms, kind: r.kind, channel: r.channel, data: r.data })),
        },
      };
    }
  }

  /* 9. 终态快照 */
  await step('final-children', () => api('GET', '/dispatch/probe/children', undefined, 15_000));
  await step('final-sponsorlog', () => api('GET', '/dispatch/probe/sponsorlog', undefined, 15_000));
}

/* ================================================================ */
/*                      post-restart 阶段                            */
/* ================================================================ */
async function postRestartPhase() {
  const env = await step('env', () => api('GET', '/dispatch/probe/env', undefined, 15_000));
  if (!env) return;
  console.log(`    新 run=${env.run}(旧宿主进程已重启)`);

  const sponsor = await step('sponsor-readopt', () => api('POST', '/dispatch/probe/sponsor', { ws: WS }));
  if (sponsor) console.log(`    via=${sponsor.via}(预期 resume:冷启动领养持久化会话)`);

  const children = await step('children-after-restart', () => api('GET', '/dispatch/probe/children', undefined, 15_000));
  if (children) console.log(`    子会话条目=${JSON.stringify(children.children)}`);

  // 对上一阶段的 child1(正常完成)再发一条消息:验证「已完成子会话冷恢复/续聊」的真实行为
  const prev = report.ws && children?.children?.[0];
  if (prev?.id) {
    await step('send-to-old-child', async () => {
      const send = await api('POST', '/dispatch/probe/send', {
        childId: prev.id,
        text: '重启后的探针消息:请调用一次 dispatch_probe_identity,然后只回复「重启后已响应」。',
      }, 30_000);
      const w = await watch((r) => lifecycleFor(prev.id, 'start')(r) || lifecycleFor(prev.id, 'end')(r) || identityFrom(prev.id)(r), 150_000, `旧 child(${prev.id}) 冷恢复活动`);
      return {
        send,
        anyActivity: w.hits.length > 0,
        activity: w.hits.map((r) => ({ ms: r.ms, kind: r.kind, channel: r.channel, data: r.data })),
      };
    });
  }

  await step('final-children-2', () => api('GET', '/dispatch/probe/children', undefined, 15_000));
}

/* ---------- 收尾 ---------- */
try {
  if (PHASE === 'main') await mainPhase();
  else if (PHASE === 'post-restart') await postRestartPhase();
  else { console.error(`未知 --phase ${PHASE}`); process.exit(2); }
} finally {
  report.finishedAt = new Date().toISOString();
  clearTimeout(watchdog);
  writeReport();
  const okCount = Object.values(report.steps).filter((s) => s.ok).length;
  console.log(`[probe] 完成:${okCount}/${Object.keys(report.steps).length} 步成功;详细证据见报告文件`);
}
