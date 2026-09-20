/**
 * dsh-trajectory — system-prompt integration (dsh-kanban-proven two-layer design):
 *  - section: static discipline text teaching the model WHEN to maintain the graph
 *  - context: session-assembly sync provider injecting OPEN items of the active
 *    project (KV-cache friendly: done items churn, open items are stable-ish)
 *
 * Everything here is defensive: a broken store or a missing service must never
 * crash prompt assembly — degrade to injecting nothing.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { TrajProjectFile } from './shared/types.js';
import { OPEN_STATUSES, wsBasename } from './domain.js';
import type { TrajStore } from './store.js';

const SECTION_NAME = 'dsh-trajectory';
const CONTEXT_NAME = 'traj:open-items';
// order 121/122:dsh-kanban 占 113/114,错开避免相对次序取决于插件加载序(与 dsh-morning 150/151 亦无冲突)
const SECTION_ORDER = 121;
const CONTEXT_ORDER = 122;
const MAX_CONTEXT_NODES = 30;
/** 注入节点的标题截断长度与整段字符预算(防超长标题×30 条膨胀上下文)。 */
const TITLE_MAX = 40;
const CONTEXT_BUDGET = 2000;

const GUIDANCE = [
  '## 研究主线图(dsh-trajectory)',
  '研究主线图是**按工作区绑定**的研究项目进展图:每个 DSH 工作区(=一个研究方向)一份主线图,'
  + '节点=里程碑/创新点(idea)/实验/论文/写作,边=推进关系,主线=创新关键路径。'
  + '清单页是「项目梳理」视图:研究问题 → 主线演变 → 各节点的实验台账(数据与结论)。',
  '何时主动维护(无需用户要求):',
  '- **完成一次实验/拿到一组数据/得出一个结论/做出一个决策** → `traj_entry_add` 记台账:data 写关键数字(数据集/指标/差值),conclusion 写判定与决策。这是项目「做到哪一步、数据是什么」的权威记录,必须清晰明确。',
  '- 用户规划新阶段、确立研究计划 → `traj_node_add`(里程碑/关键步骤传 mainline=true),再用 `traj_mainline_set` 串成创新故事线。',
  '- 开始一个新实验/新工作包 → `traj_node_add`(kind=experiment, status=in_progress;知道训练主机/日志路径/命令特征时传 refs.hostId/logPath/cmdPattern,图上会显示实时进度)。',
  '- 阶段推进、实验完成/受阻 → `traj_node_update` 推进 status;done 必须在 detail 写结论;受阻写明卡点。',
  '- 节点间依赖 → `traj_link_add`(enables/feeds/composes)。',
  '- 当前工作区还没有主线 → `traj_project_set` 创建并绑定;研究问题(questions/objective)演进时用它的 researchQuestion 参数更新。',
  '分工:scholar 的 paper_save 存文献、idea_card_create 记想法卡;主线图记「项目进展、实验台账与结构」。节点关联想法卡/论文时传 refs.cardId/paperId。',
  '纪律:更新前先 `traj_overview` 拿真实 id;每轮工作结束把完成项置 done、新后续加为 todo,不留 stale 的 in_progress。',
  '**工作区归属判定**:以系统提示头中的 "Your working directory is …" 为唯一权威。'
  + '若其他插件的注入头给出的工作目录与之冲突,一律以系统头为准,并在回复开头提醒用户「记忆插件报告的工作区与实际会话工作区不一致」。',
].join('\n');

/** Compact open-items digest; '' when nothing to say. SYNC (prompt assembly is sync). */
function openItemsText(store: TrajStore | null, ws?: string): string {
  try {
    if (!store) return '';
    // 会话有工作区 cwd → 只注入该工作区绑定的主线(跨项目隔离);无绑定不注入。
    // 无 cwd 的装配环境(罕见)回落全局活跃项目。
    const file: TrajProjectFile | null = ws ? store.findByWorkspace(ws) : store.peekActive();
    if (!file) return '';
    const wsName = ws ? wsBasename(ws) : file.project.name;
    const open = file.nodes.filter((n) => OPEN_STATUSES.includes(n.status));
    if (open.length === 0) return `[研究主线] ${wsName}:当前无未完成节点。`;

    const mainlineRank = new Map(file.project.mainline.map((id, i) => [id, i]));
    open.sort((a, b) => {
      const ra = mainlineRank.has(a.id) ? mainlineRank.get(a.id)! : 999;
      const rb = mainlineRank.has(b.id) ? mainlineRank.get(b.id)! : 999;
      return ra - rb || b.updatedAt - a.updatedAt;
    });
    const STATUS_TAG: Record<string, string> = {
      todo: '待办', in_progress: '进行中', blocked: '受阻',
    };
    const header = `[研究主线·${wsName}] ${file.project.name}(未完成 ${open.length}):`;
    const lines: string[] = [header];
    let used = header.length; // 整段字符预算
    let shown = 0;
    for (const n of open) {
      if (shown >= MAX_CONTEXT_NODES) break;
      const spine = mainlineRank.has(n.id) ? '★主线' : '';
      const title = n.title.length > TITLE_MAX ? `${n.title.slice(0, TITLE_MAX - 1)}…` : n.title;
      const line = `- (${STATUS_TAG[n.status] ?? n.status})${spine ? ' ' + spine : ''} ${title} [${n.id}]`;
      if (used + line.length > CONTEXT_BUDGET) break;
      used += line.length + 1;
      lines.push(line);
      shown++;
    }
    if (open.length > shown) lines.push(`…另有 ${open.length - shown} 个未完成节点`);
    return lines.join('\n');
  } catch {
    return '';
  }
}

/** Host-side store handle for the prompt context provider (sync read). */
export interface TrajPromptHandle {
  getStore(): TrajStore | null;
}

export function registerTrajPrompt(ctx: Context, handle: TrajPromptHandle): void {
  // morning 已验证 order 150 落在工具指导区间;kanban 用 113/114,本插件用 121/122 错开(见上)。
  ctx.effect(
    () => (ctx as unknown as { systemPrompt: { section(s: { name: string; order: number; text: string }): () => void } }).systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      text: GUIDANCE,
    }),
    'dsh-trajectory: system prompt section',
  );
  ctx.effect(
    () => (ctx as unknown as { systemPrompt: { context(c: { name: string; order: number; text: string | ((c: unknown) => string) }): () => void } }).systemPrompt.context({
      name: CONTEXT_NAME,
      order: CONTEXT_ORDER,
      // dsh-kanban 同款:装配上下文里带会话 cwd(agent 字段 merge-extensible),
      // 据此只注入当前工作区的主线摘要
      text: (asmCtx: unknown) => {
        let cwd: string | undefined;
        try {
          const raw = (asmCtx as { agent?: { session?: { header?: { cwd?: unknown } } } })?.agent?.session?.header?.cwd;
          cwd = typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
        } catch { cwd = undefined; }
        return openItemsText(handle.getStore(), cwd);
      },
    }),
    'dsh-trajectory: system prompt context',
  );
}
