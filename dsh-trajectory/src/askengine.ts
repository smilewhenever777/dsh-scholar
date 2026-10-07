/**
 * dsh-trajectory — 对话式研究记忆查询引擎(v0.4 方向 C)。
 *
 * 接收自然语言问题,路由到对应的轨迹数据查询,返回结构化答案。
 * 纯函数,被 traj_ask 工具调用。
 */
import type { TrajProjectFile, TrajHypothesis, TrajNode, TrajGoalLog } from './shared/types.js';

export interface AskResult {
  topic: string;
  answer: string;
  details?: unknown[];
}

export function trajAsk(file: TrajProjectFile, question: string): AskResult {
  const q = question.toLowerCase();
  const activeGoal = file.goals?.find((g) => g.status === 'active');
  const hyps = file.hypotheses ?? [];
  const nodes = file.nodes ?? [];
  const currentHyps = activeGoal ? hyps.filter((h) => h.goalVersionId === activeGoal.id && h.status !== 'superseded') : hyps;

  /* 路由 1:卡在哪 / 受阻 / blocked */
  if (q.includes('卡') || q.includes('受阻') || q.includes('blocked') || q.includes('stuck')) {
    const blocked = currentHyps.filter((h) => h.status === 'active' && h.track === 'detour');
    const blockedNodes = nodes.filter((n) => n.status === 'blocked');
    return {
      topic: '当前卡点',
      answer: blocked.length > 0
        ? `有 ${blocked.length} 个偏离假设:${blocked.map((h) => `「${h.text.slice(0, 30)}」(${h.outcomeReason ?? '无原因'})`).join('; ')}`
        : blockedNodes.length > 0
          ? `有 ${blockedNodes.length} 个受阻实验:${blockedNodes.map((n) => n.title.slice(0, 25)).join('; ')}`
          : '当前没有明确的卡点。',
      details: [...blocked, ...blockedNodes],
    };
  }

  /* 路由 2:为什么放弃 / 证否 / falsified */
  if (q.includes('放弃') || q.includes('证否') || q.includes('falsified') || q.includes('为什么')) {
    const falsified = hyps.filter((h) => h.status === 'falsified');
    const superseded = hyps.filter((h) => h.status === 'superseded' && h.outcomeReason);
    if (falsified.length > 0 || superseded.length > 0) {
      const lines: string[] = [];
      for (const h of falsified) {
        lines.push(`已证否「${h.text.slice(0, 35)}」:${h.outcomeReason ?? '(未填原因)'}`);
      }
      for (const h of superseded.slice(0, 3)) {
        lines.push(`已替代「${h.text.slice(0, 35)}」:${h.outcomeReason}`);
      }
      return { topic: '被放弃的假设', answer: lines.join('\n'), details: [...falsified, ...superseded] };
    }
    return { topic: '被放弃的假设', answer: '没有被证否或替代的假设。' };
  }

  /* 路由 3:目标变化 / 演化 / pivot / 版本 */
  if (q.includes('目标') || q.includes('变化') || q.includes('演化') || q.includes('pivot') || q.includes('版本')) {
    const goals = file.goals ?? [];
    const log = file.goalLog ?? [];
    if (goals.length <= 1) {
      return { topic: '目标演化', answer: `目标只有 v1,未修订过:${activeGoal?.text.slice(0, 60) ?? '(无)'}` };
    }
    const lines = goals.sort((a, b) => a.version - b.version).map((g) =>
      `v${g.version}${g.status === 'active' ? '(当前)' : '(已替代)'}:${g.text.slice(0, 50)}`
        + (g.supersededReason ? ` → 原因:${g.supersededReason.slice(0, 40)}` : ''));
    return { topic: '目标演化', answer: lines.join('\n'), details: log.slice(0, 5) };
  }

  /* 路由 4:进展 / 进度 / 多少实验 */
  if (q.includes('进展') || q.includes('进度') || q.includes('多少') || q.includes('如何') || q.includes('状态')) {
    const active = currentHyps.filter((h) => h.status === 'active');
    const validated = currentHyps.filter((h) => h.status === 'validated');
    const doneNodes = nodes.filter((n) => n.status === 'done');
    const todoNodes = nodes.filter((n) => n.status === 'todo');
    const inProgress = nodes.filter((n) => n.status === 'in_progress');
    const recentEntries = nodes
      .flatMap((n) => (n.entries ?? []).map((e) => ({ ...e, node: n.title })))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 3);
    return {
      topic: '项目进展',
      answer: `目标 v${activeGoal?.version ?? '?'}:${activeGoal?.text.slice(0, 50)}\n`
        + `假设:${active.length} 活跃 / ${validated.length} 已证实 / ${currentHyps.filter((h) => h.status === 'falsified').length} 已证否\n`
        + `实验:${doneNodes.length} 完成 / ${inProgress.length} 进行中 / ${todoNodes.length} 待办\n`
        + (recentEntries.length > 0 ? `最近台账:${recentEntries[0].title.slice(0, 40)}` : ''),
    };
  }

  /* 路由 5:还没做 / 待办 / todo */
  if (q.includes('还没') || q.includes('待办') || q.includes('todo') || q.includes('next')) {
    const todos = nodes.filter((n) => n.status === 'todo');
    return {
      topic: '待办实验',
      answer: todos.length > 0
        ? `${todos.length} 个待办:${todos.map((n) => n.title.slice(0, 25)).slice(0, 5).join('; ')}`
        : '没有待办实验。',
      details: todos,
    };
  }

  /* 默认:返回项目概览 */
  return {
    topic: '项目概览',
    answer: `目标 v${activeGoal?.version ?? '?'}:${activeGoal?.text.slice(0, 50)}\n`
      + `假设 ${currentHyps.length} / 实验 ${nodes.length} / 台账 ${nodes.reduce((s, n) => s + (n.entries?.length ?? 0), 0)} 条\n`
      + '支持的问题类型:卡在哪 / 为什么放弃 / 目标变化 / 进展 / 待办',
  };
}
