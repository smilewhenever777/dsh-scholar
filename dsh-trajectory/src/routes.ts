/**
 * dsh-trajectory — REST routes under /traj/* (host half).
 *
 * NOTE: routes must NOT live under /api — dsh-client-connection owns the
 * /api prefix (RPC bridge) and would swallow them.
 *
 * POST/PUT bodies are forced to application/json (CSRF hardening, same as
 * dsh-server-dashboard / dsh-scholar). Validation uses schemastery schemas.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import z from 'schemastery';
import type { TrajConfig, TrajEdge, TrajNodeKind, TrajStatus } from './shared/types.js';
import { TRAJ_NODE_KINDS, TRAJ_STATUSES } from './shared/types.js';
import type { TrajStore } from './store.js';
import { countsByStatus, normalizeWorkspaceKey } from './domain.js';

const NodeInputSchema = z.object({
  kind: z.union([...TRAJ_NODE_KINDS]).default('other'),
  title: z.string().required(),
  status: z.union([...TRAJ_STATUSES]).default('todo'),
  detail: z.string().default(''),
  tags: z.array(z.string()).default([]),
});
const ProjectInputSchema = z.object({
  name: z.string().required(),
  description: z.string().default(''),
});

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    // F02:严格媒体类型——分号前主类型必须精确等于 application/json;
    // includes 匹配可被 "text/plain;application/json" 绕过(浏览器简单请求不需预检)
    const ct = String(req.headers['content-type'] ?? '');
    if (ct.split(';')[0].trim().toLowerCase() !== 'application/json') {
      reject(new Error('请求必须是 application/json'));
      return;
    }
    // F02:Host 必须是回环域——DNS rebinning 把外域解析到 127.0.0.1 时 Host 是外域名
    const hostRaw = String(req.headers.host ?? '').toLowerCase();
    let hostName = hostRaw;
    if (hostName.startsWith('[')) hostName = hostName.slice(1, hostName.includes(']') ? hostName.indexOf(']') : undefined);
    else if (hostName.includes(':')) hostName = hostName.split(':')[0];
    if (hostName && !['localhost', '127.0.0.1', '::1'].includes(hostName)) {
      reject(new Error('非法 Host'));
      return;
    }
    // F02:浏览器跨源请求的 Origin 必须与 Host 同源(同域同端口)——
    // 本机其他端口的恶意页面发起的简单 CSRF 因此被拒;无 Origin 的非浏览器
    // 客户端放行,由 loopback 对端校验兜底
    const origin = String(req.headers.origin ?? '');
    if (origin) {
      try {
        const o = new URL(origin);
        const oHost = (o.hostname || '').toLowerCase();
        const loopback = oHost === 'localhost' || oHost === '127.0.0.1' || oHost === '::1';
        const sameOrigin = o.host === hostRaw || (oHost === hostName && !o.port && !hostRaw.includes(':'));
        if (!loopback || !sameOrigin) {
          reject(new Error('跨源请求被拒绝'));
          return;
        }
      } catch {
        reject(new Error('非法 Origin'));
        return;
      }
    }
    // F10:按字节缓冲、超限即断流、结束时一次性 UTF-8 解码——
    // 逐 chunk 字符串拼接会把多字节汉字从中间拆开损坏
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
function sendJson(res: ServerResponse, code: number, payload: unknown): void {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

/** 403 unless loopback(与 dsh-server-dashboard 同款):0.1.5 的 Web 认证门不覆盖
 * 插件命名路由,/traj/* 需要自己的本机围栏 */
function guardRoute(req: import('node:http').IncomingMessage, res: ServerResponse): boolean {
  // F02:Host 必须是回环域——DNS rebinding 把外域解析到 127.0.0.1 时 Host 是外域名
  const hostRaw = String(req.headers.host ?? '').toLowerCase();
  let hostName = hostRaw;
  if (hostName.startsWith('[')) hostName = hostName.slice(1, hostName.includes(']') ? hostName.indexOf(']') : undefined);
  else if (hostName.includes(':')) hostName = hostName.split(':')[0];
  if (hostName && !['localhost', '127.0.0.1', '::1'].includes(hostName)) {
    sendJson(res, 403, { error: '非法 Host' });
    return false;
  }
  // F02:浏览器跨源请求的 Origin 必须与 Host 同源——本机其他端口的页面发起的简单 CSRF 因此被拒
  const origin = String(req.headers.origin ?? '');
  if (origin) {
    try {
      const o = new URL(origin);
      const oHost = (o.hostname || '').toLowerCase();
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

/** REST 错误分类:文件系统/服务器故障 500,其余(参数/校验/业务拒绝)400。 */
function errorStatus(err: unknown): number {
  const code = (err as { code?: string } | null)?.code;
  if (typeof code === 'string' && ['EACCES', 'EPERM', 'EBUSY', 'ENOENT', 'EMFILE', 'ENOSPC', 'EROFS'].includes(code)) {
    return 500;
  }
  return 400;
}

/** cmdPattern 过短提示(过宽的命令特征会错挂无关进程的进度)。 */
function cmdPatternWarning(body: Record<string, unknown>): { warning?: string } {
  const s = typeof body.cmdPattern === 'string' ? body.cmdPattern.trim() : '';
  return s && s.length < 4 ? { warning: 'cmdPattern 过短(建议 ≥4 字符),可能匹配到无关进程的实时进度' } : {};
}

function pathInfo(req: IncomingMessage, prefix: string): { rest: string; params: URLSearchParams } {
  const u = new URL(req.url ?? '/', 'http://localhost');
  return { rest: u.pathname.slice(prefix.length), params: u.searchParams };
}

/** Extract the refs block from a raw body (host-side only; id+label strings). */
function refsFromBody(body: Record<string, unknown>): Record<string, string> {
  const keys = ['cardId', 'cardLabel', 'paperId', 'paperLabel', 'hostId', 'logPath', 'cmdPattern'] as const;
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = body[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return Object.keys(out).length ? out : {};
}

export function registerTrajRoutes(
  ctx: Context,
  getStore: () => Promise<TrajStore>,
  getConfig: () => TrajConfig,
  updateConfig: (patch: Partial<TrajConfig>) => Promise<void>,
): void {
  /* ---------- v0.3 层 0:Goal 路由 ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/traj/goals',
    handler: async (req, res) => {
      try {
        if (!guardRoute(req, res)) return;
        const store = await getStore();
        const { rest } = pathInfo(req, '/traj/goals');

        if (!rest || rest === '/') {
          if (req.method === 'GET') {
            const file = await store.resolveProject({ ws: new URL(req.url ?? '/', 'http://localhost').searchParams.get('ws') ?? undefined });
            sendJson(res, 200, { goals: file.goals, activeGoalId: store.getActiveGoal(file.project.id)?.id ?? null });
            return;
          }
          if (req.method === 'POST') {
            const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
            const file = await store.resolveProject({
              ws: typeof body.ws === 'string' ? body.ws : undefined,
              projectId: typeof body.projectId === 'string' && body.projectId ? body.projectId : undefined,
            });
            const r = await store.setGoal(file.project.id, String(body.text ?? ''), typeof body.reason === 'string' ? body.reason : undefined);
            sendJson(res, 200, { goal: r.goal, revised: r.revised });
            return;
          }
          return sendJson(res, 405, { error: 'method not allowed' });
        }
        return sendJson(res, 404, { error: 'not found' });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- v0.3 层 1:Hypothesis 路由 ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/traj/hypotheses',
    handler: async (req, res) => {
      try {
        if (!guardRoute(req, res)) return;
        const store = await getStore();
        const { rest } = pathInfo(req, '/traj/hypotheses');

        if (!rest || rest === '/') {
          if (req.method === 'GET') {
            const file = await store.resolveProject({ ws: new URL(req.url ?? '/', 'http://localhost').searchParams.get('ws') ?? undefined });
            sendJson(res, 200, { hypotheses: store.listHypotheses(file.project.id) });
            return;
          }
          if (req.method === 'POST') {
            const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
            const file = await store.resolveProject({
              ws: typeof body.ws === 'string' ? body.ws : undefined,
              projectId: typeof body.projectId === 'string' && body.projectId ? body.projectId : undefined,
            });
            const hyp = await store.addHypothesis(file.project.id, {
              text: String(body.text ?? ''),
              track: typeof body.track === 'string' ? body.track : undefined,
            });
            sendJson(res, 201, { hypothesis: hyp });
            return;
          }
          return sendJson(res, 405, { error: 'method not allowed' });
        }

        const id = decodeURIComponent(rest.slice(1));
        if (!id || id.includes('/')) return sendJson(res, 404, { error: 'not found' });
        if (req.method === 'PUT') {
          const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
          const file = await store.resolveProject({
            ws: typeof body.ws === 'string' ? body.ws : undefined,
            projectId: typeof body.projectId === 'string' && body.projectId ? body.projectId : undefined,
          });
          const hyp = await store.updateHypothesis(file.project.id, id, {
            text: typeof body.text === 'string' ? body.text : undefined,
            status: typeof body.status === 'string' ? body.status : undefined,
            track: typeof body.track === 'string' ? body.track : undefined,
            outcomeReason: typeof body.outcomeReason === 'string' ? body.outcomeReason : undefined,
          });
          sendJson(res, 200, { hypothesis: hyp });
          return;
        }
        sendJson(res, 405, { error: 'method not allowed' });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- overview (badge polling) ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/traj/overview',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      try {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
        const store = await getStore();
        const wsRaw = new URL(req.url ?? '/', 'http://localhost').searchParams.get('ws') ?? '';
        // ws 优先:返回该工作区绑定的项目;无 ws 参数则回落全局活跃(读操作允许回落)
        const resolved = wsRaw ? store.findByWorkspace(wsRaw) : store.getActive();
        const active = resolved;
        sendJson(res, 200, {
          activeProjectId: active?.project.id ?? null,
          ws: wsRaw ? normalizeWorkspaceKey(wsRaw) : undefined, // 回显复用域层归一化
          wsBound: wsRaw ? !!active : true,
          projects: store.listProjectFiles().map((f) => ({
            id: f.project.id,
            name: f.project.name,
            status: f.project.status,
            workspaceKey: f.project.workspaceKey,
            nodes: f.nodes.length,
            open: f.nodes.filter((n) => n.status === 'todo' || n.status === 'in_progress' || n.status === 'blocked').length,
            updatedAt: f.project.updatedAt,
          })),
          counts: active ? countsByStatus(active.nodes) : { todo: 0, in_progress: 0, blocked: 0, done: 0, dropped: 0 },
          dir: store.dir,
        });
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- stats (settings page) ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/traj/stats',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      try {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
        const store = await getStore();
        sendJson(res, 200, store.stats());
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- config ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/traj/config',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      try {
        if (req.method === 'GET') {
          sendJson(res, 200, { config: getConfig() });
          return;
        }
        if (req.method === 'PUT') {
          const body = JSON.parse(await readBody(req)) as { dataDir?: unknown };
          if (typeof body.dataDir !== 'string' || !body.dataDir.trim()) {
            return sendJson(res, 400, { error: 'dataDir 必须是非空字符串' });
          }
          await updateConfig({ dataDir: body.dataDir.trim() });
          sendJson(res, 200, { ok: true });
          return;
        }
        sendJson(res, 405, { error: 'method not allowed' });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- projects ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/traj/projects',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      try {
        const store = await getStore();
        const { rest } = pathInfo(req, '/traj/projects');

        if (!rest || rest === '/') {
          if (req.method === 'GET') {
            sendJson(res, 200, {
              projects: store.listProjectFiles().map((f) => ({
                project: f.project,
                nodeCount: f.nodes.length,
                edgeCount: f.edges.length,
              })),
              activeProjectId: store.activeProjectId,
            });
            return;
          }
          if (req.method === 'POST') {
            const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
            // ws 绑定创建:工作区已绑定时幂等返回(name 可省,用目录名)
            if (typeof body.ws === 'string' && body.ws.trim()) {
              const r = await store.createForWorkspace({
                workspaceKey: body.ws,
                name: typeof body.name === 'string' && body.name.trim() ? body.name : undefined,
                description: typeof body.description === 'string' ? body.description : undefined,
              });
              sendJson(res, r.existed ? 200 : 201, { created: !r.existed, project: r.project });
              return;
            }
            const input = ProjectInputSchema(body);
            const { project, existed } = await store.createProject({
              name: input.name,
              description: input.description || undefined,
              activate: true,
            });
            sendJson(res, existed ? 200 : 201, { created: !existed, project });
            return;
          }
          return sendJson(res, 405, { error: 'method not allowed' });
        }

        const m = /^\/([^/]+)(\/active)?$/.exec(rest);
        if (!m) return sendJson(res, 404, { error: 'not found' });
        const id = decodeURIComponent(m[1]);
        if (m[2]) {
          if (req.method !== 'PUT') return sendJson(res, 405, { error: 'method not allowed' });
          const file = await store.setActive(id);
          sendJson(res, 200, { project: file.project });
          return;
        }
        if (req.method === 'GET') {
          const file = store.getFile(id);
          if (!file) return sendJson(res, 404, { error: '项目不存在' });
          sendJson(res, 200, file);
          return;
        }
        if (req.method === 'PUT') {
          const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
          // 绑定/改绑/解绑工作区
          if (typeof body.bindWs === 'string' && body.bindWs.trim()) {
            const project = await store.bindWorkspace(id, body.bindWs);
            sendJson(res, 200, { project });
            return;
          }
          if (body.unbindWs === true) {
            const project = await store.bindWorkspace(id, '');
            sendJson(res, 200, { project });
            return;
          }
          const patch: Record<string, unknown> = {};
          if (typeof body.name === 'string') patch.name = body.name;
          if (typeof body.description === 'string') patch.description = body.description;
          if (typeof body.researchQuestion === 'string') patch.researchQuestion = body.researchQuestion;
          if (body.status === 'active' || body.status === 'archived') patch.status = body.status;
          if (Array.isArray(body.mainline)) patch.mainline = body.mainline;
          if (!Object.keys(patch).length) {
            const cur = store.getFile(id);
            if (!cur) return sendJson(res, 404, { error: '项目不存在' });
            return sendJson(res, 200, { project: cur.project });
          }
          const project = await store.updateProject(id, patch);
          sendJson(res, 200, { project });
          return;
        }
        if (req.method === 'DELETE') {
          const ok = await store.deleteProject(id);
          sendJson(res, ok ? 200 : 404, ok ? { deleted: true } : { error: '项目不存在' });
          return;
        }
        sendJson(res, 405, { error: 'method not allowed' });
      } catch (err) {
        sendJson(res, errorStatus(err), { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- nodes ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/traj/nodes',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      try {
        const store = await getStore();
        const { rest } = pathInfo(req, '/traj/nodes');

        if (!rest) {
          if (req.method === 'POST') {
            const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
            const input = NodeInputSchema(body);
            // mutating:无 ws 且无 projectId 时 400(store 抛错),绝不静默落全局活跃
            const file = await store.resolveProject({
              ws: typeof body.ws === 'string' ? body.ws : undefined,
              projectId: typeof body.projectId === 'string' && body.projectId ? body.projectId : undefined,
              mutating: true,
            });
            const node = await store.addNode({
              projectId: file.project.id,
              kind: input.kind as TrajNodeKind,
              title: input.title,
              status: input.status as TrajStatus,
              detail: input.detail || undefined,
              tags: input.tags,
              refs: refsFromBody(body),
              parentIds: Array.isArray(body.parentIds) ? body.parentIds as string[] : undefined,
              mainline: body.mainline === true,
            });
            sendJson(res, 201, { node, ...cmdPatternWarning(body) });
            return;
          }
          return sendJson(res, 405, { error: 'method not allowed' });
        }

        /* ---------- 实验台账 /traj/nodes/:id/entries[/:eid](先于 :id 解析)---------- */
        const entryMatch = /^\/([^/]+)\/entries(\/([^/]+))?$/.exec(rest);
        if (entryMatch) {
          const nodeId = decodeURIComponent(entryMatch[1]);
          const eid = entryMatch[3] ? decodeURIComponent(entryMatch[3]) : null;
          if (req.method === 'POST' && !eid) {
            const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
            const r = await store.addEntry(nodeId, {
              title: typeof body.title === 'string' ? body.title : undefined,
              data: typeof body.data === 'string' ? body.data : undefined,
              conclusion: typeof body.conclusion === 'string' ? body.conclusion : undefined,
              ts: typeof body.ts === 'number' ? body.ts : undefined,
              metrics: body.metrics,
            });
            sendJson(res, 201, { node: r.node, entry: r.entry });
            return;
          }
          if (req.method === 'DELETE' && eid) {
            const ok = await store.removeEntry(nodeId, eid);
            sendJson(res, ok ? 200 : 404, ok ? { deleted: true } : { error: '台账不存在' });
            return;
          }
          return sendJson(res, 405, { error: 'method not allowed' });
        }

        const id = decodeURIComponent(rest.slice(1));
        if (!id || id.includes('/')) return sendJson(res, 404, { error: 'not found' });
        if (req.method === 'PUT') {
          const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
          const patch: Record<string, unknown> = {};
          if (typeof body.title === 'string') patch.title = body.title;
          if (typeof body.kind === 'string' && TRAJ_NODE_KINDS.includes(body.kind as TrajNodeKind)) patch.kind = body.kind;
          if (typeof body.status === 'string' && TRAJ_STATUSES.includes(body.status as TrajStatus)) patch.status = body.status;
          if (typeof body.detail === 'string') patch.detail = body.detail;
          if (typeof body.hypothesisId === 'string') patch.hypothesisId = body.hypothesisId || undefined;
          if (Array.isArray(body.tags)) patch.tags = body.tags;
          // explicit refs object wins; flat ref fields (cardId=… etc.) merge into a replace-block
          if (body.refs !== undefined && typeof body.refs === 'object' && !Array.isArray(body.refs)) {
            patch.refs = body.refs;
          } else {
            const flat = refsFromBody(body);
            if (Object.keys(flat).length) patch.refs = flat;
          }
          // 空 patch(如仅携带 projectId:"")直接返回现状:免一次无意义落盘 + updatedAt 搅动
          if (!Object.keys(patch).length) {
            const cur = store.getNode(id);
            if (!cur) return sendJson(res, 404, { error: '节点不存在' });
            return sendJson(res, 200, { node: cur });
          }
          const node = await store.updateNode(id, patch, typeof body.projectId === 'string' ? body.projectId : undefined);
          sendJson(res, 200, { node, ...cmdPatternWarning(body) });
          return;
        }
        if (req.method === 'DELETE') {
          const ok = await store.removeNode(id);
          sendJson(res, ok ? 200 : 404, ok ? { deleted: true } : { error: '节点不存在' });
          return;
        }
        sendJson(res, 405, { error: 'method not allowed' });
      } catch (err) {
        sendJson(res, errorStatus(err), { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- edges ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/traj/edges',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      try {
        const store = await getStore();
        const { rest } = pathInfo(req, '/traj/edges');

        if (!rest) {
          if (req.method === 'POST') {
            const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
            // mutating:无 ws 且无 projectId 时 400(store 抛错),绝不静默落全局活跃
            const file = await store.resolveProject({
              ws: typeof body.ws === 'string' ? body.ws : undefined,
              projectId: typeof body.projectId === 'string' && body.projectId ? body.projectId : undefined,
              mutating: true,
            });
            const { edge, existed } = await store.addEdge({
              projectId: file.project.id,
              source: typeof body.source === 'string' ? body.source : undefined,
              target: typeof body.target === 'string' ? body.target : undefined,
              kind: typeof body.kind === 'string' ? body.kind as TrajEdge['kind'] : undefined,
            });
            sendJson(res, existed ? 200 : 201, { existed, edge });
            return;
          }
          return sendJson(res, 405, { error: 'method not allowed' });
        }

        const id = decodeURIComponent(rest.slice(1));
        if (!id || id.includes('/')) return sendJson(res, 404, { error: 'not found' });
        if (req.method === 'DELETE') {
          const ok = await store.removeEdge(id);
          sendJson(res, ok ? 200 : 404, ok ? { deleted: true } : { error: '边不存在' });
          return;
        }
        sendJson(res, 405, { error: 'method not allowed' });
      } catch (err) {
        sendJson(res, errorStatus(err), { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));
}
