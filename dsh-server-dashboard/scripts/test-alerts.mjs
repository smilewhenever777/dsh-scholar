// Unit tests for planGpuAlerts (busy→idle crash detection, pure function).
import { planGpuAlerts } from '../dist/index.js';

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};
const snap = (busy) => ({ ok: true, gpus: busy.map((b) => ({ processes: b ? [{ pid: 1 }] : [] })) });
const MIN = 60_000;

// 1) busy → idle: countdown starts, fires once after threshold, never twice
{
  let st;
  let r = planGpuAlerts(undefined, snap([true]), 1000, 5 * MIN);
  st = r.state;
  check('busy GPU: no alert', r.fired.length === 0);
  r = planGpuAlerts(st, snap([false]), 2 * MIN, 5 * MIN); // transition
  st = r.state;
  check('busy→idle: countdown starts, no immediate alert', r.fired.length === 0 && st.idleSince[0] === 2 * MIN);
  r = planGpuAlerts(st, snap([false]), 4 * MIN, 5 * MIN); // 2min idle < 5min
  st = r.state;
  check('idle below threshold: still silent', r.fired.length === 0);
  r = planGpuAlerts(st, snap([false]), 8 * MIN, 5 * MIN); // 6min idle ≥ 5min
  st = r.state;
  check('threshold crossed: exactly one crash event', r.fired.length === 1 && r.fired[0].gpuIndex === 0 && r.fired[0].min === 6, JSON.stringify(r.fired));
  r = planGpuAlerts(st, snap([false]), 20 * MIN, 5 * MIN);
  st = r.state;
  check('stays idle: no repeat alert', r.fired.length === 0);
  r = planGpuAlerts(st, snap([true]), 25 * MIN, 5 * MIN); // back to busy (poll 1)
  st = r.state;
  r = planGpuAlerts(st, snap([true]), 26 * MIN, 5 * MIN); // confirmed streak (poll 2)
  st = r.state;
  check('busy again (2-poll streak): re-armed', r.fired.length === 0 && st.idleSince[0] === 0 && !st.alerted[0]);
  r = planGpuAlerts(st, snap([false]), 40 * MIN, 5 * MIN); // second crash episode
  st = r.state;
  r = planGpuAlerts(st, snap([false]), 50 * MIN, 5 * MIN);
  check('second episode fires again', r.fired.length === 1);
}

// 1b) glitch debounce: single busy poll does NOT re-arm a fired episode
{
  let st;
  let r = planGpuAlerts(undefined, snap([true]), 1000, 5 * MIN);
  st = r.state;
  r = planGpuAlerts(st, snap([false]), 2000, 5 * MIN); st = r.state; // transition
  r = planGpuAlerts(st, snap([false]), 10 * MIN, 5 * MIN); st = r.state; // FIRED
  check('glitch 前提: 已触发一次', true);
  // glitch: one busy poll
  r = planGpuAlerts(st, snap([true]), 11 * MIN, 5 * MIN); st = r.state;
  check('单次忙毛刺: 不重置 episode(alerted 保留)', st.alerted[0] === true && st.idleSince[0] === 2000);
  // idle again — must NOT fire a second time
  r = planGpuAlerts(st, snap([false]), 20 * MIN, 5 * MIN); st = r.state;
  check('毛刺后继续空闲: 不二次触发', r.fired.length === 0);
  // confirmed busy streak (2 polls) DOES re-arm
  r = planGpuAlerts(st, snap([true]), 21 * MIN, 5 * MIN); st = r.state;
  r = planGpuAlerts(st, snap([true]), 22 * MIN, 5 * MIN); st = r.state;
  check('连续 2 次忙: 真正重新武装', st.idleSince[0] === 0 && st.alerted[0] === false);
  r = planGpuAlerts(st, snap([false]), 23 * MIN, 5 * MIN); st = r.state;
  r = planGpuAlerts(st, snap([false]), 30 * MIN, 5 * MIN);
  check('重武装后的新 episode 会再次触发(合法)', r.fired.length === 1);
}

// 2) never-busy GPU stays silent (idle ≠ crash)
{
  let st;
  let r = planGpuAlerts(undefined, snap([false]), 1000, 5 * MIN);
  st = r.state;
  r = planGpuAlerts(st, snap([false]), 100 * MIN, 5 * MIN);
  check('never-busy GPU: no alert ever', r.fired.length === 0);
}

// 3) per-GPU independence
{
  let st;
  let r = planGpuAlerts(undefined, snap([true, true]), 1000, 5 * MIN);
  st = r.state;
  r = planGpuAlerts(st, snap([false, true]), 2000, 5 * MIN); // GPU0 drops, GPU1 busy
  st = r.state;
  r = planGpuAlerts(st, snap([false, true]), 10 * MIN, 5 * MIN);
  check('only GPU0 fires', r.fired.length === 1 && r.fired[0].gpuIndex === 0);
}

// 4) offline snapshot: state frozen, no spurious fire
{
  let st;
  let r = planGpuAlerts(undefined, snap([true]), 1000, 5 * MIN);
  st = r.state;
  r = planGpuAlerts(st, { ok: false }, 10 * MIN, 5 * MIN);
  check('offline: no crash event (host-status covers it)', r.fired.length === 0);
}

// 5) stabilizeProcs: phantom-idle guard (memory allocated + empty list = dead
//    query stream, not vanished training)
{
  const { stabilizeProcs } = await import('../dist/host/collector.js');
  const mk = (mem, procs) => ({ processes: procs, memoryUsedMiB: mem });
  const prev = [[{ pid: 1, user: 'u', name: 'python', memoryMiB: 9000 }]];
  check('幽灵空闲: 复用上轮进程', stabilizeProcs([mk(8000, [])], prev)[0].length === 1);
  check('真实空闲(显存~0): 不复用', stabilizeProcs([mk(50, [])], prev)[0].length === 0);
  check('正常列表: 用当前', stabilizeProcs([mk(8000, [{ pid: 2, user: 'u', name: 'p', memoryMiB: 1 }])], prev)[0][0].pid === 2);
  check('无历史可复用: 保持空', stabilizeProcs([mk(8000, [])], undefined)[0].length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
