import React, { useCallback, useEffect, useState } from 'react';
import type { ScholarConfig, ScholarStats } from '../shared/types';
import { api } from './api';
import type { TFunc } from './nav';
import { Btn, Field, Icon, Icons, Input, SchStyles, T } from './ui';

export function ScholarSettings({ t }: { t: TFunc }) {
  const [config, setConfig] = useState<ScholarConfig>({ paperDir: '' });
  const [stats, setStats] = useState<ScholarStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [c, s] = await Promise.all([
        api<{ config: ScholarConfig }>('/scholar/config'),
        api<ScholarStats>('/scholar/stats'),
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
      await api('/scholar/config', {
        method: 'PUT',
        body: JSON.stringify({
          paperDir: config.paperDir,
          defaultTags: (config.defaultTags ?? []).filter((x) => x.trim()),
          fetchProxy: config.fetchProxy ?? '',
          openalexEmail: config.openalexEmail ?? '',
        }),
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
      <SchStyles />
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
          <Field label={t('settings.paperDir')} hint={t('settings.paperDirHint')}>
            <Input value={config.paperDir} onChange={(e) => setConfig({ ...config, paperDir: e.target.value })} />
          </Field>

          <Field label={t('settings.defaultTags')} hint={t('settings.defaultTagsHint')}>
            <Input
              value={(config.defaultTags ?? []).join(', ')}
              onChange={(e) => setConfig({
                ...config,
                defaultTags: e.target.value.split(/[,，]/).map((x) => x.trim()).filter(Boolean),
              })}
            />
          </Field>

          <Field label={t('settings.fetchProxy')} hint={t('settings.fetchProxyHint')}>
            <Input
              value={config.fetchProxy ?? ''}
              placeholder="http://127.0.0.1:7890"
              onChange={(e) => setConfig({ ...config, fetchProxy: e.target.value })}
            />
          </Field>

          <Field label={t('settings.openalexEmail')} hint={t('settings.openalexEmailHint')}>
            <Input
              value={config.openalexEmail ?? ''}
              placeholder="you@example.com"
              onChange={(e) => setConfig({ ...config, openalexEmail: e.target.value })}
            />
          </Field>

          {stats && (
            <div style={{
              marginTop: 14, display: 'flex', alignItems: 'center', gap: 8,
              border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10,
              background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))',
              padding: '9px 12px', flexWrap: 'wrap',
            }}>
              <Icon d={Icons.book} size={13} color={T.business} />
              <span style={{ fontSize: 11, color: T.secondary }}>
                {t('settings.statsLine', {
                  papers: stats.papers,
                  cards: stats.cards,
                  nodes: stats.nodes,
                  edges: stats.edges,
                })}
              </span>
              <span style={{
                flex: 1, minWidth: 60, textAlign: 'right',
                fontSize: 10, color: T.caption, overflow: 'hidden',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }} title={stats.dir}>
                {stats.dir}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
