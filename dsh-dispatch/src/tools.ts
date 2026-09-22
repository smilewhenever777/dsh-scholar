/**
 * 执行者工具(P1):dispatch_progress / dispatch_report(§5.2)。
 * 归属由可信工具调用上下文解析——exec.agent.id 即 childSessionId(P0 实测),
 * 模型自报的 dispatchId 仅作一致性检查,不作为授权依据。
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { DispatchService } from './service.js';
import type { RuntimeAdapter } from './runtime.js';

const renderProbe = (_args: unknown, value: unknown) =>
  [{ type: 'text', text: JSON.stringify(value) }] as ContentBlock[];

/** 观察日志(与 P0 探针一致的 journal 约定)。 */
export interface ToolJournal {
  (kind: string, data: unknown): void;
}

export function registerDispatchTools(
  ctx: Context,
  getService: () => DispatchService | null,
  runtime: RuntimeAdapter,
  journal: ToolJournal,
): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'dispatch_progress',
    description: '[派发] 提交一次执行进度(每个关键步骤一条,sequence 从 1 递增)。'
      + 'summary 一句话;metrics 可放结构化指标;evidence 放日志/命令/产物引用。'
      + '同一 sequence 重发相同内容幂等;不同内容将冲突。',
    parameters: {
      sequence: { type: 'number', required: true, description: '进度序号(从 1 递增)' },
      summary: { type: 'string', required: true, description: '本步做了什么(一句话)' },
      metrics: { type: 'array', description: '结构化指标数组,每项 {name: string, value: number, baseline?: number, unit?: string},如 [{name:"exp_a mAP",value:0.641,baseline:0.628,unit:"pp"}]' },
      evidence: { type: 'array', description: '证据引用列表' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderProbe },
    async execute(args: Record<string, unknown>, exec: unknown) {
      const service = getService();
      const e = exec as { agent?: { id?: string } };
      if (!service || !e?.agent?.id) throw new Error('dispatch 服务不可用或调用者身份缺失');
      journal('tool/dispatch_progress', { caller: e.agent.id, sequence: args.sequence });
      return service.ingestProgress(e.agent.id, {
        sequence: Number(args.sequence),
        summary: String(args.summary ?? ''),
        metrics: args.metrics ?? null,
        evidence: Array.isArray(args.evidence) ? args.evidence : [],
      });
    },
  })));

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'dispatch_report',
    description: '[派发] 提交最终结果并停止新增任务性写操作。outcome: done=执行完成(负结果也算 done)/'
      + 'failed=执行失败/blocked=受阻(缺依赖/权限/歧义)。evidence 为可核验引用。'
      + '最终报告内容幂等;不同内容的第二次最终报告不会覆盖第一份。',
    parameters: {
      dispatchId: { type: 'string', description: '一致性检查用(非授权依据)' },
      outcome: { type: 'string', required: true, description: 'done | failed | blocked' },
      summary: { type: 'string', required: true, description: '结果摘要(≤2000 字符,如实报告,不编造)' },
      evidence: { type: 'array', description: '证据引用列表' },
      nextHint: { type: 'string', description: '建议的下一步(可选)' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderProbe },
    async execute(args: Record<string, unknown>, exec: unknown) {
      const service = getService();
      const e = exec as { agent?: { id?: string } };
      if (!service || !e?.agent?.id) throw new Error('dispatch 服务不可用或调用者身份缺失');
      journal('tool/dispatch_report', { caller: e.agent.id, outcome: args.outcome });
      return service.ingestReport(e.agent.id, {
        outcome: String(args.outcome ?? ''),
        summary: String(args.summary ?? ''),
        evidence: Array.isArray(args.evidence) ? args.evidence : [],
        nextHint: args.nextHint === undefined ? undefined : String(args.nextHint),
      });
    },
  })));

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'dispatch_read_file',
    description: '[派发] 读取当前工作区内的一个文本文件(日志/配置等)。仅允许工作区内路径,'
      + '相对路径相对工作区根;越界、二进制、不存在都会返回明确错误。单文件读取上限 1MB(超限截断并标注)。',
    parameters: {
      path: { type: 'string', required: true, description: '文件路径(工作区内相对或绝对)' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderProbe },
    async execute(args: Record<string, unknown>, exec: unknown) {
      const service = getService();
      const e = exec as { agent?: { id?: string } };
      if (!service || !e?.agent?.id) throw new Error('dispatch 服务不可用或调用者身份缺失');
      journal('tool/dispatch_read_file', { caller: e.agent.id, path: String(args.path ?? '').slice(0, 160) });
      return service.workerReadFile(e.agent.id, String(args.path ?? ''));
    },
  })));

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'dispatch_list_dir',
    description: '[派发] 列出当前工作区内一个目录的条目(名称/是否目录/大小)。仅允许工作区内路径。',
    parameters: {
      path: { type: 'string', description: '目录路径,缺省为工作区根' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderProbe },
    async execute(args: Record<string, unknown>, exec: unknown) {
      const service = getService();
      const e = exec as { agent?: { id?: string } };
      if (!service || !e?.agent?.id) throw new Error('dispatch 服务不可用或调用者身份缺失');
      journal('tool/dispatch_list_dir', { caller: e.agent.id, path: String(args.path ?? '') });
      return service.workerListDir(e.agent.id, String(args.path ?? ''));
    },
  })));

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'dispatch_write_report',
    description: '[派发] 把交付物文件写入本派发的专属报告目录(工作区/dispatch-reports/<dispatchId>/)。'
      + 'filename 只能是纯文件名(字母数字._-,不含路径);这是唯一允许的文件写入入口。报告完成后请在 dispatch_report 的 evidence 里引用该路径。',
    parameters: {
      filename: { type: 'string', required: true, description: '报告文件名,如 comparison-report.md' },
      content: { type: 'string', required: true, description: '文件全文(≤2MB)' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderProbe },
    async execute(args: Record<string, unknown>, exec: unknown) {
      const service = getService();
      const e = exec as { agent?: { id?: string } };
      if (!service || !e?.agent?.id) throw new Error('dispatch 服务不可用或调用者身份缺失');
      journal('tool/dispatch_write_report', { caller: e.agent.id, filename: String(args.filename ?? '') });
      return service.workerWriteReport(e.agent.id, String(args.filename ?? ''), String(args.content ?? ''));
    },
  })));

  void runtime;
}
