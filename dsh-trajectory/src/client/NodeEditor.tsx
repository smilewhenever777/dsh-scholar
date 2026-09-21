import { ReferenceSearch, type ReferenceOption } from './ReferenceSearch';
import React, { useEffect, useRef, useState } from 'react';
import type { TrajNode, TrajNodeKind, TrajProjectFile, TrajStatus } from '../shared/types';
import { TRAJ_NODE_KINDS, TRAJ_STATUSES } from '../shared/types';
import { api } from './api';
import type { TFunc } from './nav';
import { Btn, Field, Icon, Icons, Input, labelStyle, Modal, Select, T, Textarea } from './ui';
import { NODE_KIND_LABELS, STATUS_LABELS } from './locales';

/* ---------- node create / edit modal ---------- */

export interface NodeEditorRequest {
  editing: TrajNode | null;
}

interface EditorProps {
  t: TFunc; file: TrajProjectFile; editing: TrajNode | null; onClose: () => void; onSaved: () => void;
}
function draftOf(file: TrajProjectFile, editing: TrajNode | null) {
  return { title: editing?.title ?? '', kind: editing?.kind ?? 'other' as TrajNodeKind,
    status: editing?.status ?? 'todo' as TrajStatus, detail: editing?.detail ?? '',
    tags: (editing?.tags ?? []).join(', '), hypoId: editing?.hypothesisId ?? '',
    mainline: !!editing && file.project.mainline.includes(editing.id), parents: [] as string[],
    cardId: editing?.refs?.cardId ?? '', cardLabel: editing?.refs?.cardLabel ?? '',
    paperId: editing?.refs?.paperId ?? '', paperLabel: editing?.refs?.paperLabel ?? '',
    hostId: editing?.refs?.hostId ?? '', logPath: editing?.refs?.logPath ?? '', cmdPattern: editing?.refs?.cmdPattern ?? '' };
}
type Draft = ReturnType<typeof draftOf>;
// Memory only; no research text is written to browser storage. Bounded to 20 drafts.
const drafts = new Map<string, { draft: Draft; baseline: Draft }>();
export function NodeEditorModal(props: EditorProps) {
  const target = props.file.project.id + ':' + (props.editing?.id ?? 'new');
  return <NodeEditorForm key={target} {...props} target={target} />;
}
function NodeEditorForm({ t, file, editing, onClose, onSaved, target }: EditorProps & { target: string }) {
  const [initial] = useState(() => drafts.get(target)?.draft ?? draftOf(file, editing));
  const initialRef = useRef(drafts.get(target)?.baseline ?? draftOf(file, editing));
  const [restored] = useState(() => drafts.has(target));
  const [title, setTitle] = useState(initial.title);
  const [kind, setKind] = useState(initial.kind);
  const [status, setStatus] = useState(initial.status);
  const [detail, setDetail] = useState(initial.detail);
  const [tags, setTags] = useState(initial.tags);
  const [hypoId, setHypoId] = useState(initial.hypoId);
  const [mainline, setMainline] = useState(initial.mainline);
  const [parents, setParents] = useState(initial.parents);
  const [cardId, setCardId] = useState(initial.cardId);
  const [cardLabel, setCardLabel] = useState(initial.cardLabel);
  const [paperId, setPaperId] = useState(initial.paperId);
  const [paperLabel, setPaperLabel] = useState(initial.paperLabel);
  const [hostId, setHostId] = useState(initial.hostId);
  const [logPath, setLogPath] = useState(initial.logPath);
  const [cmdPattern, setCmdPattern] = useState(initial.cmdPattern);
  const finished = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const busy = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [delArm, setDelArm] = useState(false);

  const removeNode = async () => {
    if (!editing || busy.current) return;
    busy.current = true;
    setSaving(true);
    setError('');
    try {
      await api(`/traj/nodes/${encodeURIComponent(editing.id)}`, { method: 'DELETE' });
      finished.current = true; drafts.delete(target);
      if (mounted.current) onClose();
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  const draft = { title, kind, status, detail, tags, hypoId, mainline, parents, cardId, cardLabel, paperId, paperLabel, hostId, logPath, cmdPattern };
  const draftRef = useRef(draft); draftRef.current = draft;
  const dirty = JSON.stringify(draft) !== JSON.stringify(initialRef.current);
  useEffect(() => () => {
    if (!finished.current && JSON.stringify(draftRef.current) !== JSON.stringify(initialRef.current)) {
      drafts.set(target, { draft: draftRef.current, baseline: initialRef.current });
      while (drafts.size > 20) drafts.delete(drafts.keys().next().value!);
    } else drafts.delete(target);
  }, [target]);
  useEffect(() => {
    const unload = (e: BeforeUnloadEvent) => { if (dirty || busy.current) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, [dirty]);
  const requestClose = () => {
    if (busy.current) return;
    if (dirty && !window.confirm(t('node.confirmDiscard'))) return;
    finished.current = true; drafts.delete(target); onClose();
  };
  const [paperOptions, setPaperOptions] = useState<ReferenceOption[]>([]);
  const [cardOptions, setCardOptions] = useState<ReferenceOption[]>([]);
  type Binding = { hostId: string; host: string; gpu: number; logPath: string; command: string; at: number };
  const [hostOptions, setHostOptions] = useState<ReferenceOption[]>([]);
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [lookupFailed, setLookupFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let alive = true;
    type Source = { id: string; title: string };
    type Snapshot = { at?: number; gpus?: { index?: number; log?: { path?: string }; processes?: { cmd?: string }[] }[] };
    void Promise.allSettled([
      api<{ papers: Source[] }>('/scholar/papers', { signal: controller.signal }),
      api<{ cards: Source[] }>('/scholar/cards', { signal: controller.signal }),
      api<{ hosts: { id: string; name: string }[]; snapshots: Record<string, Snapshot> }>('/dash/snapshots?cached=1', { signal: controller.signal }),
    ]).then(([p, c, h]) => {
      if (!alive) return;
      setLookupFailed([p, c, h].some(x => x.status === 'rejected'));
      if (p.status === 'fulfilled') setPaperOptions((p.value.papers ?? []).map(x => ({ id: x.id, label: x.title })));
      if (c.status === 'fulfilled') setCardOptions((c.value.cards ?? []).map(x => ({ id: x.id, label: x.title })));
      if (h.status === 'fulfilled') {
        setHostOptions((h.value.hosts ?? []).map(x => ({ id: x.id, label: x.name })));
        setBindings((h.value.hosts ?? []).flatMap(host => {
          const snap = h.value.snapshots?.[host.id];
          return (snap?.gpus ?? []).map(gpu => ({ hostId: host.id, host: host.name, gpu: gpu.index ?? 0, logPath: gpu.log?.path ?? '', command: (gpu.processes ?? []).map(p => p.cmd ?? '').filter(Boolean).join(' | '), at: snap?.at ?? 0 }));
        }));
      }
    }).finally(() => clearTimeout(timer));
    return () => { alive = false; controller.abort(); clearTimeout(timer); };
  }, []);
  const matches = bindings.filter(b => (!hostId || b.hostId === hostId) && (logPath ? b.logPath.replace(/\/+$/, '') === logPath.replace(/\/+$/, '') : !!cmdPattern && b.command.toLowerCase().includes(cmdPattern.toLowerCase())));
  const save = async () => {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setError('');
    try {
      const refBody = {
        cardId, cardLabel,
        paperId, paperLabel,
        hostId, logPath, cmdPattern,
      };
      if (editing) {
        await api(`/traj/nodes/${encodeURIComponent(editing.id)}`, {
          method: 'PUT',
          body: JSON.stringify({
            title, kind, status, detail, tags: tags.split(/[,，]/).map((x) => x.trim()).filter(Boolean),
            refs: refBody, mainline, projectId: file.project.id,
            hypothesisId: hypoId, // F18:显式归属(空串 = 解除)
          }),
        });
      } else {
        await api('/traj/nodes', {
          method: 'POST',
          body: JSON.stringify({
            projectId: file.project.id,
            hypothesisId: hypoId,
            kind, title, status,
            detail,
            tags: tags.split(/[,，]/).map((x) => x.trim()).filter(Boolean),
            parentIds: parents,
            mainline,
            ...refBody,
          }),
        });
      }
      finished.current = true; drafts.delete(target);
      if (mounted.current) onClose();
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  return (
    <Modal title={editing ? t('node.edit') : t('node.new')} onClose={requestClose} width={460}>
      <fieldset disabled={saving} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
      {restored && <div role="status" style={{ fontSize: 11, color: T.caption }}>{t('node.draftRestored')}</div>}
      <Field label={t('node.title')}>
        <Input value={title} placeholder={t('node.titlePh')} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </Field>
      <div style={{ display: 'flex', gap: 10 }}>
        <div style={{ flex: 1 }}>
          <Field label={t('node.kind')}>
            <Select value={kind} onChange={(e) => setKind(e.target.value as TrajNodeKind)}>
              {TRAJ_NODE_KINDS.map((k) => (
                <option key={k} value={k}>{t(NODE_KIND_LABELS[k])}</option>
              ))}
            </Select>
          </Field>
        </div>
        <div style={{ flex: 1 }}>
          <Field label={t('node.status')}>
            <Select value={status} onChange={(e) => setStatus(e.target.value as TrajStatus)}>
              {TRAJ_STATUSES.map((s) => (
                <option key={s} value={s}>{t(STATUS_LABELS[s])}</option>
              ))}
            </Select>
          </Field>
        </div>
      </div>
      <Field label={t('node.detail')}>
        <Textarea rows={3} value={detail} placeholder={t('node.detailPh')} onChange={(e) => setDetail(e.target.value)} />
      </Field>
      <Field label={t('node.tags')}>
        <Input value={tags} onChange={(e) => setTags(e.target.value)} />
      </Field>

      {/* F18/R09:归属假设选择(读本项目假设;空 = 无归属) */}
      <Field label={t('node.hypothesis')}>
        <select
          value={hypoId}
          onChange={(e) => setHypoId(e.target.value)}
          className="traj-input"
          style={{ padding: '6px 8px', borderRadius: 7, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2, transparent)', color: 'var(--dsw-alias-label-primary)', fontSize: 11.5 }}
        >
          <option value="">{t('node.hypothesisNone')}</option>
          {(file.hypotheses ?? []).filter((h) => h.status !== 'superseded' && h.status !== 'falsified').map((h) => (
            <option key={h.id} value={h.id}>{h.text.slice(0, 60)}</option>
          ))}
        </select>
      </Field>

      {!editing && file.nodes.length > 0 && (
        <Field label={t('node.parents')} hint={t('node.parentsHint')}>
          <select
            multiple
            value={parents}
            onChange={(e) => setParents([...e.target.selectedOptions].map((o) => o.value))}
            className="traj-input"
            style={{ height: 84, padding: 4, borderRadius: 7, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2, transparent)', color: 'var(--dsw-alias-label-primary)', fontSize: 11.5 }}
          >
            {file.nodes.map((n) => (
              <option key={n.id} value={n.id}>{t(NODE_KIND_LABELS[n.kind])} · {n.title}</option>
            ))}
          </select>
        </Field>
      )}

      <Field label={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon d={Icons.traj} size={11} /> {t('node.mainline')}</span>}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: T.secondary, cursor: 'pointer' }}>
          <input type="checkbox" checked={mainline} onChange={(e) => setMainline(e.target.checked)} />
        </label>
      </Field>

      <ReferenceSearch label={t('node.searchPaper')} options={paperOptions} value={paperId} onSelect={o => { setPaperId(o.id); setPaperLabel(o.label); }} />
      <ReferenceSearch label={t('node.searchCard')} options={cardOptions} value={cardId} onSelect={o => { setCardId(o.id); setCardLabel(o.label); }} />
      <ReferenceSearch label={t('node.searchHost')} options={hostOptions} value={hostId} onSelect={o => setHostId(o.id)} />
      {lookupFailed && <div role="status" style={{ fontSize: 11, color: T.caption }}>{t('node.lookupUnavailable')}</div>}
      <details style={{ marginBottom: 10 }}>
        <summary>{t('node.bindingPreview')}</summary>
        {bindings.filter(b => !hostId || b.hostId === hostId).map((b, i) => <button type="button" key={i} onClick={() => { setHostId(b.hostId); setLogPath(b.logPath); if (!b.logPath) setCmdPattern(b.command.split(' | ')[0]); }}
          style={{ display: 'block', width: '100%', textAlign: 'left', color: T.primary, background: 'none', border: '1px solid var(--dsw-alias-border-l2)', padding: 6, overflowWrap: 'anywhere' }}>
          {b.host} · GPU {b.gpu} · {b.at ? new Date(b.at).toLocaleString() : '—'}<br />{b.logPath || b.command}
        </button>)}
      </details>
      <div role="status" style={{ fontSize: 11, color: matches.length > 1 ? T.warning : T.caption, marginBottom: 8 }}>
        {!logPath && !cmdPattern ? t('node.bindingNeed') : matches.length > 1 ? t('node.bindingAmbiguous') : matches.length === 0 ? t('node.bindingNone') : matches.map(b => b.host + ' · GPU ' + b.gpu + ' · ' + b.logPath).join('')}
      </div>
      <div style={{ fontSize: 11, color: T.caption }}>{t('node.manual')}</div>
      <div style={{ borderTop: '1px solid var(--dsw-alias-border-l2)', marginTop: 4, paddingTop: 8 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <Field label={t('node.refs')}>
              <Input value={cardId} onChange={(e) => setCardId(e.target.value)} placeholder="c_xxx" />
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label={t('node.refsLabel')}>
              <Input value={cardLabel} onChange={(e) => setCardLabel(e.target.value)} />
            </Field>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <Field label={t('node.refPaper')}>
              <Input value={paperId} onChange={(e) => setPaperId(e.target.value)} />
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label={t('node.refsLabel')}>
              <Input value={paperLabel} onChange={(e) => setPaperLabel(e.target.value)} />
            </Field>
          </div>
        </div>
        <Field label={t('node.expBind')} hint={t('node.expBindHint')}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <Input value={hostId} onChange={(e) => setHostId(e.target.value)} placeholder={t('node.expHost')} style={{ flex: 'none', width: 96 }} />
            <Input value={cmdPattern} onChange={(e) => setCmdPattern(e.target.value)} placeholder={t('node.expCmd')} />
          </div>
          <Input value={logPath} onChange={(e) => setLogPath(e.target.value)} placeholder={t('node.expLog')} />
        </Field>
      </div>

      {error && <div style={{ color: T.danger, fontSize: 11.5, marginBottom: 8 }}>{error}</div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {editing && (
          <>
            <Btn tone="danger" disabled={saving} onClick={() => (delArm ? void removeNode() : setDelArm(true))}>
              {delArm ? t('node.deleteSure') : t('common.delete')}
            </Btn>
            {delArm && <span style={{ fontSize: 10, color: T.danger, flex: 1 }}>{t('pset.deleteConfirm')}</span>}
          </>
        )}
        <span style={{ flex: 1 }} />
        <Btn onClick={requestClose}>{t('common.cancel')}</Btn>
        <Btn tone="primary" disabled={!title.trim() || saving} onClick={() => void save()}>{t('common.save')}</Btn>
      </div>
      </fieldset>
    </Modal>
  );
}

/* ---------- project settings modal(改名/研究问题/绑定管理/删除)---------- */

const normWs = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

export function ProjectSettingsModal({ t, file, wsKey, onClose, onChanged }: {
  t: TFunc;
  file: TrajProjectFile;
  /** 当前会话工作区 cwd(用于「绑定到当前工作区」) */
  wsKey: string;
  onClose: () => void;
  /** 任何变更后回调(父层刷新数据) */
  onChanged: () => void;
}) {
  const p = file.project;
  const [name, setName] = useState(p.name);
  const [researchQuestion, setResearchQuestion] = useState(p.researchQuestion ?? '');
  const [description, setDescription] = useState(p.description ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(0); // 0 未进入确认 → 1 待确认 → 2 可点

  React.useEffect(() => {
    if (confirmDelete === 1) {
      const timer = setTimeout(() => setConfirmDelete(2), 350);
      return () => clearTimeout(timer);
    }
  }, [confirmDelete]);

  const run = async (fn: () => Promise<void>, okMsg?: string) => {
    setSaving(true);
    setError('');
    try {
      await fn();
      if (okMsg) { setMessage(okMsg); setTimeout(() => setMessage(''), 2200); }
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const saveMeta = () => run(async () => {
    await api(`/traj/projects/${encodeURIComponent(p.id)}`, {
      method: 'PUT',
      body: JSON.stringify({ name, researchQuestion, description }),
    });
  }, t('settings.saved'));

  const unbind = () => run(async () => {
    await api(`/traj/projects/${encodeURIComponent(p.id)}`, {
      method: 'PUT',
      body: JSON.stringify({ unbindWs: true }),
    });
  }, t('pset.unbound'));

  const bindCurrent = () => run(async () => {
    await api(`/traj/projects/${encodeURIComponent(p.id)}`, {
      method: 'PUT',
      body: JSON.stringify({ bindWs: wsKey }),
    });
  }, t('pset.boundCurrent'));

  const remove = () => run(async () => {
    await api(`/traj/projects/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
    onClose();
  });

  const boundElsewhere = p.workspaceKey && (!wsKey || normWs(p.workspaceKey) !== normWs(wsKey));

  return (
    <Modal title={t('pset.title')} onClose={onClose} width={420}>
      <Field label={t('project.name')}>
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label={t('digest.question')}>
        <Textarea rows={2} value={researchQuestion} onChange={(e) => setResearchQuestion(e.target.value)} />
      </Field>
      <Field label={t('project.desc')}>
        <Input value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
        <Btn tone="primary" disabled={saving || !name.trim()} onClick={() => void saveMeta()}>{t('common.save')}</Btn>
      </div>

      {/* 绑定管理 */}
      <div style={{ borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: 10, marginTop: 4 }}>
        <span style={labelStyle}>{t('pset.binding')}</span>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px', borderRadius: 8,
          background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))',
          border: '1px solid var(--dsw-alias-border-l2)', marginBottom: 8, flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: 10.5, color: p.workspaceKey ? T.business : T.caption }}>
            {p.workspaceKey ? `${t('pset.currentBinding')}: ${p.workspaceKey}` : t('pset.none')}
          </span>
          <span style={{ flex: 1 }} />
          {p.workspaceKey && <Btn disabled={saving} onClick={() => void unbind()}>{t('pset.unbind')}</Btn>}
          {wsKey && boundElsewhere && <Btn tone="soft" disabled={saving} onClick={() => void bindCurrent()}>{t('pset.bindCurrent')}</Btn>}
        </div>
        <div style={{ fontSize: 10, color: T.caption, lineHeight: 1.5, marginBottom: 10 }}>{t('pset.bindingHint')}</div>
      </div>

      {/* 危险区:删除项目 */}
      <div style={{
        borderTop: '1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5484d) 30%, transparent)',
        paddingTop: 10,
      }}>
        <span style={{ ...labelStyle, color: T.danger }}>{t('pset.delete')}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 10, color: T.caption, flex: 1, lineHeight: 1.5 }}>{t('pset.deleteHint')}</span>
          <Btn
            tone="danger"
            disabled={saving || (confirmDelete === 2 ? false : confirmDelete === 0 ? false : true)}
            onClick={() => {
              if (confirmDelete === 0) { setConfirmDelete(1); }
              else if (confirmDelete === 2) { void remove(); }
            }}
          >
            {confirmDelete === 2 ? t('pset.deleteSure') : t('pset.delete')}
          </Btn>
        </div>
        {confirmDelete === 1 && (
          <div style={{ fontSize: 10, color: T.danger, marginTop: 4 }}>{t('pset.deleteConfirm')}</div>
        )}
      </div>

      {message && <div style={{ color: T.success, fontSize: 11.5, marginTop: 8 }}>✓ {message}</div>}
      {error && <div style={{ color: T.danger, fontSize: 11.5, marginTop: 8 }}>{error}</div>}
    </Modal>
  );
}

export function ProjectModal({ t, ws, onClose, onCreated }: {
  t: TFunc;
  /** 工作区 cwd:提供时创建即绑定该工作区 */
  ws?: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const create = async () => {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      await api('/traj/projects', {
        method: 'POST',
        body: JSON.stringify({ name, description, ...(ws ? { ws } : {}) }),
      });
      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={t('project.new')} onClose={onClose} width={380}>
      <Field label={t('project.name')}>
        <Input value={name} placeholder={t('project.namePh')} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
      <Field label={t('project.desc')}>
        <Input value={description} placeholder={t('project.descPh')} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      {error && <div style={{ color: T.danger, fontSize: 11.5, marginBottom: 8 }}>{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Btn onClick={onClose}>{t('common.cancel')}</Btn>
        <Btn tone="primary" disabled={!name.trim() || saving} onClick={() => void create()}>{t('project.create')}</Btn>
      </div>
    </Modal>
  );
}
