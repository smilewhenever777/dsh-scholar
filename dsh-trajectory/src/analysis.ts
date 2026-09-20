/**
 * dsh-trajectory — 研究轨迹分析引擎(纯函数,无 I/O)。
 *
 * 输入一个 TrajProjectFile,输出结构化 findings + 建议提问。
 * 被 traj_review 工具调用;AI 拿到 findings 后以对话形式向用户提问,
 * 根据回答调用 traj_goal_set / traj_hypothesis_update 等工具落盘决策。
 *
 * 分析规则(按优先级):
 *  R1 冷滞假设    — active 假设但实验长期无更新
 *  R2 孤儿实验    — 实验未归属任何假设
 *  R3 目标错配    — 当前实验的方向与目标文本不一致(关键词无交集)
 *  R4 证否未标    — 假设的实验全部失败但假设仍标 active
 *  R5 高频 pivot  — 目标短时间内多次修订(方向不稳定)
 *  R6 断链        — 假设已 validated 但下游实验仍 todo(应该推进或砍掉)
 *  R7 偏离未回归  — track=detour 的假设长期未回归 mainline
 */
import type {
  TrajHypothesis, TrajNode, TrajProjectFile, TrajGoal, TrajGoalLog,
} from './shared/types.js';

export interface TrajFinding {
  /** 规则 ID */
  rule: string;
  /** 严重度: high(需要用户决策) / medium(建议关注) / low(信息性) */
  severity: 'high' | 'medium' | 'low';
  /** 发现的描述(给 AI 看,AI 转述给用户) */
  description: string;
  /** 建议向用户提的问题(AI 可以原样问或改编) */
  suggestedQuestion: string;
  /** 涉及的实体 id */
  entityIds: string[];
}

export interface TrajReview {
  findings: TrajFinding[];
  /** 项目概览摘要(给 AI 的上下文) */
  summary: {
    goalVersion: number;
    goalText: string;
    totalHypotheses: number;
    activeHypotheses: number;
    validatedHypotheses: number;
    falsifiedHypotheses: number;
    mainlineHypotheses: number;
    branchHypotheses: number;
    detourHypotheses: number;
    orphanExperiments: number;
    recentPivots: number;
  };
}

const STALE_DAYS = 14;
const PIVOT_WINDOW_DAYS = 7;
const PIVOT_THRESHOLD = 3;

export function analyzeTrajectory(file: TrajProjectFile, now = Date.now()): TrajReview {
  const findings: TrajFinding[] = [];
  const goals = file.goals ?? [];
  const hyps = file.hypotheses ?? [];
  const nodes = file.nodes ?? [];
  const log = file.goalLog ?? [];

  const activeGoal = goals.find((g) => g.status === 'active')
    ?? [...goals].sort((a, b) => b.version - a.version)[0];
  const currentHyps = activeGoal ? hyps.filter((h) => h.goalVersionId === activeGoal.id) : hyps;
  const active = currentHyps.filter((h) => h.status === 'active');
  const validated = currentHyps.filter((h) => h.status === 'validated');
  const falsified = currentHyps.filter((h) => h.status === 'falsified');
  const mainline = currentHyps.filter((h) => h.track === 'mainline');
  const branch = currentHyps.filter((h) => h.track === 'branch');
  const detour = currentHyps.filter((h) => h.track === 'detour');
  const orphans = nodes.filter((n) => !n.hypothesisId);

  /* R1: 冷滞假设 */
  for (const hyp of active) {
    const hypNodes = nodes.filter((n) => n.hypothesisId === hyp.id);
    if (hypNodes.length === 0) continue;
    const lastActivity = Math.max(...hypNodes.map((n) => n.updatedAt));
    const daysIdle = Math.floor((now - lastActivity) / 86_400_000);
    if (daysIdle >= STALE_DAYS) {
      findings.push({
        rule: 'R1_stale_hypothesis',
        severity: daysIdle >= 30 ? 'high' : 'medium',
        description: `假设「${hyp.text.slice(0, 30)}」已 ${daysIdle} 天没有实验更新`,
        suggestedQuestion: `假设「${hyp.text.slice(0, 40)}」已经 ${daysIdle} 天没有实验活动了。这条线还在推进吗,还是应该标记为搁置(parked)?`,
        entityIds: [hyp.id],
      });
    }
  }

  /* R2: 孤儿实验 */
  if (orphans.length > 0) {
    findings.push({
      rule: 'R2_orphan_experiments',
      severity: 'medium',
      description: `${orphans.length} 个实验未归属任何假设:${orphans.map((n) => n.title.slice(0, 15)).join('、')}`,
      suggestedQuestion: `有 ${orphans.length} 个实验没有关联到任何假设(${orphans.map((n) => `「${n.title.slice(0, 20)}」`).join('、')})。它们属于哪条假设?还是新的探索方向?`,
      entityIds: orphans.map((n) => n.id),
    });
  }

  /* R3: 目标错配(简化:当前活跃实验的标题与目标文本无关键词交集) */
  if (activeGoal && active.length > 0) {
    const goalWords = extractKeywords(activeGoal.text);
    const activeExpTitles = nodes
      .filter((n) => n.status === 'in_progress' && n.hypothesisId)
      .map((n) => n.title);
    if (activeExpTitles.length > 0) {
      const expWords = new Set(activeExpTitles.flatMap((t) => [...extractKeywords(t)]));
      const overlap = [...goalWords].filter((w) => expWords.has(w));
      if (overlap.length === 0 && goalWords.size > 2) {
        findings.push({
          rule: 'R3_goal_mismatch',
          severity: 'high',
          description: `当前目标与进行中实验的关键词无交集(目标:「${activeGoal.text.slice(0, 30)}」vs 实验:「${activeExpTitles[0]?.slice(0, 20)}」等)`,
          suggestedQuestion: `当前目标是「${activeGoal.text.slice(0, 50)}」,但正在进行的实验似乎在另一个方向(「${activeExpTitles[0]?.slice(0, 30)}」等)。研究重心是否已经转移?需要修订目标吗?`,
          entityIds: [activeGoal.id],
        });
      }
    }
  }

  /* R4: 证否未标(假设的实验全部 done/dropped 但结论负面,假设仍 active) */
  for (const hyp of active) {
    const hypNodes = nodes.filter((n) => n.hypothesisId === hyp.id && n.status === 'done');
    if (hypNodes.length < 2) continue;
    const negative = hypNodes.filter((n) =>
      n.detail && /失败|负|下降|不行|放弃|falsified|no|negative/i.test(n.detail));
    if (negative.length === hypNodes.length && hypNodes.length >= 2) {
      findings.push({
        rule: 'R4_should_be_falsified',
        severity: 'high',
        description: `假设「${hyp.text.slice(0, 30)}」的所有实验结论都是负面的,但假设仍标 active`,
        suggestedQuestion: `假设「${hyp.text.slice(0, 40)}」的实验结论看起来都是负面的。是否应该标记为已证否(falsified)?如果是,原因是什么?`,
        entityIds: [hyp.id],
      });
    }
  }

  /* R5: 高频 pivot */
  if (activeGoal && activeGoal.version > 1) {
    const recentPivots = log.filter((l) =>
      l.type === 'goal_pivoted' && now - l.ts < PIVOT_WINDOW_DAYS * 86_400_000);
    if (recentPivots.length >= PIVOT_THRESHOLD) {
      findings.push({
        rule: 'R5_high_pivot_frequency',
        severity: 'medium',
        description: `过去 ${PIVOT_WINDOW_DAYS} 天内目标修订了 ${recentPivots.length} 次`,
        suggestedQuestion: `最近一周目标已修订 ${recentPivots.length} 次,方向似乎不太稳定。要不要停下来梳理一下:当前最核心的一个问题到底是什么?`,
        entityIds: [activeGoal.id],
      });
    }
  }

  /* R6: 断链(validated 假设但下游实验仍 todo) */
  for (const hyp of validated) {
    const downstream = nodes.filter((n) => n.hypothesisId === hyp.id && n.status === 'todo');
    if (downstream.length >= 2) {
      findings.push({
        rule: 'R6_broken_chain',
        severity: 'low',
        description: `假设「${hyp.text.slice(0, 25)}」已证实,但仍有 ${downstream.length} 个待办实验挂在下面`,
        suggestedQuestion: `假设「${hyp.text.slice(0, 30)}」已验证通过,下面还有 ${downstream.length} 个待办实验。这些还需要做吗,还是可以清理掉?`,
        entityIds: [hyp.id, ...downstream.map((n) => n.id)],
      });
    }
  }

  /* R7: 偏离未回归 */
  for (const hyp of detour) {
    if (hyp.status !== 'active') continue;
    const daysSince = Math.floor((now - hyp.updatedAt) / 86_400_000);
    if (daysSince >= STALE_DAYS) {
      findings.push({
        rule: 'R7_detour_not_returned',
        severity: 'medium',
        description: `假设「${hyp.text.slice(0, 25)}」标记为已偏离但 ${daysSince} 天未处理`,
        suggestedQuestion: `「${hyp.text.slice(0, 35)}」之前标记为走偏了,已经 ${daysSince} 天。这条线是彻底放弃,还是找到了回归主线的路径?`,
        entityIds: [hyp.id],
      });
    }
  }

  /* 按严重度排序 */
  const sevOrder = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);

  return {
    findings,
    summary: {
      goalVersion: activeGoal?.version ?? 0,
      goalText: activeGoal?.text ?? '(无目标)',
      totalHypotheses: currentHyps.length,
      activeHypotheses: active.length,
      validatedHypotheses: validated.length,
      falsifiedHypotheses: falsified.length,
      mainlineHypotheses: mainline.length,
      branchHypotheses: branch.length,
      detourHypotheses: detour.length,
      orphanExperiments: orphans.length,
      recentPivots: activeGoal ? activeGoal.version - 1 : 0,
    },
  };
}

/** 简单关键词提取:去停用词、取 ≥2 字的词 */
function extractKeywords(text: string): Set<string> {
  const stop = new Set(['的', '了', '在', '是', '和', '与', '或', '不', '为', '有', '对', '从', '会', '能', '要', 'the', 'a', 'an', 'is', 'are', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'with', 'that', 'this', 'it']);
  const tokens = text.toLowerCase().split(/[\s,;.、。;:?!""''()\[\]{}]+/);
  const out = new Set<string>();
  for (const t of tokens) {
    if (t.length < 2 || stop.has(t)) continue;
    out.add(t);
    // 中文 token(连续 CJK 字符 ≥3 字)额外提取 bigram,提供部分匹配能力
    const cjk = t.match(/[一-鿿]/g);
    if (cjk && cjk.length >= 3) {
      for (let i = 0; i < cjk.length - 1; i++) {
        const bi = cjk[i] + cjk[i + 1];
        if (!stop.has(bi)) out.add(bi);
      }
    }
  }
  return out;
}
