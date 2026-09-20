/**
 * dsh-trajectory — agent-facing tools (registered via ctx.tools.register).
 *
 * The conversation model maintains the research trajectory on the user's
 * behalf: create/switch projects, register nodes, advance statuses with
 * conclusions, wire dependency edges and curate the mainline. All content
 * arrives as structured tool arguments (validated here), checked against the
 * store, and persisted locally. presentCall/presentResult are PURE (they run
 * on live streaming AND session-log replay).
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
// 0.1.5 类型线已原生收录 presentCall/presentResult/presentationMeta,直接使用官方类型
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { TrajEdgeKind, TrajNode, TrajNodeKind, TrajProject, TrajProjectFile, TrajStatus } from './shared/types.js';
import type { TrajStore } from './store.js';
import { apiBase, fetchDashSnapshots, matchLiveProgress } from './liveprogress.js';
import { analyzeTrajectory } from './analysis.js';

const renderJson = (_args: unknown, value: unknown): ContentBlock[] => [
  { type: 'text', text: JSON.stringify(value, null, 2) },
];

/** Deep-clone into plain JSON (drops `undefined`) to satisfy the JsonValue contract. */
const toJson = (v: unknown): any => JSON.parse(JSON.stringify(v));

const callView = (title: string, rawInput?: unknown) => ({
  card: 'generic' as const,
  title,
  kind: 'other' as const,
  ...(rawInput !== undefined ? { rawInput } : {}),
});

const resultView = (title: string, md: string) => ({
  card: 'generic' as const,
  title,
  content: [{ type: 'text', text: md } as ContentBlock],
});

const STATUS_ZH: Record<TrajStatus, string> = {
  todo: '待办', in_progress: '进行中', blocked: '受阻', done: '完成', dropped: '放弃',
};
const KIND_ZH: Record<TrajNodeKind, string> = {
  milestone: '里程碑', idea: '创新点', experiment: '实验', paper: '论文', writing: '写作', other: '其他',
};

function mdNode(n: TrajNode): string {
  const bits = [`${KIND_ZH[n.kind] ?? n.kind}`, STATUS_ZH[n.status]];
  const refs: string[] = [];
  if (n.refs?.cardId) refs.push(`卡:${n.refs.cardLabel ?? n.refs.cardId}`);
  if (n.refs?.paperId) refs.push(`论文:${n.refs.paperLabel ?? n.refs.paperId}`);
  if (n.refs?.logPath || n.refs?.cmdPattern) refs.push('实验已绑定');
  return [`**${n.title}** \`${n.id}\``, bits.join(' · '), refs.join(' · '), n.detail ?? '']
    .filter(Boolean).join('\n');
}

const mdList = (items: string[], more = 0): string =>
  items.join('\n') + (more > 0 ? `\n_…另有 ${more} 条未列出_` : '');

/** 当前会话所属工作区 cwd(dsh-kanban 同款解析;取不到则回落全局)。 */
function wsKeyOf(exec: any): string | undefined {
  try {
    const cwd = exec?.agent?.session?.header?.cwd;
    return typeof cwd === 'string' && cwd.trim() ? cwd.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** cmdPattern 过短提示:太宽的命令特征会匹配到无关进程(进度映射错挂)。 */
function cmdPatternWarning(raw: unknown): { warning?: string } {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return s && s.length < 4 ? { warning: 'cmdPattern 过短(建议 ≥4 字符),可能匹配到无关进程的实时进度' } : {};
}

/** 解析操作目标项目:显式 projectId > 会话工作区绑定 > 全局活跃。
 *  mutating 场景(autoCreate/写入)在 ws 无法识别时由 store 抛错(不落全局活跃)。 */
function resolveTarget(store: TrajStore, args: any, exec: any, opts: { autoCreate?: boolean; mutating?: boolean; description?: string } = {}) {
  return store.resolveProject({
    ws: wsKeyOf(exec),
    projectId: typeof args?.projectId === 'string' && args.projectId ? args.projectId : undefined,
    autoCreate: opts.autoCreate,
    mutating: opts.mutating,
    description: opts.description,
  });
}

/** Node list item used by overview output (token-lean). */
function nodeBrief(n: TrajNode) {
  const entries = n.entries ?? [];
  const latest = [...entries].sort((a, b) => b.ts - a.ts)[0];
  return {
    id: n.id,
    kind: n.kind,
    title: n.title,
    status: n.status,
    detail: n.detail,
    entriesCount: entries.length || undefined,
    latestEntry: latest ? { title: latest.title, data: latest.data } : undefined,
    refs: n.refs
      ? {
          ...(n.refs.cardId ? { cardId: n.refs.cardId } : {}),
          ...(n.refs.paperId ? { paperId: n.refs.paperId } : {}),
          ...(n.refs.hostId || n.refs.logPath || n.refs.cmdPattern
            ? { hostId: n.refs.hostId, logPath: n.refs.logPath, cmdPattern: n.refs.cmdPattern }
            : {}),
        }
      : undefined,
    mainline: undefined as boolean | undefined,
  };
}

/** Full project view for traj_overview: mainline first, then branches, then edges. */
function projectOverview(file: TrajProjectFile) {
  const mainlineSet = new Set(file.project.mainline);
  const byId = new Map(file.nodes.map((n) => [n.id, n]));
  const spine = file.project.mainline
    .map((id) => byId.get(id))
    .filter((n): n is TrajNode => !!n)
    .map((n) => ({ ...nodeBrief(n), mainline: true }));
  const spineIds = new Set(spine.map((n) => n.id));
  const branches = file.nodes
    .filter((n) => !spineIds.has(n.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 80)
    .map(nodeBrief);
  const edges = file.edges.slice(0, 120).map((e) => ({
    id: e.id,
    from: byId.get(e.source)?.title ?? e.source,
    to: byId.get(e.target)?.title ?? e.target,
    kind: e.kind,
  }));
  const counts = { todo: 0, in_progress: 0, blocked: 0, done: 0, dropped: 0 } as Record<TrajStatus, number>;
  for (const n of file.nodes) counts[n.status] += 1;
  return {
    project: {
      id: file.project.id,
      name: file.project.name,
      description: file.project.description,
      status: file.project.status,
    },
    counts,
    mainline: spine,
    branches,
    edges,
    hint: 'mainline 数组即主线顺序;edges.from/to 是节点标题。更新前先读本概览拿真实 id。',
  };
}

export function registerTrajTools(ctx: Context, getStore: () => Promise<TrajStore>): void {
      /* ---------- v0.3:traj_review(分析引擎 + 互动提问) ---------- */
      ctx.tools.register(defineTool({
        name: 'traj_review',
        description:
          '分析当前研究项目的轨迹状态,发现需要用户决策的问题并给出建议提问(研究主线图插件 v0.3)。'
          + '分析规则:冷滞假设(R1)/孤儿实验(R2)/目标与实验方向错配(R3)/应证否未标(R4)/'
          + '高频目标修订(R5)/已验证假设下的待办积压(R6)/偏离长期未回归(R7)。'
          + '**使用时机**:用户问「研究进展如何」「帮我梳理一下」「有什么问题」时;'
          + '或每隔几个工作会话主动调用一次(作为研究健康检查)。'
          + '拿到 findings 后,**以对话形式**向用户提出 suggestedQuestion(可以改编得更自然),'
          + '根据用户的回答调用 traj_goal_set / traj_hypothesis_update / traj_node_update 落盘决策。'
          + '这是「AI 研究顾问」的核心工具——不是替用户做决定,而是发现值得问的问题。',
        parameters: {},
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: renderJson,
        },
        
        presentCall: () => callView('研究轨迹健康检查'),
        presentResult: (_args: unknown, result: { value?: any; meta?: any }) => {
          const v: any = result.value ?? {};
          const f: any[] = v.findings ?? [];
          const s: any = v.summary ?? {};
          const high = f.filter((x) => x.severity === 'high').length;
          return resultView(
            `轨迹检查:${high > 0 ? `${high} 个需要决策` : f.length > 0 ? `${f.length} 个建议关注` : '健康'}`,
            [
              `目标 v${s.goalVersion ?? '?'} · 假设 ${s.activeHypotheses ?? 0} 活跃 / ${s.validatedHypotheses ?? 0} 证实 / ${s.falsifiedHypotheses ?? 0} 证否`,
              f.length > 0 ? `发现 ${f.length} 个问题:${f.map((x) => `[${x.severity}] ${x.rule}`).join('; ')}` : '',
            ].filter(Boolean).join(String.fromCharCode(10)),
          );
        },
        async execute(args: any, exec: any) {
          const store = await getStore();
          const file = await resolveTarget(store, args, exec);
          const review = analyzeTrajectory(file);
          return toJson({ ok: true, ...review });
        },
      })),

      /* ---------- v0.3 层 0:traj_goal_set ---------- */
      ctx.tools.register(defineTool({
        name: 'traj_goal_set',
        description:
          '设置或修订研究项目的**总目标**(研究主线图插件 v0.3)。首次调用确立 Goal v1;'
          + '再次调用(文本不同)会修订:旧目标标 superseded(留痕),新目标版本+1,旧假设自动标 superseded。'
          + '用户说「研究问题改为 X」「目标调整为 Y」「我们发现…方向变了」时调用。'
          + 'reason 填变化原因(如「F330C 在 DVTOD 上失败,转向层级融合适应」)。',
        parameters: {
          text: { type: 'string', required: true, description: '总目标陈述(一句话)' },
          reason: { type: 'string', description: '修订原因(为什么变;首次确立可省略)' },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: { ok: { type: 'boolean' }, revised: { type: 'boolean' }, goal: { type: 'json' } },
          },
          render: renderJson,
        },
        
        presentCall: (args: any) => callView(`设置研究目标:${String(args.text ?? '').slice(0, 30)}`, { reason: args.reason }),
        presentResult: (args: any, result: { value?: any; meta?: any }) => {
          const v: any = result.value ?? {};
          const g: any = v.goal ?? {};
          return resultView(`${v.revised ? `目标已修订(v${g.version})` : '目标已确立(v1)'}:${String(g.text ?? '').slice(0, 36)}`,
            [g.supersededReason ? `原因: ${g.supersededReason}` : ''].filter(Boolean).join('\n'));
        },
        async execute(args: any, exec: any) {
          const store = await getStore();
          const file = await resolveTarget(store, args, exec);
          const r = await store.setGoal(file.project.id, args.text, args.reason);
          return { ok: true, revised: r.revised, goal: toJson(r.goal) };
        },
      })),

      /* ---------- v0.3 层 1:traj_hypothesis_add ---------- */
      ctx.tools.register(defineTool({
        name: 'traj_hypothesis_add',
        description:
          '在当前总目标下添加**子假设**(研究主线图插件 v0.3)。假设是要验证的具体推断,'
          + '可以后续被证实(validated)/证否(falsified)/搁置(parked)。'
          + 'track 标注轨迹:mainline=主线(默认)/branch=探索分支/detour=已偏离。'
          + '用户说「我们的假设是 X」「试试这个方向」时调用。',
        parameters: {
          text: { type: 'string', required: true, description: '假设陈述(要验证什么)' },
          track: {
            type: 'string', enum: ['mainline', 'branch', 'detour', 'returned'],
            description: '轨迹标签(默认 mainline):主线/探索分支/已偏离/已回归',
          },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: { ok: { type: 'boolean' }, hypothesis: { type: 'json' } },
          },
          render: renderJson,
        },
        
        presentCall: (args: any) => callView(`添加假设:${String(args.text ?? '').slice(0, 30)}`, { track: args.track }),
        presentResult: (args: any, result: { value?: any; meta?: any }) => {
          const v: any = result.value ?? {};
          const h: any = v.hypothesis ?? {};
          return resultView(`假设已添加(${h.track}):${String(h.text ?? '').slice(0, 30)}`, `id: ${h.id}`);
        },
        async execute(args: any, exec: any) {
          const store = await getStore();
          const file = await resolveTarget(store, args, exec);
          const hyp = await store.addHypothesis(file.project.id, { text: args.text, track: args.track });
          return { ok: true, hypothesis: toJson(hyp) };
        },
      })),

      /* ---------- v0.3 层 1:traj_hypothesis_update ---------- */
      ctx.tools.register(defineTool({
        name: 'traj_hypothesis_update',
        description:
          '更新子假设的状态/轨迹(研究主线图插件 v0.3)。假设被验证或证否时**必须**调用此工具记录结果:'
          + 'validated=已证实 / falsified=已证否 / parked=搁置 / superseded=被新假设替代。'
          + 'outcomeReason 填结果原因(如「FLIR 上 +1.66pp 但 DVTOD 上 -20pp,数据集敏感」)。'
          + 'track 变更用于标记走偏(mainline→detour)或回归(detour→returned)。',
        parameters: {
          id: { type: 'string', required: true, description: '假设 id(traj_overview 可查)' },
          status: {
            type: 'string', enum: ['active', 'validated', 'falsified', 'superseded', 'parked'],
            description: '新状态',
          },
          track: {
            type: 'string', enum: ['mainline', 'branch', 'detour', 'returned'],
            description: '新轨迹标签',
          },
          outcomeReason: { type: 'string', description: '结果原因(证否/搁置时必填)' },
          text: { type: 'string', description: '修改假设陈述' },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: { ok: { type: 'boolean' }, hypothesis: { type: 'json' } },
          },
          render: renderJson,
        },
        
        presentCall: (args: any) => callView(`更新假设:${String(args.id ?? '').slice(0, 24)}`, { status: args.status, track: args.track }),
        presentResult: (args: any, result: { value?: any; meta?: any }) => {
          const v: any = result.value ?? {};
          const h: any = v.hypothesis ?? {};
          return resultView(`假设已更新:${String(h.text ?? args.id ?? '').slice(0, 30)}`,
            `${h.status} · ${h.track}${h.outcomeReason ? ` · ${h.outcomeReason}` : ''}`);
        },
        async execute(args: any, exec: any) {
          const store = await getStore();
          const file = await resolveTarget(store, args, exec);
          const hyp = await store.updateHypothesis(file.project.id, args.id, {
            status: args.status, track: args.track, outcomeReason: args.outcomeReason, text: args.text,
          });
          return { ok: true, hypothesis: toJson(hyp) };
        },
      })),

      ctx.effect(() => {
    const disposers = [
      /* ---------- 1. traj_overview ---------- */
      ctx.tools.register(defineTool({
        name: 'traj_overview',
        description:
          '读取研究主线图当前项目全景(研究主线图插件):项目名、各状态计数、主线节点(有序)、'
          + '分支节点、依赖边、**绑定实验的实时进度**(epoch/百分比/停滞,dashboard 联动)。'
          + '默认读取**当前会话工作区**绑定的主线(在哪个工作区对话就读哪个项目);'
          + '任何 traj_* 更新操作前先调用它拿真实节点/边 id;新会话恢复研究上下文也用它。',
        parameters: {
          projectId: { type: 'string', description: '项目 id(缺省 = 当前工作区绑定的项目)' },
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: renderJson,
          presentationMeta: (_a: unknown, value: any) => value,
        },
        presentCall: (args: any) => callView('读取研究主线', { projectId: args.projectId }),
        presentResult: (_args: any, result: { value?: any; meta?: any }) => {
          const v: any = result.value ?? {};
          if (v.empty) return resultView('研究主线:未绑定', String(v.message ?? ''));
          const c: any = v.counts ?? {};
          const open = (c.todo ?? 0) + (c.in_progress ?? 0) + (c.blocked ?? 0);
          const live: any[] = v.liveProgress ?? [];
          const liveLine = live.length
            ? live.map((x) => `${String(x.title ?? '').slice(0, 16)} ${x.stale ? '(停滞)' : ''}${x.label || (x.pct != null ? `${Math.round(x.pct)}%` : '')}`).join(';')
            : '';
          return resultView(`研究主线:${v.project?.name ?? '?'}`, [
            `主线 ${v.mainline?.length ?? 0} 步 · 分支 ${v.branches?.length ?? 0} · 边 ${v.edges?.length ?? 0}`,
            `未完成 ${open}(进行中 ${c.in_progress ?? 0} / 受阻 ${c.blocked ?? 0} / 待办 ${c.todo ?? 0})· 完成 ${c.done ?? 0}`,
            liveLine ? `在跑 ${live.length}:${liveLine}` : '',
          ].filter(Boolean).join('\n'));
        },
        async execute(args: any, exec: any) {
          const store = await getStore();
          try {
            const file = await resolveTarget(store, args, exec);
            // 实时进度并入(dashboard 缺席静默降级为无 liveProgress 字段)。
            // 无绑定实验节点时跳过 loopback 拉取——省一次最长 4s 的超时等待
            const hasBoundExp = file.nodes.some((n) => n.kind === 'experiment' && n.refs
              && !!(n.refs.logPath || n.refs.cmdPattern));
            const dash = hasBoundExp ? await fetchDashSnapshots(apiBase(ctx)) : null;
            const live = dash ? matchLiveProgress(file, dash) : [];
            return toJson({
              ok: true,
              ...projectOverview(file),
              ...(live.length ? { liveProgress: live } : {}),
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('绑定')) {
              return toJson({ ok: true, empty: true, message: msg + '。用 traj_project_set 创建并绑定。' });
            }
            throw err;
          }
        },
      })),

      /* ---------- 2. traj_project_set ---------- */
      ctx.tools.register(defineTool({
        name: 'traj_project_set',
        description:
          '为**当前会话工作区**创建并绑定研究主线(研究主线图插件),并可写入研究问题。工作区已绑定时幂等返回。'
          + '用户说「给这个项目建个研究主线」「开个新方向 X」时调用;name 省略时用工作区目录名。'
          + 'researchQuestion 填一句话研究问题/目标(梳理视图置顶展示);研究问题演进时也用它更新。',
        parameters: {
          name: { type: 'string', description: '项目名称(省略 = 用工作区目录名)' },
          description: { type: 'string', description: '一句话研究目标' },
          researchQuestion: { type: 'string', description: '研究问题(如:能否先稳定保留双单模态证据,同时给融合受控的层级适应空间?)' },
          rebindProjectId: { type: 'string', description: '把指定项目改绑到当前工作区(修复绑错工作区;若当前工作区已被其他项目占用会报错,先 unbind)' },
          unbind: { type: 'boolean', description: '只解绑当前工作区的主线(项目保留,可被收养),不创建' },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: { ok: { type: 'boolean' }, created: { type: 'boolean' }, project: { type: 'json' } },
          },
          render: renderJson,
          presentationMeta: (_a: unknown, value: any) => value,
        },
        presentCall: (args: any) => callView(`绑定研究主线:${String(args.name ?? '(当前工作区)').slice(0, 30)}`, { description: args.description, researchQuestion: args.researchQuestion, rebind: args.rebindProjectId, unbind: args.unbind }),
        presentResult: (args: any, result: { value?: any; meta?: any }) => {
          const v: any = result.value ?? {};
          const p: any = v.project ?? {};
          const action = args.unbind ? '已解绑' : args.rebindProjectId ? '已改绑到当前工作区' : v.created ? '已创建并绑定' : '已绑定';
          return resultView(`${action}:${String(p.name ?? '').slice(0, 30)}`,
            [p.researchQuestion ? `研究问题:${p.researchQuestion}` : '', p.workspaceKey ? `工作区 ${p.workspaceKey}` : ''].filter(Boolean).join('\n'));
        },
        async execute(args: any, exec: any) {
          const store = await getStore();
          const ws = wsKeyOf(exec);

          // 解绑当前工作区(项目保留)
          if (args.unbind) {
            if (!ws) throw new Error('拿不到当前会话工作区,无法解绑');
            const cur = store.findByWorkspace(ws);
            if (!cur) return { ok: true, unbound: false, project: null, message: '当前工作区没有绑定主线' };
            const project = await store.bindWorkspace(cur.project.id, '');
            return { ok: true, unbound: true, project: toJson(project) };
          }

          // 改绑:把既有项目绑到当前工作区(修复绑错工作区)
          if (args.rebindProjectId) {
            if (!ws) throw new Error('拿不到当前会话工作区,无法改绑');
            const target = store.getFile(args.rebindProjectId)
              ?? store.listProjectFiles().find((f) => f.project.name.toLowerCase() === String(args.rebindProjectId).toLowerCase());
            if (!target) throw new Error(`项目不存在: ${args.rebindProjectId}`);
            const project = await store.bindWorkspace(target.project.id, ws);
            if (args.researchQuestion || args.description) {
              await store.updateProject(project.id, {
                ...(args.researchQuestion ? { researchQuestion: args.researchQuestion } : {}),
                ...(args.description && !project.description ? { description: args.description } : {}),
              });
            }
            return { ok: true, created: false, project: toJson(project) };
          }

          let project: TrajProject;
          let created = false;
          if (ws) {
            const r = await store.createForWorkspace({
              workspaceKey: ws,
              name: args.name,
              description: args.description,
            });
            project = r.project;
            created = !r.existed;
            // 已绑定时允许补描述/研究问题
            const patch: Record<string, unknown> = {};
            if (args.description && !project.description) patch.description = args.description;
            if (args.researchQuestion) patch.researchQuestion = args.researchQuestion;
            if (Object.keys(patch).length) project = await store.updateProject(project.id, patch);
          } else {
            const r = await store.createProject({ name: args.name, description: args.description, activate: true });
            project = r.project;
            created = !r.existed;
            if (args.researchQuestion) project = await store.updateProject(project.id, { researchQuestion: args.researchQuestion });
          }
          return { ok: true, created, project: toJson(project) };
        },
      })),

      /* ---------- 2c. traj_project_delete ---------- */
      ctx.tools.register(defineTool({
        name: 'traj_project_delete',
        description:
          '删除研究主线项目(研究主线图插件):连同全部节点/实验台账/边/主线一起删除,**不可恢复**。'
          + '只用于清理绑错工作区或确认废弃的项目;必须显式 confirm=true 才执行。',
        parameters: {
          projectId: { type: 'string', required: true, description: '项目 id(traj_overview 的 projects 里可查)' },
          confirm: { type: 'boolean', required: true, description: '必须显式传 true 才会执行删除' },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: { ok: { type: 'boolean' }, deleted: { type: 'boolean' } },
          },
          render: renderJson,
          presentationMeta: (_a: unknown, value: any) => value,
        },
        presentCall: (args: any) => callView(`删除研究主线项目:${String(args.projectId ?? '').slice(0, 24)}`, { confirm: args.confirm }),
        presentResult: (args: any, result: { value?: any; meta?: any }) => {
          const v: any = result.value ?? {};
          return resultView(v.deleted ? '项目已删除' : '未删除(缺少 confirm=true)', String(args.projectId ?? '').slice(0, 30));
        },
        async execute(args: any) {
          if (args.confirm !== true) {
            return { ok: true, deleted: false, message: '删除项目不可恢复;确认后请带 confirm=true 重新调用。' };
          }
          const store = await getStore();
          const deleted = await store.deleteProject(args.projectId);
          return { ok: true, deleted };
        },
      })),

      /* ---------- 2b. traj_entry_add(实验台账)---------- */
      ctx.tools.register(defineTool({
        name: 'traj_entry_add',
        description:
          '给研究主线节点追加一条**实验台账**(研究主线图插件):记录已经发生过的工作——实验结果数据、'
          + '关键决策、阶段性结论。清单页会按时间排列展示,是「项目做到了哪一步、数据是什么」的权威记录。'
          + '场景:跑完一次实验拿到数据、一次归因/分析得出结论、一个方案被验证或否决。'
          + '完成后同时把节点 status 推进(traj_node_update)。',
        parameters: {
          nodeId: { type: 'string', required: true, description: '节点 id(traj_overview 可查)' },
          title: { type: 'string', required: true, description: '做了什么(如「消融实验 A/B/C 30 epochs」)' },
          data: { type: 'string', description: '关键数据,自由文本(如「数据集A 0.75 vs 基线 0.70;数据集B IR -15.0pp」)。有明确指标数字时优先用 metrics,两者可并用' },
          metrics: {
            type: 'array',
            description: '结构化指标(优先于 data 文本,面板渲染为对比表):每项 {name 指标名, value 本方法取值, baseline 对照值(可选), unit 单位(可选)}。'
              + '例:[{"name":"数据集A mAP50-95","value":0.75,"baseline":0.70},{"name":"数据集B mAP50-95","value":0.82,"baseline":0.78}]',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                name: { type: 'string', required: true, description: '指标名(含数据集与指标类型)' },
                value: { type: 'number', required: true, description: '本方法取值' },
                baseline: { type: 'number', description: '对照/基线取值(如 BASE)' },
                unit: { type: 'string', description: '单位(pp / % / 空可省)' },
              },
            },
          },
          conclusion: { type: 'string', description: '结论/判定(如「partial:数据集敏感;决策:停止 DVTOD 门控」)' },
          date: { type: 'string', description: '发生日期 YYYY-MM-DD(省略 = 今天)' },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: { ok: { type: 'boolean' }, entry: { type: 'json' }, warning: { type: 'string' } },
          },
          render: renderJson,
          presentationMeta: (_a: unknown, value: any) => value,
        },
        presentCall: (args: any) => callView(`记台账:${String(args.title ?? '').slice(0, 30)}`, { nodeId: args.nodeId, data: args.data }),
        presentResult: (args: any, result: { value?: any; meta?: any }) => {
          const v: any = result.value ?? {};
          const e: any = v.entry ?? {};
          return resultView(`台账已记:${String(e.title ?? '').slice(0, 30)}`,
            [e.data ? `数据 ${e.data}` : '', e.conclusion ? `结论 ${e.conclusion}` : '', v.warning ?? ''].filter(Boolean).join('\n'));
        },
        async execute(args: any) {
          const store = await getStore();
          // date 严格校验:YYYY-MM-DD 且各分量回验(本地时区构造);非法时按当前时间记录并带 warning
          let ts: number | undefined;
          let warning: string | undefined;
          if (typeof args.date === 'string' && args.date.trim()) {
            const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(args.date.trim());
            const y = m ? Number(m[1]) : NaN;
            const mo = m ? Number(m[2]) : NaN;
            const d = m ? Number(m[3]) : NaN;
            const dt = new Date(y, mo - 1, d); // 本地时区构造(不再 UTC 解析导致显示偏移一天)
            if (m && dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d) {
              ts = dt.getTime();
            } else {
              warning = `date「${args.date}」非法(应为合法的 YYYY-MM-DD),已按当前时间记录`;
            }
          }
          const { entry } = await store.addEntry(args.id ?? args.nodeId, {
            title: args.title, data: args.data, conclusion: args.conclusion, ts, metrics: args.metrics,
          });
          return { ok: true, entry: toJson(entry), ...(warning ? { warning } : {}) };
        },
      })),

      /* ---------- 3. traj_node_add ---------- */
      ctx.tools.register(defineTool({
        name: 'traj_node_add',
        description:
          '在研究主线图登记一个节点(研究主线图插件,**落到当前会话工作区的主线**;工作区还没有主线时自动创建并绑定)。'
          + '场景:规划新阶段/确立想法(kind=idea 或 milestone,主线关键步骤加 mainline=true)、'
          + '开始新实验(kind=experiment,status=in_progress,尽量绑定 refs.hostId/logPath/cmdPattern '
          + '以便图上显示实时进度)、论文产出(kind=paper)等。'
          + 'parentIds 填依赖来源节点 id(自动建 enables 边:先有它们才有本节点)。',
        parameters: {
          kind: {
            type: 'string',
            enum: ['milestone', 'idea', 'experiment', 'paper', 'writing', 'other'],
            description: '节点类型(默认 other)',
          },
          title: { type: 'string', required: true, description: '节点标题(一句话,如「实验:LoRA 秩扫描」)' },
          status: {
            type: 'string',
            enum: ['todo', 'in_progress', 'blocked', 'done', 'dropped'],
            description: '状态(默认 todo)',
          },
          detail: { type: 'string', description: '说明/结论(done 时必写)' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签' },
          parentIds: {
            type: 'array',
            items: { type: 'string' },
            description: '依赖来源节点 id 列表(traj_overview 可查);自动创建 enables 边',
          },
          mainline: { type: 'boolean', description: '是否追加到创新主线末尾(关键路径节点传 true)' },
          cardId: { type: 'string', description: '关联 scholar idea 卡 id(idea_card_search 可查)' },
          paperId: { type: 'string', description: '关联 scholar 论文 id(paper_search 可查)' },
          hostId: { type: 'string', description: '实验绑定:dashboard 主机 id' },
          logPath: { type: 'string', description: '实验绑定:训练日志绝对路径' },
          cmdPattern: { type: 'string', description: '实验绑定:进程命令行特征子串(如 train.py --rank-sweep)' },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: { ok: { type: 'boolean' }, node: { type: 'json' }, warning: { type: 'string' } },
          },
          render: renderJson,
          presentationMeta: (_a: unknown, value: any) => value,
        },
        presentCall: (args: any) => callView(`主线图 + 节点:${String(args.title ?? '').slice(0, 30)}`, {
          kind: args.kind, status: args.status, mainline: args.mainline, parents: args.parentIds,
        }),
        presentResult: (args: any, result: { value?: any; meta?: any }) => {
          const v: any = result.value ?? {};
          const n: any = v.node ?? {};
          return resultView(`已登记:${String(n.title ?? '').slice(0, 30)}`, [mdNode(n as TrajNode), v.warning ?? ''].filter(Boolean).join('\n'));
        },
        async execute(args: any, exec: any) {
          const store = await getStore();
          const file = await resolveTarget(store, args, exec, { autoCreate: true });
          const node = await store.addNode({
            projectId: file.project.id,
            kind: args.kind as TrajNodeKind | undefined,
            title: args.title,
            status: args.status as TrajStatus | undefined,
            detail: args.detail,
            tags: Array.isArray(args.tags) ? args.tags : undefined,
            refs: {
              cardId: args.cardId, paperId: args.paperId,
              hostId: args.hostId, logPath: args.logPath, cmdPattern: args.cmdPattern,
            },
            parentIds: Array.isArray(args.parentIds) ? args.parentIds : undefined,
            mainline: args.mainline === true,
          });
          return { ok: true, node: toJson(node), ...cmdPatternWarning(args.cmdPattern) };
        },
      })),

      /* ---------- 4. traj_node_update ---------- */
      ctx.tools.register(defineTool({
        name: 'traj_node_update',
        description:
          '更新研究主线图节点(研究主线图插件):推进状态、写结论、绑定实验/想法卡/论文等。只更新提供的字段。'
          + 'status 置为 done 时务必同时写 detail 结论;受阻(blocked)时 detail 写卡点。ref 字段传空字符串清除该绑定。',
        parameters: {
          id: { type: 'string', required: true, description: '节点 id(traj_overview 可查)' },
          title: { type: 'string', description: '新标题' },
          kind: {
            type: 'string',
            enum: ['milestone', 'idea', 'experiment', 'paper', 'writing', 'other'],
            description: '新类型',
          },
          status: {
            type: 'string',
            enum: ['todo', 'in_progress', 'blocked', 'done', 'dropped'],
            description: '新状态',
          },
          detail: { type: 'string', description: '结论/说明(done 必写;空字符串清除)' },
          tags: { type: 'array', items: { type: 'string' }, description: '新标签(整体替换)' },
          cardId: { type: 'string', description: '关联 idea 卡 id(空字符串清除)' },
          paperId: { type: 'string', description: '关联论文 id(空字符串清除)' },
          hostId: { type: 'string', description: '实验绑定:主机 id(空字符串清除)' },
          logPath: { type: 'string', description: '实验绑定:日志路径(空字符串清除)' },
          cmdPattern: { type: 'string', description: '实验绑定:命令特征(空字符串清除)' },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: { ok: { type: 'boolean' }, node: { type: 'json' }, warning: { type: 'string' } },
          },
          render: renderJson,
          presentationMeta: (_a: unknown, value: any) => value,
        },
        presentCall: (args: any) => callView(`更新节点:${String(args.id ?? '').slice(0, 24)}`, {
          status: args.status, detail: args.detail ? '(写结论)' : undefined,
        }),
        presentResult: (args: any, result: { value?: any; meta?: any }) => {
          const v: any = result.value ?? {};
          const n: any = v.node ?? {};
          const warn = n.status === 'done' && !n.detail ? '\n_提示:done 节点应写 detail 结论_' : '';
          return resultView(`节点已更新:${String(n.title ?? args.id ?? '').slice(0, 30)}`,
            `${KIND_ZH[n.kind as TrajNodeKind] ?? ''} · 状态 → ${STATUS_ZH[n.status as TrajStatus] ?? ''}${warn}${v.warning ? `\n${v.warning}` : ''}`);
        },
        async execute(args: any) {
          const store = await getStore();
          const existing = store.getNode(args.id);
          if (!existing) throw new Error(`节点不存在: ${args.id}`);
          // per-field ref semantics: provided non-empty sets, empty string clears
          const refKeys = ['cardId', 'paperId', 'hostId', 'logPath', 'cmdPattern'] as const;
          const updates: Record<string, string> = {};
          let refsTouched = false;
          for (const k of refKeys) {
            if (args[k] === undefined) continue;
            refsTouched = true;
            updates[k] = String(args[k]).trim();
          }
          const node = await store.updateNode(args.id, {
            title: args.title,
            kind: args.kind as TrajNodeKind | undefined,
            status: args.status as TrajStatus | undefined,
            detail: args.detail,
            tags: Array.isArray(args.tags) ? args.tags : undefined,
            ...(refsTouched ? { refs: mergeRefFields(existing.refs, updates) } : {}),
          });
          return { ok: true, node: toJson(node), ...cmdPatternWarning(args.cmdPattern) };
        },
      })),

      /* ---------- 5. traj_node_remove ---------- */
      ctx.tools.register(defineTool({
        name: 'traj_node_remove',
        description: '从研究主线图删除节点(研究主线图插件),自动清理相关边与主线引用。',
        parameters: {
          id: { type: 'string', required: true, description: '节点 id' },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: { ok: { type: 'boolean' }, deleted: { type: 'boolean' } },
          },
          render: renderJson,
          presentationMeta: (_a: unknown, value: any) => value,
        },
        presentCall: (args: any) => callView(`删除节点:${String(args.id ?? '').slice(0, 24)}`),
        presentResult: (args: any, result: { value?: any; meta?: any }) => {
          const v: any = result.value ?? {};
          return resultView(v.deleted ? '节点已删除' : '节点不存在(未删除)', String(args.id ?? '').slice(0, 40));
        },
        async execute(args: any) {
          const store = await getStore();
          const deleted = await store.removeNode(args.id);
          return { ok: true, deleted };
        },
      })),

      /* ---------- 6. traj_link_add ---------- */
      ctx.tools.register(defineTool({
        name: 'traj_link_add',
        description:
          '在研究主线图当前工作区项目的两节点间建推进边(研究主线图插件;**禁止构成依赖环**,成环会被拒绝)。'
          + 'kind:enables=验证后才能(默认)/feeds=产出喂给/composes=汇入论文。id 用 traj_overview 查。',
        parameters: {
          source: { type: 'string', required: true, description: '起点节点 id(上游)' },
          target: { type: 'string', required: true, description: '终点节点 id(下游)' },
          kind: { type: 'string', enum: ['enables', 'feeds', 'composes'], description: '关系类型(默认 enables)' },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: { ok: { type: 'boolean' }, existed: { type: 'boolean' }, edge: { type: 'json' } },
          },
          render: renderJson,
          presentationMeta: (_a: unknown, value: any) => value,
        },
        presentCall: (args: any) => callView(`建边:${String(args.source ?? '').slice(0, 16)} → ${String(args.target ?? '').slice(0, 16)}`, { kind: args.kind }),
        presentResult: (args: any, result: { value?: any; meta?: any }) => {
          const v: any = result.value ?? {};
          const e: any = v.edge ?? {};
          return resultView(`${v.existed ? '边已存在' : '已建边'}:${String(e.source ?? '').slice(0, 20)} → ${String(e.target ?? '').slice(0, 20)}`,
            String(e.kind ?? ''));
        },
        async execute(args: any, exec: any) {
          const store = await getStore();
          const file = await resolveTarget(store, args, exec, { mutating: true });
          const { edge, existed } = await store.addEdge({
            projectId: file.project.id,
            source: args.source,
            target: args.target,
            kind: args.kind as TrajEdgeKind | undefined,
          });
          return { ok: true, existed, edge: toJson({ ...edge }) };
        },
      })),

      /* ---------- 7. traj_link_remove ---------- */
      ctx.tools.register(defineTool({
        name: 'traj_link_remove',
        description: '删除研究主线图中一条推进边(研究主线图插件)。边 id 从 traj_overview 的 edges 里拿。',
        parameters: {
          id: { type: 'string', required: true, description: '边 id' },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: { ok: { type: 'boolean' }, deleted: { type: 'boolean' } },
          },
          render: renderJson,
          presentationMeta: (_a: unknown, value: any) => value,
        },
        presentCall: (args: any) => callView(`删边:${String(args.id ?? '').slice(0, 24)}`),
        presentResult: (args: any, result: { value?: any; meta?: any }) => {
          const v: any = result.value ?? {};
          return resultView(v.deleted ? '边已删除' : '边不存在(未删除)', String(args.id ?? '').slice(0, 40));
        },
        async execute(args: any) {
          const store = await getStore();
          const deleted = await store.removeEdge(args.id);
          return { ok: true, deleted };
        },
      })),

      /* ---------- 8. traj_mainline_set ---------- */
      ctx.tools.register(defineTool({
        name: 'traj_mainline_set',
        description:
          '重排当前工作区主线的创新关键路径(研究主线图插件):按顺序传节点 id 数组,图上会渲染为高亮脊柱。'
          + '规划会话里把「创新故事线」的里程碑/关键实验串起来;分支节点不进主线。',
        parameters: {
          nodeIds: {
            type: 'array',
            items: { type: 'string' },
            description: '主线节点 id,按推进顺序;不存在的 id 会被忽略,重复 id 自动去重',
          },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: { ok: { type: 'boolean' }, mainline: { type: 'json' }, project: { type: 'json' } },
          },
          render: renderJson,
          presentationMeta: (_a: unknown, value: any) => value,
        },
        presentCall: (args: any) => callView(`重排主线(${Array.isArray(args.nodeIds) ? args.nodeIds.length : 0} 步)`),
        presentResult: (args: any, result: { value?: any; meta?: any }) => {
          const v: any = result.value ?? {};
          const ml: any[] = v.mainline ?? [];
          const items = ml.slice(0, 10).map((id: string, i: number) => `${i + 1}. ${id}`);
          return resultView(`主线已更新:${ml.length} 步`, mdList(items, Math.max(0, ml.length - items.length)));
        },
        async execute(args: any, exec: any) {
          const store = await getStore();
          const file = await resolveTarget(store, args, exec, { mutating: true });
          const project = await store.setMainline(args.nodeIds, file.project.id);
          return { ok: true, mainline: toJson(project.mainline), project: toJson(project) };
        },
      })),
    ];
    return () => {
      for (const d of disposers) d();
    };
  });
}

/** Apply per-field ref updates onto an existing refs object ('' clears the field). */
function mergeRefFields(
  existing: TrajNode['refs'],
  updates: Record<string, string>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(existing ?? {})) out[k] = v;
  for (const [k, v] of Object.entries(updates)) {
    if (v) out[k] = v;
    else {
      delete out[k];
      if (k === 'cardId') delete out.cardLabel;
      if (k === 'paperId') delete out.paperLabel;
    }
  }
  return out;
}
