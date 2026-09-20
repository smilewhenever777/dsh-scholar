import React, { useCallback, useEffect, useState } from 'react';
import type { TrajConfig, TrajStats } from '../shared/types';
import { api } from './api';
import type { TFunc } from './nav';
import { Btn, Field, Icon, Icons, Input, TrajStyles, T } from './ui';

export function TrajSettings({ t }: { t: TFunc }) {
  const [config, setConfig] = useState<TrajConfig>({ dataDir: '' });
  const [stats, setStats] = useState<TrajStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [c, s] = await Promise.all([
        api<{ config: TrajConfig }>('/traj/config'),
        api<TrajStats>('/traj/stats'),
      ]);
      setConfig(c.config);
      setStats(s);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    try {
      setSaving(true);
      await api('/traj/config', {
        method: 'PUT',
        body: JSON.stringify({ dataDir: config.dataDir }),
      });
      setMessage(t('settings.saved'));
      setError('');
      setTimeout(() => setMessage(''), 2500);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ padding: '14px 18px', fontSize: 12, maxWidth: 560 }}>
      <TrajStyles />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontWeight: 700, fontSize: 13.5 }}>{t('settings.title')}</span>
        <span style={{ flex: 1 }} />
        {message && <span style={{ color: T.success, fontSize: 11.5 }}>✓ {message}</span>}
        <Btn tone="primary" onClick={() => void save()} disabled={saving || loading}>
          {t('settings.save')}
        </Btn>
      </div>

      {loading && <div style={{ color: T.caption }}>{t('common.loading')}</div>}
      {error && <div style={{ color: T.danger, marginBottom: 8 }}>{error}</div>}

      {!loading && (
        <>
          <Field label={t('settings.dataDir')} hint={t('settings.dataDirHint')}>
            <Input value={config.dataDir} onChange={(e) => setConfig({ ...config, dataDir: e.target.value })} />
          </Field>

          {stats && (
            <div style={{
              marginTop: 14, display: 'flex', alignItems: 'center', gap: 8,
              border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10,
              background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))',
              padding: '9px 12px', flexWrap: 'wrap',
            }}>
              <Icon d={Icons.traj} size={13} color={T.business} />
              <span style={{ fontSize: 11, color: T.secondary }}>
                {t('settings.statsLine', {
                  projects: stats.projects,
                  nodes: stats.nodes,
                  edges: stats.edges,
                  inProgress: stats.counts.in_progress,
                  blocked: stats.counts.blocked,
                })}
              </span>
              <span style={{
                flex: 1, minWidth: 60, textAlign: 'right',
                fontSize: 10, color: T.caption, overflow: 'hidden',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }} title={stats.dir}>
                {stats.activeProjectName ? `★ ${stats.activeProjectName} · ${stats.dir}` : stats.dir}
              </span>
            </div>
          )}

          <div style={{ marginTop: 10, fontSize: 10.5, color: T.caption, lineHeight: 1.6 }}>
            {t('settings.promptHint')}
          </div>
        </>
      )}
    </div>
  );
}
