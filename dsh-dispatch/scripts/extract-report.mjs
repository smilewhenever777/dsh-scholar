import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'probe-results');
const want = process.argv[2] || 'main';
const file = readdirSync(dir).filter((x) => x.includes(`-${want}-`)).sort().pop();
const r = JSON.parse(readFileSync(join(dir, file), 'utf8'));
const S = r.steps;

const slim = (arr) => (arr ?? []).map((x) => ({ ms: x.ms, ch: x.channel, kind: x.kind, d: x.data }));
const out = {
  file,
  policy: S.policy?.data,
  child1: {
    start: S['child1-start']?.ok
      ? {
          childId: S['child1-start'].data.childId,
          elapsedMs: S['child1-start'].data.elapsedMs,
          reservedMatched: S['child1-start'].data.reservedMatched,
          listAtAcceptance: S['child1-start'].data.listAtAcceptance,
        }
      : S['child1-start'],
    timeline: slim(S['child1-timeline']?.data?.timeline),
    endObserved: S['child1-timeline']?.data?.endObserved,
  },
  sponsorWake: (() => {
    const w = S['sponsor-wake-watch']?.data;
    if (!w) return undefined;
    const s = w.samples ?? [];
    return { grew: w.grew, first: s[0], last: s[s.length - 1] };
  })(),
  child2: S['child2-evidence']?.data
    ? {
        interruptReceipt: S['child2-evidence'].data.interruptReceipt,
        sleepToolRecord: S['child2-evidence'].data.sleepToolRecord,
        identityCalledAfterInterrupt: S['child2-evidence'].data.identityCalledAfterInterrupt,
        endEvent: S['child2-evidence'].data.endEvent,
        timeline: slim(S['child2-evidence'].data.timeline),
      }
    : S['child2-evidence'],
  child3: S['child3-outcome']?.data,
  child3wake: (() => {
    const w = S['child3-wake-outcome']?.data;
    return w ? { anyActivity: w.anyActivity, activity: slim(w.activity) } : undefined;
  })(),
  finalChildren: S['final-children']?.data?.children,
};
console.log(JSON.stringify(out, null, 1));
