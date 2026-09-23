/**
 * dsh-dispatch — 研究任务派发引擎。
 * P0:运行时语义探针(已完成,docs/runtime-capabilities.md)。
 * P1:无界面执行内核(store/纯 reducer/幂等/资源预留/启动意图/取消对账)。
 * 设计:仓库根 DISPATCH-DESIGN-REVISED.md(r2)。
 *
 * 路由面:
 *  - /dispatch/probe/*   P0 探针(保留)
 *  - /dispatch/start|cancel|takeover|reconcile|resolve|status/:id|list   P1 业务面(§5.1)
 */
import type { Context } from '@deepseek-ai/cordis';
// 仅加载 dsh-settings 的 Context 类型增强(ctx.settings);与 dsh-trajectory 同款
import type {} from '@deepseek-ai/dsh-settings';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import z from 'schemastery';
import { DispatchStore, dshHome } from './store.js';
import { DispatchService, allowedActions as allowedActionsFor } from './service.js';
import { SubagentRuntimeAdapter } from './runtime.js';
import { HttpTrajectoryAdapter, InMemoryTargetAdapter } from './adapters/target.js';
import { registerDispatchTools } from './tools.js';
import { registerProbe } from './probe.js';
import { journal } from './journal.js';
import { ServiceError } from './types.js';
import type { PolicyConfig } from './policy.js';
import type {} from '@deepseek-ai/dsh-session-query';
import { WorkbenchStore } from './workbench/store.js';
import { WorkbenchTargetAdapter, RoutedTargetAdapter } from './workbench/target.js';
import { WorkbenchService } from './workbench/service.js';
import { guardLocal, registerWorkbenchRoutes } from './workbench/routes.js';

export const name = 'dsh-dispatch';

/** P0 实测:agents/subagents 是 cordis 服务,必须声明在 inject(否则取属性即抛错)。 */
export const inject = ['settings', 'tools', 'webServer', 'agents', 'subagents', 'sessionQuery'];

const NS = 'dispatch';

const ConfigSchema = z.object({
  /** P1 默认 memory(测试后端);P2 接入 trajectory 后切换为 trajectory */
  targetBackend: z.union(['memory', 'trajectory']).default('memory'),
  modelProvider: z.string().default('glm'),
  model: z.string().default('glm-5.3'),
  /** `provider/model` 允许列表;空 = 仅默认模型 */
  allowedModels: z.array(z.string()).default([]),
  maxWallMinutes: z.number().default(120),
});

interface DispatchConfig {
  targetBackend: 'memory' | 'trajectory';
  modelProvider: string;
  model: string;
  allowedModels: string[];
  maxWallMinutes: number;
}

function readConfig(scope: { get: () => unknown }): DispatchConfig {
  const cfg = (scope.get() ?? {}) as Partial<DispatchConfig>;
  return {
    targetBackend: cfg.targetBackend === 'trajectory' ? 'trajectory' : 'memory',
    modelProvider: cfg.modelProvider?.trim() || 'glm',
    model: cfg.model?.trim() || 'glm-5.3',
    allowedModels: Array.isArray(cfg.allowedModels) ? cfg.allowedModels.filter((x) => typeof x === 'string' && x) : [],
    maxWallMinutes: Number(cfg.maxWallMinutes) > 0 ? Number(cfg.maxWallMinutes) : 120,
  };
}

export function apply(ctx: Context): void {
  console.log(`[dsh-dispatch] P1 执行内核加载(home ${dshHome()})`);

  const scope = ctx.settings.register(NS, ConfigSchema, {});
  let cfg = readConfig(scope);
  let activePolicy: (PolicyConfig & { maxWallMs: number }) | null = null;
  ctx.effect(() => scope.watch?.(() => {
    cfg = readConfig(scope);
    if (activePolicy) {
      activePolicy.allowedModels = cfg.allowedModels.length ? cfg.allowedModels : [`${cfg.modelProvider}/${cfg.model}`];
      activePolicy.defaultModel = `${cfg.modelProvider}/${cfg.model}`;
      activePolicy.maxWallMs = cfg.maxWallMinutes * 60_000;
    }
  }));

  const memoryTarget = new InMemoryTargetAdapter();
  const legacyTarget = cfg.targetBackend === 'trajectory'
    ? new HttpTrajectoryAdapter(`http://127.0.0.1:${(ctx as unknown as { webServer?: { port?: number } }).webServer?.port ?? 3080}`)
    : memoryTarget;
  const workbenchStore = new WorkbenchStore();
  const workbenchReady = workbenchStore.init();
  const target = new RoutedTargetAdapter(legacyTarget, new WorkbenchTargetAdapter(workbenchStore));
  const runtimeAdapter = new SubagentRuntimeAdapter(ctx);

  let service: DispatchService | null = null;
  let workbenchInstance: WorkbenchService | null = null;
  const servicePromise: Promise<DispatchService | null> = (async () => {
    const store = new DispatchStore();
    await store.init();
    await workbenchReady;
    if (store.fault.readOnly) {
      console.error(`[dsh-dispatch] store 只读故障态:${store.fault.reason ?? '未知'}——派发写入被禁用`);
      journal('store/fault', { reason: store.fault.reason });
      return null;
    }
    const policy: PolicyConfig & { maxWallMs: number } = {
      allowedModels: cfg.allowedModels.length ? cfg.allowedModels : [`${cfg.modelProvider}/${cfg.model}`],
      defaultModel: `${cfg.modelProvider}/${cfg.model}`,
      maxWallMs: cfg.maxWallMinutes * 60_000,
      maxPromptBytes: 256 * 1024,
    };
    activePolicy = policy;
    const svc = new DispatchService({ store, runtime: runtimeAdapter, target, config: policy });
    const workbench = !workbenchStore.snapshot() ? null : new WorkbenchService(
      workbenchStore, svc, store,
      () => policy.allowedModels,
      () => policy.defaultModel,
    );
    workbenchInstance = workbench;
    service = svc;
    journal('service/ready', { backend: target.kind, defaultModel: policy.defaultModel });
    console.log(`[dsh-dispatch] 执行内核就绪(backend=${target.kind}, model=${policy.defaultModel})`);
    return svc;
  })();
  registerWorkbenchRoutes(ctx, async () => {
    const dispatch = await servicePromise;
    if (!dispatch || !workbenchInstance) return null;
    const { SquadService } = await import('./workbench/squad.js');
    const { AutomationService } = await import('./workbench/automation.js');
    const squad = new SquadService(workbenchStore);
    const automation = new AutomationService(
      workbenchStore,
      async (template, source) => {
        // 创建任务并启动(经 workbench service 保证原子性)
        const task = await workbenchInstance!.createTask({
          projectId: template.projectId, title: template.title,
          description: template.description, acceptanceCriteria: template.acceptanceCriteria,
          assigneeId: template.assigneeId,
        });
        const result = await workbenchInstance!.start(task.id, { idempotencyKey: `auto-${source}-${Date.now()}` });
        return { taskId: task.id, dispatchId: result.dispatchId };
      },
      () => {
        try {
          const all = (dispatch as { list?: (ws?: string) => Array<Record<string, unknown>> }).list?.() ?? [];
          return all.some((d) => String(d.phase ?? '') !== 'finished');
        } catch { return false; }
      },
    );
    automation.start();
    return { workbench: workbenchInstance, squad, automation, dispatch };
  });

  // §7.1:启动对账(初始退避 ~5s;只扫描,不重放业务任务)
  void servicePromise.then((svc) => {
    if (!svc) return;
    const t = setTimeout(() => {
      void svc.reconcileOnce().then((r) => {
        if (r.notes.length) journal('service/reconcile-boot', r);
      });
    }, 5_000);
    t.unref?.();
  });

  // 卸载:释放运行时订阅与写入者锁
  try {
    (ctx as unknown as { on?: (ev: string, fn: () => void) => void }).on?.('dispose', () => {
      service?.dispose();
      workbenchStore.dispose();
      journal('service/dispose', {});
    });
  } catch {
    /* 宿主差异忽略 */
  }

  registerDispatchTools(ctx, () => service, runtimeAdapter, journal);
  registerProbe(ctx, { memoryTarget });

  /* ---------- 业务 REST(§5.1) ---------- */
  const sendJson = (res: ServerResponse, code: number, payload: unknown): void => {
    res.statusCode = code;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
  };

  const guardRoute = guardLocal;

  const readBody = (req: IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
    const ct = String(req.headers['content-type'] ?? '');
    if (ct.split(';')[0].trim().toLowerCase() !== 'application/json') {
      reject(new Error('请求必须是 application/json'));
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      if (over) return;
      chunks.push(chunk);
      bytes += chunk.length;
      if (bytes > 1_000_000) {
        over = true;
        req.destroy();
        reject(new Error('请求体过大'));
      }
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dispatch/start',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        if (!guardRoute(req, res)) return;
        const svc = await servicePromise;
        if (!svc) return sendJson(res, 503, { code: 'STORE_READONLY', error: '执行内核不可用(只读故障态)' });
        const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        if (body.targetType !== undefined && body.targetType !== 'traj_node') {
          return sendJson(res, 422, { code: 'VALIDATION', error: '工作台任务必须通过 /dispatch/workbench/tasks/:id/run 启动' });
        }
        const r = await svc.start({
          actorScope: typeof body.actorScope === 'string' ? body.actorScope : 'local',
          idempotencyKey: String(body.idempotencyKey ?? ''),
          targetType: String(body.targetType ?? 'traj_node'),
          projectId: String(body.projectId ?? ''),
          nodeId: String(body.nodeId ?? ''),
          ws: String(body.ws ?? ''),
          model: body.model === undefined ? undefined : String(body.model),
          toolAllow: Array.isArray(body.toolAllow) ? body.toolAllow.map(String) : undefined,
        });
        sendJson(res, r.replay ? 200 : 202, r);
      } catch (err) {
        if (err instanceof ServiceError) return sendJson(res, err.httpStatus, { code: err.code, error: err.message, dispatchId: undefined });
        sendJson(res, 500, { code: 'INTERNAL', error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dispatch/cancel',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        if (!guardRoute(req, res)) return;
        const svc = await servicePromise;
        if (!svc) return sendJson(res, 503, { code: 'STORE_READONLY', error: '执行内核不可用' });
        const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        const r = await svc.cancel(String(body.dispatchId ?? ''), String(body.by ?? 'user'), String(body.reason ?? ''));
        sendJson(res, 202, { ...r, note: '取消已受理;完成以静止确认为准' });
      } catch (err) {
        if (err instanceof ServiceError) return sendJson(res, err.httpStatus, { code: err.code, error: err.message });
        sendJson(res, 500, { code: 'INTERNAL', error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dispatch/takeover',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        if (!guardRoute(req, res)) return;
        const svc = await servicePromise;
        if (!svc) return sendJson(res, 503, { code: 'STORE_READONLY', error: '执行内核不可用' });
        const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        const r = await svc.takeover(String(body.dispatchId ?? ''), String(body.actor ?? 'user'), String(body.reason ?? ''));
        sendJson(res, 202, r);
      } catch (err) {
        if (err instanceof ServiceError) return sendJson(res, err.httpStatus, { code: err.code, error: err.message });
        sendJson(res, 500, { code: 'INTERNAL', error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dispatch/reconcile',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        if (!guardRoute(req, res)) return;
        const svc = await servicePromise;
        if (!svc) return sendJson(res, 503, { code: 'STORE_READONLY', error: '执行内核不可用' });
        sendJson(res, 200, await svc.reconcileOnce());
      } catch (err) {
        sendJson(res, 500, { code: 'INTERNAL', error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dispatch/resolve',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        if (!guardRoute(req, res)) return;
        const svc = await servicePromise;
        if (!svc) return sendJson(res, 503, { code: 'STORE_READONLY', error: '执行内核不可用' });
        const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        const r = await svc.resolve(String(body.dispatchId ?? ''), String(body.operator ?? 'operator'), String(body.evidence ?? ''));
        sendJson(res, 202, r);
      } catch (err) {
        if (err instanceof ServiceError) return sendJson(res, err.httpStatus, { code: err.code, error: err.message });
        sendJson(res, 500, { code: 'INTERNAL', error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/dispatch/status',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
        if (!guardRoute(req, res)) return;
        const svc = await servicePromise;
        if (!svc) return sendJson(res, 503, { code: 'STORE_READONLY', error: '执行内核不可用' });
        const u = new URL(req.url ?? '/', 'http://127.0.0.1');
        const id = u.pathname.replace(/^\/dispatch\/status\/?/, '').split('/')[0];
        if (!id) return sendJson(res, 422, { error: '缺少 dispatchId' });
        const rec = svc.status(id);
        const { source, ...rest } = rec;
        sendJson(res, 200, {
          ...rest,
          allowedActions: allowedActionsFor(rec),
          source: { taskFingerprint: source.taskFingerprint, promptHash: source.promptHash, protocolVersion: source.protocolVersion, snapshot: source.snapshot },
        });
      } catch (err) {
        if (err instanceof ServiceError) return sendJson(res, err.httpStatus, { code: err.code, error: err.message });
        sendJson(res, 500, { code: 'INTERNAL', error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dispatch/list',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
        if (!guardRoute(req, res)) return;
        const svc = await servicePromise;
        if (!svc) return sendJson(res, 503, { code: 'STORE_READONLY', error: '执行内核不可用' });
        const u = new URL(req.url ?? '/', 'http://127.0.0.1');
        const ws = u.searchParams.get('ws') ?? undefined;
        sendJson(res, 200, { dispatches: svc.list(ws) });
      } catch (err) {
        sendJson(res, 500, { code: 'INTERNAL', error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));
}
