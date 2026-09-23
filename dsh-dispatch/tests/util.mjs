/** 测试共享 harness:临时目录 store + MockRuntime + 内存目标 + 服务装配。 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DispatchStore } from '../dist/store.js';
import { MockRuntime } from '../dist/runtime.js';
import { InMemoryTargetAdapter } from '../dist/adapters/target.js';
import { DispatchService } from '../dist/service.js';
import { defaultPolicyConfig } from '../dist/policy.js';

export const WS = 'D:/lab/ws-a';
export const WS_B = 'D:/lab/ws-b';

export function makeTask(overrides = {}) {
  return {
    source: 'memory',
    projectId: 'p1',
    nodeId: 'n1',
    nodeTitle: '比对 A/B 实验日志',
    nodeKind: 'experiment',
    nodeDetail: '核对三份日志并生成指标对比报告',
    goalText: 'RGBT 多模态检测提速',
    goalVersion: 2,
    hypothesisText: '层级融合适应能提升 DVTOD',
    entriesCount: 3,
    contract: {
      deliverables: '一份对比报告',
      completionCriteria: '三份日志逐一给出来源与指标;缺失项明确列出',
      blockedWhen: '日志不可访问',
    },
    ...overrides,
  };
}

export function baseReq(o = {}) {
  return {
    actorScope: 'local',
    idempotencyKey: 'k1',
    targetType: 'traj_node',
    projectId: 'p1',
    nodeId: 'n1',
    ws: WS,
    ...o,
  };
}

export async function makeHarness(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-test-'));
  const store = new DispatchStore(dir);
  await store.init();
  const runtime = new MockRuntime();
  const target = new InMemoryTargetAdapter();
    target.upsertNode(makeTask(opts.task));
    if (opts.taskB) target.upsertNode(opts.taskB);
    if (opts.taskC) target.upsertNode(opts.taskC);
  const config = { ...defaultPolicyConfig(), maxWallMs: opts.maxWallMs ?? 2 * 3600_000,
    ...(opts.maxConcurrentDispatches ? { maxConcurrentDispatches: opts.maxConcurrentDispatches } : {}) };
  const service = new DispatchService({ store, runtime, target, config });
  return {
    dir,
    store,
    runtime,
    target,
    service,
    /** 模拟"宿主重启":同一 store 目录/同一目标后端,全新 service 实例。 */
    async restartService(restartOpts = {}) {
      service.dispose();
      const store2 = new DispatchStore(dir);
      await store2.init();
      const svc2 = new DispatchService({
        store: store2,
        runtime: restartOpts.keepRuntime === false ? new MockRuntime() : runtime,
        target,
        config: { ...config, ...(restartOpts.config ?? {}) },
      });
      return { store: store2, service: svc2 };
    },
    dispose() {
      service.dispose();
      store.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function assertRejects(fn, code) {
  try {
    await fn();
  } catch (e) {
    if (code && e.code !== code) {
      throw new Error(`期望错误码 ${code},收到 ${e.code}:${e.message}`);
    }
    return e;
  }
  throw new Error(`期望抛出错误(${code ?? 'any'})但未抛出`);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
