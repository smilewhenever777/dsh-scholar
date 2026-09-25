/**
 * 宿主已配置的模型清单(设置 → 模型 的数据源:settings.yaml providers 段)。
 * 供白名单下拉选择,免手输 provider/model。解析失败降级为空(手输仍可用)。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { dshHome } from '../store.js';

export function hostModels(): string[] {
  try {
    const doc = parse(readFileSync(join(dshHome(), 'settings.yaml'), 'utf8')) as {
      providers?: Record<string, { models?: Array<{ id?: unknown }> }>;
      // 宿主模型管理插件的命名空间(llm-pi-ai);顶层 providers 兼容读取
      'llm-pi-ai'?: { providers?: Record<string, { models?: Array<{ id?: unknown }> }> };
    };
    const out: string[] = [];
    for (const [provider, cfg] of Object.entries(doc.providers ?? doc['llm-pi-ai']?.providers ?? {})) {
      for (const m of cfg.models ?? []) {
        if (typeof m?.id === 'string' && m.id) out.push(`${provider}/${m.id}`);
      }
    }
    return out;
  } catch {
    return [];
  }
}
