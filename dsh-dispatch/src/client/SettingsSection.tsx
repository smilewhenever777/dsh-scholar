import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api';

/**
 * 宿主设置页的「AI 团队工作台」分区。
 * 宿主内置的插件配置卡是硬编码的(仅终端/Agent循环/Subagent/网页搜索),
 * 第三方插件通过 client slot `settings.section` 自注册分区(与 dsh-trajectory 同款)。
 */
type Policy = { allowed: string[]; default: string; maxConcurrent?: number; available?: string[] };

const CSS = `
.dsp-set { display: flex; flex-direction: column; gap: 14px; font-size: 13px; color: var(--dsw-alias-label-base, #d7dae0); }
.dsp-set h3 { margin: 0; font-size: 13px; font-weight: 700; }
.dsp-set p { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-caption, #9aa0aa); }
.dsp-set-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.dsp-set-chip { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); border-radius: 999px; padding: 3px 11px; font-size: 11.5px; }
.dsp-set-chip button { border: 0; background: transparent; color: inherit; cursor: pointer; padding: 0; font-size: 11px; }
.dsp-set-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.dsp-set select { background: var(--dsw-alias-bg-inset, rgba(0,0,0,.25)); border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); border-radius: 8px; padding: 6px 10px; color: inherit; font-size: 12.5px; }
.dsp-set input { background: var(--dsw-alias-bg-inset, rgba(0,0,0,.25)); border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); border-radius: 8px; padding: 6px 10px; color: inherit; font-size: 12.5px; }
.dsp-set button.primary { background: var(--dsw-alias-fill-primary, #5d74ec); border: 0; color: #fff; border-radius: 8px; padding: 6px 14px; font-size: 12.5px; cursor: pointer; }
.dsp-set button.plain { background: transparent; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); color: inherit; border-radius: 8px; padding: 6px 14px; font-size: 12.5px; cursor: pointer; }
.dsp-set-msg { font-size: 12px; }
.dsp-set-msg.ok { color: #5fbf7f; }
.dsp-set-msg.err { color: #d96959; }
`;

export function DispatchSettingsSection(): React.ReactElement {
  const [policy, setPolicy] = useState<Policy>({ allowed: [], default: '', maxConcurrent: 3 });
  const [newModel, setNewModel] = useState('');
  const [maxC, setMaxC] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const p = await api<Policy>('/dispatch/workbench/model-policy');
      setPolicy(p);
      setMaxC(String(p.maxConcurrent ?? 3));
    } catch (e) {
      setMsg({ ok: false, text: `加载失败:${e instanceof Error ? e.message : String(e)}` });
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = async (patch: { allowedModels?: string[]; maxConcurrentDispatches?: number }) => {
    try {
      setBusy(true);
      const p = await api<Policy>('/dispatch/workbench/model-policy', { method: 'PUT', body: JSON.stringify(patch) });
      setPolicy(p);
      setMaxC(String(p.maxConcurrent ?? 3));
      setMsg({ ok: true, text: '已保存,立即生效(无需重启)' });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(false); }
  };

  return <div className="dsp-set"><style>{CSS}</style>
    <div>
      <h3>模型白名单</h3>
      <p style={{ marginTop: 4 }}>工作台新建 Agent 只能从下列模型中选择。格式 provider/model,可用 provider 见「模型」页(当前已配 kimi / glm / gpt / linkapi 等)。</p>
      <div className="dsp-set-chips" style={{ marginTop: 8 }}>
        {policy.allowed.map((m) => <span key={m} className="dsp-set-chip">{m}
          <button type="button" aria-label={'移除 ' + m} disabled={policy.allowed.length <= 1 || busy} onClick={() => void save({ allowedModels: policy.allowed.filter((x) => x !== m) })}>✕</button></span>)}
      </div>
      <div className="dsp-set-row" style={{ marginTop: 8 }}>
        {(policy.available?.length ?? 0) > 0
          ? <>
            <select className="dsp-set-sel" value={newModel} onChange={(e) => setNewModel(e.target.value)} aria-label="选择要添加的模型">
              <option value="">选择要添加的模型…</option>
              {policy.available!.filter((m) => !policy.allowed.includes(m)).map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <button type="button" className="plain" disabled={busy || !newModel} onClick={() => { if (newModel) void save({ allowedModels: [...policy.allowed, newModel] }); setNewModel(''); }}>添加</button>
          </>
          : <p>未读取到宿主模型清单(settings.yaml providers),请按 provider/model 手动输入。</p>}
      </div>
    </div>
    <div>
      <h3>并发上限</h3>
      <p style={{ marginTop: 4 }}>不同(非重叠)工作区的任务可同时运行的个数;同一/重叠工作区始终互斥。</p>
      <div className="dsp-set-row" style={{ marginTop: 8 }}>
        <input value={maxC} style={{ maxWidth: 80 }} onChange={(e) => setMaxC(e.target.value)} aria-label="并发上限" />
        <button type="button" className="plain" disabled={busy} onClick={() => {
          const n = Number(maxC);
          if (!Number.isInteger(n) || n < 1) { setMsg({ ok: false, text: '并发上限须为 ≥1 的整数' }); return; }
          void save({ maxConcurrentDispatches: n });
        }}>保存并发上限</button>
      </div>
    </div>
    {msg && <div className={`dsp-set-msg ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}
  </div>;
}
