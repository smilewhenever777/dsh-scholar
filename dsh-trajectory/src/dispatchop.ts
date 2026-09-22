/**
 * P2 派发适配层核心(§5.4/§5.5):任务语义指纹 + 只读任务卡 + 服务身份 token。
 *
 * 指纹是 trajectory 与 dispatch 之间的"任务未变"凭据:**由 trajectory 单侧计算**,
 * dispatch 经 read 取回、claim 时原样带回,trajectory 在自己的临界区内重算比对——
 * 两端不共享算法实现,不存在漂移。
 *
 * 字段口径(§5.5):含影响任务含义的目标/假设/节点正文/绑定;**排除**节点 status、
 * 台账 entries、派发管理字段(dispatchClaim/dispatchHistory)——人工改 status 不改指纹,
 * 但走编辑钩子撤销所有权;执行者写台账不触发自失效。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TrajGoal, TrajHypothesis, TrajNode, TrajProject } from './shared/types.js';

/** 指纹输入:调用方(project 内)先解析好 goal/hypothesis。 */
export function computeDispatchFingerprint(input: {
  project: Pick<TrajProject, 'id' | 'workspaceKey'>;
  node: Pick<TrajNode, 'id' | 'title' | 'kind' | 'detail' | 'tags' | 'refs' | 'hypothesisId'>;
  goal: Pick<TrajGoal, 'text' | 'version'> | null;
  hypothesis: Pick<TrajHypothesis, 'id' | 'text' | 'status' | 'track'> | null;
}): string {
  const refs: Record<string, string> = {};
  for (const k of Object.keys(input.node.refs ?? {}).sort()) {
    const v = (input.node.refs as Record<string, string> | undefined)?.[k];
    if (typeof v === 'string' && v) refs[k] = v;
  }
  const semantic = {
    projectId: input.project.id,
    workspaceKey: input.project.workspaceKey ?? '',
    nodeId: input.node.id,
    nodeTitle: input.node.title,
    nodeKind: input.node.kind,
    nodeDetail: input.node.detail ?? '',
    nodeTags: [...(input.node.tags ?? [])].sort(),
    nodeRefs: refs,
    hypothesisId: input.node.hypothesisId ?? '',
    hypothesisText: input.hypothesis?.text ?? '',
    hypothesisStatus: input.hypothesis?.status ?? '',
    hypothesisTrack: input.hypothesis?.track ?? '',
    goalText: input.goal?.text ?? '',
    goalVersion: input.goal?.version ?? 0,
  };
  return createHash('sha256').update(JSON.stringify(semantic)).digest('hex');
}

/** dispatch 侧 read 动作的返回体(快照 + 指纹)。 */
export interface TrajTaskRead {
  projectId: string;
  nodeId: string;
  workspaceKey: string;
  goal: { text: string; version: number } | null;
  hypothesis: { id: string; text: string; status: string; track: string } | null;
  node: {
    title: string;
    kind: string;
    status: string;
    detail: string;
    tags: string[];
    refs: Record<string, string>;
  };
  entriesCount: number;
  fingerprint: string;
}

/* ---------- 服务身份 token(§5.4:不可由模型伪造;凭据不进 prompt) ---------- */

function dshHome(): string {
  const home = process.env.DSH_HOME?.trim();
  return home || join(homedir(), '.dsh');
}

export function serviceTokenPath(): string {
  return join(dshHome(), '.dispatch-service-token');
}

/** trajectory 启动时确保存在;同宿主的 dispatch 插件读同一文件。 */
export function ensureServiceToken(): string {
  const p = serviceTokenPath();
  if (!existsSync(p)) {
    writeFileSync(p, randomBytes(32).toString('hex'), 'utf8');
  }
  return readFileSync(p, 'utf8').trim();
}

export function readServiceToken(): string | null {
  try {
    const t = readFileSync(serviceTokenPath(), 'utf8').trim();
    return t.length >= 32 ? t : null;
  } catch {
    return null;
  }
}

/** 常时比较(本地威胁模型下等值即可,常时比较是免费的加固)。 */
export function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
