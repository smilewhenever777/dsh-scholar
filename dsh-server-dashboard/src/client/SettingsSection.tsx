import React, { useCallback, useEffect, useRef, useState } from 'react';

interface HostRow {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authKind: 'password' | 'key' | 'none';
  credentialRef: string;
  identityFile: string;
  hostKeyFingerprint?: string;
  logPath: string;
  pinned: boolean;
  archived?: boolean;
}

interface ConfigResponse {
  revision: string;
  config: {
    hosts: HostRow[];
    refreshIntervalS: number;
    staleMinutes: number;
    alertIdleMin: number;
  };
}

/** PUT /dash/config 的响应:后端会回 {ok, config};旧版只回 {ok:true}(无 config 字段) */
interface PutConfigResponse {
  revision?: string;
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
  const revision = useRef('');
  const writing = useRef(false);
  const liveHosts = useRef<HostRow[]>([]);
  const testPending = useRef(new Map<string, symbol>());
  const discoverPending = useRef(new Map<string, symbol>());
  const signature = (h: HostRow) => JSON.stringify([h.host, h.port, h.username, h.authKind, h.identityFile, h.hostKeyFingerprint]);
  const currentHost = (row: HostRow) => liveHosts.current.some(h => h.id === row.id && signature(h) === signature(row));
  const [hosts, setHosts] = useState<HostRow[]>([]);
  liveHosts.current = hosts;
  const [refreshIntervalS, setRefreshIntervalS] = useState(30);
  const [staleMinutes, setStaleMinutes] = useState(10);
  const [alertIdleMin, setAlertIdleMin] = useState(5);
  const [loading, setLoading] = useState(true);
  /** E04:加载成功才算 ready——失败/未完成时不把 [] 当可提交配置(保存会清空后端) */
  const [configReady, setConfigReady] = useState(false);
  /** E11:本页共享写锁——主机保存与阈值保存互斥,后完成者不再携带旧快照覆盖前者 */
  const [mutationBusy, setMutationBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<HostRow | null>(null);
  const editingBase = useRef<HostRow | null>(null);
  const editingNew = useRef(false);
  const beginEdit = (row: HostRow, isNew = false) => { editingNew.current = isNew; editingBase.current = { ...row }; setEditing({ ...row }); };
  const [secrets, setSecrets] = useState<Record<string, { password?: string; privateKey?: string }>>({});
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  /** 正在测试连接的主机 id 集合(E08:并行多台时各自独立防重,一个完成不解锁另一个) */
  const [testing, setTesting] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [filter, setFilter] = useState('');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setConfigReady(false);
      const res = await api<ConfigResponse>('/dash/config');
      if (!Array.isArray(res.config?.hosts) || !res.revision) throw new Error(t('settings.reloadRequired'));
      revision.current = res.revision;
      setConfigReady(true);
      liveHosts.current = res.config.hosts;
      setHosts(res.config.hosts);
      setRefreshIntervalS(res.config.refreshIntervalS ?? 30);
      setStaleMinutes(res.config.staleMinutes ?? 10);
      setAlertIdleMin(res.config.alertIdleMin ?? 5);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setConfigReady(false); // E04:未知基线禁止提交
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /** PUT 成功且后端返回了新 config 时以后端为权威回显(并发 PUT 相互覆盖后
   *  界面不停留在旧值);旧版后端只回 {ok:true},此时沿用本地乐观状态 */
  const syncConfig = (body: PutConfigResponse, fields?: string[]) => {
    if (!body?.config || !body.revision) return;
    revision.current = body.revision;
    liveHosts.current = body.config.hosts ?? [];
    setHosts(liveHosts.current);
    if ((!fields || fields.includes('refreshIntervalS')) && typeof body.config.refreshIntervalS === 'number') setRefreshIntervalS(body.config.refreshIntervalS);
    if ((!fields || fields.includes('staleMinutes')) && typeof body.config.staleMinutes === 'number') setStaleMinutes(body.config.staleMinutes);
    setConfigReady(true);
    if ((!fields || fields.includes('alertIdleMin')) && typeof body.config.alertIdleMin === 'number') setAlertIdleMin(body.config.alertIdleMin);
  };

  const mutate = async (patch: Record<string, unknown>): Promise<PutConfigResponse> => {
    const res = await api<PutConfigResponse>('/dash/config', { method: 'PATCH', body: JSON.stringify({ ...patch, revision: revision.current }) });
    syncConfig(res, Object.keys(patch));
    setError('');
    return res;
  };
  const beginWrite = () => {
    if (!configReady || writing.current || loading) return false;
    writing.current = true;
    setMutationBusy(true);
    return true;
  };
  const endWrite = () => { writing.current = false; setMutationBusy(false); };
  const writeError = (e: unknown) => {
    setError(e instanceof Error ? e.message : String(e));
    // Keep the draft; an explicit reload is required after conflict/partial failure.
  };
  const saveIntervals = async () => {
    if (!beginWrite()) return;
    try {
      await mutate({ refreshIntervalS, staleMinutes, alertIdleMin });
      setNotice(t('settings.saved'));
    } catch (e) { writeError(e); } finally { endWrite(); }
  };

  /** 连接测试(一次真实 SSH 握手):per-host testing 态 + 期间禁用按钮 */
  const runTest = async (row: HostRow, secret?: { password?: string; privateKey?: string }) => {
    if (testPending.current.has(row.id)) return;
    const token = Symbol(); testPending.current.set(row.id, token);
    setTesting((cur) => new Set(cur).add(row.id)); // E08:按主机加锁
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
      if (currentHost(row) && testPending.current.get(row.id) === token) setTestResult((m) => ({ ...m, [row.id]: (res.ok ? '✅ ' : '❌ ') + res.detail }));
    } catch (e) {
      setTestResult((m) => ({ ...m, [row.id]: '❌ ' + (e instanceof Error ? e.message : String(e)) }));
    } finally {
      testPending.current.delete(row.id);
      setTesting((cur) => { const n = new Set(cur); n.delete(row.id); return n; }); // E08:只清自身
    }
  };

  const save = async (row: HostRow) => {
    // E04/E11:未知基线不提交;本页共享写锁防两处保存交错覆盖
    if (!beginWrite()) return;
    try {
      await saveInner(row);
    } finally { endWrite(); }
  };
  const saveInner = async (row: HostRow) => {
    const previous = hosts.find(h => h.id === row.id);
    if (editingBase.current?.hostKeyFingerprint && editingBase.current.hostKeyFingerprint !== row.hostKeyFingerprint
      && !window.confirm(t('settings.confirmFingerprint'))) return;
    const savedSecret = secrets[row.id];
    try {
      if (!previous && !editingNew.current) throw new Error(t('settings.hostRemoved'));
      const { id, credentialRef: _ref, ...values } = row;
      const changes = Object.fromEntries(Object.entries(values).filter(([key, value]) =>
        value !== editingBase.current?.[key as keyof HostRow]));
      const put = await mutate({
        ...(previous ? { updateHost: { id, changes } } : { addHosts: [row] }),
        secrets: savedSecret ? { [row.id]: savedSecret } : undefined,
      });
      setTestResult(m => { const next = { ...m }; delete next[row.id]; return next; });
      setDiscovered(m => { const next = { ...m }; delete next[row.id]; return next; });
      setEditing(null);
      setSecrets((s) => {
        const copy = { ...s };
        delete copy[row.id];
        return copy;
      });
      // auto-test right after saving, with the one-off secret still in hand
      // (an existing credentialRef falls back to the vault server-side)
      void runTest(put.config?.hosts.find(h => h.id === row.id) ?? row, savedSecret);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (id: string) => {
    if (!configReady || writing.current) return;
    const row = hosts.find((h) => h.id === id);
    if (row && !window.confirm(t('settings.confirmDelete', { name: row.name || row.host }))) return;
    if (!beginWrite()) return;
    try {
      await mutate({ removeHostId: id });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { endWrite(); }
  };

  interface LogCandidate { pid: number; user: string; cmd: string; logPath: string; size: number; mtimeMs: number; source: string }
  const [discovering, setDiscovering] = useState<Set<string>>(new Set());
  const [discovered, setDiscovered] = useState<Record<string, LogCandidate[]>>({});
  const discoverLogs = async (row: HostRow) => {
    if (discoverPending.current.has(row.id)) return;
    const token = Symbol(); discoverPending.current.set(row.id, token);
    try {
      setDiscovering((cur) => new Set(cur).add(row.id)); // E08:按主机加锁
      const res = await api<{ candidates: LogCandidate[] }>('/dash/discover-logs', {
        method: 'POST',
        body: JSON.stringify({
          host: row.host, port: row.port, username: row.username,
          authKind: row.authKind, credentialRef: row.credentialRef,
          password: secrets[row.id]?.password, privateKey: secrets[row.id]?.privateKey,
          // F24:与「测试连接」同链——SSH config 导入的非默认 IdentityFile 不能漏
          identityFile: row.identityFile || undefined,
        }),
      });
      if (currentHost(row) && discoverPending.current.get(row.id) === token) setDiscovered((m) => ({ ...m, [row.id]: res.candidates ?? [] }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      discoverPending.current.delete(row.id);
      setDiscovering((cur) => { const n = new Set(cur); n.delete(row.id); return n; }); // E08:只清自身
    }
  };

  const applyLog = async (row: HostRow, logPath: string) => {
    if (!beginWrite()) return;
    try {
      await mutate({ updateHost: { id: row.id, changes: { logPath } } });
      setDiscovered(m => ({ ...m, [row.id]: [] }));
    } catch (e) { writeError(e); } finally { endWrite(); }
  };

  const importSsh = async () => {
    if (!beginWrite()) return;
    try {
      setImporting(true);
      const res = await api<{ hosts: { alias: string; host: string; port: number; username: string; identityFile?: string }[] }>('/dash/import-ssh');
      const existing = new Set(hosts.map((h) => `${h.username}@${h.host}:${h.port}`));
      const usedIds = new Set(hosts.map((h) => h.id));
      const source = res.hosts.filter((h) => {
        if (!h.host) return false;
        const key = `${h.username}@${h.host}:${h.port}`;
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
      if (added.length) await mutate({ addHosts: added });
      setNotice(added.length > 0
        ? t('settings.imported', { added: added.length, skipped: res.hosts.length - added.length })
        : t('settings.importNone'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
      endWrite();
    }
  };

  const test = (row: HostRow) => void runTest(row, secrets[row.id]);

  const shown = filter.trim()
    ? hosts.filter((h) => `${h.name} ${h.host} ${h.username}`.toLowerCase().includes(filter.trim().toLowerCase()))
    : hosts;

  return (
    <div style={{ padding: '12px 16px', fontSize: 12, maxWidth: 560, minWidth: 0, boxSizing: 'border-box', width: '100%' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{t('settings.nav')}</span>
        <span style={{ flex: 1 }} />
        <input
          style={{ ...input, width: 120, margin: 0 }}
          placeholder={t('settings.searchHosts')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button type="button" style={btn} onClick={importSsh} disabled={!configReady || mutationBusy || importing}>
          {importing ? '…' : t('settings.importSsh')}
        </button>
        <button type="button" style={btn} disabled={!configReady || mutationBusy} onClick={() => beginEdit(emptyHost(), true)}>{t('settings.addHost')}</button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 12, padding: '8px 10px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8 }}>
        <label style={{ ...label, whiteSpace: 'nowrap', margin: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
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
        <label style={{ ...label, whiteSpace: 'nowrap', margin: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
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
        <label style={{ ...label, whiteSpace: 'nowrap', margin: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }} title={t('settings.alertIdleHint')}>
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
        <button type="button" style={btn} onClick={() => void saveIntervals()} disabled={!configReady || mutationBusy || loading}>{t('settings.save')}</button>
      </div>
      {(!configReady || error) && !loading && <button type="button" style={btn} disabled={mutationBusy} onClick={() => void load()}>{t('settings.reload')}</button>}
      {error && <div role="alert" style={{ color: 'var(--dsw-alias-state-danger, #e5484d)', marginBottom: 8 }}>{error}</div>}
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
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
            <span style={{ fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.name || row.host}>{row.name || row.host}</span>
            {row.pinned && <span style={{ fontSize: 10, color: 'var(--dsw-alias-state-business-primary, #4d6bfe)' }}>{t('settings.pinnedTag')}</span>}
            {row.archived && <span style={{ fontSize: 10, color: 'var(--dsw-alias-label-caption)' }}>{t('host.archivedTag')}</span>}
            <span style={{ flex: 1 }} />
            <button type="button" style={btn} onClick={() => test(row)} disabled={testing.has(row.id)}>
              {testing.has(row.id) ? t('settings.testing') : t('settings.testShort')}
            </button>
            <button type="button" style={btn} onClick={() => void discoverLogs(row)} disabled={discovering.has(row.id)}>
              {discovering.has(row.id) ? t('settings.discovering') : `🔍 ${t('settings.discover')}`}
            </button>
            <button type="button" style={btn} disabled={mutationBusy} onClick={() => beginEdit(row)}>{t('settings.edit')}</button>
            <button type="button" style={btn} disabled={!configReady || mutationBusy} onClick={() => void remove(row.id)}>{t('settings.remove')}</button>
          </div>
          <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-caption)', marginTop: 2 }}>
            {row.username}@{row.host}:{row.port}
            {row.authKind !== 'none' && ` · ${t('settings.cred')} ${row.credentialRef || t('settings.credUnnamed')}`}
            {row.authKind === 'key' && !row.credentialRef && row.identityFile && ` · ${t('settings.identityFile')} ${row.identityFile}`}
            {row.logPath && ` · ${t('settings.logPathLabel')} ${row.logPath}`}
          </div>
          {discovered[row.id]?.length === 0 && !discovering.has(row.id) && (
            <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-caption)', marginTop: 4 }}>
              {t('settings.discoverEmpty')}
            </div>
          )}
          {(discovered[row.id] ?? []).map((c) => (
            <div key={`${c.source}-${c.pid}-${c.logPath}`} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, fontSize: 11, marginTop: 4 }}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`pid ${c.pid} (${c.user}) ${c.cmd}`}>
                {c.logPath}
                <span style={{ color: 'var(--dsw-alias-label-caption)' }}>
                  {' '}· {c.source} · pid {c.pid} ({c.user})
                  {c.size < 0 ? ` · ⚠️ ${t('settings.noPerm')}` : ` · ${(c.size / 1024).toFixed(0)}KB · ${new Date(c.mtimeMs).toLocaleTimeString()}`}
                </span>
              </span>
              <button type="button" style={btn} disabled={c.size < 0 || !configReady || mutationBusy} onClick={() => void applyLog(row, c.logPath)}>{t('settings.useIt')}</button>
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
            placeholder={t('f.credAuto')}
            readOnly
          />
          <label style={label}>{t('f.fingerprint')}</label>
          <input style={input} value={editing.hostKeyFingerprint ?? ''} placeholder="SHA256:…"
            onChange={e => setEditing({ ...editing, hostKeyFingerprint: e.target.value.trim() })} />
          <div style={{ ...label, marginBottom: 8 }}>{t('f.fingerprintHint')}</div>
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
          <label style={{ ...label, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={editing.pinned} onChange={(e) => setEditing({ ...editing, pinned: e.target.checked })} />
            {t('settings.pin')}
          </label>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" style={btn} disabled={!configReady || mutationBusy || !editing.name || !editing.host} onClick={() => void save(editing)}>{t('settings.save')}</button>
            <button type="button" style={btn} onClick={() => setEditing(null)}>{t('settings.cancel')}</button>
          </div>
        </div>
      )}
    </div>
  );
}
