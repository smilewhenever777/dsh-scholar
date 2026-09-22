/**
 * P0 探针面(保留供持续运行时核验;设计 §1.3)。
 * 与 P1 业务面隔离:/dispatch/probe/* + dispatch_probe_* 工具。
 * sponsor/child 直接走宿主原始 API,不经过 DispatchService。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { journal, journalSnapshot } from './journal.js';
import { dshHome } from './store.js';
import type { InMemoryTargetAdapter } from './adapters/target.js';
import type { TaskSnapshot } from './types.js';

function sendJson(res: ServerResponse, code: number, payload: unknown): void {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function guardRoute(req: IncomingMessage, res: ServerResponse): boolean {
  const hostRaw = String(req.headers.host ?? '').toLowerCase();
  let hostName = hostRaw;
  if (hostName.startsWith('[')) hostName = hostName.slice(1, hostName.includes(']') ? hostName.indexOf(']') : undefined);
  else if (hostName.includes(':')) hostName = hostName.split(':')[0];
  if (hostName && !['localhost', '127.0.0.1', '::1'].includes(hostName)) {
    sendJson(res, 403, { error: '非法 Host' });
    return false;
  }
  const origin = String(req.headers.origin ?? '');
  if (origin) {
    try {
      const o = new URL(origin);
      const oHost = (o.hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
      const loopback = oHost === 'localhost' || oHost === '127.0.0.1' || oHost === '::1';
      const sameOrigin = o.host === hostRaw || (oHost === hostName && !o.port && !hostRaw.includes(':'));
      if (!loopback || !sameOrigin) {
        sendJson(res, 403, { error: '跨源请求被拒绝' });
        return false;
      }
    } catch {
      sendJson(res, 403, { error: '非法 Origin' });
      return false;
    }
  }
  const addr = req.socket.remoteAddress ?? '';
  if (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1') return true;
  sendJson(res, 403, { error: '仅允许本机(loopback)访问' });
  return false;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
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
}

function excerpt(blocks: unknown): string | null {
  if (!Array.isArray(blocks)) return null;
  const t = (blocks as ContentBlock[])
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join(' ')
    .trim();
  return t ? (t.length > 300 ? `${t.slice(0, 300)}…` : t) : null;
}

function pickLifecycle(info: unknown): Record<string, unknown> {
  const i = info as { runId?: unknown; id?: unknown; provider?: unknown; local?: unknown; stopReason?: unknown; lastAssistantMessage?: unknown } | null;
  return {
    runId: i?.runId === undefined ? null : String(i.runId),
    id: i?.id === undefined ? null : String(i.id),
    provider: i?.provider ?? null,
    local: i?.local ?? null,
    stopReason: i?.stopReason ?? null,
    lastAssistantText: excerpt(i?.lastAssistantMessage),
  };
}

function sessionFileStat(sessionId: string): { path: string; size: number; mtimeMs: number } | null {
  const root = join(dshHome(), 'sessions');
  try {
    for (const wsDir of readdirSync(root)) {
      for (const name of ['session.v3.jsonl.zstd', 'session.jsonl.zstd']) {
        try {
          const p = join(root, wsDir, sessionId, name);
          const st = statSync(p);
          return { path: p, size: st.size, mtimeMs: st.mtimeMs };
        } catch {
          /* 下一个候选 */
        }
      }
    }
  } catch {
    /* sessions 根不存在 */
  }
  return null;
}

export interface ProbeDeps {
  memoryTarget: InMemoryTargetAdapter | null;
}

export function registerProbe(ctx: Context, deps: ProbeDeps): void {
  let sponsorSessionId: string | null = null;
  let sponsorAgent: Agent | null = null;
  let sponsorVia = '';

  const sub = () => (ctx as unknown as Record<string, unknown>).subagents as
    | {
        list?: () => string[];
        startContinuable?: (spec: unknown) => Promise<{ childId: unknown; messageId: unknown }>;
        listChildren?: (id: string) => Promise<unknown[]>;
        interruptByParent?: (c: string, p: string, m: 'continuable') => unknown;
        drainContinuableChildren?: (p: Agent, ids: string[]) => Promise<void>;
        sendMessage?: (s: Agent, t: string, c: ContentBlock[], o: { signal: AbortSignal }) => Promise<unknown>;
      }
    | undefined;
  const agents = () => (ctx as unknown as Record<string, unknown>).agents as
    | {
        get?: (id: string) => Agent | undefined;
        create?: (o: unknown) => Promise<{ agent: Agent }>;
        resume?: (o: unknown) => Promise<{ agent: Agent }>;
      }
    | undefined;

  const anyCtx = ctx as unknown as { on?: (ev: string, fn: (info: unknown) => void) => void };
  anyCtx.on?.('subagent/provider-added', (p) => journal('subagent/provider-added', { name: (p as { name?: string })?.name ?? String(p) }));
  anyCtx.on?.('subagent/start', (info) => journal('subagent/start', pickLifecycle(info)));
  anyCtx.on?.('subagent/end', (info) => journal('subagent/end', pickLifecycle(info)));

  /* ---------- 探针工具 ---------- */
  const renderProbe = (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] as ContentBlock[];
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'dispatch_probe_identity',
    description: '[P0 探针] 返回调用者身份信息,不产生任何副作用。任何 agent 都可以随时调用。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: renderProbe },
    async execute(_args: unknown, exec: unknown) {
      const e = exec as { agent?: Agent; signal?: AbortSignal } | undefined;
      journal('tool/identity', { callerSessionId: e?.agent?.id ?? null, signalAborted: !!e?.signal?.aborted });
      return { ok: true, callerSessionId: e?.agent?.id ?? null, hasAgent: !!e?.agent, t: Date.now() };
    },
  })));
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'dispatch_probe_sleep',
    description: '[P0 探针] 等待指定毫秒(中断语义测试);收到取消信号会提前返回并如实报告。',
    parameters: { ms: { type: 'number', required: true, description: '等待毫秒数(1~300000)' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderProbe },
    async execute(args: unknown, exec: unknown) {
      const a = args as { ms?: number } | undefined;
      const e = exec as { agent?: Agent; signal?: AbortSignal } | undefined;
      const requestedMs = Math.max(1, Math.min(Number(a?.ms) || 0, 300_000));
      const t0 = Date.now();
      await new Promise<void>((resolve) => {
        const sig = e?.signal;
        const timer = setTimeout(() => { sig?.removeEventListener?.('abort', onAbort); resolve(); }, requestedMs);
        const onAbort = () => { clearTimeout(timer); resolve(); };
        sig?.addEventListener?.('abort', onAbort, { once: true });
      });
      const sleptMs = Date.now() - t0;
      journal('tool/sleep', { requestedMs, sleptMs, aborted: !!e?.signal?.aborted, callerSessionId: e?.agent?.id ?? null });
      return { ok: true, requestedMs, sleptMs, aborted: !!e?.signal?.aborted };
    },
  })));

  /* ---------- 探针路由 ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/dispatch/probe',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        if (!guardRoute(req, res)) return;
        const u = new URL(req.url ?? '/', 'http://127.0.0.1');
        const rest = u.pathname.replace(/^\/dispatch\/probe/, '').replace(/\/+$/, '');

        if (req.method === 'GET' && rest === '/env') {
          const providers = typeof sub()?.list === 'function' ? sub()!.list!() : null;
          sendJson(res, 200, {
            ok: true,
            dshHome: dshHome(),
            node: process.version,
            webPort: (ctx as unknown as { webServer?: { port?: number } }).webServer?.port ?? null,
            providers,
            spawnProviderPresent: Array.isArray(providers) && providers.includes('spawn'),
          });
          return;
        }
        if (req.method === 'POST' && rest === '/seed-node') {
          if (!deps.memoryTarget) { sendJson(res, 400, { error: '仅 memory 后端可播种任务节点' }); return; }
          const body = JSON.parse(await readBody(req)) as TaskSnapshot;
          if (!body?.projectId || !body?.nodeId || !body?.nodeTitle) { sendJson(res, 422, { error: '需要 projectId/nodeId/nodeTitle' }); return; }
          deps.memoryTarget.upsertNode(body);
          journal('probe/seed-node', { node: `${body.projectId}/${body.nodeId}` });
          sendJson(res, 200, { ok: true });
          return;
        }
        if (req.method === 'POST' && rest === '/sponsor') {
          const body = JSON.parse(await readBody(req)) as { ws?: string; modelProvider?: string; model?: string };
          const ws = String(body.ws ?? '').trim();
          if (!ws) { sendJson(res, 422, { error: '缺少 ws' }); return; }
          const a = agents();
          if (!a) { sendJson(res, 503, { error: 'ctx.agents 不可用' }); return; }
          const norm = ws.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
          const id = `dispatch-p0-${createHash('sha256').update(norm).digest('hex').slice(0, 12)}`;
          const agentOptions = {
            provider: String(body.modelProvider ?? 'glm'),
            model: String(body.model ?? 'glm-5.3'),
          };
          const live = a.get?.(id);
          if (live) {
            sponsorSessionId = id; sponsorAgent = live; sponsorVia = 'get-live';
          } else {
            try {
              const h = await a.create!({ sessionId: id, meta: { cwd: ws }, agentOptions });
              sponsorSessionId = id; sponsorAgent = h.agent; sponsorVia = 'create';
            } catch {
              const h = await a.resume!({ resumeSessionId: id, agentOptions });
              sponsorSessionId = id; sponsorAgent = h.agent; sponsorVia = 'resume';
            }
          }
          journal('probe/sponsor', { sessionId: sponsorSessionId, via: sponsorVia });
          sendJson(res, 200, { ok: true, sessionId: sponsorSessionId, via: sponsorVia });
          return;
        }
        if (req.method === 'POST' && rest === '/start') {
          if (!sponsorAgent) { sendJson(res, 400, { error: '先 POST /dispatch/probe/sponsor' }); return; }
          const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
          const reserved = typeof body.childId === 'string' && body.childId ? body.childId : undefined;
          const toolFilter: Record<string, string[]> = {};
          if (Array.isArray(body.toolAllow)) toolFilter.allow = body.toolAllow.map(String);
          if (Array.isArray(body.toolDeny)) toolFilter.deny = body.toolDeny.map(String);
          const agentOptions = {
            provider: String(body.modelProvider ?? 'glm'),
            model: String(body.model ?? 'glm-5.3'),
          };
          const t0 = Date.now();
          let r: { childId: unknown; messageId: unknown };
          try {
            r = await sub()!.startContinuable!({
              provider: 'spawn',
              label: String(body.label ?? `probe-${t0}`),
              ...(reserved ? { childId: reserved } : {}),
              request: {
                prompt: [{ type: 'text', text: String(body.prompt ?? '') }],
                parent: sponsorAgent,
                agentOptions,
                maxDepth: 1,
                ...(Object.keys(toolFilter).length ? { toolFilter } : {}),
              },
              signal: new AbortController().signal,
            });
          } catch (e) {
            journal('probe/start-rejected', { error: String((e as Error)?.message ?? e) });
            sendJson(res, 500, { error: String((e as Error)?.message ?? e) });
            return;
          }
          journal('probe/start-accepted', { childId: String(r.childId), elapsedMs: Date.now() - t0, reservedMatched: reserved ? String(r.childId) === reserved : null });
          let list0: unknown = null;
          try { list0 = await sub()!.listChildren!(sponsorSessionId!); } catch (e) { list0 = { error: String(e) }; }
          sendJson(res, 200, { ok: true, childId: String(r.childId), messageId: String(r.messageId), elapsedMs: Date.now() - t0, listAtAcceptance: list0 });
          return;
        }
        if (req.method === 'GET' && rest === '/children') {
          if (!sponsorSessionId) { sendJson(res, 400, { error: 'no sponsor' }); return; }
          try {
            const list = await sub()!.listChildren!(sponsorSessionId);
            sendJson(res, 200, { ok: true, children: list });
          } catch (e) {
            sendJson(res, 200, { ok: false, error: String(e) });
          }
          return;
        }
        if (req.method === 'POST' && rest === '/interrupt') {
          const body = JSON.parse(await readBody(req)) as { childId?: string };
          if (!sponsorSessionId || !body.childId) { sendJson(res, 422, { error: '缺少 childId' }); return; }
          sub()!.interruptByParent!(body.childId, sponsorSessionId, 'continuable');
          journal('probe/interrupt', { childId: body.childId });
          sendJson(res, 200, { ok: true, accepted: true });
          return;
        }
        if (req.method === 'GET' && rest === '/journal') {
          const sinceMs = Number(u.searchParams.get('sinceMs') ?? 0) || 0;
          const limit = Number(u.searchParams.get('limit') ?? 800) || 800;
          sendJson(res, 200, { ok: true, ...journalSnapshot(sinceMs, limit) });
          return;
        }
        sendJson(res, 404, { error: 'not found' });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));
}
