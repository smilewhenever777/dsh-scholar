import React from 'react';
import { DndContext, KeyboardSensor, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { api } from './api';
import { ConfirmModal, ToastHost, showToast, type ConfirmRequest } from './feedback';
import { workbenchCss } from './workbench-style';

type Status = 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done';
type Page = 'overview' | 'tasks' | 'projects' | 'agents' | 'legacy';
type Project = { id: string; title: string; root: string; revision: number };
type Agent = { id: string; name: string; instructions: string; model: string; toolAllow: string[]; revision: number };
type Timeline = { id: string; kind: string; at: number; text: string; runId?: string; actor: string };
type Task = { id: string; projectId: string; title: string; description: string; acceptanceCriteria: string; assigneeId?: string;
  status: Status; revision: number; runIds: string[]; timeline: Timeline[]; owner?: { dispatchId: string } };
type Run = { id: string; phase: string; createdAt: number; acceptedAt?: number; lastProgressAt?: number; endedAt?: number; runtime: { childSessionId: string; quiescence: string };
  effectiveConfig: { modelProvider: string; model: string; agentProfile?: { name: string } };
  report?: { outcome: string; summary: string; evidence: ({ kind: string; ref: string; summary?: string } | string)[]; nextHint?: string };
  result?: { kind: string; reasonCode: string; summary: string }; writeback: { state: string; lastErrorCode?: string };
  targetRef: { nodeId: string; canonicalRoot?: string }; targetType: string; cancel?: { reason: string } };
type Overview = { projects: Project[]; agents: Agent[]; tasks: Task[]; counts: Record<Status, number>; legacyCount: number; readOnly: boolean };
type Event = { seq: number; at: number; kind: string; text?: string; name?: string; error?: boolean; interrupted?: boolean };
type Models = { allowed: string[]; default: string };

const BASE = '/dispatch/workbench';
const STATUS: Status[] = ['todo', 'in_progress', 'in_review', 'blocked', 'done'];
const LABEL: Record<Status, string> = { todo: '待办', in_progress: '执行中', in_review: '待验收', blocked: '受阻', done: '已完成' };
const TOOLS: Record<string, string> = { dispatch_read_file: '读取文件', dispatch_list_dir: '列出目录', dispatch_write_report: '写入报告', dispatch_progress: '提交进度', dispatch_report: '提交结果' };
const EMPTY: Overview = { projects: [], agents: [], tasks: [], counts: { todo: 0, in_progress: 0, in_review: 0, blocked: 0, done: 0 }, legacyCount: 0, readOnly: false };
const state = { open: false, listeners: new Set<() => void>() };
function subscribe(fn: () => void) { state.listeners.add(fn); return () => { state.listeners.delete(fn); }; }
function openSnapshot() { return state.open; }
function setOpen(value: boolean) { state.open = value; for (const fn of state.listeners) fn(); }
export function openWorkbench() { setOpen(true); }
function fmt(ts?: number) { return ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—'; }
function elapsed(run: Run) {
  const seconds = Math.max(0, Math.floor(((run.endedAt ?? Date.now()) - run.createdAt) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} 分 ${seconds % 60} 秒` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}
const PHASE_LABEL: Record<string, string> = {
  preparing: '准备中', starting: '正在启动', queued: '等待子代理', running: '执行中',
  cancelling: '正在取消', settling: '正在保存结果', reconciling: '等待核验', finished: '已结束',
};
const OUTCOME_LABEL: Record<string, string> = { done: '执行完成', failed: '执行失败', blocked: '执行受阻', aborted: '已取消' };
function runLabel(run: Run) { return run.phase === 'finished' ? (OUTCOME_LABEL[run.result?.kind ?? ''] ?? '已结束') : (PHASE_LABEL[run.phase] ?? run.phase); }
function runGuidance(run: Run) {
  if (run.phase === 'finished') {
    if (run.result?.kind === 'done') return '本次执行结果已保存。报告、证据和任务验收记录可分别在下方查看。';
    if (run.result?.kind === 'aborted') return '本次执行已停止。任务可在静止确认后重新运行。';
    return '本次执行未完成。请看结果说明和活动记录，处理受阻原因后可重新运行。';
  }
  if (run.phase === 'reconciling') return '宿主正在对账，暂不能断定子代理已经停止。';
  if (run.phase === 'cancelling') return '取消请求已发送，正在等待子代理停止和队列静止。';
  if (run.phase === 'settling') return '子代理已结束，正在保存结果和同步任务状态。';
  if (run.phase === 'running') return 'Agent 正在工作。活动记录会自动更新；这里不显示猜测的完成百分比。';
  return '已创建执行请求，正在等待子代理开始。';
}
function preview(value: string, max = 140) { const compact = value.replace(/\s+/g, ' ').trim(); return compact.length > max ? `${compact.slice(0, max)}…` : compact; }
function eventLabel(event: Event) { return event.kind === 'assistant' ? 'Agent 消息' : event.kind === 'tool_call' ? (TOOLS[event.name ?? ''] ?? event.name ?? '工具调用') : event.kind === 'tool_result' ? '工具结果' : '执行尝试'; }
function evidencePath(run: Run, ref: string) {
  const root = run.targetRef.canonicalRoot;
  if (!root || /^(?:[a-z][\w+.-]*:|[\\/])/i.test(ref) || ref.replace(/\\/g, '/').split('/').includes('..')) return ref;
  const sep = root.includes('\\') ? '\\' : '/';
  return root.replace(/[\\/]+$/, '') + sep + ref.replace(/[\\/]/g, sep);
}
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }
/** 409 等常见失败转成可行动文案;其余透传服务端消息。 */
function friendlyError(error: unknown): string {
  const status = (error as { status?: number })?.status;
  if (status === 409) return '内容刚被其他操作更新过。已为你拉取最新数据,请重试一次刚才的操作。';
  return errorText(error);
}
function write(path: string, method: 'POST' | 'PATCH', body: unknown) {
  return api(`${BASE}${path}`, { method, body: JSON.stringify(body) });
}

export function WorkbenchTrigger({ wide }: { wide?: boolean }) {
  const open = React.useSyncExternalStore(subscribe, openSnapshot);
  return <button type="button" title="AI 团队工作台" aria-label="打开 AI 团队工作台" aria-pressed={open}
    onClick={() => setOpen(!open)} style={{ border: 0, borderRadius: 8, background: open ? 'rgba(93,116,236,.2)' : 'transparent',
      color: 'var(--dsw-alias-label-secondary, #b5b8c1)', cursor: 'pointer', padding: '4px 8px', fontSize: 12 }}>
    ◈{wide ? ' AI 团队' : ''}
  </button>;
}

function Column({ status, tasks, agents, onTask }: { status: Status; tasks: Task[]; agents: Agent[]; onTask: (id: string) => void }) {
  // 全列可放置:不接受的目标在 onDragEnd 里校验并给出明确提示(拖入无反馈的静默失败更差)
  const droppable = status !== 'in_progress';
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return <section ref={setNodeRef} className={`dsh-wb-col${isOver ? ' over' : ''}`} aria-label={LABEL[status]} data-accepts={droppable ? 'yes' : 'no'}>
    <div className="dsh-wb-col-head"><span>{LABEL[status]}</span><em>{tasks.length}</em></div>
    {tasks.map((task) => <TaskCard key={task.id} task={task} agent={agents.find((a) => a.id === task.assigneeId)} onTask={onTask} />)}
  </section>;
}
function TaskCard({ task, agent, onTask }: { task: Task; agent?: Agent; onTask: (id: string) => void }) {
  const movable = (task.status === 'todo' || task.status === 'blocked') && !task.owner;
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: task.id, disabled: !movable });
  return <article ref={setNodeRef} className="dsh-wb-card" style={{ opacity: isDragging ? .55 : 1,
    transform: transform ? `translate3d(${transform.x}px,${transform.y}px,0)` : undefined }}>
    <div className="dsh-wb-row"><button className="dsh-wb-card-title" onClick={() => onTask(task.id)}>{task.title}</button>
      {task.owner && <span className="dsh-wb-card-live" title="执行中" aria-label="执行中" />}
      {movable && <button type="button" className="dsh-wb-drag" title="拖动任务;也可在详情中使用状态选择"
        {...attributes} {...listeners}>⠿</button>}</div>
    <div className="dsh-wb-muted">{agent?.name ?? '未分派'} · {task.runIds.length} 次执行</div>
    {task.description && <div className="dsh-wb-card-desc">{preview(task.description, 64)}</div>}
  </article>;
}

function ExpandableText({ text, label, fold = false }: { text: string; label: string; fold?: boolean }) {
  if (!text) return null;
  if (!fold && text.length <= 1800) return <div className="dsh-wb-copy">{text}</div>;
  return <details className="dsh-wb-expand"><summary>{label} · {text.length} 字 <span>{preview(text, 90)}</span></summary>
    <pre>{text}</pre></details>;
}
type ActivityItem = { event: Event; result?: Event };
function groupActivity(events: Event[]): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const event of events) {
    if (event.kind === 'assistant' && !event.text?.trim()) continue;
    if (event.kind === 'tool_result' && items.at(-1)?.event.kind === 'tool_call' && !items.at(-1)?.result) {
      items[items.length - 1].result = event;
    } else items.push({ event });
  }
  return items;
}
function ActivityCard({ item }: { item: ActivityItem }) {
  const { event, result } = item;
  const kind = event.kind === 'assistant' ? 'agent' : event.kind === 'tool_call' ? 'tool' : 'system';
  return <article className={'dsh-wb-activity ' + kind + (event.error || result?.error ? ' error' : '')}>
    <div className="dsh-wb-activity-head"><span className="dsh-wb-activity-kind">{eventLabel(event)}</span><time>{fmt(event.at)}</time>
      {result?.error && <strong>工具报错</strong>}</div>
    {event.kind === 'assistant' ? <ExpandableText text={event.text ?? ''} label="展开 Agent 消息" /> :
      event.kind === 'tool_call' ? <>
        <ExpandableText text={event.text ?? ''} label="查看调用参数" fold />
        {result ? <ExpandableText text={result.text ?? ''} label={result.error ? '查看错误结果' : '查看工具结果'} fold /> :
          <div className="dsh-wb-muted">等待工具返回</div>}</> :
      <ExpandableText text={event.text ?? ''} label="查看详情" fold />}
  </article>;
}
function RunPanel({ run, latestProgress, onCancel, onAskTakeover, onAskResolve }: { run: Run; latestProgress?: Timeline; onCancel: () => Promise<void>;
  onAskTakeover: () => void; onAskResolve: () => void }) {
  const [events, setEvents] = React.useState<Event[]>([]);
  const [cursor, setCursor] = React.useState(-1);
  const cursorRef = React.useRef(-1);
  const [more, setMore] = React.useState(false);
  const [error, setError] = React.useState('');
  const [view, setView] = React.useState<'overview' | 'activity' | 'raw'>('overview');
  const [filter, setFilter] = React.useState<'all' | 'agent' | 'tool' | 'error'>('all');
  const [copied, setCopied] = React.useState(-1);
  async function copyEvidence(index: number, ref: string) {
    try { await navigator.clipboard.writeText(evidencePath(run, ref)); setCopied(index); }
    catch { setCopied(-2); }
  }
  const load = React.useCallback(async (after: number, append: boolean) => {
    try {
      const page = await api<{ events: Event[]; nextCursor: number; hasMore: boolean }>(`${BASE}/runs/${encodeURIComponent(run.id)}/events?after=${after}&limit=50`);
      setEvents((old) => append ? [...old, ...page.events] : page.events);
      setCursor(page.nextCursor);
      cursorRef.current = page.nextCursor;
      setMore(page.hasMore);
      setError('');
    } catch (e) { setError(errorText(e)); }
  }, [run.id]);
  React.useEffect(() => {
    cursorRef.current = -1;
    setEvents([]);
    void load(-1, false);
    if (run.phase === 'finished') return;
    const timer = setInterval(() => { if (!document.hidden) void load(cursorRef.current, true); }, 4000);
    return () => clearInterval(timer);
  }, [load, run.phase]);
  const activity = groupActivity(events);
  const shown = activity.filter((item) => filter === 'all' || (filter === 'agent' && item.event.kind === 'assistant') ||
    (filter === 'tool' && item.event.kind === 'tool_call') || (filter === 'error' && (item.event.error || item.result?.error)));
  const lastActivity = [...events].reverse().find((event) => event.kind === 'tool_call' || (event.kind === 'assistant' && event.text?.trim()));
  const tone = run.phase !== 'finished' ? 'active' : run.result?.kind === 'done' ? 'success' : 'warning';
  const resultRepeatsReport = !!run.result?.summary && !!run.report?.summary &&
    run.report.summary.trim().startsWith(run.result.summary.trim());
  return <div className="dsh-wb-run">
    <section className={'dsh-wb-run-state ' + tone} aria-live="polite">
      <div className="dsh-wb-kicker">本次执行状态</div>
      <div className="dsh-wb-run-state-top"><h3>{runLabel(run)}</h3><span>{run.effectiveConfig.agentProfile?.name ?? 'Agent'}</span></div>
      <p>{runGuidance(run)}</p>
      {run.phase !== 'finished' && <div className="dsh-wb-run-progress"><b>最新进度</b>
        <span>{latestProgress?.text || '尚未收到进度回报，可在「执行过程」查看 Agent 活动。'}</span>
        {latestProgress && <time>{fmt(latestProgress.at)}</time>}</div>}
      {run.phase !== 'finished' && lastActivity && <p className="dsh-wb-run-latest">
        最近活动 · {eventLabel(lastActivity)} · {fmt(lastActivity.at)}
        {lastActivity.kind === 'assistant' && lastActivity.text ? ' · ' + preview(lastActivity.text, 70) : ''}
      </p>}
      {run.phase !== 'finished' && <div className="dsh-wb-row">
        <button className="dsh-wb-btn danger" onClick={() => void onCancel()}>取消执行</button>
        <button className="dsh-wb-btn" onClick={() => onAskTakeover()}>人工接管</button>
        {run.phase === 'reconciling' && <button className="dsh-wb-btn" onClick={() => onAskResolve()}>确认静止并收尾</button>}
      </div>}
    </section>
    <div className="dsh-wb-run-facts">
      <div><span>开始时间</span><strong>{fmt(run.createdAt)}</strong></div>
      <div><span>{run.phase === 'finished' ? '总耗时' : '已运行'}</span><strong>{elapsed(run)}</strong></div>
      <div><span>最近进度回报</span><strong>{fmt(run.lastProgressAt)}</strong></div>
      <div><span>执行模型</span><strong>{run.effectiveConfig.modelProvider}/{run.effectiveConfig.model}</strong></div>
    </div>
    {run.writeback.lastErrorCode && <div className="dsh-wb-error">任务状态同步失败：{run.writeback.lastErrorCode}</div>}
    <div className="dsh-wb-run-tabs" role="tablist" aria-label="执行详情视图">
      {([['overview', '结果概览'], ['activity', '执行过程'], ['raw', '原始记录']] as const).map(([key, label]) =>
        <button key={key} type="button" role="tab" aria-selected={view === key} className={view === key ? 'active' : ''}
          onClick={() => setView(key)}>{label}</button>)}
    </div>
    {view === 'overview' && <section className="dsh-wb-panel dsh-wb-run-content">
      {run.result && !resultRepeatsReport && <div className="dsh-wb-run-result"><b>结果说明</b><p>{run.result.summary}</p></div>}
      {run.report ? <>
        <h3>Agent 交付报告</h3><div className="dsh-wb-copy">{run.report.summary}</div>
        {run.report.nextHint && <div className="dsh-wb-run-next"><b>建议下一步</b><p>{run.report.nextHint}</p></div>}
        <h3>证据 · {run.report.evidence?.length ?? 0}</h3>
        {run.report.evidence?.length ? <div className="dsh-wb-evidence-list">{run.report.evidence.map((item, i) => {
          const ref = typeof item === 'string' ? item : item.ref;
          return <div className="dsh-wb-evidence" key={i}>
            <span>{typeof item === 'string' ? '证据' : ({ log: '日志', artifact: '产物', metric: '指标', command: '命令', code_change: '代码修改' } as Record<string, string>)[item.kind] ?? item.kind}</span>
            <div><b>{typeof item === 'string' ? ref : item.summary || ref}</b><small>{evidencePath(run, ref)}</small></div>
            <button type="button" className="dsh-wb-link" onClick={() => void copyEvidence(i, ref)}>{copied === i ? '已复制' : '复制路径'}</button>
          </div>;
        })}</div> : <div className="dsh-wb-muted">本次报告未附证据引用。</div>}
        {copied === -2 && <p className="dsh-wb-muted">浏览器未允许复制，请手动选中上方路径。</p>}
      </> : <div className="dsh-wb-empty">{run.phase === 'finished' ? '本次执行没有提交报告。请查看结果说明和执行过程。' : 'Agent 尚未提交报告，执行过程可查看实时活动。'}</div>}
      <details className="dsh-wb-technical"><summary>技术信息</summary>
        <div>执行 ID：{run.id}</div><div>子会话：{run.runtime.childSessionId || '尚未创建'}</div>
        <div>内部阶段：{run.phase} · 状态同步：{run.writeback.state}</div>
        {run.result && <div>结束原因：{run.result.reasonCode}</div>}
        {(run.cancel || run.phase === 'reconciling') && <div>静止确认：{run.runtime.quiescence}</div>}
      </details>
    </section>}
    {view === 'activity' && <section className="dsh-wb-panel dsh-wb-run-content">
      <div className="dsh-wb-run-section-head"><div><h3>执行过程</h3><p>Agent 消息与工具调用分开展示；调用参数和结果默认收起。</p></div>
        <span>{activity.length} 条活动</span></div>
      <div className="dsh-wb-filter" role="group" aria-label="筛选执行活动">
        {([['all', '全部'], ['agent', 'Agent 消息'], ['tool', '工具调用'], ['error', '错误']] as const).map(([key, label]) =>
          <button key={key} type="button" className={filter === key ? 'active' : ''} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>)}
      </div>
      {error && <div className="dsh-wb-error">{error}</div>}
      {shown.length ? shown.map((item) => <ActivityCard key={item.event.seq} item={item} />) :
        <div className="dsh-wb-empty">{events.length ? '这个筛选条件下没有记录。' : '尚无可显示的活动；运行中会自动刷新。'}</div>}
      {more && <button className="dsh-wb-btn" onClick={() => void load(cursor, true)}>加载后续记录</button>}
    </section>}
    {view === 'raw' && <section className="dsh-wb-panel dsh-wb-run-content">
      <div className="dsh-wb-run-section-head"><div><h3>原始记录</h3><p>仅包含本次子会话的可见消息与工具事件，按事件序号排列。</p></div><span>{events.length} 条事件</span></div>
      {error && <div className="dsh-wb-error">{error}</div>}
      {events.map((event) => <div className="dsh-wb-raw-event" key={event.seq}>
        <div className="dsh-wb-muted">#{event.seq} · {fmt(event.at)} · {eventLabel(event)}{event.error ? ' · 错误' : ''}</div>
        {event.text && <ExpandableText text={event.text} label="查看原文" fold />}
      </div>)}
      {!events.length && <div className="dsh-wb-empty">暂无可显示的会话事件</div>}
      {more && <button className="dsh-wb-btn" onClick={() => void load(cursor, true)}>加载后续记录</button>}
    </section>}
  </div>;
}

function ComparisonColumn({ run, number }: { run: Run; number: number }) {
  return <div className="dsh-wb-compare-col">
    <div className="dsh-wb-row"><b>第 {number} 次</b><span className="dsh-wb-run-pill">{runLabel(run)}</span></div>
    <div className="dsh-wb-muted">{fmt(run.createdAt)} · {elapsed(run)}</div>
    <dl>
      <dt>结果</dt><dd>{run.result?.summary ?? runGuidance(run)}</dd>
      <dt>报告</dt><dd>{run.report?.summary ?? '未提交报告'}</dd>
      <dt>证据</dt><dd>{run.report?.evidence?.length ?? 0} 项</dd>
      <dt>模型</dt><dd>{run.effectiveConfig.modelProvider}/{run.effectiveConfig.model}</dd>
    </dl>
  </div>;
}
function RunHistory({ runs, selectedId, onSelect }: { runs: Run[]; selectedId: string; onSelect: (id: string) => void }) {
  const [compare, setCompare] = React.useState(false);
  const [leftId, setLeftId] = React.useState('');
  const [rightId, setRightId] = React.useState('');
  const left = runs.find((run) => run.id === leftId) ?? runs.at(-2);
  const right = runs.find((run) => run.id === rightId) ?? runs.at(-1);
  if (runs.length === 1) return null;
  return <section className="dsh-wb-panel">
    <div className="dsh-wb-run-section-head"><div><h3>执行历史 · {runs.length}</h3><p>每次运行独立保存；选择一条查看结果和完整记录。</p></div>
      {runs.length > 1 && <button className="dsh-wb-btn" aria-expanded={compare} onClick={() => setCompare(!compare)}>
        {compare ? '收起对比' : '对比两次运行'}</button>}</div>
    {runs.length ? <div className="dsh-wb-run-list">{[...runs].reverse().map((run) => {
      const number = runs.findIndex((item) => item.id === run.id) + 1;
      return <button type="button" key={run.id} className={'dsh-wb-run-choice' + (selectedId === run.id ? ' active' : '')}
        aria-pressed={selectedId === run.id} onClick={() => onSelect(run.id)}>
        <span className="dsh-wb-run-choice-top"><b>第 {number} 次{number === runs.length ? ' · 最新' : ''}</b><span className="dsh-wb-run-pill">{runLabel(run)}</span></span>
        <small>{fmt(run.createdAt)} · {elapsed(run)}</small>
        <span>{preview(run.report?.summary ?? run.result?.summary ?? runGuidance(run), 110)}</span>
      </button>;
    })}</div> : <div className="dsh-wb-empty">尚未运行。分派 Agent 后点击「手动运行」。</div>}
    {compare && left && right && <div className="dsh-wb-compare">
      <div className="dsh-wb-compare-controls">
        <label>左侧运行<select className="dsh-wb-select" value={left.id} onChange={(event) => setLeftId(event.target.value)}>
          {runs.map((run, i) => <option key={run.id} value={run.id}>第 {i + 1} 次 · {runLabel(run)}</option>)}</select></label>
        <label>右侧运行<select className="dsh-wb-select" value={right.id} onChange={(event) => setRightId(event.target.value)}>
          {runs.map((run, i) => <option key={run.id} value={run.id}>第 {i + 1} 次 · {runLabel(run)}</option>)}</select></label>
      </div>
      <div className="dsh-wb-compare-grid"><ComparisonColumn run={left} number={runs.indexOf(left) + 1} />
        <ComparisonColumn run={right} number={runs.indexOf(right) + 1} /></div>
    </div>}
  </section>;
}
function TaskTimeline({ items, onRun }: { items: Timeline[]; onRun: (id: string) => void }) {
  const title = (event: Timeline) => event.kind === 'progress' ? '进度更新' : event.kind === 'review' ? '人工验收' :
    event.kind === 'comment' ? '评论' : event.text === '开始执行' ? '开始执行' : '执行结束';
  return <div className="dsh-wb-task-timeline">{items.length ? items.map((event) => {
    const body = event.kind === 'run' && /^[A-Z_]+:/.test(event.text) ? event.text.slice(event.text.indexOf(':') + 1) : event.text;
    return <article className="dsh-wb-task-event" key={event.id}>
      <div className="dsh-wb-activity-head"><span className="dsh-wb-activity-kind">{title(event)}</span><time>{fmt(event.at)}</time></div>
      <ExpandableText text={body} label="查看事件内容" fold={event.kind === 'run' && event.text !== '开始执行'} />
      {event.runId && <button className="dsh-wb-link" onClick={() => onRun(event.runId!)}>查看关联执行 →</button>}
    </article>;
  }) : <div className="dsh-wb-empty">暂无讨论或状态更新</div>}</div>;
}
function Workbench() {
  const [page, setPage] = React.useState<Page>('overview');
  const [overview, setOverview] = React.useState<Overview>(EMPTY);
  const [models, setModels] = React.useState<Models>({ allowed: [], default: '' });
  const [legacy, setLegacy] = React.useState<Run[]>([]);
  const [projectId, setProjectId] = React.useState('');
  const [layout, setLayout] = React.useState<'board' | 'list'>('board');
  const [statusFilter, setStatusFilter] = React.useState<Status | ''>('');
  const [taskId, setTaskId] = React.useState('');
  const [detail, setDetail] = React.useState<{ task: Task; runs: Run[] } | null>(null);
  const [runId, setRunId] = React.useState('');
  const [modal, setModal] = React.useState<'project' | 'agent' | 'task' | null>(null);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [form, setForm] = React.useState<Record<string, string>>({});
  const [toolAllow, setToolAllow] = React.useState<string[]>(Object.keys(TOOLS));
  const [comment, setComment] = React.useState('');
  const [reviewText, setReviewText] = React.useState('');
  const [error, setError] = React.useState('');
  const [formError, setFormError] = React.useState('');
  const [detailError, setDetailError] = React.useState('');
  const [confirmReq, setConfirmReq] = React.useState<ConfirmRequest | null>(null);
  const [busy, setBusy] = React.useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor));
  const selected = taskId && detail?.task.id === taskId ? detail.task : null;
  const selectedRun = detail?.runs.find((run) => run.id === runId);
  const scoped = projectId ? overview.tasks.filter((task) => task.projectId === projectId) : overview.tasks;
  const filtered = statusFilter ? scoped.filter((task) => task.status === statusFilter) : scoped;
  const project = overview.projects.find((p) => p.id === projectId);

  const refresh = React.useCallback(async () => {
    try {
      const value = await api<Overview>(`${BASE}/overview`);
      setOverview(value);
      setError('');
    } catch (e) { setError(errorText(e)); }
  }, []);
  const refreshDetail = React.useCallback(async (id: string) => {
    try {
      const next = await api<{ task: Task; runs: Run[] }>(`${BASE}/tasks/${encodeURIComponent(id)}`);
      setDetail(next);
      setRunId((current) => next.runs.some((run) => run.id === current) ? current : (next.runs.at(-1)?.id ?? ''));
      setError('');
    }
    catch (e) { setError(errorText(e)); }
  }, []);
  React.useEffect(() => {
    void refresh(); void api<Models>(`${BASE}/models`).then(setModels).catch((e) => setError(errorText(e)));
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  React.useEffect(() => {
    if (!taskId) return;
    void refreshDetail(taskId);
    const timer = setInterval(() => { if (!document.hidden) void refreshDetail(taskId); }, 5000);
    return () => clearInterval(timer);
  }, [taskId, refreshDetail]);
  React.useEffect(() => {
    if (page === 'legacy') void api<{ runs: Run[] }>(`${BASE}/legacy`).then((x) => setLegacy(x.runs)).catch((e) => setError(errorText(e)));
  }, [page]);
  React.useEffect(() => { const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { if (confirmReq) return; if (modal) setModal(null); else if (taskId) setTaskId(''); else setOpen(false); } };
    document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key); }, [modal, taskId, confirmReq]);

  async function mutate(action: () => Promise<unknown>, scope: 'page' | 'detail' | 'modal' = 'page') {
    if (overview.readOnly) {
      const text = '工作台处于只读故障态，请检查 DSH 宿主日志和存储备份。';
      if (scope === 'modal') setFormError(text); else if (scope === 'detail') setDetailError(text); else showToast(text, 'error');
      return false;
    }
    setBusy(true);
    if (scope === 'modal') setFormError(''); else if (scope === 'detail') setDetailError(''); else setError('');
    try { await action(); await refresh(); if (taskId) await refreshDetail(taskId); return true; }
    catch (e) {
      const text = friendlyError(e);
      if (scope === 'modal') setFormError(text); else if (scope === 'detail') setDetailError(text); else showToast(text, 'error');
      await refresh(); if (taskId) await refreshDetail(taskId);
      return false;
    }
    finally { setBusy(false); }
  }
  function begin(kind: 'project' | 'agent' | 'task', id?: string) {
    const item = kind === 'project' ? overview.projects.find((p) => p.id === id) : kind === 'agent' ? overview.agents.find((a) => a.id === id) : overview.tasks.find((t) => t.id === id);
    setEditing(id ?? null);
    setFormError('');
    if (kind === 'agent') setToolAllow((item as Agent | undefined)?.toolAllow ?? Object.keys(TOOLS));
    setForm(item ? Object.fromEntries(Object.entries(item).map(([k, v]) => [k, String(v ?? '')])) :
      kind === 'task' ? { projectId: projectId || overview.projects[0]?.id || '', title: '', description: '', acceptanceCriteria: '', assigneeId: '' } :
      kind === 'agent' ? { name: '', instructions: '', model: models.default } : { title: '', root: '' });
    setModal(kind);
  }
  async function saveModal() {
    if (!modal) return;
    const kind = modal;
    // 客户端必填校验:失败留在 modal 内展示,不打扰后端
    const missing: string[] = [];
    if (!form.title?.trim() && kind !== 'agent') missing.push(kind === 'task' ? '任务标题' : '项目名称');
    if (kind === 'project' && !editing && !form.root?.trim()) missing.push('本机工作区绝对路径');
    if (kind === 'agent' && !form.name?.trim()) missing.push('Agent 名称');
    if (kind === 'task') {
      if (!form.acceptanceCriteria?.trim()) missing.push('验收标准');
      if (!form.projectId) missing.push('所属项目');
    }
    if (missing.length) { setFormError(`请填写:${missing.join('、')}`); return; }
    const endpoint = kind === 'project' ? 'projects' : kind === 'agent' ? 'agents' : 'tasks';
    const current = editing ? (kind === 'project' ? overview.projects : kind === 'agent' ? overview.agents : overview.tasks).find((x) => x.id === editing) : undefined;
    const body = kind === 'project' ? { title: form.title, root: form.root, expectedRevision: current?.revision } :
      kind === 'agent' ? { name: form.name, instructions: form.instructions, model: form.model, toolAllow, expectedRevision: current?.revision } :
      { projectId: form.projectId, title: form.title, description: form.description, acceptanceCriteria: form.acceptanceCriteria,
        assigneeId: form.assigneeId || null, expectedRevision: current?.revision };
    const ok = await mutate(() => write(`/${endpoint}${editing ? `/${editing}` : ''}`, editing ? 'PATCH' : 'POST', body), 'modal');
    if (ok) { setModal(null); if (kind === 'task' && taskId) void refreshDetail(taskId); }
  }
  function moveTask(id: string, status: Status) {
    const task = overview.tasks.find((t) => t.id === id);
    if (!task) return;
    if (task.owner) { showToast('任务执行中,状态由运行流程管理;请先取消或等待完成。', 'warn'); return; }
    if (!['todo', 'blocked'].includes(task.status)) { showToast('该状态由运行或验收流程流转,不能手工切换。', 'warn'); return; }
    if (!['todo', 'blocked'].includes(status)) {
      showToast(status === 'in_progress' ? '「执行中」由「手动运行」进入,不能拖入。' : `「${LABEL[status]}」由人工验收流转,不能拖入。`, 'warn');
      return;
    }
    if (status === task.status) return;
    void mutate(() => write(`/tasks/${id}`, 'PATCH', { expectedRevision: task.revision, status }), 'detail');
  }
  function onDragEnd(event: DragEndEvent) { if (event.over) moveTask(String(event.active.id), String(event.over.id) as Status); }
  const taskButton = (id: string) => { setDetail(null); setDetailError(''); setTaskId(id); setRunId(''); };
  const counts = overview.counts;
  return <div className="dsh-wb" data-dsh-plugin="dsh-dispatch" data-dsh-part="workbench"><style>{workbenchCss}</style>
    <ToastHost />
    <nav className="dsh-wb-nav" aria-label="工作台导航">
      <div className="dsh-wb-brand"><small>DSH DISPATCH</small>AI 团队工作台</div>
      {([['overview', '◫', '总览'], ['tasks', '▤', '任务'], ['projects', '⊀', '项目'], ['agents', '◈', 'Agent 目录'], ['legacy', '⧖', '旧派发历史']] as const).map(([key, ico, title]) =>
        <button className={`dsh-wb-navbtn${page === key ? ' active' : ''}`} key={key} onClick={() => setPage(key)}><span className="dsp-nav-ico" aria-hidden>{ico}</span><span>{title}</span></button>)}
      <div className="dsh-wb-navfoot">同一时间运行一个任务;<br />完成后由你验收归档。</div>
    </nav>
    <main className="dsh-wb-main">
      <header className="dsh-wb-head"><div><div className="dsh-wb-kicker">DSH / DISPATCH</div><h1>{page === 'overview' ? '工作总览' : page === 'tasks' ? '任务' : page === 'projects' ? '项目' : page === 'agents' ? 'Agent 目录' : '旧派发历史'}</h1></div>
        <div className="dsh-wb-head-actions"><button className="dsh-wb-btn" onClick={() => void refresh()}>刷新</button><button className="dsh-wb-btn ghost" onClick={() => setOpen(false)} aria-label="关闭工作台">关闭 ✕</button></div></header>
      {error && <div role="alert" className="dsh-wb-error">{error}</div>}
      {overview.readOnly && <div role="status" className="dsh-wb-error">工作台当前只读；项目、任务和历史记录仍可查看。</div>}
      {page === 'overview' && <>
        <div className="dsh-wb-grid dsp-stagger">{STATUS.map((s, i) =>
          <button type="button" className="dsh-wb-stat" key={s} data-tone={s} style={{ ['--dsp-i' as string]: String(i) }}
            onClick={() => { setPage('tasks'); setStatusFilter(s); }} title={`查看${LABEL[s]}任务`}>
            <span>{LABEL[s]}</span><strong>{counts[s]}</strong>
          </button>)}</div>
        <div className="dsh-wb-panel"><div className="dsh-wb-row" style={{ justifyContent: 'space-between' }}><h2>当前项目</h2><button className="dsh-wb-btn primary" onClick={() => begin('project')}>新建项目</button></div>
          {overview.projects.length ? overview.projects.map((p) => <div className="dsh-wb-row" key={p.id} style={{ padding: '9px 0' }}><button className="dsh-wb-link" onClick={() => { setProjectId(p.id); setPage('tasks'); }}>{p.title}</button><span className="dsh-wb-muted">{overview.tasks.filter((t) => t.projectId === p.id).length} 个任务 · {p.root}</span></div>) : <div className="dsh-wb-empty">先创建一个项目并绑定本机工作区。</div>}</div>
        <div className="dsh-wb-panel"><div className="dsh-wb-row" style={{ justifyContent: 'space-between' }}><h2>最近任务</h2><button className="dsh-wb-btn" onClick={() => setPage('tasks')}>查看全部</button></div>
          {[...overview.tasks].sort((a, b) => b.revision - a.revision).slice(0, 8).map((t) => <div key={t.id} className="dsh-wb-row" style={{ padding: '8px 0' }}><button className="dsh-wb-link" onClick={() => taskButton(t.id)}>{t.title}</button><span className="dsh-wb-muted">{LABEL[t.status]}</span></div>)}</div>
      </>}
      {page === 'tasks' && <><div className="dsh-wb-toolbar"><select className="dsh-wb-select" aria-label="按项目筛选" value={projectId} onChange={(e) => setProjectId(e.target.value)}><option value="">全部项目</option>{overview.projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select>
        <select className="dsh-wb-select" aria-label="按状态筛选" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as Status | '')}><option value="">全部状态</option>{STATUS.map((s) => <option key={s} value={s}>{LABEL[s]}</option>)}</select>
        <button className={`dsh-wb-btn${layout === 'board' ? ' primary' : ''}`} onClick={() => setLayout('board')}>看板</button><button className={`dsh-wb-btn${layout === 'list' ? ' primary' : ''}`} onClick={() => setLayout('list')}>列表</button>
        <button className="dsh-wb-btn primary" disabled={!overview.projects.length} onClick={() => begin('task')}>新建任务</button></div>
        {project && <p className="dsh-wb-muted">工作区：{project.root}</p>}
        {layout === 'board' ? <DndContext sensors={sensors} onDragEnd={onDragEnd}><div className="dsh-wb-board">{STATUS.map((s) => <Column key={s} status={s} tasks={filtered.filter((t) => t.status === s)} agents={overview.agents} onTask={taskButton} />)}</div></DndContext> :
          <div className="dsh-wb-panel"><table className="dsh-wb-table"><thead><tr><th>任务</th><th>项目</th><th>执行者</th><th>状态</th><th>Run</th></tr></thead><tbody>{filtered.map((t) => <tr key={t.id}><td><button className="dsh-wb-link" onClick={() => taskButton(t.id)}>{t.title}</button></td><td>{overview.projects.find((p) => p.id === t.projectId)?.title}</td><td>{overview.agents.find((a) => a.id === t.assigneeId)?.name ?? '未分派'}</td><td>{LABEL[t.status]}</td><td>{t.runIds.length}</td></tr>)}</tbody></table>{!filtered.length && <div className="dsh-wb-empty">暂无任务</div>}</div>}</>}
      {page === 'projects' && <><button className="dsh-wb-btn primary" onClick={() => begin('project')}>新建项目</button><div style={{ height: 16 }} />
        {overview.projects.map((p) => <div className="dsh-wb-panel" key={p.id}><div className="dsh-wb-row" style={{ justifyContent: 'space-between' }}><h2>{p.title}</h2><button className="dsh-wb-btn" onClick={() => begin('project', p.id)}>重命名</button></div><div className="dsh-wb-code">{p.root}</div><button className="dsh-wb-link" onClick={() => { setProjectId(p.id); setPage('tasks'); }}>查看 {overview.tasks.filter((t) => t.projectId === p.id).length} 个任务 →</button></div>)}</>}
      {page === 'agents' && <><button className="dsh-wb-btn primary" onClick={() => begin('agent')}>新建 Agent</button><div style={{ height: 16 }} />
        <div className="dsp-stagger">{overview.agents.map((a, i) => <div className="dsh-wb-panel" key={a.id} style={{ ['--dsp-i' as string]: String(i) }}>
          <div className="dsh-wb-row" style={{ justifyContent: 'space-between' }}><h2>{a.name}</h2><button className="dsh-wb-btn" onClick={() => begin('agent', a.id)}>编辑</button></div>
          <div className="dsh-wb-muted">模型:{a.model} · 已分派 {overview.tasks.filter((t) => t.assigneeId === a.id).length} 个任务 · 工具 {a.toolAllow.length}/{Object.keys(TOOLS).length}</div>
          <ExpandableText text={a.instructions} label="展开完整工作指令" fold /></div>)}</div></>}
      {page === 'legacy' && <div className="dsh-wb-panel"><p className="dsh-wb-muted">旧 trajectory 派发仅供查看,不会自动成为已验收任务。共 {overview.legacyCount} 条。</p>
        <table className="dsh-wb-table"><thead><tr><th>目标</th><th>结果</th><th>开始</th><th>结束</th></tr></thead><tbody>{legacy.map((r) => <tr key={r.id}><td>{r.targetType === 'workbench_task' ? '工作台任务' : r.targetRef.nodeId}</td><td>{OUTCOME_LABEL[r.result?.kind ?? ''] ?? PHASE_LABEL[r.phase] ?? r.phase}</td><td>{fmt(r.createdAt)}</td><td>{fmt(r.endedAt)}</td></tr>)}</tbody></table></div>}
    </main>
    {selected && <><button className="dsh-wb-backdrop" aria-label="关闭任务详情" onClick={() => setTaskId('')} /><aside className="dsh-wb-detail" aria-label="任务详情">
      <div className="dsh-wb-row" style={{ justifyContent: 'space-between' }}><span className="dsh-wb-kicker">TASK / {selected.id}</span><button className="dsh-wb-btn ghost" onClick={() => setTaskId('')}>关闭 ✕</button></div>
      <h1>{selected.title}</h1><p className="dsh-wb-muted">{overview.projects.find((p) => p.id === selected.projectId)?.title} · {LABEL[selected.status]}</p>
      {detailError && <div role="alert" className="dsh-wb-error">{detailError}</div>}
      <div className="dsh-wb-row" style={{ margin: '16px 0' }}><button className="dsh-wb-btn" disabled={!!selected.owner || ['in_review', 'done'].includes(selected.status)} onClick={() => begin('task', selected.id)}>编辑任务</button>
        {selected.status === 'done' && <button className="dsh-wb-btn" disabled={busy} onClick={() => void mutate(() => write(`/tasks/${selected.id}`, 'PATCH', { expectedRevision: selected.revision, status: 'todo' }), 'detail')}>重新打开</button>}
        {['todo', 'blocked'].includes(selected.status) && !selected.owner && <select className="dsh-wb-select" aria-label="修改任务状态" value={selected.status} onChange={(e) => moveTask(selected.id, e.target.value as Status)}><option value="todo">待办</option><option value="blocked">受阻</option></select>}</div>
      <details className="dsh-wb-panel dsh-wb-task-brief" key={selected.id} open={!selected.runIds.length}>
        <summary><b>任务要求与验收标准</b><span>{preview(selected.acceptanceCriteria, 90)}</span></summary>
        <h3>任务目标</h3><p style={{ whiteSpace: 'pre-wrap' }}>{selected.description || '无补充说明'}</p>
        <h3>验收标准</h3><p style={{ whiteSpace: 'pre-wrap' }}>{selected.acceptanceCriteria}</p>
      </details>
      <div className="dsh-wb-panel dsh-wb-assignment">
        <div className="dsh-wb-row"><span>执行者：</span><select className="dsh-wb-select" aria-label="分派 Agent" disabled={!!selected.owner || busy} value={selected.assigneeId ?? ''} onChange={(e) => void mutate(() => write('/tasks/' + selected.id, 'PATCH', { expectedRevision: selected.revision, assigneeId: e.target.value || null }), 'detail')}><option value="">未分派</option>{overview.agents.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.model}</option>)}</select>
          {['todo', 'blocked'].includes(selected.status) && !selected.owner && <button className="dsh-wb-btn primary" disabled={!selected.assigneeId || busy} onClick={() => void mutate(() => write('/tasks/' + selected.id + '/run', 'POST', { idempotencyKey: 'ui-' + crypto.randomUUID() }), 'detail')}>手动运行</button>}</div>
        {selected.owner && <p className="dsh-wb-muted">执行中；目标与验收标准已锁定。取消后等待静止确认。</p>}
      </div>
      <RunHistory key={selected.id} runs={detail?.runs ?? []} selectedId={runId} onSelect={setRunId} />
      {selectedRun && <RunPanel key={selectedRun.id} run={selectedRun}
        latestProgress={[...selected.timeline].reverse().find((event) => event.kind === 'progress' && event.runId === selectedRun.id)}
        onCancel={async () => { await mutate(() => write('/runs/' + selectedRun.id + '/cancel', 'POST', { reason: '用户取消' }), 'detail'); }}
        onAskTakeover={() => setConfirmReq({
          title: '人工接管本次执行',
          description: '接管会撤销执行者的写入权限并请求其停止;迟到的报告不会再改动任务。请填写接管原因(审计记录)。',
          placeholder: '例如:方向需要调整 / 发现任务描述有误',
          confirmText: '接管', danger: true,
          onConfirm: (reason) => { setConfirmReq(null); void mutate(() => write('/runs/' + selectedRun.id + '/takeover', 'POST', { reason }), 'detail'); },
          onClose: () => setConfirmReq(null),
        })}
        onAskResolve={() => setConfirmReq({
          title: '确认已停止并收尾',
          description: '请先在「执行过程」确认子会话已停止且队列静止,再填写核验依据(操作员责任,审计记录)。',
          placeholder: '例如:已核查子会话无新事件、无残留进程',
          confirmText: '确认并收尾',
          onConfirm: (evidence) => { setConfirmReq(null); void mutate(() => write('/runs/' + selectedRun.id + '/resolve', 'POST', { evidence }), 'detail'); },
          onClose: () => setConfirmReq(null),
        })} />}
      {selected.status === 'in_review' && <div className="dsh-wb-panel dsh-wb-review">
        <h3>人工验收</h3><p>先核对上方选中运行的报告、证据和过程记录。接受后任务才会标记为已完成。</p>
        <textarea className="dsh-wb-textarea" aria-label="验收或退回意见" value={reviewText} onChange={(e) => setReviewText(e.target.value)} placeholder="退回时必须填写意见" />
        <div className="dsh-wb-row"><button className="dsh-wb-btn primary" disabled={busy} onClick={() => void mutate(() => write('/tasks/' + selected.id + '/review', 'POST', { expectedRevision: selected.revision, decision: 'accept', comment: reviewText }), 'detail')}>接受，标记完成</button>
          <button className="dsh-wb-btn" disabled={busy || !reviewText.trim()} onClick={() => void mutate(() => write('/tasks/' + selected.id + '/review', 'POST', { expectedRevision: selected.revision, decision: 'reject', comment: reviewText }), 'detail')}>退回待办</button></div>
      </div>}
      <div className="dsh-wb-panel"><h3>任务讨论与状态更新</h3><TaskTimeline items={selected.timeline} onRun={setRunId} />
        <textarea className="dsh-wb-textarea" aria-label="发表评论" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="记录问题、建议或决策" /><button className="dsh-wb-btn" disabled={!comment.trim() || busy} onClick={() => void mutate(() => write(`/tasks/${selected.id}/comments`, 'POST', { expectedRevision: selected.revision, text: comment }), 'detail').then((ok) => { if (ok) setComment(''); })}>发送评论</button></div>
    </aside></>}
    {modal && <><button className="dsh-wb-backdrop" style={{ zIndex: 112 }} aria-label="关闭表单" onClick={() => setModal(null)} /><div className="dsh-wb-modal" role="dialog" aria-modal="true" aria-label={editing ? '编辑' : '新建'}>
      <h2>{editing ? '编辑' : '新建'}{modal === 'project' ? '项目' : modal === 'agent' ? ' Agent' : '任务'}</h2>
      {formError && <div role="alert" className="dsh-wb-error">{formError}</div>}
      {modal === 'project' && <><Field autoFocus label="项目名称" value={form.title} onChange={(v) => setForm({ ...form, title: v })} />{editing ? <div className="dsh-wb-code">{form.root}</div> : <Field label="本机工作区绝对路径" hint="须位于 DSH_HOME 之外;一个路径只绑一个项目" value={form.root} onChange={(v) => setForm({ ...form, root: v })} />}</>}
      {modal === 'agent' && <><Field autoFocus label="Agent 名称" value={form.name} onChange={(v) => setForm({ ...form, name: v })} /><div className="dsh-wb-field"><label>模型</label><select className="dsh-wb-select" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })}>{models.allowed.map((m) => <option key={m}>{m}</option>)}</select></div><div className="dsh-wb-field"><label>工作指令</label><textarea className="dsh-wb-textarea" rows={Math.min(16, Math.max(4, (form.instructions ?? '').split('\n').length))} value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} /></div><div className="dsh-wb-field"><label>受控工具权限</label><div className="dsh-wb-row">{Object.entries(TOOLS).map(([name, label]) => <label key={name} className="dsh-wb-row"><input type="checkbox" checked={toolAllow.includes(name)} onChange={(e) => setToolAllow(e.target.checked ? [...toolAllow, name] : toolAllow.filter((x) => x !== name))} />{label}</label>)}</div></div></>}
      {modal === 'task' && <><div className="dsh-wb-field"><label>项目</label>{editing ? <div>{overview.projects.find((p) => p.id === form.projectId)?.title}</div> : <select className="dsh-wb-select" value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })}>{overview.projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select>}</div><Field autoFocus label="任务标题" value={form.title} onChange={(v) => setForm({ ...form, title: v })} /><div className="dsh-wb-field"><label>任务描述</label><textarea className="dsh-wb-textarea" rows={Math.min(10, Math.max(3, (form.description ?? '').split('\n').length))} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div><div className="dsh-wb-field"><label>验收标准(必填)</label><textarea className="dsh-wb-textarea" rows={Math.min(10, Math.max(3, (form.acceptanceCriteria ?? '').split('\n').length))} value={form.acceptanceCriteria} onChange={(e) => setForm({ ...form, acceptanceCriteria: e.target.value })} /></div><div className="dsh-wb-field"><label>分派 Agent（不会自动运行）</label><select className="dsh-wb-select" value={form.assigneeId} onChange={(e) => setForm({ ...form, assigneeId: e.target.value })}><option value="">暂不分派</option>{overview.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div></>}
      <div className="dsh-wb-row" style={{ justifyContent: 'flex-end' }}><button className="dsh-wb-btn" onClick={() => setModal(null)}>取消</button><button className="dsh-wb-btn primary" disabled={busy} onClick={() => void saveModal()}>保存</button></div>
    </div></>}
    {confirmReq && <ConfirmModal {...confirmReq} />}
  </div>;
}
function Field({ label, value, onChange, autoFocus, hint }: { label: string; value?: string; onChange: (v: string) => void; autoFocus?: boolean; hint?: string }) {
  return <div className="dsh-wb-field"><label>{label}</label><input className="dsh-wb-input" autoFocus={autoFocus} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />{hint && <small className="dsh-wb-field-hint">{hint}</small>}</div>;
}
export function WorkbenchOverlay() {
  const open = React.useSyncExternalStore(subscribe, openSnapshot);
  return open ? <Workbench /> : null;
}
