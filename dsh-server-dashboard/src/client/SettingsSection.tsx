import React, { useCallback, useEffect, useState } from 'react';

interface HostRow {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authKind: 'password' | 'key' | 'none';
  credentialRef: string;
  identityFile: string;
  logPath: string;
  pinned: boolean;
  archived?: boolean;
}

interface ConfigResponse {
  config: {
    hosts: HostRow[];
    refreshIntervalS: number;
    staleMinutes: number;
    alertIdleMin: number;
  };
}

/** PUT /dash/config 的响应:后端会回 {ok, config};旧版只回 {ok:true}(无 config 字段) */
interface PutConfigResponse {
  ok?: boolean;
  config?: ConfigResponse['config'];
}

type T = (key: string, params?: Record<string, unknown>) => string;

const input: React.CSSProperties = {
  display: 'block', width: '100%', boxSizing: 'border-box', marginTop: 4, marginBottom: 8,
  padding: '4px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-2, transparent)', color: 'var(--dsw-alias-label-primary)', fontSize: 12,
};
const btn: React.CSSProperties = {
  border: '1px solid var(--dsw-alias-border-l2)', background: 'none', borderRadius: 6,
  padding: '3px 10px', cursor: 'pointer', fontSize: 12, color: 'var(--dsw-alias-label-primary)',
};
const label: React.CSSProperties = { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', display: 'block' };

function emptyHost(): HostRow {
  return {
    id: `h${Date.now().toString(36)}`,
    name: '', host: '', port: 22, username: '',
    authKind: 'key', credentialRef: '', identityFile: '', logPath: '', pinned: false,
  };
}

async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

export function ServerDashboardSettings({ t }: { t: T }) {
  const [hosts, setHosts] = useState<HostRow[]>([]);
  const [refreshIntervalS, setRefreshIntervalS] = useState(30);
  const [staleMinutes, setStaleMinutes] = useState(10);
  const [alertIdleMin, setAlertIdleMin] = useState(5);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<HostRow | null>(null);
  const [secrets, setSecrets] = useState<Record<string, { password?: string; privateKey?: string }>>({});
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  /** 正在测试连接的主机 id(每次真实 SSH 握手,期间按钮置灰防连点) */
  const [testing, setTesting] = useState('');
  const [importing, setImporting] = useState(false);
  const [filter, setFilter] = useState('');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api<ConfigResponse>('/dash/config');
      setHosts(res.config.hosts ?? []);
      setRefreshIntervalS(res.config.refreshIntervalS ?? 30);
      setStaleMinutes(res.config.staleMinutes ?? 10);
      setAlertIdleMin(res.config.alertIdleMin ?? 5);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /** PUT 成功且后端返回了新 config 时以后端为权威回显(并发 PUT 相互覆盖后
   *  界面不停留在旧值);旧版后端只回 {ok:true},此时沿用本地乐观状态 */
  const syncConfig = (body: PutConfigResponse) => {
    if (!body?.config) return;
    setHosts(body.config.hosts ?? []);
    if (typeof body.config.refreshIntervalS === 'number') setRefreshIntervalS(body.config.refreshIntervalS);
    if (typeof body.config.staleMinutes === 'number') setStaleMinutes(body.config.staleMinutes);
    if (typeof body.config.alertIdleMin === 'number') setAlertIdleMin(body.config.alertIdleMin);
  };

  const saveIntervals = async () => {
    try {
      const res = await api<PutConfigResponse>('/dash/config', {
        method: 'PUT',
        body: JSON.stringify({ hosts, refreshIntervalS, staleMinutes, alertIdleMin }),
      });
      syncConfig(res);
      setError('');
      setNotice(t('settings.saved'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /** 连接测试(一次真实 SSH 握手):per-host testing 态 + 期间禁用按钮 */
  const runTest = async (row: HostRow, secret?: { password?: string; privateKey?: string }) => {
    setTesting(row.id);
    try {
      const res = await api<{ ok: boolean; detail: string }>('/dash/test', {
        method: 'POST',
        body: JSON.stringify({
          host: row.host, port: row.port, username: row.username,
          authKind: row.authKind, credentialRef: row.credentialRef,
          identityFile: row.identityFile,
          password: secret?.password, privateKey: secret?.privateKey,
        }),
      });
      setTestResult((m) => ({ ...m, [row.id]: (res.ok ? '✅ ' : '❌ ') + res.detail }));
    } catch (e) {
      setTestResult((m) => ({ ...m, [row.id]: '❌ ' + (e instanceof Error ? e.message : String(e)) }));
    } finally {
      setTesting('');
    }
  };

  const save = async (row: HostRow) => {
    const next = hosts.some((h) => h.id === row.id)
      ? hosts.map((h) => (h.id === row.id ? row : h))
      : [...hosts, row];
    const savedSecret = secrets[row.id];
    try {
      // always send the interval thresholds too — the host keeps them when
      // omitted, but sending them makes the PUT idempotent against races.
      // secrets 只发当前行:其他行的一次性密钥草稿尚未保存,整张 map 随发
      // 会给从未落盘的行误建孤儿凭据
      const put = await api<PutConfigResponse>('/dash/config', {
        method: 'PUT',
        body: JSON.stringify({
          hosts: next,
          refreshIntervalS,
          staleMinutes,
          alertIdleMin,
          secrets: savedSecret ? { [row.id]: savedSecret } : undefined,
        }),
      });
      if (put.config) syncConfig(put);
      else setHosts(next);
      setEditing(null);
      setSecrets((s) => {
        const copy = { ...s };
        delete copy[row.id];
        return copy;
      });
      // auto-test right after saving, with the one-off secret still in hand
      // (an existing credentialRef falls back to the vault server-side)
      await runTest(row, savedSecret);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (id: string) => {
    const row = hosts.find((h) => h.id === id);
    if (row && !window.confirm(t('settings.confirmDelete', { name: row.name || row.host }))) return;
    const next = hosts.filter((h) => h.id !== id);
    try {
      const res = await api<PutConfigResponse>('/dash/config', { method: 'PUT', body: JSON.stringify({ hosts: next, refreshIntervalS, staleMinutes, alertIdleMin }) });
      if (res.config) syncConfig(res);
      else setHosts(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  interface LogCandidate { pid: number; user: string; cmd: string; logPath: string; size: number; mtimeMs: number; source: string }
  const [discovering, setDiscovering] = useState<string>('');
  const [discovered, setDiscovered] = useState<Record<string, LogCandidate[]>>({});
  const discoverLogs = async (row: HostRow) => {
    try {
      setDiscovering(row.id);
      const res = await api<{ candidates: LogCandidate[] }>('/dash/discover-logs', {
        method: 'POST',
        body: JSON.stringify({
          host: row.host, port: row.port, username: row.username,
          authKind: row.authKind, credentialRef: row.credentialRef,
          password: secrets[row.id]?.password, privateKey: secrets[row.id]?.privateKey,
        }),
      });
      setDiscovered((m) => ({ ...m, [row.id]: res.candidates ?? [] }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDiscovering('');
    }
  };

  const applyLog = async (row: HostRow, logPath: string) => {
    const next = hosts.map((h) => (h.id === row.id ? { ...h, logPath } : h));
    try {
      const res = await api<PutConfigResponse>('/dash/config', { method: 'PUT', body: JSON.stringify({ hosts: next, refreshIntervalS, staleMinutes, alertIdleMin }) });
      if (res.config) syncConfig(res);
      else setHosts(next);
      setDiscovered((m) => ({ ...m, [row.id]: [] }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const importSsh = async () => {
    try {
      setImporting(true);
      const res = await api<{ hosts: { alias: string; host: string; port: number; username: string; identityFile?: string }[] }>('/dash/import-ssh');
      const existing = new Set(hosts.map((h) => `${h.host}:${h.port}`));
      const usedIds = new Set(hosts.map((h) => h.id));
      const source = res.hosts.filter((h) => {
        if (!h.host) return false;
        const key = `${h.host}:${h.port}`;
        if (existing.has(key)) return false;
        existing.add(key); // dedupe WITHIN the import batch too (aliases sharing a target)
        return true;
      });
      const added = source.map((h) => {
        const base = `imp_${h.alias.replace(/[^A-Za-z0-9]/g, '_')}`;
        // same alias, different host → suffix the id so it stays unique
        let id = base;
        for (let n = 2; usedIds.has(id); n++) id = `${base}_${n}`;
        usedIds.add(id);
        return {
          ...emptyHost(),
          id,
          name: h.alias,
          host: h.host,
          port: h.port,
          username: h.username,
          authKind: h.identityFile ? ('key' as const) : ('none' as const),
          identityFile: h.identityFile ?? '',
          logPath: '',
        };
      });
      const next = [...hosts, ...added];
      const put = await api<PutConfigResponse>('/dash/config', { method: 'PUT', body: JSON.stringify({ hosts: next, refreshIntervalS, staleMinutes, alertIdleMin }) });
      if (put.config) syncConfig(put);
      else setHosts(next);
      setNotice(added.length > 0
        ? t('settings.imported', { added: added.length, skipped: res.hosts.length - added.length })
        : t('settings.importNone'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  const test = (row: HostRow) => void runTest(row, secrets[row.id]);

  const shown = filter.trim()
    ? hosts.filter((h) => `${h.name} ${h.host} ${h.username}`.toLowerCase().includes(filter.trim().toLowerCase()))
    : hosts;

  return (
    <div style={{ padding: '12px 16px', fontSize: 12, maxWidth: 560 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{t('settings.nav')}</span>
        <span style={{ flex: 1 }} />
        <input
          style={{ ...input, width: 120, margin: 0 }}
          placeholder={t('settings.searchHosts')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button type="button" style={btn} onClick={importSsh} disabled={importing}>
          {importing ? '…' : t('settings.importSsh')}
        </button>
        <button type="button" style={btn} onClick={() => setEditing(emptyHost())}>{t('settings.addHost')}</button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, padding: '8px 10px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8 }}>
        <label style={{ ...label, margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
          {t('settings.refreshIntervalShort')}
          <input
            type="number" min={10} max={300} step={5}
            style={{ ...input, width: 64, margin: 0 }}
            value={refreshIntervalS}
            onChange={(e) => setRefreshIntervalS(Number(e.target.value) || 30)}
            onBlur={(e) => setRefreshIntervalS(Math.max(10, Math.min(300, Number(e.target.value) || 30)))}
          />
          {t('settings.seconds')}
        </label>
        <label style={{ ...label, margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
          {t('settings.staleShort')}
          <input
            type="number" min={1} max={1440} step={1}
            style={{ ...input, width: 56, margin: 0 }}
            value={staleMinutes}
            onChange={(e) => setStaleMinutes(Number(e.target.value) || 10)}
            onBlur={(e) => setStaleMinutes(Math.max(1, Math.min(1440, Number(e.target.value) || 10)))}
          />
          {t('settings.staleSuffix')}
        </label>
        <label style={{ ...label, margin: 0, display: 'flex', alignItems: 'center', gap: 6 }} title={t('settings.alertIdleHint')}>
          {t('settings.alertIdleShort')}
          <input
            type="number" min={1} max={120} step={1}
            style={{ ...input, width: 48, margin: 0 }}
            value={alertIdleMin}
            onChange={(e) => setAlertIdleMin(Number(e.target.value) || 5)}
            onBlur={(e) => setAlertIdleMin(Math.max(1, Math.min(120, Number(e.target.value) || 5)))}
          />
          {t('settings.alertIdleSuffix')}
        </label>
        <span style={{ flex: 1 }} />
        <button type="button" style={btn} onClick={() => void saveIntervals()}>{t('settings.save')}</button>
      </div>
      {error && <div style={{ color: 'var(--dsw-alias-state-danger, #e5484d)', marginBottom: 8 }}>{error}</div>}
      {!error && notice && <div style={{ color: 'var(--dsw-alias-state-success-primary, #30a46c)', marginBottom: 8 }}>{notice}</div>}
      {loading && <div style={{ color: 'var(--dsw-alias-label-caption)' }}>{t('settings.loading')}</div>}
      {!loading && hosts.length === 0 && (
        <div style={{ color: 'var(--dsw-alias-label-caption)' }}>
          {t('settings.empty')}
        </div>
      )}
      {filter.trim() && hosts.length > 0 && shown.length === 0 && (
        <div style={{ color: 'var(--dsw-alias-label-caption)' }}>{t('settings.noMatch')}</div>
      )}
      {shown.map((row) => (
        <div key={row.id} style={{ border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: 10, marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.name || row.host}>{row.name || row.host}</span>
            {row.pinned && <span style={{ fontSize: 10, color: 'var(--dsw-alias-state-business-primary, #4d6bfe)' }}>{t('settings.pinnedTag')}</span>}
            {row.archived && <span style={{ fontSize: 10, color: 'var(--dsw-alias-label-caption)' }}>{t('host.archivedTag')}</span>}
            <span style={{ flex: 1 }} />
            <button type="button" style={btn} onClick={() => test(row)} disabled={testing === row.id}>
              {testing === row.id ? t('settings.testing') : t('settings.testShort')}
            </button>
            <button type="button" style={btn} onClick={() => void discoverLogs(row)} disabled={discovering === row.id}>
              {discovering === row.id ? t('settings.discovering') : `🔍 ${t('settings.discover')}`}
            </button>
            <button type="button" style={btn} onClick={() => setEditing({ ...row })}>{t('settings.edit')}</button>
            <button type="button" style={btn} onClick={() => void remove(row.id)}>{t('settings.remove')}</button>
          </div>
          <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-caption)', marginTop: 2 }}>
            {row.username}@{row.host}:{row.port}
            {row.authKind !== 'none' && ` · ${t('settings.cred')} ${row.credentialRef || t('settings.credUnnamed')}`}
            {row.authKind === 'key' && !row.credentialRef && row.identityFile && ` · ${t('settings.identityFile')} ${row.identityFile}`}
            {row.logPath && ` · ${t('settings.logPathLabel')} ${row.logPath}`}
          </div>
          {discovered[row.id]?.length === 0 && discovering !== row.id && (
            <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-caption)', marginTop: 4 }}>
              {t('settings.discoverEmpty')}
            </div>
          )}
          {(discovered[row.id] ?? []).map((c) => (
            <div key={`${c.source}-${c.pid}-${c.logPath}`} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, marginTop: 4 }}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`pid ${c.pid} (${c.user}) ${c.cmd}`}>
                {c.logPath}
                <span style={{ color: 'var(--dsw-alias-label-caption)' }}>
                  {' '}· {c.source} · pid {c.pid} ({c.user})
                  {c.size < 0 ? ` · ⚠️ ${t('settings.noPerm')}` : ` · ${(c.size / 1024).toFixed(0)}KB · ${new Date(c.mtimeMs).toLocaleTimeString()}`}
                </span>
              </span>
              <button type="button" style={btn} disabled={c.size < 0} onClick={() => void applyLog(row, c.logPath)}>{t('settings.useIt')}</button>
            </div>
          ))}
          {testResult[row.id] && <div style={{ fontSize: 11, marginTop: 4 }}>{testResult[row.id]}</div>}
        </div>
      ))}
      {editing && (
        <div style={{ border: '1px solid var(--dsw-alias-state-business-primary, #4d6bfe)', borderRadius: 8, padding: 12, marginTop: 4 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>{hosts.some((h) => h.id === editing.id) ? t('settings.editHost') : t('settings.addHostForm')}</div>
          <label style={label}>{t('f.name')}</label>
          <input style={input} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          <label style={label}>{t('f.host')}</label>
          <input style={input} value={editing.host} onChange={(e) => setEditing({ ...editing, host: e.target.value })} />
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <label style={label}>{t('f.port')}</label>
              <input
                style={input}
                type="number"
                value={editing.port}
                onChange={(e) => setEditing({ ...editing, port: Number(e.target.value) || 22 })}
                onBlur={(e) => setEditing({ ...editing, port: Math.max(1, Math.min(65535, Math.round(Number(e.target.value) || 22))) })}
              />
            </div>
            <div style={{ flex: 2 }}>
              <label style={label}>{t('f.user')}</label>
              <input style={input} value={editing.username} onChange={(e) => setEditing({ ...editing, username: e.target.value })} />
            </div>
          </div>
          <label style={label}>{t('f.auth')}</label>
          <select
            style={input}
            value={editing.authKind}
            onChange={(e) => {
              const kind = e.target.value as HostRow['authKind'];
              // switching kind invalidates the drafted secret of the OTHER kind —
              // without a matching draft the entry is DELETED (returning s2
              // unchanged would leave e.g. a privateKey live under 'password',
              // and the server persists privateKey for either kind)
              const draft = secrets[editing.id];
              const keep = kind === 'key' ? draft?.privateKey : kind === 'password' ? draft?.password : undefined;
              setSecrets((s2) => {
                const copy = { ...s2 };
                if (keep) copy[editing.id] = kind === 'key' ? { privateKey: keep } : { password: keep };
                else delete copy[editing.id];
                return copy;
              });
              setEditing({ ...editing, authKind: kind });
            }}
          >
            <option value="key">{t('f.authKey')}</option>
            <option value="password">{t('f.authPassword')}</option>
            <option value="none">{t('f.authNone')}</option>
          </select>
          <label style={label}>{t('f.credRef')}</label>
          <input
            style={input}
            value={editing.credentialRef}
            placeholder="SD_<ID>_KEY"
            onChange={(e) => setEditing({ ...editing, credentialRef: e.target.value })}
          />
          {editing.authKind !== 'none' && (
            <>
              <label style={label}>{t('f.secret')}</label>
              <textarea
                style={{ ...input, minHeight: 56, fontFamily: 'var(--dsw-font-mono, monospace)' }}
                value={secrets[editing.id]?.privateKey ?? secrets[editing.id]?.password ?? ''}
                onChange={(e) => {
                  const value = e.target.value;
                  setSecrets((s) => ({
                    ...s,
                    [editing.id]: editing.authKind === 'key' ? { privateKey: value } : { password: value },
                  }));
                }}
              />
            </>
          )}
          <label style={label}>{t('f.logPath')}</label>
          <input style={input} value={editing.logPath} onChange={(e) => setEditing({ ...editing, logPath: e.target.value })} />
          <label style={{ ...label, display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={editing.pinned} onChange={(e) => setEditing({ ...editing, pinned: e.target.checked })} />
            {t('settings.pin')}
          </label>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" style={btn} onClick={() => void save(editing)} disabled={!editing.name || !editing.host}>{t('settings.save')}</button>
            <button type="button" style={btn} onClick={() => setEditing(null)}>{t('settings.cancel')}</button>
          </div>
        </div>
      )}
    </div>
  );
}
