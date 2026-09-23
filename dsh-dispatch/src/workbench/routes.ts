import type { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-session-query';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { WorkbenchService } from './service.js';
import type { DispatchService } from '../service.js';
import { ServiceError } from '../types.js';

function send(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(data));
}
export function guardLocal(req: IncomingMessage, res: ServerResponse): boolean {
  const host = String(req.headers.host ?? '').toLowerCase();
  const hostName = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0];
  if (!host || !['localhost', '127.0.0.1', '::1'].includes(hostName)) { send(res, 403, { error: '非法 Host' }); return false; }
  const origin = String(req.headers.origin ?? '');
  if (origin) {
    try {
      const url = new URL(origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.host.toLowerCase() !== host) {
        send(res, 403, { error: '跨源请求被拒绝' }); return false;
      }
    } catch { send(res, 403, { error: '非法 Origin' }); return false; }
  }
  const addr = req.socket.remoteAddress;
  if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1') {
    send(res, 403, { error: '仅允许本机访问' }); return false;
  }
  return true;
}
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new ServiceError('VALIDATION', '请求必须是 application/json', 415);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new ServiceError('VALIDATION', '请求体过大', 413);
    chunks.push(buffer);
  }
  try {
    const obj = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('object expected');
    return obj as Record<string, unknown>;
  } catch { throw new ServiceError('VALIDATION', 'JSON 格式无效', 400); }
}
function textBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  const pieces: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') pieces.push(b.text);
    else if (b.type === 'tool-result') pieces.push(textBlocks(b.content));
  }
  return pieces.join('\n');
}

/** Only child-owned, human-visible message and tool events leave the host. */
export function presentEvent(event: { seq: number; type: string; time: number; data: unknown }) {
  const data = event.data as Record<string, unknown>;
  // The subagent's user message is a generated protocol prompt, not a human chat message.
  if (event.type === 'user/message') return null;
  if (event.type === 'assistant/message') {
    const message = data.message as Record<string, unknown> | undefined;
    return { seq: event.seq, at: event.time, kind: 'assistant', text: textBlocks(message?.content), interrupted: data.interrupted === true };
  }
  if (event.type === 'tool/call') return { seq: event.seq, at: event.time, kind: 'tool_call', name: String(data.name ?? ''), text: String(data.arguments ?? '') };
  if (event.type === 'tool/result') {
    const message = data.message as Record<string, unknown> | undefined;
    return { seq: event.seq, at: event.time, kind: 'tool_result', text: textBlocks(message?.content), error: !!data.error };
  }
  if (event.type === 'assistant/attempt') return { seq: event.seq, at: event.time, kind: 'attempt', text: '模型尝试未形成消息' };
  return null;
}

export function registerWorkbenchRoutes(ctx: Context, getServices: () => Promise<{ workbench: WorkbenchService; dispatch: DispatchService } | null>): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: '/dispatch/workbench',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        if (!guardLocal(req, res)) return;
        const services = await getServices();
        if (!services) return send(res, 503, { code: 'STORE_READONLY', error: '工作台不可用' });
        const { workbench, dispatch } = services;
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const path = url.pathname.replace(/^\/dispatch\/workbench\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
        const method = req.method ?? 'GET';
        const body = ['POST', 'PATCH'].includes(method) ? await readBody(req) : {};
        const [area, id, action] = path;
        if (!area && method === 'GET') { const since = Number(url.searchParams.get('sinceRevision') ?? Number.NaN); return send(res, 200, workbench.overview(Number.isNaN(since) ? undefined : since)); }
        if (area === 'overview' && method === 'GET') { const since = Number(url.searchParams.get('sinceRevision') ?? Number.NaN); return send(res, 200, workbench.overview(Number.isNaN(since) ? undefined : since)); }
        if (area === 'models' && method === 'GET') return send(res, 200, workbench.models());
        if (area === 'legacy' && method === 'GET') return send(res, 200, { runs: workbench.legacy() });
        if (area === 'projects' && !id && method === 'POST') return send(res, 201, await workbench.createProject(body));
        if (area === 'projects' && id && method === 'PATCH') return send(res, 200, await workbench.updateProject(id, body));
        if (area === 'agents' && !id && method === 'POST') return send(res, 201, await workbench.createAgent(body));
        if (area === 'agents' && id && method === 'PATCH') return send(res, 200, await workbench.updateAgent(id, body));
        if (area === 'tasks' && !id && method === 'POST') return send(res, 201, await workbench.createTask(body));
        if (area === 'tasks' && id && !action && method === 'GET') return send(res, 200, workbench.taskDetail(id));
        if (area === 'tasks' && id && !action && method === 'PATCH') return send(res, 200, await workbench.updateTask(id, body));
        if (area === 'tasks' && id && action === 'comments' && method === 'POST') return send(res, 201, await workbench.comment(id, body));
        if (area === 'tasks' && id && action === 'review' && method === 'POST') return send(res, 200, await workbench.review(id, body));
        if (area === 'tasks' && id && action === 'run' && method === 'POST') return send(res, 202, await workbench.start(id, body));
        if (area === 'runs' && id && !action && method === 'GET') return send(res, 200, workbench.runDetail(id));
        if (area === 'runs' && id && action === 'cancel' && method === 'POST') {
          if (workbench.runDetail(id).targetType !== 'workbench_task') throw new ServiceError('NOT_FOUND', '工作台执行记录不存在', 404);
          return send(res, 202, await dispatch.cancel(id, 'user', String(body.reason ?? '用户取消')));
        }
        if (area === 'runs' && id && action === 'takeover' && method === 'POST') {
          if (workbench.runDetail(id).targetType !== 'workbench_task') throw new ServiceError('NOT_FOUND', '工作台执行记录不存在', 404);
          const reason = String(body.reason ?? '').trim();
          if (!reason || reason.length > 2000) throw new ServiceError('VALIDATION', '接管原因必填且不超过 2000 字符', 422);
          return send(res, 202, await dispatch.takeover(id, 'user', reason));
        }
        if (area === 'runs' && id && action === 'resolve' && method === 'POST') {
          if (workbench.runDetail(id).targetType !== 'workbench_task') throw new ServiceError('NOT_FOUND', '工作台执行记录不存在', 404);
          const evidence = String(body.evidence ?? '').trim();
          if (!evidence || evidence.length > 2000) throw new ServiceError('VALIDATION', '静止核验依据必填且不超过 2000 字符', 422);
          return send(res, 202, await dispatch.resolve(id, 'user', evidence));
        }
        if (area === 'runs' && id && action === 'events' && method === 'GET') {
          const run = workbench.runDetail(id);
          if (run.targetType !== 'workbench_task') throw new ServiceError('NOT_FOUND', '该执行记录没有工作台会话', 404);
          const after = Number(url.searchParams.get('after') ?? '-1');
          const limit = Number(url.searchParams.get('limit') ?? '50');
          if (!Number.isSafeInteger(after) || after < -1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
            throw new ServiceError('VALIDATION', '无效的事件分页参数', 422);
          }
          let log: Awaited<ReturnType<typeof ctx.sessionQuery.readSession>>;
          try { log = await ctx.sessionQuery.readSession(SessionId(run.runtime.childSessionId)); }
          catch (e) {
            if (run.phase === 'preparing' || run.phase === 'starting') return send(res, 200, { events: [], nextCursor: after, hasMore: false });
            throw e;
          }
          const owned = log.events.filter((ev) => ev.seq >= log.inheritedEventCount && ev.seq > after);
          const events = owned.map((ev) => presentEvent(ev)).filter((ev) => ev !== null);
          const page = events.slice(0, limit);
          const nextCursor = page.at(-1)?.seq ?? (owned.at(-1)?.seq ?? after);
          return send(res, 200, { events: page, nextCursor, hasMore: events.length > limit });
        }
        send(res, 404, { error: '工作台路径不存在' });
      } catch (e) {
        if (e instanceof ServiceError) return send(res, e.httpStatus, { code: e.code, error: e.message });
        send(res, 500, { code: 'INTERNAL', error: e instanceof Error ? e.message : String(e) });
      }
    },
  } satisfies WebRoute));
}
