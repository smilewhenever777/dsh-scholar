import React, { useEffect, useState } from 'react';
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

export function NodeEditorModal({ t, file, editing, onClose, onSaved }: {
  t: TFunc;
  file: TrajProjectFile;
  editing: TrajNode | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(editing?.title ?? '');
  const [kind, setKind] = useState<TrajNodeKind>(editing?.kind ?? 'other');
  const [status, setStatus] = useState<TrajStatus>(editing?.status ?? 'todo');
  const [detail, setDetail] = useState(editing?.detail ?? '');
  const [tags, setTags] = useState((editing?.tags ?? []).join(', '));
  const [mainline, setMainline] = useState(!!editing && file.project.mainline.includes(editing.id));
  const [parents, setParents] = useState<string[]>([]);
  const [cardId, setCardId] = useState(editing?.refs?.cardId ?? '');
  const [cardLabel, setCardLabel] = useState(editing?.refs?.cardLabel ?? '');
  const [paperId, setPaperId] = useState(editing?.refs?.paperId ?? '');
  const [paperLabel, setPaperLabel] = useState(editing?.refs?.paperLabel ?? '');
  const [hostId, setHostId] = useState(editing?.refs?.hostId ?? '');
  const [logPath, setLogPath] = useState(editing?.refs?.logPath ?? '');
  const [cmdPattern, setCmdPattern] = useState(editing?.refs?.cmdPattern ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [delArm, setDelArm] = useState(false);

  const removeNode = async () => {
    if (!editing) return;
    setSaving(true);
    setError('');
    try {
      await api(`/traj/nodes/${encodeURIComponent(editing.id)}`, { method: 'DELETE' });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    // reset when switching between create/edit without unmount
    setTitle(editing?.title ?? '');
    setKind(editing?.kind ?? 'other');
    setStatus(editing?.status ?? 'todo');
    setDetail(editing?.detail ?? '');
    setTags((editing?.tags ?? []).join(', '));
    setMainline(!!editing && file.project.mainline.includes(editing.id));
    setParents([]);
    setCardId(editing?.refs?.cardId ?? '');
    setCardLabel(editing?.refs?.cardLabel ?? '');
    setPaperId(editing?.refs?.paperId ?? '');
    setPaperLabel(editing?.refs?.paperLabel ?? '');
    setHostId(editing?.refs?.hostId ?? '');
    setLogPath(editing?.refs?.logPath ?? '');
    setCmdPattern(editing?.refs?.cmdPattern ?? '');
  }, [editing, file]);

  const save = async () => {
    if (saving) return;
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
            refs: refBody,
          }),
        });
        const wasMainline = file.project.mainline.includes(editing.id);
        if (mainline !== wasMainline) {
          const next = mainline
            ? [...file.project.mainline, editing.id]
            : file.project.mainline.filter((x) => x !== editing.id);
          await api(`/traj/projects/${encodeURIComponent(file.project.id)}`, {
            method: 'PUT',
            body: JSON.stringify({ mainline: next }),
          });
        }
      } else {
        await api('/traj/nodes', {
          method: 'POST',
          body: JSON.stringify({
            projectId: file.project.id,
            kind, title, status,
            detail,
            tags: tags.split(/[,，]/).map((x) => x.trim()).filter(Boolean),
            parentIds: parents,
            mainline,
            ...refBody,
          }),
        });
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={editing ? t('node.edit') : t('node.new')} onClose={onClose} width={460}>
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
        <Btn onClick={onClose}>{t('common.cancel')}</Btn>
        <Btn tone="primary" disabled={!title.trim() || saving} onClick={() => void save()}>{t('common.save')}</Btn>
      </div>
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
