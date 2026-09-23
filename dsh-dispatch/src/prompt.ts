/**
 * 提示词契约(P1):任务快照哈希、幂等请求哈希、任务卡与执行协议的单一来源(§6)。
 * v1 不静默截断关键内容;协议版本随实现演进递增。
 */
import { createHash } from 'node:crypto';
import type { TaskSnapshot } from './types.js';

export const PROTOCOL_VERSION = 'dispatch-protocol/p1';
export const TOOL_POLICY_VERSION = 'research-safe/p1';

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** 幂等键对应的规范化请求哈希:同键不同请求 → 409(§5.1)。 */
export function payloadHash(input: { targetType: string; projectId: string; nodeId: string; ws: string; model?: string }): string {
  const norm = {
    targetType: input.targetType,
    projectId: input.projectId,
    nodeId: input.nodeId,
    ws: input.ws.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase(),
    model: input.model ?? '',
  };
  return sha256(JSON.stringify(norm));
}

/** 任务卡 + 本次执行契约 + 身份 + 执行协议(§6.1)。 */
export function buildPrompt(input: {
  snapshot: TaskSnapshot;
  dispatchId: string;
  workspaceRoot: string;
  budgetMinutes: number;
  agentInstructions?: string;
}): string {
  const s = input.snapshot;
  const lines: string[] = [];
  lines.push(s.source === 'workbench' ? `【工作台任务 #${s.nodeId}】` : `【研究任务卡 #${s.nodeId}】`);
  if (s.goalText) lines.push(`研究目标:${s.goalText}${s.goalVersion ? `(版本 ${s.goalVersion})` : ''}`);
  if (s.hypothesisText) lines.push(`所属假设:${s.hypothesisText}`);
  lines.push(`${s.source === 'workbench' ? '任务' : '任务节点'}:${s.nodeTitle}${s.nodeKind ? `(${s.nodeKind})` : ''}`);
  if (s.nodeDetail) lines.push(`详情:${s.nodeDetail}`);
  if (s.entriesCount !== undefined) lines.push(`已有台账:${s.entriesCount} 条`);
  lines.push('');
  if (input.agentInstructions) {
    lines.push('【执行者指令】');
    lines.push(input.agentInstructions);
    lines.push('');
  }
  lines.push('【本次执行契约】');
  const c = s.contract ?? {};
  lines.push(`具体任务:${s.nodeDetail || s.nodeTitle}`);
  lines.push(`交付物:${c.deliverables ?? '结果摘要(通过 dispatch_report 提交)'}`);
  lines.push(`完成标准:${c.completionCriteria ?? '按要求完成具体任务并提交可核验摘要'}`);
  lines.push(`证据要求:${c.evidenceRequired ?? '执行过程中产生的关键日志/命令/产物引用'}`);
  lines.push(`阻塞条件:${c.blockedWhen ?? '缺依赖、权限不足或任务歧义无法推进时,如实以 blocked 停止'}`);
  lines.push(`预算边界:最长执行 ${Math.round(input.budgetMinutes)} 分钟(超限将被请求停止)`);
  lines.push('');
  lines.push('【身份与工作区】');
  lines.push(`dispatchId: ${input.dispatchId}`);
  lines.push(`工作区(已继承,直接在此工作):${input.workspaceRoot}`);
  lines.push('');
  lines.push('【执行协议】');
  lines.push('可用工具:dispatch_list_dir / dispatch_read_file(仅限当前工作区内读取,越界与二进制会被拒);');
  lines.push('dispatch_write_report(唯一文件写入口,仅写本派发报告目录 dispatch-reports/<dispatchId>/,文件名不含路径);');
  lines.push('dispatch_progress(过程台账,metrics 传结构化指标数组,每项 {name,value,baseline?,unit?});');
  lines.push('dispatch_report(最终结果;文件交付物把路径写入 evidence)。');
  lines.push('仅处理本次任务;完成或受阻时提交 dispatch_report(done/failed/blocked),此后停止新增任务性写操作。');
  if (s.source === 'workbench') {
    lines.push('不得修改工作区内任何既有文件；只在本次报告目录写交付物。');
    lines.push('执行完成不等于任务已经验收；如实提供结果，等待用户审查。');
  } else {
    lines.push('不得直接修改研究目标、假设、边结构或任务节点终态;不得修改工作区内任何既有文件。');
    lines.push('不得把"实验未支持假设"报告为执行失败,也不得伪造积极结论;负结果如实报告。');
  }
  return lines.join('\n');
}
