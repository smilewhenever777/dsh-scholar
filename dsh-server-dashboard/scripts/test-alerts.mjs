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
  r = planGpuAlerts(st, snap([true]), 25 * MIN, 5 * MIN); // back to busy
  st = r.state;
  check('busy again: re-armed', r.fired.length === 0 && st.idleSince[0] === 0 && !st.alerted[0]);
  r = planGpuAlerts(st, snap([false]), 40 * MIN, 5 * MIN); // second crash episode
  st = r.state;
  r = planGpuAlerts(st, snap([false]), 50 * MIN, 5 * MIN);
  check('second episode fires again', r.fired.length === 1);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
