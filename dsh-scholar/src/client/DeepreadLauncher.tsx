/**
 * 精读任务启动面板（v1.18：一键精读的优雅形态）。
 *
 * 设计：面板配置（单篇/多篇、模式、透镜开关、上下文论文/卡片多选、focus 可编辑）
 * → POST /scholar/read/run 后台直跑（jobs 不可用时脱离任务系统执行）
 * （对用户不可见，dsh-trajectory 同款机制）→ 输入框只注入一句短触发语并发送。
 * 透镜不再强制：quick 速读恒不带；map 默认勾选可取消。
 */
import React, { useEffect, useMemo, useState } from 'react';
import type { IdeaCard, Paper, ScholarConfig } from '../shared/types';
import { api } from './api';
import { ACADEMIC_LENS } from '../shared/lens';
import type { TFunc } from './nav';
import { Btn, Icon, Icons, Modal, SchStyles, SearchInput, T, Textarea, truncate } from './ui';

type ComposerDelivery = 'sent' | 'filled' | 'clipboard' | 'failed';

/**
 * 把短触发语注入宿主对话输入框并发送（同页 DOM 注入）。
 * 目标判定：只认插件 DOM（[data-dsh-plugin]）之外的输入框——否则会误中面板自己的
 * textarea；宿主实况是 contenteditable 富文本编辑器，优先走它，textarea 为兜底。
 * contenteditable：全选 + execCommand insertText；textarea：原生 setter + input 事件
 * （包 try/catch：受控组件对合成事件的重入可能抛错，不阻断收尾）。
 * 发送按钮按 aria-label/title 定位，260ms 等 React 解锁。
 */
// E07:非破坏交付——宿主输入框为空且唯一可识别才填入(不自动点发送);
// 已有草稿/附件/多编辑器时降级为剪贴板复制,绝不覆盖用户未发送的内容。
export function deliverToComposer(text: string, done: (r: ComposerDelivery) => void): void {
  const visible = (el: Element): boolean => (el as HTMLElement).offsetParent !== null;
  const inPlugin = (el: Element): boolean => !!el.closest('[data-dsh-plugin]');
  const ces = [...document.querySelectorAll('[contenteditable="true"]')].filter((el) => visible(el) && !inPlugin(el));
  const tas = [...document.querySelectorAll('textarea')].filter((el) => visible(el) && !inPlugin(el));
  const ce = ces.length === 1 ? ces[0] as HTMLElement : undefined;
  const ta = !ce && tas.length === 1 ? tas[0] as HTMLTextAreaElement : undefined;
  const ceEmpty = ce ? (ce.textContent ?? '').trim() === '' : false;
  const taEmpty = ta ? ta.value.trim() === '' : false;
  // 目标不存在/不唯一/草稿非空 → 只复制(用户自行粘贴,原草稿不动)
  if ((!ce && !ta) || (ce && !ceEmpty) || (ta && !taEmpty)) {
    navigator.clipboard?.writeText(text).then(() => done('clipboard'), () => done('failed'));
    return;
  }
  let injected = false;
  if (ce) {
    ce.focus();
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(ce);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    injected = document.execCommand('insertText', false, text);
  } else if (ta) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) {
      setter.call(ta, text);
      try {
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      } catch { /* 受控组件对合成事件重入抛错不阻断 */ }
      injected = ta.value === text;
    }
  }
  if (!injected) {
    navigator.clipboard?.writeText(text).then(() => done('clipboard'), () => done('failed'));
    return;
  }
  // E07:填入即止——不自动点发送(全页找'发送'按钮会误触别的会话/编辑器);
  // 通知用户检查后手动发送
  done('filled');
}
// 兼容旧引用的别名(原实现返回 void;新签名由调用方 done 回调消费)
function CheckList({ items, checked, onToggle, max }: {
  items: { id: string; label: string; note?: string }[];
  checked: Set<string>;
  onToggle: (id: string) => void;
  max?: number;
}) {
  const atMax = max !== undefined && checked.size >= max;
  return (
    <div
      className="sch-scroll"
      style={{
        maxHeight: 148, overflowY: 'auto', marginTop: 5,
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: '3px 0',
      }}
    >
      {items.length === 0 && (
        <div style={{ padding: '6px 10px', fontSize: 11, color: T.caption }}>-</div>
      )}
      {items.map((it) => {
        const on = checked.has(it.id);
        const disabled = !on && atMax;
        return (
          <label
            key={it.id}
            style={{
              display: 'flex', alignItems: 'center', gap: 7, padding: '4px 10px', cursor: disabled ? 'default' : 'pointer',
              opacity: disabled ? 0.45 : 1, fontSize: 11.5, color: 'var(--dsh-alias-label-primary)',
            }}
            onClick={(e) => {
              if (disabled) { e.preventDefault(); return; }
              e.preventDefault();
              onToggle(it.id);
            }}
          >
            <input type="checkbox" checked={on} readOnly style={{ accentColor: 'var(--dsw-alias-state-business-primary, #4d6bfe)', margin: 0 }} />
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={it.label}>
              {it.label}
            </span>
            {it.note && <span style={{ flex: 'none', fontSize: 9.5, color: it.note === 'no-pdf' ? T.warning : T.caption }}>{it.note === 'no-pdf' ? '无PDF' : it.note}</span>}
          </label>
        );
      })}
    </div>
  );
}

function Segment<K extends string>({ value, options, onChange }: {
  value: K; options: { key: K; label: string }[]; onChange: (k: K) => void;
}) {
  return (
    <span style={{ display: 'inline-flex', gap: 4 }}>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          data-dsh-plugin="dsh-scholar"
          data-dsh-part="deepread-seg"
          onClick={() => onChange(o.key)}
          style={{
            fontSize: 11, padding: '3px 11px', borderRadius: 7, cursor: 'pointer',
            border: `1px solid ${value === o.key ? 'var(--dsw-alias-border-l1, var(--dsw-alias-border-l2))' : 'var(--dsw-alias-border-l2)'}`,
            background: value === o.key ? 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12))' : 'transparent',
            color: value === o.key ? 'var(--dsh-alias-label-primary)' : T.secondary,
            fontWeight: value === o.key ? 600 : 400,
          }}
        >{o.label}</button>
      ))}
    </span>
  );
}

const labelStyle: React.CSSProperties = { display: 'block', fontSize: 10.5, fontWeight: 600, color: T.caption, marginBottom: 4, letterSpacing: '.02em' };

/**
 * 对话栏底端入口（conversation.input.left 插槽，紧邻 deepread 的 📖）：
 * 打开精读任务面板。无当前论文上下文 → 默认多篇模式，从库里选。
 */
export function ScholarReadEntry({ t }: { t: TFunc }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <SchStyles />
      <button
        type="button"
        data-dsh-plugin="dsh-scholar"
        data-dsh-part="deepread-entry"
        title={t('deepread.entryTitle')}
        aria-label={t('deepread.entryTitle')}
        aria-expanded={open}
        onClick={() => setOpen(true)}
        style={{
          border: 'none', background: 'transparent', cursor: 'pointer',
          padding: '2px 4px', fontSize: 14, lineHeight: 1, color: 'var(--dsh-alias-label-secondary)',
          display: 'inline-flex', alignItems: 'center',
        }}
      >📚</button>
      {open && (
        <DeepreadLauncher
          open={open}
          onClose={() => setOpen(false)}
          notify={() => { /* composer 场景没有面板级 notice 位，静默 */ }}
          t={t}
        />
      )}
    </>
  );
}

export function DeepreadLauncher({ open, current, allPapers: allPapersProp, onClose, notify, t }: {
  open: boolean;
  /** 详情页入口传入；对话栏入口（composer 按钮）无当前论文 */
  current?: Paper;
  /** 详情页入口传入现成列表；对话栏入口自行拉取 */
  allPapers?: Paper[];
  onClose: () => void;
  notify: (msg: string) => void;
  t: TFunc;
}) {
  const [scope, setScope] = useState<'single' | 'multi'>(current ? 'single' : 'multi');
  const [mode, setMode] = useState<'paper' | 'light' | 'quick'>('paper');
  /** 直接对比已有成果（仅多篇范围）：不重读，1-3 分钟出对比报告 */
  const [directCompare, setDirectCompare] = useState(false);
  const [lens, setLens] = useState(true);
  const [allPapers, setAllPapers] = useState<Paper[]>(allPapersProp ?? []);
  const [paperIds, setPaperIds] = useState<Set<string>>(new Set());
  const [paperQ, setPaperQ] = useState('');
  const [ctxIds, setCtxIds] = useState<Set<string>>(new Set());
  const [cardIds, setCardIds] = useState<Set<string>>(new Set());
  const [ctxQ, setCtxQ] = useState('');
  const [focus, setFocus] = useState('');
  const [cards, setCards] = useState<IdeaCard[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!open) return;
    setErr('');
    let alive = true;
    (async () => {
      try {
        const reqs: Array<Promise<{ cards?: IdeaCard[]; config?: ScholarConfig; papers?: Paper[] }>> = [
          api<{ cards: IdeaCard[] }>('/scholar/cards?sort=title'),
          api<{ config: ScholarConfig }>('/scholar/config'),
        ];
        // 对话栏入口没有现成论文列表：顺带拉全库
        if (!allPapersProp) reqs.push(api<{ papers: Paper[] }>('/scholar/papers?sort=title'));
        const results = await Promise.all(reqs);
        const cs = (results.find((r) => 'cards' in r && r.cards) ?? { cards: [] as IdeaCard[] }) as { cards: IdeaCard[] };
        const cfg = (results.find((r) => 'config' in r && r.config) ?? { config: {} as ScholarConfig }) as { config: ScholarConfig };
        const rest = results.filter((r) => 'papers' in r && r.papers);
        if (!alive) return;
        const papers = allPapersProp ?? ((rest[0] as { papers: Paper[] } | undefined)?.papers ?? []);
        setAllPapers(papers);
        setCards(cs.cards);
        // 预填 focus：设置项优先，空则库内高频标签推断
        const f = (cfg.config.researchFocus ?? '').trim()
          || [...papers.flatMap((p) => p.tags).reduce((m, tg) => m.set(tg, (m.get(tg) ?? 0) + 1), new Map<string, number>())]
            .sort((a, b) => b[1] - a[1]).slice(0, 8).map(([tg]) => tg).join('、');
        setFocus(f);
        if (current) {
          // 预选上下文：与当前论文标签重叠 top6（排除自身）；卡片预选本论文的卡
          setCtxIds(new Set(papers
            .filter((p) => p.id !== current.id)
            .map((p) => ({ p, score: p.tags.filter((tg) => current.tags.includes(tg)).length }))
            .filter((r) => r.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 6)
            .map((r) => r.p.id)));
          setCardIds(new Set(cs.cards.filter((c) => c.paperId === current.id).map((c) => c.id)));
        }
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { alive = false; };
  }, [open, current?.id, allPapersProp]);

  const toggle = (set: (fn: (s: Set<string>) => Set<string>) => void, id: string) => set((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const targetIds = scope === 'single' && current ? [current.id] : [...paperIds];
  const papersWithPdf = useMemo(() => new Set(allPapers.filter((p) => p.pdfPath).map((p) => p.id)), [allPapers]);

  const paperItems = useMemo(() => allPapers
    .filter((p) => p.id !== current?.id || scope === 'multi')
    .filter((p) => !paperQ.trim() || p.title.toLowerCase().includes(paperQ.trim().toLowerCase())
      || (p.tags ?? []).some((tg) => tg.toLowerCase().includes(paperQ.trim().toLowerCase())))
    .map((p) => ({ id: p.id, label: truncate(p.title, 64), note: papersWithPdf.has(p.id) ? undefined : 'no-pdf' })), [allPapers, paperQ, scope, current?.id, papersWithPdf]);

  const ctxItems = useMemo(() => allPapers
    .filter((p) => !targetIds.includes(p.id))
    .filter((p) => !ctxQ.trim() || p.title.toLowerCase().includes(ctxQ.trim().toLowerCase()))
    .map((p) => ({ id: p.id, label: truncate(p.title, 64), note: p.year ? String(p.year) : undefined })), [allPapers, ctxQ, targetIds]);

  const cardItems = useMemo(() => (cards ?? [])
    .map((c) => ({ id: c.id, label: truncate(c.title, 56) })), [cards]);

  const launch = async () => {
    if (scope === 'multi' && (paperIds.size < 2 || paperIds.size > 10)) {
      setErr(t('deepread.errCount'));
      return;
    }
    try {
      setBusy(true);
      setErr('');
      // focus 组装：方向 + 透镜（勾选时）+ 上下文论文 + 已有卡（引擎 focus 是唯一注入口）
      const focusParts: string[] = [];
      if (focus.trim()) focusParts.push('我的研究方向：' + focus.trim());
      if (lens && (mode === 'paper' || mode === 'light')) focusParts.push(ACADEMIC_LENS);
      const rel = allPapers.filter((p) => ctxIds.has(p.id));
      const relCards = (cards ?? []).filter((c) => cardIds.has(c.id));
      if (relCards.length > 0) focusParts.push('已有 idea 卡（避免重复）：' + relCards.map((c) => c.title).join('；'));
      // 上下文论文：标题 + sidecar 迷你摘要（核心结论/关键数字，每篇 ~200 字）——
      // 无 sidecar（未深读过/旧报告）回退纯标题。透镜第⑤点的对比定位由此有实质材料。
      if (rel.length > 0) {
        const briefs = await Promise.all(rel.map(async (p) => {
          try {
            const r = await api<{ sidecar: { coreConclusions?: string[]; dataPoints?: Array<{ subject: string; value: string }>; summary?: string } | null }>(`/scholar/papers/${encodeURIComponent(p.id)}/sidecar`);
            const sc = r.sidecar;
            if (!sc) return p.title;
            const concl = (sc.coreConclusions ?? []).slice(0, 2).join('；');
            const nums = (sc.dataPoints ?? []).slice(0, 2).map((d) => `${d.subject} ${d.value}`).join('，');
            const brief = `${p.title}【${concl || (sc.summary ?? '').slice(0, 80)}${nums ? `；关键数字：${nums}` : ''}】`;
            return brief.length > 260 ? brief.slice(0, 257) + '…' : brief;
          } catch {
            return p.title;
          }
        }));
        focusParts.push('库内相关论文（对比定位，透镜第⑤点引用）：' + briefs.join('；'));
      }
      // E12:effectiveCompare 派生——单篇范围时隐藏的直接对比选项不得控制请求;
      // 此前 multi+勾选→切回 single 仍发 compare 接口并报数量错误
      const effectiveCompare = scope === 'multi' && directCompare;
      const endpoint = effectiveCompare ? '/scholar/read/compare' : '/scholar/read/run';
      const payload = effectiveCompare
        ? { paperIds: targetIds, focus: focusParts.join('\n') }
        : { paperIds: targetIds, mode: mode === 'quick' ? 'quick' : 'paper', light: mode === 'light', focus: focusParts.join('\n') };
      const r = await api<{ ok: boolean; jobId?: string; detached?: boolean; label?: string; started?: number; skipped?: number }>(endpoint, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      // 后台 detached 路径没有 jobId（脱离任务系统），成功条件两种都认
      if (!r.ok || (!r.jobId && !r.detached)) throw new Error(r.label || '启动失败');
      notify(t('deepread.launchedDetached', {
        label: r.label ?? '',
        count: String(r.skipped ? `${r.started ?? 0} 篇（${r.skipped} 篇无 PDF 跳过）` : `${r.started ?? 0} 篇`),
      }));
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // 门控渲染：open=false 时必须返回 null——否则详情页挂载即弹窗、关闭无效
  // （open 此前只控制数据加载，是"点卡跳精读且关不掉"的根因）
  if (!open) return null;

  return (
    <Modal title={t('deepread.title')} onClose={onClose} width={560}>
      <SchStyles />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
        <div>
          <span style={labelStyle}>{t('deepread.scope')}</span>
          <Segment value={scope} onChange={(v) => { setScope(v); if (v !== 'multi') setDirectCompare(false); // E12:切回单篇清除隐藏的直接对比模式
          }} options={current ? [
            { key: 'single', label: `${t('deepread.single')}：${truncate(current.title, 26)}` },
            { key: 'multi', label: t('deepread.multi') },
          ] : [
            { key: 'multi', label: t('deepread.multi') },
          ]} />
        </div>

        {scope === 'multi' && (
        <div>
          <span style={labelStyle}>{t('deepread.pickPapers')}{paperIds.size > 0 ? `（${paperIds.size}/10）` : ''}</span>
          <SearchInput value={paperQ} onChange={(v) => setPaperQ(v)} placeholder={t('deepread.search')} />
          <CheckList items={paperItems} checked={paperIds} onToggle={(id) => toggle(setPaperIds, id)} max={10} />
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 11, cursor: 'pointer', color: directCompare ? 'var(--dsw-alias-state-business-primary, #4d6bfe)' : T.secondary }}
            onClick={(e) => { e.preventDefault(); setDirectCompare((v) => !v); }}>
            <input type="checkbox" checked={directCompare} readOnly style={{ accentColor: 'var(--dsw-alias-state-business-primary, #4d6bfe)', margin: 0 }} />
            {t('deepread.directCompare')}
          </label>
        </div>
        )}

        <div>
          <span style={labelStyle}>{t('deepread.mode')}</span>
          <Segment value={mode} onChange={(m) => { setMode(m); if (m === 'quick') setLens(false); }} options={[
            { key: 'paper', label: t('deepread.paper') },
            { key: 'light', label: t('deepread.light') },
            { key: 'quick', label: t('deepread.quick') },
          ]} />
          {mode === 'paper' && (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 12, fontSize: 11, cursor: 'pointer', color: T.secondary }}
              onClick={(e) => { e.preventDefault(); setLens((v) => !v); }}>
              <input type="checkbox" checked={lens} readOnly style={{ accentColor: 'var(--dsw-alias-state-business-primary, #4d6bfe)', margin: 0 }} />
              {t('deepread.lens')}
            </label>
          )}
          {mode === 'light' && (
            <span style={{ marginLeft: 12, fontSize: 10.5, color: T.caption }}>{t('deepread.lightHint')}</span>
          )}
        </div>

        <div>
          <span style={labelStyle}>{t('deepread.ctxPapers')}（{ctxIds.size}）</span>
          <SearchInput value={ctxQ} onChange={(v) => setCtxQ(v)} placeholder={t('deepread.search')} />
          <CheckList items={ctxItems} checked={ctxIds} onToggle={(id) => toggle(setCtxIds, id)} />
        </div>

        <div>
          <span style={labelStyle}>{t('deepread.ctxCards')}（{cardIds.size}）</span>
          <CheckList items={cardItems} checked={cardIds} onToggle={(id) => toggle(setCardIds, id)} />
        </div>

        <div>
          <span style={labelStyle}>{t('deepread.focus')}</span>
          <Textarea value={focus} rows={3} onChange={(e) => setFocus(e.target.value)} placeholder={t('settings.researchFocusPlaceholder')} />
        </div>

        {err && <div style={{ color: T.danger, fontSize: 11 }}>{err}</div>}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
          <span style={{ flex: 1, fontSize: 10, color: T.caption }}>{t('deepread.footHint2')}</span>
          <Btn onClick={onClose}>{t('common.cancel')}</Btn>
          <Btn tone="primary" onClick={() => void launch()} disabled={busy}>
            <Icon d={Icons.book} size={12} /> {t('deepread.launch')}
          </Btn>
        </div>
      </div>
    </Modal>
  );
}
