/**
 * 安全与资源约束(P1):research-safe 工具面、模型允许列表、预算、执行者写入门控(§9)。
 * P0 实测:委派审批固化 approvalPolicy='never' + sandboxMode='workspace-write',不可配置——
 * 因此边界只能靠 toolFilter(单次可见性已实测)+ 工具自限(每次调用校验归属)。
 */
import type { DispatchRecord } from './types.js';
import { TOOL_POLICY_VERSION } from './prompt.js';

/** §5.3:执行者工具集排除一切 trajectory 直写工具;v1 最小面 = 两个汇报工具。 */
export const TRAJECTORY_WRITE_TOOLS = [
  'traj_node_update', 'traj_node_add', 'traj_node_remove',
  'traj_link_add', 'traj_link_remove',
  'traj_entry_add', 'traj_goal_set',
  'traj_hypothesis_add', 'traj_hypothesis_update',
  'traj_project_set', 'traj_project_delete', 'traj_mainline_set',
] as const;

/** §5.3+§0.3:执行者默认工具面——两个汇报工具 + P3 受控文件面(读/列表限工作区、写仅报告目录)。
 * 文件面工具内部每次调用重过 worker 门控;trajectory 直写工具无条件排除。 */
export const DEFAULT_CHILD_TOOL_ALLOW = [
  'dispatch_progress',
  'dispatch_report',
  'dispatch_read_file',
  'dispatch_list_dir',
  'dispatch_write_report',
];

export interface PolicyConfig {
  /** `provider/model` 允许列表;start 请求的 model 必须命中。 */
  allowedModels: string[];
  defaultModel: string;
  maxWallMs: number;
  /** 单任务快照/正文尺寸上限(字节)——超限明确拒绝,不静默截断(§6.3/T28)。 */
  maxPromptBytes: number;
}

export function defaultPolicyConfig(): PolicyConfig {
  return {
    allowedModels: ['glm/glm-5.3'],
    defaultModel: 'glm/glm-5.3',
    maxWallMs: 2 * 60 * 60 * 1000,
    maxPromptBytes: 256 * 1024,
  };
}

/** 子代理 toolFilter 组装:白名单 ∩ 允许面,trajectory 直写工具无条件排除。
 * 真机实测(2026-09-22):toolFilter 的 deny 对未注册工具名严格报错,且宿主语义本就是
 * "allow 即完备隔离"(被滤工具从子代理提示中消失且拒绝执行)——deny 冗余,不再下发。 */
export function childToolFilter(requestedAllow?: string[]): { allow: string[] } {
  const base = requestedAllow === undefined ? DEFAULT_CHILD_TOOL_ALLOW : requestedAllow;
  const allow = [...new Set(base)].filter((t) => DEFAULT_CHILD_TOOL_ALLOW.includes(t)
    && !(TRAJECTORY_WRITE_TOOLS as readonly string[]).includes(t));
  return { allow };
}

/** 工具调用门控结论(§9.3:每次写入与冷恢复都重新校验,不缓存授权)。 */
export type WorkerGate =
  | { ok: true; dispatch: DispatchRecord; writes: 'enabled' }
  | { ok: false; code: 'NO_DISPATCH' | 'WRITES_DISABLED' | 'WRITES_REVOKED' | 'WRONG_PHASE'; detail: string; dispatch?: DispatchRecord };

/**
 * 执行者调用门控:按 childSessionId(P0:exec.agent.id 即 childSessionId)反查在册派发,
 * 校验 workerWrites 与阶段。迟到/已撤权调用只返回拒绝,由调用方记入隔离审计。
 */
export function gateWorkerCall(
  findByChild: (childId: string) => DispatchRecord | undefined,
  childSessionId: string,
  phase: 'progress' | 'report',
): WorkerGate {
  const d = findByChild(childSessionId);
  if (!d) return { ok: false, code: 'NO_DISPATCH', detail: `childSessionId=${childSessionId} 不属于任何派发` };
  if (d.ownership.workerWrites === 'revoked') {
    return { ok: false, code: 'WRITES_REVOKED', detail: '派发已被人工接管,写入权限已撤销', dispatch: d };
  }
  if (d.ownership.workerWrites !== 'enabled') {
    return { ok: false, code: 'WRITES_DISABLED', detail: '执行者写入已封闭(报告已提交或取消已受理)', dispatch: d };
  }
  if (phase === 'progress' && !['queued', 'running'].includes(d.phase)) {
    return { ok: false, code: 'WRONG_PHASE', detail: `phase=${d.phase} 不接受 progress` , dispatch: d };
  }
  if (phase === 'report' && !['queued', 'running', 'settling', 'reconciling'].includes(d.phase)) {
    return { ok: false, code: 'WRONG_PHASE', detail: `phase=${d.phase} 不接受 report`, dispatch: d };
  }
  return { ok: true, dispatch: d, writes: 'enabled' };
}

export { TOOL_POLICY_VERSION };
