/**
 * 交互式追问区（详情页）：输入框直连 /scholar/read/ask（一次检索+一次模型调用），
 * 问答记录持久化在 reads/<id>.json（重读保留），带页码引用与置信度标签。
 */
import React, { useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { TFunc } from './nav';
import { Btn, Icon, Icons, Input, Section, T } from './ui';

interface QAEntry {
  q: string
  a: string
  pages: string[]
  confidence: string
  sufficient: boolean
  at: number
}

const CONF_COLOR: Record<string, string> = {
  '作者原意': '#8ab4f8',
  '原文事实与数据': '#69c08d',
  '合理推断': '#e0b45c',
  '无法确认': '#9a9ca3',
};

export function PaperAsk({ paperId, t }: { paperId: string; t: TFunc }) {
  const [qa, setQa] = useState<QAEntry[] | null>(null);
  const [exists, setExists] = useState(false);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    // R06:切换论文进入显式隔离态——清空上一论文的历史/问题/错误/忙碌,
    // 加载期间不再显示别的论文内容;父组件同时以 key 隔离挂载实例
    setErr('');
    setQa(null);
    setExists(false);
    setBusy(false);
    api<{ exists: boolean; qa: QAEntry[] }>(`/scholar/read/session/${encodeURIComponent(paperId)}`)
      .then((r) => { if (alive) { setExists(r.exists); setQa(r.qa ?? []); } })
      .catch(() => { if (alive) setQa([]); });
    return () => { alive = false; };
  }, [paperId]);

  // F28/R06:会话归属——任何异步回写(成功/失败/finally)前校验论文未切换
  const askPaperRef = useRef(paperId);
  useEffect(() => { askPaperRef.current = paperId; }, [paperId]);

  const ask = async () => {
    const q = question.trim();
    const askedFor = paperId;
    if (q === '' || busy) return;
    try {
      setBusy(true);
      setErr('');
      const r = await api<{ ok: boolean; answer: string; pages: string[]; confidence: string; sufficient: boolean }>('/scholar/read/ask', {
        method: 'POST',
        body: JSON.stringify({ paperId, question: q }),
      });
      if (askPaperRef.current !== askedFor) return; // 已切换论文:迟到响应丢弃
      setQa((cur) => [...(cur ?? []), { q, a: r.answer, pages: r.pages ?? [], confidence: r.confidence ?? '', sufficient: r.sufficient !== false, at: Date.now() }]);
      setQuestion('');
      setExists(true);
    } catch (e) {
      if (askPaperRef.current !== askedFor) return; // R06:迟到错误不落到别的论文
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (askPaperRef.current === askedFor) setBusy(false); // R06:忙碌态不跨论文
    }
  };

  return (
    <Section title={t('ask.title')} icon={<Icon d={Icons.search} size={11} color={T.business} />} accent={T.business}>
      {!exists && (qa === null || qa.length === 0) ? (
        <div style={{ fontSize: 11, color: T.caption, lineHeight: 1.6 }}>{t('ask.needRead')}</div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 6 }}>
            <Input
              value={question}
              placeholder={t('ask.placeholder')}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void ask(); } }}
            />
            <Btn tone="primary" onClick={() => void ask()} disabled={busy || question.trim() === ''}>
              <Icon d={Icons.search} size={11} /> {busy ? t('ask.busy') : t('ask.go')}
            </Btn>
          </div>
          {err && <div style={{ color: T.danger, fontSize: 11, marginTop: 6 }}>{err}</div>}
          {(qa ?? []).length > 0 && (
            <div style={{ marginTop: 9, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {(qa ?? []).slice().reverse().map((entry, i) => {
                const color = CONF_COLOR[entry.confidence] ?? '#9a9ca3';
                return (
                  <div key={`${entry.at}-${i}`} style={{ border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 9, padding: '7px 10px' }}>
                    <div style={{ fontSize: 11.5, fontWeight: 600, marginBottom: 4 }}>{entry.q}</div>
                    <div style={{ fontSize: 11.5, lineHeight: 1.6, color: T.secondary, whiteSpace: 'pre-wrap' }}>{entry.a}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5, flexWrap: 'wrap' }}>
                      {entry.pages.length > 0 && (
                        <span style={{ fontSize: 9.5, color: T.caption }}>出处：{entry.pages.join('、')}</span>
                      )}
                      <span style={{ fontSize: 9.5, color, border: `1px solid ${color}55`, borderRadius: 999, padding: '0 7px' }}>{entry.confidence}</span>
                      {entry.sufficient === false && (
                        <span style={{ fontSize: 9.5, color: T.warning }}>⚠ 片段不足，建议复读或换问法</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </Section>
  );
}
