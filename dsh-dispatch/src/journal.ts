/**
 * 观察日志:内存 ring + JSONL 落盘($DSH_HOME/dispatch/probe/events-<run>.jsonl)。
 * P0 探针与 P1 内核共用;日志失败不阻断主流程。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dshHome } from './store.js';

export interface JournalRec {
  t: string;
  ms: number;
  run: string;
  channel: string;
  kind: string;
  data: unknown;
}

const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const recs: JournalRec[] = [];
let journalFile: string | null = null;

function file(): string {
  if (!journalFile) {
    const dir = join(dshHome(), 'dispatch', 'probe');
    mkdirSync(dir, { recursive: true });
    journalFile = join(dir, `events-${RUN_ID}.jsonl`);
  }
  return journalFile;
}

export function journal(kind: string, data: unknown, channel = 'plugin'): void {
  const rec: JournalRec = { t: new Date().toISOString(), ms: Date.now(), run: RUN_ID, channel, kind, data };
  recs.push(rec);
  if (recs.length > 4000) recs.splice(0, recs.length - 4000);
  try {
    appendFileSync(file(), JSON.stringify(rec) + '\n');
  } catch {
    /* 观察失败静默 */
  }
}

export function journalSnapshot(sinceMs = 0, limit = 800): { run: string; total: number; recs: JournalRec[] } {
  const out = recs.filter((r) => r.ms >= sinceMs).slice(-Math.min(limit, 4000));
  return { run: RUN_ID, total: recs.length, recs: out };
}

export function currentRun(): string {
  return RUN_ID;
}
