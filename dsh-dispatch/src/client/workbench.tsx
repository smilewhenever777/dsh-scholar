import React from 'react';
import { DndContext, KeyboardSensor, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { api } from './api';
import { ConfirmModal, ToastHost, showToast, useModalFocus, type ConfirmRequest } from './feedback';
import { renderMarkdown, markdownCss } from './markdown';
import { workbenchCss } from './workbench-style';

type Status = 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done';
type Page = 'overview' | 'tasks' | 'projects' | 'agents' | 'squads' | 'automations' | 'legacy';
type Project = { id: string; title: string; root: string; revision: number; goal?: string; description?: string; archivedAt?: number };
type Agent = { id: string; name: string; instructions: string; model: string; toolAllow: string[]; revision: number; displayDescription?: string };
type Timeline = { id: string; kind: string; at: number; text: string; runId?: string; actor: string };
type Task = { id: string; projectId: string; title: string; description: string; acceptanceCriteria: string; assigneeId?: string;
  assignment?: { kind: string; id: string }; updatedAt?: number;
  status: Status; revision: number; runIds: string[]; timeline: Timeline[]; timelineTotal?: number; owner?: { dispatchId: string } };
type SquadStep = { agentId: string; responsibility: string };
type SquadExecution = { id: string; taskId: string; squadId: string; steps: SquadStep[]; currentStep: number;
  state: 'running' | 'paused_failed' | 'completed' | 'aborted'; runIds: string[]; pauseReason?: string;
  waitReason?: string; waitSince?: number; handoffs?: Record<string, { fromAgent: string; summary: string; evidence?: string[]; at: number }>;
  createdAt: number; updatedAt: number };
const EXEC_LABEL: Record<string, string> = { running: '执行中', paused_failed: '已暂停(失败)', completed: '已完成', aborted: '已取消' };
type Squad = { id: string; name: string; description: string; steps: SquadStep[]; revision: number; createdAt: number; updatedAt: number };
type AutomationRule = { id: string; name: string; enabled: boolean; cron: string; timezone: string; template: { projectId: string; title: string; description: string; acceptanceCriteria: string; assigneeId: string }; nextTriggerAt?: number; revision: number };
type TriggerAttempt = { id: string; ruleId: string; ruleName: string; scheduledAt: number; result: string; reason?: string; taskId?: string; at: number };
type Run = { id: string; phase: string; createdAt: number; acceptedAt?: number; lastProgressAt?: number; endedAt?: number; runtime: { childSessionId: string; quiescence: string };
  effectiveConfig: { modelProvider: string; model: string; agentProfile?: { name: string } };
  report?: { outcome: string; summary: string; evidence: ({ kind: string; ref: string; summary?: string } | string)[]; nextHint?: string };
  result?: { kind: string; reasonCode: string; summary: string }; writeback: { state: string; lastErrorCode?: string };
  targetRef: { nodeId: string; canonicalRoot?: string }; targetType: string; cancel?: { reason: string } };
type Overview = { projects: Project[]; agents: Agent[]; tasks: Task[]; counts: Record<Status, number>; legacyCount: number; concurrency?: { active: number; max: number }; readOnly: boolean; revision?: number; squads?: Squad[] };
type Event = { seq: number; at: number; kind: string; text?: string; name?: string; error?: boolean; interrupted?: boolean };
type Models = { allowed: string[]; default: string; available?: string[] };

const BASE = '/dispatch/workbench';
const STATUS: Status[] = ['todo', 'in_progress', 'in_review', 'blocked', 'done'];
const LABEL: Record<Status, string> = { todo: '待办', in_progress: '执行中', in_review: '待验收', blocked: '受阻', done: '已完成' };
const TOOLS: Record<string, string> = { dispatch_read_file: '读取文件', dispatch_list_dir: '列出目录', dispatch_write_report: '写入报告', dispatch_progress: '提交进度', dispatch_report: '提交结果' };
const EMPTY: Overview = { projects: [], agents: [], tasks: [], counts: { todo: 0, in_progress: 0, in_review: 0, blocked: 0, done: 0 }, legacyCount: 0, readOnly: false };
type BrowseEntry = { name: string; path: string; blocked: boolean };
type BrowseResult = { path: string; parent: string | null; blocked: boolean; home: string; drives: string[]; dirs: BrowseEntry[]; truncated: boolean };
/** v2:从 assignment 或旧 assigneeId 取分派 Agent id(客户端兼容读取) */
function assigneeOf(task: Task): string | undefined { return task.assignment?.id ?? task.assigneeId; }
const state = { open: false, listeners: new Set<() => void>() };
function subscribe(fn: () => void) { state.listeners.add(fn); return () => { state.listeners.delete(fn); }; }
function openSnapshot() { return state.open; }
function setOpen(value: boolean) { state.open = value; for (const fn of state.listeners) fn(); }
export function openWorkbench() { setOpen(true); }
function fmt(ts?: number) { return ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—'; }
function relTime(ts?: number): string {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return fmt(ts);
}
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
  // P1-3:全列可悬停;不可放置列在 CSS data-accepts="no" 中视觉标灰+拖入提示
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const droppable = status === 'todo' || status === 'blocked';
  return <section ref={setNodeRef}
    className={`dsh-wb-col${isOver ? ' over' : ''}${isOver && !droppable ? ' reject' : ''}`}
    aria-label={LABEL[status]} data-accepts={droppable ? 'yes' : 'no'}>
    <div className="dsh-wb-col-head"><span>{LABEL[status]}</span><em>{tasks.length}</em></div>
    {tasks.map((task) => <TaskCard key={task.id} task={task} agent={agents.find((a) => a.id === assigneeOf(task))} onTask={onTask} />)}
    {!tasks.length && <div className="dsh-wb-col-empty" />}
  </section>;
}
function TaskCard({ task, agent, onTask }: { task: Task; agent?: Agent; onTask: (id: string) => void }) {
  const movable = (task.status === 'todo' || task.status === 'blocked') && !task.owner;
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: task.id, disabled: !movable });
  // P1-3:卡片「下一步」提示(评审 §4.2.3)
  const nextStep = task.owner ? 'Agent 执行中'
    : task.status === 'in_review' ? '等待人工验收'
    : task.status === 'done' ? '已完成'
    : task.status === 'blocked' ? '受阻,需处理'
    : !assigneeOf(task) ? '待分派 Agent'
    : '待手动启动';
  return <article ref={setNodeRef} className="dsh-wb-card" style={{ opacity: isDragging ? .55 : 1,
    transform: transform ? `translate3d(${transform.x}px,${transform.y}px,0)` : undefined }}>
    <div className="dsh-wb-row"><button className="dsh-wb-card-title" onClick={() => onTask(task.id)}>{task.title}</button>
      {task.owner && <span className="dsh-wb-card-live" title="执行中" aria-label="执行中" />}
      {movable && <button type="button" className="dsh-wb-drag" title="拖动任务;也可在详情中使用状态选择"
        {...attributes} {...listeners}>⠿</button>}</div>
    <div className="dsh-wb-card-next" data-tone={task.status === 'in_review' ? 'review' : task.owner ? 'run' : task.status === 'blocked' ? 'blocked' : 'idle'}>{nextStep}</div>
    {task.description && <div className="dsh-wb-card-desc">{preview(task.description, 56)}</div>}
  </article>;
}

function ExpandableText({ text, label, fold = false }: { text: string; label: string; fold?: boolean }) {
  if (!text) return null;
  if (!fold && text.length <= 1800) return <div className="dsh-wb-copy">{text}</div>;
  return <details className="dsh-wb-expand"><summary>{label} · {text.length} 字 <span>{preview(text, 90)}</span></summary>
    <pre>{text}</pre></details>;
}
type PreviewData = { ref: string; kind: 'text' | 'html' | 'image' | 'pdf'; content?: string; base64?: string; mime?: string; size: number; truncated: boolean };
function isolatedHtml(content: string) {
  // 部分 HTML 交付物靠内联脚本渲染。脚本只在无同源权限的 iframe 内执行，CSP 封闭网络与嵌套内容。
  const policy = "default-src 'none'; script-src 'unsafe-inline'; img-src data:; style-src 'unsafe-inline'; font-src data:; frame-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'";
  // 预览不写浏览器历史；srcdoc 的不透明源也无法写入宿主 URL。
  const previewBridge = '<script>try{history.replaceState=function(){};history.pushState=function(){}}catch(e){};addEventListener("keydown",function(e){if(e.key==="Escape")parent.postMessage({type:"dsh-dispatch-preview-escape"},"*")},true)</script>';
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer">${previewBridge}${content}`;
}
function EvidencePreview({ data, onClose }: { data: PreviewData; onClose: () => void }) {
  const [source, setSource] = React.useState(false);
  const ref = useModalFocus(onClose);
  const frameRef = React.useRef<HTMLIFrameElement | null>(null);
  React.useEffect(() => {
    if (data.kind !== 'html') return;
    const onMessage = (event: MessageEvent) => {
      if (event.source === frameRef.current?.contentWindow && event.data?.type === 'dsh-dispatch-preview-escape') onClose();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [data.kind, onClose]);
  const mediaUrl = data.base64 && data.mime ? `data:${data.mime};base64,${data.base64}` : '';
  return <>
    <button type="button" className="dsh-wb-backdrop" style={{ zIndex: 114 }} aria-label="关闭预览" onClick={onClose} />
    <div ref={ref} className="dsh-wb-modal dsh-wb-preview" role="dialog" aria-modal="true" aria-label="文件预览">
      <div className="dsh-wb-preview-head">
        <div><b>{data.ref.split(/[\\/]/).pop()}</b><span>{data.kind === 'html' ? 'HTML 页面' : data.kind === 'image' ? '图片' : data.kind === 'pdf' ? 'PDF 文档' : '文本文件'}</span></div>
        <div className="dsh-wb-row">
          {data.kind === 'html' && <button type="button" className="dsh-wb-btn" aria-pressed={source} onClick={() => setSource(!source)}>{source ? '查看页面' : '查看源码'}</button>}
          <button type="button" className="dsh-wb-btn ghost" onClick={onClose}>关闭 ✕</button>
        </div>
      </div>
      <p className="dsh-wb-muted">{data.size} 字节{data.truncated ? ' · 已截断' : ''} · {data.ref}</p>
      {data.kind === 'html' && !source && <>
        <p className="dsh-wb-preview-note">隔离预览：页面脚本仅在沙箱内运行；同源访问、网络请求与表单提交已禁用。</p>
        <iframe ref={frameRef} className="dsh-wb-preview-frame" title={`${data.ref} 页面预览`} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={isolatedHtml(data.content ?? '')} />
      </>}
      {data.kind === 'image' && <div className="dsh-wb-preview-media"><img src={mediaUrl} alt={data.ref.split(/[\\/]/).pop() ?? '交付物图片'} /></div>}
      {data.kind === 'pdf' && <iframe className="dsh-wb-preview-frame" title={`${data.ref} PDF 预览`} sandbox="" referrerPolicy="no-referrer" src={mediaUrl} />}
      {(data.kind === 'text' || source) && <div className="dsh-wb-preview-content">{data.content ?? ''}</div>}
    </div>
  </>;
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
  // Wave 3:Agent 消息按对话气泡排版(头像 chip + 气泡);markdown 受限渲染
  if (kind === 'agent') {
    return <article className={'dsh-wb-chat' + (event.error ? ' error' : '')}>
      <span className="dsh-wb-chat-avatar" aria-hidden>◈</span>
      <div className="dsh-wb-chat-body">
        <div className="dsh-wb-chat-meta"><b>{eventLabel(event)}</b><time>{fmt(event.at)}</time></div>
        {event.text && event.text.length > 1800
          ? <ExpandableText text={event.text} label="展开完整消息" />
          : <div className="dsh-wb-chat-text">{renderMarkdown(event.text ?? '')}</div>}
      </div>
    </article>;
  }
  // P1-2:工具调用改为摘要行——工具名+目标+状态+时间一行扫读(评审 §4.4.2);详情次级展开
  if (kind === 'tool') {
    const toolName = TOOLS[event.name ?? ''] ?? event.name ?? '工具调用';
    let target = '';
    try { const args = JSON.parse(event.text ?? '{}'); target = args.path ?? args.filename ?? args.ref ?? (args.sequence != null ? `seq=${args.sequence}` : ''); } catch { target = preview(event.text ?? '', 40); }
    const status = result?.error ? 'err' : result ? 'ok' : 'wait';
    const statusLabel = result?.error ? '失败' : result ? '成功' : '…';
    return <article className="dsh-wb-activity tool">
      <div className="dsh-wb-tool-line">
        <span className="dsh-wb-tool-line-name">{toolName}</span>
        {target && <span className="dsh-wb-tool-line-target" title={target}>{target}</span>}
        <span className={'dsh-wb-tool-line-status ' + status}>{statusLabel}</span>
        <time>{fmt(event.at)}</time>
      </div>
      <details className="dsh-wb-expand">
        <summary><span>调用详情</span></summary>
        <ExpandableText text={event.text ?? ''} label="参数" fold />
        {result && <ExpandableText text={result.text ?? ''} label={result.error ? '错误结果' : '返回结果'} fold />}
      </details>
    </article>;
  }
  return <article className={'dsh-wb-activity ' + kind + (event.error || result?.error ? ' error' : '')}>
    <div className="dsh-wb-activity-head"><span className="dsh-wb-activity-kind">{eventLabel(event)}</span><time>{fmt(event.at)}</time>
      {result?.error && <strong>工具报错</strong>}</div>
    <ExpandableText text={event.text ?? ''} label="查看详情" fold />
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
  const [filter, setFilter] = React.useState<'key' | 'all' | 'agent' | 'tool' | 'error'>('key');
  const [order, setOrder] = React.useState<'asc' | 'desc'>('asc');
  const [copied, setCopied] = React.useState(-1);
  // P0-3:交付物安全预览
  const [previewLoading, setPreviewLoading] = React.useState('');
  const [previewData, setPreviewData] = React.useState<PreviewData | null>(null);
  const closePreview = React.useCallback(() => setPreviewData(null), []);
  // P0-3:交付物安全预览(评审 §4.5)——经服务端工作区校验读取
  async function previewFile(ref: string) {
    setPreviewLoading(ref);
    try {
      const result = await api<Omit<PreviewData, 'ref'> & { kind?: PreviewData['kind'] }>(`${BASE}/runs/${encodeURIComponent(run.id)}/preview?ref=${encodeURIComponent(ref)}`);
      // 已打开的旧宿主可能仍返回文本预览结构；重启后由服务端提供受限类型。
      const kind = result.kind ?? (!result.truncated && /\.html?$/i.test(ref) ? 'html' : 'text');
      setPreviewData({ ref, ...result, kind });
    } catch (e) { showToast(`预览失败:${errorText(e)}`, 'error'); }
    finally { setPreviewLoading(''); }
  }
  // Wave 3:自动滚动跟随——用户滚到底部附近时新事件自动滚入;离开底部显示「N 条新事件」浮标
  const scrollerRef = React.useRef<HTMLDivElement | null>(null);
  const [follow, setFollow] = React.useState(true);
  const [pendingNew, setPendingNew] = React.useState(0);
  const prevCountRef = React.useRef(0);
  const scroller = scrollerRef.current;
  const atBottom = !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
  React.useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      setFollow(bottom);
      if (bottom) setPendingNew(0);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [view]);
  React.useEffect(() => {
    if (events.length > prevCountRef.current && prevCountRef.current > 0 && !follow) {
      setPendingNew((n) => n + (events.length - prevCountRef.current));
    }
    prevCountRef.current = events.length;
    if (follow) {
      const el = scrollerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [events, follow]);
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
  const shownRaw = activity.filter((item) => filter === 'all' || (filter === 'key' && (item.event.kind === 'assistant' || item.event.error || item.result?.error)) ||
    (filter === 'agent' && item.event.kind === 'assistant') ||
    (filter === 'tool' && item.event.kind === 'tool_call') || (filter === 'error' && (item.event.error || item.result?.error)));
  // P1-2:顺序切换(评审 §4.4.4)——默认正序;可切倒序(最新在前)
  const shown = order === 'desc' ? [...shownRaw].reverse() : shownRaw;
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
      {/* P0-3:报告重排(评审 §4.5)——结论→交付物→验收标准→完整报告→技术 */}
      {run.result && <div className="dsh-wb-run-result"><b>结论</b><p>{preview(run.result.summary, 180)}</p>
        {run.result.summary.length > 180 && (resultRepeatsReport
          ? <p className="dsh-wb-muted">完整内容可在下方「展开完整报告」查看。</p>
          : <ExpandableText text={run.result.summary} label="展开完整结论" fold />)}
        {run.result.kind === 'done' && <p className="dsh-wb-muted">执行完成;是否满足验收标准请对照下方交付物判断。</p>}
        {run.result.kind === 'blocked' && <p className="dsh-wb-muted">执行受阻;请查看执行过程了解原因。</p>}
        {run.result.kind === 'failed' && <p className="dsh-wb-muted">执行失败;详情见执行过程与停止原因。</p>}</div>}
      {run.report?.nextHint && <div className="dsh-wb-run-next"><b>建议下一步</b><p>{run.report.nextHint}</p></div>}
      <h3>交付物 · {run.report?.evidence?.length ?? 0}</h3>
      {run.report?.evidence?.length ? <div className="dsh-wb-evidence-list">{run.report.evidence.map((item, i) => {
        const ref = typeof item === 'string' ? item : item.ref;
        const label = typeof item === 'string' ? '文件' : ({ log: '日志', artifact: '产物', metric: '指标', command: '命令', code_change: '代码修改' } as Record<string, string>)[item.kind] ?? item.kind;
        return <div className="dsh-wb-evidence" key={i}>
          <span>{label}</span>
          <div><b>{typeof item === 'string' ? ref.split('/').pop() : item.summary || ref.split('/').pop()}</b><small>{evidencePath(run, ref)}</small></div>
          <div className="dsh-wb-row">
            <button type="button" className="dsh-wb-btn" onClick={() => void previewFile(ref)} disabled={previewLoading === ref}>{previewLoading === ref ? '加载中…' : '预览'}</button>
            <button type="button" className="dsh-wb-link" onClick={() => void copyEvidence(i, ref)}>{copied === i ? '已复制' : '复制路径'}</button>
          </div>
        </div>;
      })}</div> : <div className="dsh-wb-muted">{run.report ? '本次报告未附文件引用。' : 'Agent 尚未提交报告。'}</div>}
      {copied === -2 && <p className="dsh-wb-muted">浏览器未允许复制，请手动选中上方路径。</p>}
      {run.report && <ExpandableText text={run.report.summary} label="展开完整报告" fold />}
      <details className="dsh-wb-technical"><summary>技术信息</summary>
        <div>执行 ID：{run.id}</div><div>子会话：{run.runtime.childSessionId || '尚未创建'}</div>
        <div>内部阶段：{run.phase} · 状态同步：{run.writeback.state}</div>
        {run.result && <div>结束原因：{run.result.reasonCode}</div>}
        {(run.cancel || run.phase === 'reconciling') && <div>静止确认：{run.runtime.quiescence}</div>}
      </details>
    </section>}
    {view === 'activity' && <section className="dsh-wb-panel dsh-wb-run-content dsh-wb-activity-scroll" ref={scrollerRef}>
      <div className="dsh-wb-run-section-head"><div><h3>执行过程</h3><p>Agent 消息按对话排版;工具调用卡片可展开参数与结果。</p></div>
        <div className="dsh-wb-row" style={{ gap: 6 }}>
          <span>{filter === 'all' ? `${activity.length} 条活动` : `显示 ${shownRaw.length} / ${activity.length} 条`}</span>
          <button type="button" className="dsh-wb-order-toggle" aria-label={order === 'asc' ? '切换为最新在前' : '切换为最早在前'} onClick={() => setOrder(order === 'asc' ? 'desc' : 'asc')}>{order === 'asc' ? '↑ 最早在前' : '↓ 最新在前'}</button>
        </div></div>
      <div className="dsh-wb-filter" role="group" aria-label="筛选执行活动">
        {([['key', '关键事件'], ['all', '全部'], ['agent', 'Agent 消息'], ['tool', '工具调用'], ['error', '错误']] as const).map(([key, label]) =>
          <button key={key} type="button" className={filter === key ? 'active' : ''} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>)}
      </div>
      {error && <div className="dsh-wb-error">{error}</div>}
      {shown.length ? shown.map((item) => <ActivityCard key={item.event.seq} item={item} />) :
        <div className="dsh-wb-empty">{events.length ? '这个筛选条件下没有记录。' : '尚无可显示的活动;运行中会自动刷新。'}</div>}
      {more && <button className="dsh-wb-btn" onClick={() => void load(cursor, true)}>加载后续记录</button>}
      {!follow && pendingNew > 0 && <button type="button" className="dsh-wb-new-events"
        onClick={() => { const el = scrollerRef.current; if (el) el.scrollTop = el.scrollHeight; setFollow(true); setPendingNew(0); }}>
        ↓ {pendingNew} 条新事件</button>}
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
    {previewData && <EvidencePreview data={previewData} onClose={closePreview} />}
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
  // P0-1:第 1 次 Run 也展示——消除「待办但执行完成」歧义(评审 §2/§6)
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
  // 阶段A:活动流重组(评审 §4.3.2)——评论/交付/决定为主线;进度收起为摘要
  const main = items.filter((e) => e.kind === 'comment' || e.kind === 'review' || (e.kind === 'run' && e.text !== '开始执行'));
  const collapsed = items.filter((e) => e.kind === 'progress' || (e.kind === 'run' && e.text === '开始执行'));
  const title = (event: Timeline) => event.kind === 'progress' ? '进度更新' : event.kind === 'review' ? '人工验收' :
    event.kind === 'comment' ? '评论' : event.text === '开始执行' ? '开始执行' : 'Agent 交付';
  const renderEvent = (event: Timeline) => {
    const body = event.kind === 'run' && /^[A-Z_]+:/.test(event.text) ? event.text.slice(event.text.indexOf(':') + 1) : event.text;
    return <article className="dsh-wb-task-event" key={event.id}>
      <div className="dsh-wb-activity-head"><span className="dsh-wb-activity-kind">{title(event)}</span><time>{fmt(event.at)}</time></div>
      <ExpandableText text={body} label="查看事件内容" fold={event.kind === 'run' && event.text !== '开始执行'} />
      {event.runId && <button className="dsh-wb-link" onClick={() => onRun(event.runId!)}>查看关联执行 →</button>}
    </article>;
  };
  return <div className="dsh-wb-task-timeline">
    {main.length ? main.map(renderEvent) : <div className="dsh-wb-empty">暂无讨论、交付或决定</div>}
    {collapsed.length > 0 && <details className="dsh-wb-collapsed-progress">
      <summary><b>进度与系统事件</b><span>{collapsed.length} 条已收起</span></summary>
      {collapsed.map(renderEvent)}
    </details>}
  </div>;
}
function Workbench() {
  const [page, setPage] = React.useState<Page>('overview');
  const [overview, setOverview] = React.useState<Overview>(EMPTY);
  const [models, setModels] = React.useState<Models>({ allowed: [], default: '' });
  const [browse, setBrowse] = React.useState<BrowseResult | null>(null);
  const [browseError, setBrowseError] = React.useState('');
  const [newModel, setNewModel] = React.useState('');
  async function saveModelPolicy(next: string[]) {
    try {
      const r = await api<Models>(`${BASE}/model-policy`, { method: 'PUT', body: JSON.stringify({ allowedModels: next }) });
      setModels(r);
      showToast('模型白名单已更新,新建 Agent 即刻可选', 'info');
    } catch (e) { showToast(friendlyError(e), 'error'); }
  }
  async function loadBrowse(p: string) {
    setBrowseError('');
    try { setBrowse(await api<BrowseResult>(`${BASE}/fs/browse?path=${encodeURIComponent(p)}`)); }
    catch (e) { setBrowseError(errorText(e)); }
  }
  const [legacy, setLegacy] = React.useState<Run[]>([]);
  const [squads, setSquads] = React.useState<Squad[]>([]);
  const [squadExecs, setSquadExecs] = React.useState<SquadExecution[]>([]);
  const [autoRules, setAutoRules] = React.useState<AutomationRule[]>([]);
  const [autoAttempts, setAutoAttempts] = React.useState<TriggerAttempt[]>([]);
  const [projectId, setProjectId] = React.useState('');
  const [layout, setLayout] = React.useState<'board' | 'list'>('board');
  const [statusFilter, setStatusFilter] = React.useState<Status | ''>('');
  const [taskId, setTaskId] = React.useState('');
  const [detail, setDetail] = React.useState<{ task: Task; runs: Run[] } | null>(null);
  const [runId, setRunId] = React.useState('');
  const [modal, setModal] = React.useState<'project' | 'agent' | 'task' | 'squad' | 'automation' | null>(null);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [form, setForm] = React.useState<Record<string, string>>({});
  const [toolAllow, setToolAllow] = React.useState<string[]>(Object.keys(TOOLS));
  const [comment, setComment] = React.useState('');
  const [reviewText, setReviewText] = React.useState('');
  const [error, setError] = React.useState('');
  const overviewRevision = React.useRef(0);
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
      // Wave 4:带 sinceRevision 短路——未变时服务端返回 {unchanged},不重传全量
      const value = await api<Overview | { unchanged: true }>(`${BASE}/overview${overviewRevision.current ? `?sinceRevision=${overviewRevision.current}` : ''}`);
      if (!('unchanged' in value)) {
        if ('revision' in value && typeof value.revision === 'number') overviewRevision.current = value.revision;
        setOverview(value as Overview);
      }
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
    void refresh(); void api<{ rules: AutomationRule[]; attempts: TriggerAttempt[] }>(`${BASE}/automations`).then((r) => { setAutoRules(r.rules ?? []); setAutoAttempts(r.attempts ?? []); }).catch(() => undefined);
    void api<{ squads: Squad[] }>(`${BASE}/squads`).then((r) => setSquads(r.squads)).catch(() => undefined);
    void api<{ executions: SquadExecution[] }>(`${BASE}/squad-executions`).then((r) => setSquadExecs(r.executions ?? [])).catch(() => undefined);
    void api<Models>(`${BASE}/models`).then(setModels).catch((e) => setError(errorText(e)));
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
    // P0-1:保存后同步刷新 squads/automations(否则新建不出现、启停不更新)
    const refreshCollections = () => {
      void api<{ squads: Squad[] }>(`${BASE}/squads`).then((r) => setSquads(r.squads ?? [])).catch(() => undefined);
      void api<{ executions: SquadExecution[] }>(`${BASE}/squad-executions`).then((r) => setSquadExecs(r.executions ?? [])).catch(() => undefined);
      void api<{ rules: AutomationRule[]; attempts: TriggerAttempt[] }>(`${BASE}/automations`).then((r) => { setAutoRules(r.rules ?? []); setAutoAttempts(r.attempts ?? []); }).catch(() => undefined);
    };
    try { await action(); await refresh(); refreshCollections(); if (taskId) await refreshDetail(taskId); return true; }
    catch (e) {
      const text = friendlyError(e);
      if (scope === 'modal') setFormError(text); else if (scope === 'detail') setDetailError(text); else showToast(text, 'error');
      await refresh(); refreshCollections(); if (taskId) await refreshDetail(taskId);
      return false;
    }
    finally { setBusy(false); }
  }
  function begin(kind: 'project' | 'agent' | 'task' | 'squad' | 'automation', id?: string) {
    const item = kind === 'project' ? overview.projects.find((p) => p.id === id) : kind === 'agent' ? overview.agents.find((a) => a.id === id) : kind === 'squad' ? squads.find((s) => s.id === id) : kind === 'automation' ? autoRules.find((r) => r.id === id) as unknown as Record<string, unknown> : overview.tasks.find((t) => t.id === id);
    setEditing(id ?? null);
    setFormError('');
    if (kind === 'agent') setToolAllow((item as Agent | undefined)?.toolAllow ?? Object.keys(TOOLS));
    setForm(item ? (kind === 'automation'
      ? { name: (item as { name?: string })?.name ?? '', cron: (item as { cron?: string })?.cron ?? '0 9 * * *', timezone: (item as { timezone?: string })?.timezone ?? 'Asia/Shanghai', ...(item as { template?: Record<string, string> })?.template ?? {} }
      : kind === 'squad'
      ? { ...Object.fromEntries(Object.entries(item).map(([k, v]) => [k, String(v ?? '')])), steps: (item as unknown as Squad).steps.map((s) => `${s.agentId}|${s.responsibility}`).join('\n') }
      : kind === 'task'
      // P0-4:v2 任务——assignment 对象映射回 assigneeId,不 String() 化
      ? { ...Object.fromEntries(Object.entries(item).filter(([k]) => k !== 'assignment' && k !== 'owner' && k !== 'operations' && k !== 'timeline' && k !== 'runIds').map(([k, v]) => [k, String(v ?? '')])),
          assigneeId: (item as Task).assignment?.id ?? (item as Task).assigneeId ?? '' }
      : Object.fromEntries(Object.entries(item).map(([k, v]) => [k, String(v ?? '')]))) :
      kind === 'task' ? { projectId: projectId || overview.projects[0]?.id || '', title: '', description: '', acceptanceCriteria: '', assigneeId: '' } :
      kind === 'agent' ? { name: '', instructions: '', model: models.default, displayDescription: '' } :
      kind === 'squad' ? { name: '', description: '', steps: '' } :
      kind === 'automation' ? { name: '', cron: '0 9 * * *', timezone: 'Asia/Shanghai', projectId: overview.projects[0]?.id ?? '', title: '', description: '', acceptanceCriteria: '', assigneeId: overview.agents[0]?.id ?? '' } : { title: '', root: '', goal: '', description: '' });
    setModal(kind);
  }
  async function saveModal() {
    if (!modal) return;
    const kind = modal;
    // 客户端必填校验:失败留在 modal 内展示,不打扰后端
    const missing: string[] = [];
    if (!form.title?.trim() && !['agent', 'squad', 'automation'].includes(kind)) missing.push(kind === 'task' ? '任务标题' : '项目名称');
    if (kind === 'project' && !editing && !form.root?.trim()) missing.push('本机工作区绝对路径');
    if (kind === 'agent' && !form.name?.trim()) missing.push('Agent 名称');
    if (kind === 'squad') {
      if (!form.name?.trim()) missing.push('小队名称');
      if ((form.steps ?? '').split('\n').filter(Boolean).length < 2) missing.push('至少 2 个步骤');
    }
    if (kind === 'automation') {
      if (!form.name?.trim()) missing.push('规则名称');
      if (!form.cron?.trim()) missing.push('cron 表达式');
      if (!form.title?.trim()) missing.push('任务标题');
      if (!form.acceptanceCriteria?.trim()) missing.push('验收标准');
      if (!form.assigneeId) missing.push('分派 Agent');
    }
    if (kind === 'task') {
      if (!form.acceptanceCriteria?.trim()) missing.push('验收标准');
      if (!form.projectId) missing.push('所属项目');
    }
    if (missing.length) { setFormError(`请填写:${missing.join('、')}`); return; }
    const endpoint = kind === 'project' ? 'projects' : kind === 'agent' ? 'agents' : kind === 'squad' ? 'squads' : kind === 'automation' ? 'automations' : 'tasks';
    const current = editing ? (kind === 'project' ? overview.projects : kind === 'agent' ? overview.agents : kind === 'squad' ? squads : kind === 'automation' ? autoRules : overview.tasks).find((x) => x.id === editing) : undefined;
    const body = kind === 'project' ? { title: form.title, root: form.root, goal: form.goal ?? '', description: form.description ?? '', expectedRevision: current?.revision } :
      kind === 'agent' ? { name: form.name, instructions: form.instructions, model: form.model, toolAllow, displayDescription: form.displayDescription ?? '', expectedRevision: current?.revision } :
      kind === 'automation' ? (() => ({
        name: form.name, cron: form.cron, timezone: form.timezone ?? 'Asia/Shanghai',
        template: { projectId: form.projectId, title: form.title, description: form.description ?? '', acceptanceCriteria: form.acceptanceCriteria, assigneeId: form.assigneeId },
        expectedRevision: current?.revision,
      }))() :
      kind === 'squad' ? (() => {
        const steps = (form.steps ?? '').split('\n').filter(Boolean).map((line) => {
          const [agentId, ...resp] = line.split('|');
          return { agentId, responsibility: resp.join('|').trim() };
        });
        return { name: form.name, description: form.description ?? '', steps, expectedRevision: current?.revision };
      })() :
      { projectId: form.projectId, title: form.title, description: form.description, acceptanceCriteria: form.acceptanceCriteria,
        assigneeId: form.assigneeId || null, expectedRevision: current?.revision };
    const ok = await mutate(() => write(`/${endpoint}${editing ? `/${editing}` : ''}`, editing ? 'PATCH' : 'POST', body), 'modal');
    if (ok) {
      setModal(null);
      if (kind === 'task' && taskId) void refreshDetail(taskId);
      // P2:保存后明确下一步(评审 §4.6)
      if (kind === 'task' && !editing) showToast(form.assigneeId ? '任务已创建 → 到详情点「手动运行」启动' : '任务已创建 → 先分派 Agent,再手动运行', 'info');
      else if (kind === 'project' && !editing) showToast('项目已创建 → 下一步建 Agent 或直接建任务', 'info');
      else if (kind === 'automation' && !editing) showToast('规则已创建(默认禁用)→ 确认模板无误后点「启用」开始调度', 'info');
    }
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
  const recentRoots = [...new Set(overview.projects.map((p) => p.root).filter(Boolean))].slice(-4).reverse();
  return <div className="dsh-wb" data-dsh-plugin="dsh-dispatch" data-dsh-part="workbench"><style>{workbenchCss}{markdownCss}</style>
    <ToastHost />
    <nav className="dsh-wb-nav" aria-label="工作台导航">
      <div className="dsh-wb-brand"><small>DSH DISPATCH</small>AI 团队工作台</div>
      {([['overview', '◫', '总览'], ['tasks', '▤', '任务'], ['projects', '⊀', '项目'], ['agents', '◈', 'Agent 目录'], ['squads', '☰', '小队'], ['automations', '⏱', '自动化'], ['legacy', '⧖', '旧派发历史']] as const).map(([key, ico, title]) =>
        <button className={`dsh-wb-navbtn${page === key ? ' active' : ''}`} key={key} onClick={() => setPage(key)}><span className="dsp-nav-ico" aria-hidden>{ico}</span><span>{title}</span></button>)}
      <div className="dsh-wb-navfoot">并行 {overview.concurrency?.max ?? 1} 个任务(不同工作区);<br />进行中 {overview.concurrency?.active ?? 0}/{overview.concurrency?.max ?? 1};完成后由你验收归档。</div>
    </nav>
    <main className="dsh-wb-main">
      <header className="dsh-wb-head"><div><div className="dsh-wb-kicker">DSH / DISPATCH</div><h1>{selected ? '任务详情' : page === 'overview' ? '工作总览' : page === 'tasks' ? '任务' : page === 'projects' ? '项目' : page === 'agents' ? 'Agent 目录' : page === 'squads' ? '小队' : page === 'automations' ? '自动化' : '旧派发历史'}</h1></div>
        <div className="dsh-wb-head-actions">
          {selected && <button className="dsh-wb-btn" onClick={() => { setTaskId(''); setDetail(null); }}>← 返回{page === 'overview' ? '总览' : '列表'}</button>}
          <button className="dsh-wb-btn" onClick={() => void refresh()}>刷新</button><button className="dsh-wb-btn ghost" onClick={() => setOpen(false)} aria-label="关闭工作台">关闭 ✕</button></div></header>
      {error && <div role="alert" className="dsh-wb-error">{error}</div>}
      {overview.readOnly && <div role="status" className="dsh-wb-error">工作台当前只读；项目、任务和历史记录仍可查看。</div>}
      {selected ? <div className="dsh-wb-taskpage">
        {/* P1-1:任务详情改为完整页面——中央活动流 + 右栏常驻属性/Run/验收(评审 §4.3) */}
        <div className="dsh-wb-taskpage-main">
          <h1>{selected.title}</h1>
          <p className="dsh-wb-muted">{overview.projects.find((p) => p.id === selected.projectId)?.title} · {LABEL[selected.status]}</p>
          {selectedRun && <div className="dsh-wb-status-split">
            <span className="dsh-wb-status-chip" data-tone={selected.status}>任务:{LABEL[selected.status]}</span>
            <span className="dsh-wb-status-chip" data-tone="run">{selectedRun.id === detail?.runs.at(-1)?.id ? '上次执行' : `当前查看第 ${(detail?.runs.findIndex((run) => run.id === selectedRun.id) ?? -1) + 1} 次执行`}:{runLabel(selectedRun)}</span>
          </div>}
          {detailError && <div role="alert" className="dsh-wb-error">{detailError}</div>}
          <details className="dsh-wb-panel dsh-wb-task-brief" open={!selected.runIds.length}>
            <summary><b>任务要求与验收标准</b><span>{preview(selected.acceptanceCriteria, 90)}</span></summary>
            <h3>任务目标</h3><p style={{ whiteSpace: 'pre-wrap' }}>{selected.description || '无补充说明'}</p>
            <h3>验收标准</h3><p style={{ whiteSpace: 'pre-wrap' }}>{selected.acceptanceCriteria}</p>
          </details>
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
            <h3>人工验收</h3><p>先核对上方运行的报告与证据。接受后任务才会标记为已完成。</p>
            <textarea className="dsh-wb-textarea" aria-label="验收或退回意见" value={reviewText} onChange={(e) => setReviewText(e.target.value)} placeholder="退回时必须填写意见" />
            <div className="dsh-wb-row"><button className="dsh-wb-btn primary" disabled={busy} onClick={() => void mutate(() => write('/tasks/' + selected.id + '/review', 'POST', { expectedRevision: selected.revision, decision: 'accept', comment: reviewText }), 'detail')}>接受，标记完成</button>
              <button className="dsh-wb-btn" disabled={busy || !reviewText.trim()} onClick={() => void mutate(() => write('/tasks/' + selected.id + '/review', 'POST', { expectedRevision: selected.revision, decision: 'reject', comment: reviewText }), 'detail')}>退回待办</button></div>
          </div>}
          <div className="dsh-wb-panel"><h3>任务讨论与状态更新{selected.timelineTotal != null && selected.timelineTotal > selected.timeline.length ? <span className="dsh-wb-muted" style={{ fontWeight: 400 }}>{`(最近 ${selected.timeline.length}/${selected.timelineTotal} 条)`}</span> : null}</h3><TaskTimeline items={selected.timeline} onRun={setRunId} />
            <textarea className="dsh-wb-textarea" aria-label="发表评论" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="记录问题、建议或决策" /><button className="dsh-wb-btn" disabled={!comment.trim() || busy} onClick={() => void mutate(() => write(`/tasks/${selected.id}/comments`, 'POST', { expectedRevision: selected.revision, text: comment }), 'detail').then((ok) => { if (ok) setComment(''); })}>发送评论</button></div>
        </div>
        <aside className="dsh-wb-taskpage-side" aria-label="任务属性与执行">
          <div className="dsh-wb-panel dsh-wb-side-card">
            <h3>任务属性</h3>
            <dl className="dsh-wb-side-dl">
              <dt>项目</dt><dd>{overview.projects.find((p) => p.id === selected.projectId)?.title ?? '—'}</dd>
              <dt>执行者</dt><dd>{overview.agents.find((a) => a.id === assigneeOf(selected))?.name ?? (squads.find((s) => s.id === assigneeOf(selected)) ? `☰ ${squads.find((s) => s.id === assigneeOf(selected))!.name}` : '未分派')}</dd>
              {assigneeOf(selected) && <dt>模型</dt>}{assigneeOf(selected) && <dd>{overview.agents.find((a) => a.id === assigneeOf(selected))?.model ?? (squads.find((s) => s.id === assigneeOf(selected)) ? `${squads.find((s) => s.id === assigneeOf(selected))!.steps.length} 步小队` : '—')}</dd>}
              <dt>执行次数</dt><dd>{selected.runIds.length}</dd>
            </dl>
            <div className="dsh-wb-row" style={{ marginTop: 10 }}>
              <button className="dsh-wb-btn" disabled={!!selected.owner || ['in_review', 'done'].includes(selected.status)} onClick={() => begin('task', selected.id)}>编辑</button>
              {selected.status === 'done' && <button className="dsh-wb-btn" disabled={busy} onClick={() => void mutate(() => write(`/tasks/${selected.id}`, 'PATCH', { expectedRevision: selected.revision, status: 'todo' }), 'detail')}>重新打开</button>}
              {['todo', 'blocked'].includes(selected.status) && !selected.owner && <select className="dsh-wb-select" aria-label="修改任务状态" value={selected.status} onChange={(e) => moveTask(selected.id, e.target.value as Status)}><option value="todo">待办</option><option value="blocked">受阻</option></select>}
            </div>
          </div>
          <div className="dsh-wb-panel dsh-wb-side-card dsh-wb-side-action">
            <h3>执行</h3>
            <div className="dsh-wb-row"><select className="dsh-wb-select" aria-label="分派 Agent 或小队" disabled={!!selected.owner || busy} value={assigneeOf(selected) ?? ''} onChange={(e) => void mutate(() => write('/tasks/' + selected.id, 'PATCH', { expectedRevision: selected.revision, assigneeId: e.target.value || null }), 'detail')}><option value="">未分派</option>{overview.agents.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.model}</option>)}{squads.length > 0 && <optgroup label="小队">{squads.map((sq) => <option key={sq.id} value={sq.id}>☰ {sq.name}({sq.steps.length}步)</option>)}</optgroup>}</select></div>
            {['todo', 'blocked'].includes(selected.status) && !selected.owner && <button className="dsh-wb-btn primary" style={{ width: '100%', marginTop: 8 }} disabled={!assigneeOf(selected) || busy} onClick={() => void mutate(() => write('/tasks/' + selected.id + '/run', 'POST', { idempotencyKey: 'ui-' + crypto.randomUUID() }), 'detail')}>手动运行</button>}
            {selected.owner && <p className="dsh-wb-muted" style={{ marginTop: 8 }}>执行中;目标与验收标准已锁定。取消后等待静止确认。</p>}
          </div>
          <RunHistory key={selected.id} runs={detail?.runs ?? []} selectedId={runId} onSelect={setRunId} />
        </aside>
      </div> : <>
      {page === 'overview' && <>
        {/* P0-2:「现在需要你处理」行动区(评审 §4.1)——按待验收→受阻→执行中→未分派排列 */}
        {(() => {
          const review = overview.tasks.filter((t) => t.status === 'in_review');
          const blocked = overview.tasks.filter((t) => t.status === 'blocked');
          const running = overview.tasks.filter((t) => t.status === 'in_progress' || t.owner);
          const ready = overview.tasks.filter((t) => t.status === 'todo' && !!assigneeOf(t) && !t.owner);
          const unassigned = overview.tasks.filter((t) => t.status === 'todo' && !assigneeOf(t));
          const actionable = [...review.map((t) => ({ task: t, why: '等待人工验收', act: '去验收' })),
            ...blocked.map((t) => ({ task: t, why: '任务受阻,需查看原因', act: '查看' })),
            ...running.map((t) => ({ task: t, why: 'Agent 正在工作', act: '查看进度' })),
            ...ready.map((t) => ({ task: t, why: '已分派 Agent,等待启动', act: '去运行' })),
            ...unassigned.map((t) => ({ task: t, why: '未分派 Agent', act: '去分派' }))];
          if (!actionable.length && !overview.projects.length) {
            return <div className="dsh-wb-panel dsh-wb-next-steps">
              <h2>开始使用</h2>
              <div className="dsh-wb-guide-steps">
                <div><b>1.</b> 创建项目,绑定本机工作区(须在 DSH_HOME 之外)</div>
                <div><b>2.</b> 在 Agent 目录建一个执行者(选模型、写指令)</div>
                <div><b>3.</b> 建任务并分派 Agent,点「手动运行」启动</div>
              </div>
              <button className="dsh-wb-btn primary" onClick={() => begin('project')}>创建第一个项目</button>
            </div>;
          }
          if (!actionable.length) return <div className="dsh-wb-panel dsh-wb-next-steps"><p className="dsh-wb-muted">暂无需要你处理的事项。空闲时可新建任务或检查 Agent 配置。</p></div>;
          return <div className="dsh-wb-panel dsh-wb-next-steps">
            <h2>需要你处理 · {actionable.length}</h2>
            <div className="dsp-stagger">{actionable.slice(0, 5).map(({ task, why, act }, i) =>
              <div key={task.id} className="dsh-wb-action-row" style={{ ['--dsp-i' as string]: String(i) }}>
                <span className="dsh-wb-action-why">{why}</span>
                <button className="dsh-wb-link" onClick={() => taskButton(task.id)}>{task.title}</button>
                <button className="dsh-wb-btn" onClick={() => taskButton(task.id)}>{act} →</button>
              </div>)}</div>
            {actionable.length > 5 && <p className="dsh-wb-muted">还有 {actionable.length - 5} 项…</p>}
          </div>;
        })()}
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
        {layout === 'board' ? <DndContext sensors={sensors} onDragEnd={onDragEnd}><div className="dsh-wb-board">{STATUS.filter((s) => !statusFilter || s === statusFilter).map((s) => <Column key={s} status={s} tasks={filtered.filter((t) => t.status === s)} agents={overview.agents} onTask={taskButton} />)}</div></DndContext> :
          <div className="dsh-wb-panel"><table className="dsh-wb-table"><thead><tr><th>任务</th><th>项目</th><th>执行者</th><th>状态</th><th>Run</th></tr></thead><tbody>{filtered.map((t) => <tr key={t.id}><td><button className="dsh-wb-link" onClick={() => taskButton(t.id)}>{t.title}</button></td><td>{overview.projects.find((p) => p.id === t.projectId)?.title}</td><td>{overview.agents.find((a) => a.id === assigneeOf(t))?.name ?? (squads.find((sq) => sq.id === assigneeOf(t)) ? `☰ ${squads.find((sq) => sq.id === assigneeOf(t))!.name}` : '未分派')}</td><td>{LABEL[t.status]}</td><td>{t.runIds.length}</td></tr>)}</tbody></table>{!filtered.length && <div className="dsh-wb-empty">暂无任务</div>}</div>}</>}
      {page === 'projects' && <><button className="dsh-wb-btn primary" onClick={() => begin('project')}>新建项目</button><div style={{ height: 16 }} />
        {overview.projects.map((p) => {
          const ptasks = overview.tasks.filter((t) => t.projectId === p.id);
          const pc: Record<Status, number> = { todo: 0, in_progress: 0, in_review: 0, blocked: 0, done: 0 };
          for (const t of ptasks) pc[t.status] += 1;
          const recent = [...ptasks].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, 3);
          const goTasks = (st?: Status) => { setProjectId(p.id); setStatusFilter(st ?? ''); setPage('tasks'); };
          return <div className="dsh-wb-panel dsh-wb-projcard" key={p.id}>
            <div className="dsh-wb-row" style={{ justifyContent: 'space-between' }}>
              <h2 className="dsh-wb-row">{p.title}{pc.in_progress > 0 && <span className="dsh-wb-card-live" title="有任务执行中" />}</h2>
              <div className="dsh-wb-row">
                <button className="dsh-wb-btn" onClick={() => begin('project', p.id)}>编辑</button>
                <button className="dsh-wb-btn" onClick={() => goTasks()}>查看任务 →</button>
              </div>
            </div>
            {p.goal ? <p className="dsh-wb-projgoal">{p.goal}</p> : <p className="dsh-wb-muted">未设定目标——点「编辑」补一段话说明这个项目要解决什么问题。</p>}
            <div className="dsh-wb-code">{p.root}</div>
            <div className="dsh-wb-row dsh-wb-projcounts">
              {STATUS.map((st) => (pc[st] > 0 || ['todo', 'in_progress', 'in_review'].includes(st)
                ? <button key={st} type="button" className="dsh-wb-countchip" data-tone={st} onClick={() => goTasks(st)} title={`查看${LABEL[st]}任务`}>{LABEL[st]} <b>{pc[st]}</b></button>
                : null))}
            </div>
            {recent.length > 0 && <div className="dsh-wb-projrecent">
              <span className="dsh-wb-muted">最近活动</span>
              {recent.map((t) => <button key={t.id} type="button" className="dsh-wb-link dsh-wb-projrecent-item" onClick={() => taskButton(t.id)}>{t.title}<span className="dsh-wb-muted"> · {LABEL[t.status]} · {relTime(t.updatedAt)}</span></button>)}
            </div>}
          </div>;
        })}</>}
      {page === 'agents' && <><button className="dsh-wb-btn primary" onClick={() => begin('agent')}>新建 Agent</button><div style={{ height: 16 }} />
  <div className="dsh-wb-panel" style={{ marginBottom: 16 }}>
    <div className="dsh-wb-row" style={{ justifyContent: 'space-between' }}><h2 style={{ fontSize: 13 }}>模型白名单</h2><span className="dsh-wb-muted">新建 Agent 只能从下列模型中选择;保存即热生效(持久化到 DSH settings)</span></div>
    <div className="dsh-wb-row" style={{ marginTop: 10, flexWrap: 'wrap', gap: 6 }}>
      {models.allowed.map((m) => <span key={m} className="dsh-wb-pickerchip" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>{m}
        <button type="button" aria-label={'移除 ' + m} style={{ border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', padding: 0 }} disabled={models.allowed.length <= 1} onClick={() => void saveModelPolicy(models.allowed.filter((x) => x !== m))}>✕</button></span>)}
    </div>
    <div className="dsh-wb-row" style={{ marginTop: 10 }}>
      <select className="dsh-wb-select" style={{ maxWidth: 280 }} value={newModel} onChange={(e) => setNewModel(e.target.value)} aria-label="选择要添加的模型">
        <option value="">选择要添加的模型…</option>
        {(models.available ?? []).filter((m) => !models.allowed.includes(m)).map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
      <button type="button" className="dsh-wb-btn" disabled={!newModel} onClick={() => { if (newModel) void saveModelPolicy([...models.allowed, newModel]); setNewModel(''); }}>添加</button>
    </div>
    <p className="dsh-wb-muted" style={{ margin: '8px 0 0', fontSize: 10.5 }}>可用 provider 见 DSH 设置 → 模型(当前已配 kimi/glm/gpt/linkapi 等);删除最后一条不可用。</p>
  </div>
        <div className="dsp-stagger">{overview.agents.map((a, i) => <div className="dsh-wb-panel" key={a.id} style={{ ['--dsp-i' as string]: String(i) }}>
          <div className="dsh-wb-row" style={{ justifyContent: 'space-between' }}><h2>{a.name}</h2><button className="dsh-wb-btn" onClick={() => begin('agent', a.id)}>编辑</button></div>
          {a.displayDescription && <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>{a.displayDescription}</p>}
          <div className="dsh-wb-muted">模型:{a.model} · 已分派 {overview.tasks.filter((t) => assigneeOf(t) === a.id).length} 个任务 · 工具 {a.toolAllow.length}/{Object.keys(TOOLS).length}</div>
          <ExpandableText text={a.instructions} label="展开完整工作指令" fold /></div>)}</div></>}
      {page === 'squads' && <><button className="dsh-wb-btn primary" onClick={() => begin('squad')}>新建小队</button><div style={{ height: 16 }} />
  <div className="dsp-stagger">{squads.map((sq, i) => <div className="dsh-wb-panel" key={sq.id} style={{ ['--dsp-i' as string]: String(i) }}>
    <div className="dsh-wb-row" style={{ justifyContent: 'space-between' }}><h2>{sq.name}</h2><button className="dsh-wb-btn" onClick={() => begin('squad', sq.id)}>编辑</button></div>
    {sq.description && <p style={{ margin: '4px 0 8px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>{sq.description}</p>}
    <div className="dsh-wb-muted">{sq.steps.length} 步:{sq.steps.map((s, j) => `${j + 1}.${s.responsibility || overview.agents.find(a => a.id === s.agentId)?.name || '?'}`).join(' → ')}</div>
  </div>)}</div>
  {!squads.length && <div className="dsh-wb-empty">暂无小队。创建 2+ 步骤的 Agent 序列来自动化多步工作流。</div>}
  {squadExecs.length > 0 && <><h2 style={{ margin: '22px 0 10px', fontSize: 14 }}>执行记录</h2>
    {[...squadExecs].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20).map((ex) => {
      const exTask = overview.tasks.find((t) => t.id === ex.taskId);
      const exSquad = squads.find((sq) => sq.id === ex.squadId);
      const handoffList = Object.entries(ex.handoffs ?? {}).sort((a, b) => Number(a[0]) - Number(b[0]));
      return <div className="dsh-wb-panel" key={ex.id} style={{ marginBottom: 10 }}>
        <div className="dsh-wb-row" style={{ justifyContent: 'space-between' }}>
          <div className="dsh-wb-row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <button type="button" className="dsh-wb-link" onClick={() => exTask && taskButton(exTask.id)}>{exTask?.title ?? ex.taskId}</button>
            <span className="dsh-wb-countchip" data-tone={ex.state === 'running' ? 'in_progress' : ex.state === 'completed' ? 'done' : ex.state === 'paused_failed' ? 'blocked' : 'todo'}>{EXEC_LABEL[ex.state] ?? ex.state}</span>
            <span className="dsh-wb-muted">{exSquad?.name ?? ex.squadId} · 第 {Math.min(ex.currentStep + 1, ex.steps.length)}/{ex.steps.length} 步 · {ex.runIds.length} 次 Run · {relTime(ex.updatedAt)}</span>
          </div>
        </div>
        {ex.waitReason && <p className="dsh-wb-muted" style={{ margin: '6px 0 0' }}>⏳ {ex.waitReason}(自 {relTime(ex.waitSince)})</p>}
        {ex.pauseReason && <p className="dsh-wb-muted" style={{ margin: '6px 0 0' }}>⛔ {ex.pauseReason}</p>}
        {handoffList.length > 0 && <details style={{ marginTop: 8 }}><summary className="dsh-wb-muted" style={{ cursor: 'pointer', fontSize: 11 }}>交接记录({handoffList.length})</summary>
          {handoffList.map(([idx, h]) => <p key={idx} style={{ margin: '6px 0 0', fontSize: 12, lineHeight: 1.6 }}>
            <b>第 {Number(idx) + 1} 步 · {h.fromAgent}</b>:{h.summary}{h.evidence?.length ? <span className="dsh-wb-muted">(交付:{h.evidence.join('、')})</span> : null}</p>)}
        </details>}
      </div>;
    })}</>}</>}
      {page === 'automations' && <><button className="dsh-wb-btn primary" onClick={() => begin('automation')}>新建规则</button><div style={{ height: 16 }} />
  {autoRules.length ? autoRules.map((rule) => <div className="dsh-wb-panel" key={rule.id}>
    <div className="dsh-wb-row" style={{ justifyContent: 'space-between' }}>
      <h2>{rule.name}</h2>
      <div className="dsh-wb-row">
        <button className={`dsh-wb-btn ${rule.enabled ? 'danger' : 'primary'}`} onClick={() => void mutate(() => write(`/automations/${rule.id}`, 'PATCH', { expectedRevision: rule.revision, enabled: !rule.enabled }), 'page')}>{rule.enabled ? '禁用' : '启用'}</button>
        <button className="dsh-wb-btn" onClick={() => begin('automation', rule.id)}>编辑</button>
      </div>
    </div>
    <div className="dsh-wb-muted">{rule.cron} · 下次:{fmt(rule.nextTriggerAt)} · {rule.enabled ? '✅ 已启用' : '⛔ 已禁用'}</div>
    <div className="dsh-wb-muted">任务模板:{rule.template.title} → {overview.agents.find(a => a.id === rule.template.assigneeId)?.name ?? '?'}</div>
  </div>) : <div className="dsh-wb-empty">暂无自动化规则。创建定时规则来自动生成并运行任务。</div>}
  {autoAttempts.length > 0 && <div className="dsh-wb-panel"><h3>最近触发</h3>
    <table className="dsh-wb-table"><thead><tr><th>规则</th><th>计划时间</th><th>结果</th><th>原因/任务</th></tr></thead>
    <tbody>{autoAttempts.slice(0, 10).map((a) => <tr key={a.id}><td>{a.ruleName}</td><td>{fmt(a.scheduledAt)}</td><td>{a.result}</td><td>{a.reason ?? a.taskId ?? ''}</td></tr>)}</tbody></table></div>}</>}
      {page === 'legacy' && <div className="dsh-wb-panel"><p className="dsh-wb-muted">旧 trajectory 派发仅供查看,不会自动成为已验收任务。共 {overview.legacyCount} 条。</p>
        <table className="dsh-wb-table"><thead><tr><th>目标</th><th>结果</th><th>开始</th><th>结束</th></tr></thead><tbody>{legacy.map((r) => <tr key={r.id}><td>{r.targetType === 'workbench_task' ? '工作台任务' : r.targetRef.nodeId}</td><td>{OUTCOME_LABEL[r.result?.kind ?? ''] ?? PHASE_LABEL[r.phase] ?? r.phase}</td><td>{fmt(r.createdAt)}</td><td>{fmt(r.endedAt)}</td></tr>)}</tbody></table></div>}
      </>}
    </main>
    {modal && <><button className="dsh-wb-backdrop" style={{ zIndex: 112 }} aria-label="关闭表单" onClick={() => setModal(null)} /><div className="dsh-wb-modal" role="dialog" aria-modal="true" aria-label={editing ? '编辑' : '新建'}>
      <h2>{editing ? '编辑' : '新建'}{modal === 'project' ? '项目' : modal === 'agent' ? ' Agent' : modal === 'squad' ? '小队' : modal === 'automation' ? '自动化规则' : '任务'}</h2>
      {formError && <div role="alert" className="dsh-wb-error">{formError}</div>}
      {browse && <div className="dsh-wb-picker" role="dialog" aria-modal="true" aria-label="选择工作区目录" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setBrowse(null); } }}>
        <div className="dsh-wb-picker-head">
          <button type="button" className="dsh-wb-btn" autoFocus disabled={browse.parent === null} onClick={() => void loadBrowse(browse.parent ?? '')}>↑ 上级</button>
          <div className="dsh-wb-picker-path" title={browse.path}>{browse.path || '此电脑'}</div>
          <button type="button" className="dsh-wb-btn ghost" onClick={() => setBrowse(null)}>✕ 关闭</button>
        </div>
        {browseError && <div role="alert" className="dsh-wb-error" style={{ marginBottom: 8 }}>{browseError}</div>}
        <div className="dsh-wb-picker-list">
          {browse.path === '' && browse.drives.map((d) => <button key={d} type="button" className="dsh-wb-picker-item" onClick={() => void loadBrowse(d)}>💽 {d}</button>)}
          {browse.path === '' && <button type="button" className="dsh-wb-picker-item" onClick={() => void loadBrowse(browse.home)}>🏠 用户主目录</button>}
          {browse.path !== '' && browse.dirs.map((e) => <button key={e.path} type="button" className="dsh-wb-picker-item" disabled={e.blocked} title={e.blocked ? '位于 DSH_HOME 内,不能作为工作区' : e.path} onClick={() => void loadBrowse(e.path)}>📁 {e.name}</button>)}
          {browse.path !== '' && browse.dirs.length === 0 && <div className="dsh-wb-muted" style={{ padding: 8 }}>此目录下没有子文件夹</div>}
          {browse.truncated && <div className="dsh-wb-muted" style={{ padding: 8 }}>子目录过多,仅显示前 500 项——可直接在下方输入完整路径</div>}
        </div>
        <div className="dsh-wb-picker-foot">
          <span className="dsh-wb-muted" style={{ marginRight: 'auto', fontSize: 10.5 }}>选中的目录即项目工作区(Agent 只在其中读写)</span>
          <button type="button" className="dsh-wb-btn" onClick={() => setBrowse(null)}>取消</button>
          <button type="button" className="dsh-wb-btn primary" disabled={!browse.path || browse.blocked} title={browse.blocked ? '当前目录位于 DSH_HOME 内,不能作为工作区' : ''} onClick={() => { setForm((f) => ({ ...f, root: browse.path })); setBrowse(null); }}>选择此目录</button>
        </div>
      </div>}
      {modal === 'project' && <><Field autoFocus label="项目名称" value={form.title} onChange={(v) => setForm({ ...form, title: v })} />{editing ? <div className="dsh-wb-code">{form.root}</div> : <div className="dsh-wb-field"><label>本机工作区绝对路径</label>
          <div className="dsh-wb-row"><input className="dsh-wb-input" value={form.root} onChange={(e) => setForm({ ...form, root: e.target.value })} placeholder="D:/research/project(或点「浏览…」选择)" /><button type="button" className="dsh-wb-btn" onClick={() => void loadBrowse(form.root?.trim() || '')}>浏览…</button></div>
          <small className="dsh-wb-field-hint">须位于 DSH_HOME 之外;一个路径只绑一个项目</small>
          {recentRoots.length > 0 && <div className="dsh-wb-row" style={{ marginTop: 6, flexWrap: 'wrap', gap: 6 }}>{recentRoots.map((r) => <button key={r} type="button" className="dsh-wb-pickerchip" title={r} onClick={() => setForm({ ...form, root: r })}>↻ {r.split(/[\/]/).filter(Boolean).pop() || r}</button>)}</div>}</div>}
        <div className="dsh-wb-field"><label>项目目标(可选)</label><textarea className="dsh-wb-textarea" rows={3} value={form.goal ?? ''} onChange={(e) => setForm({ ...form, goal: e.target.value })} placeholder="一段话说明这个项目要解决什么问题" /></div>
        <div className="dsh-wb-field"><label>项目说明(可选)</label><textarea className="dsh-wb-textarea" rows={3} value={form.description ?? ''} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="方法论、分工、注意事项等" /></div></>}
      {modal === 'agent' && <><Field autoFocus label="Agent 名称" value={form.name} onChange={(v) => setForm({ ...form, name: v })} /><div className="dsh-wb-field"><label>模型</label><select className="dsh-wb-select" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })}>{models.allowed.map((m) => <option key={m}>{m}</option>)}</select></div>
        <div className="dsh-wb-field"><label>角色描述(可选,不注入提示词)</label><input className="dsh-wb-input" value={form.displayDescription ?? ''} onChange={(e) => setForm({ ...form, displayDescription: e.target.value })} placeholder="一句话说明这个 Agent 做什么(仅 UI 展示)" /></div><div className="dsh-wb-field"><label>工作指令</label><textarea className="dsh-wb-textarea" rows={Math.min(16, Math.max(4, (form.instructions ?? '').split('\n').length))} value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} /></div><div className="dsh-wb-field"><label>受控工具权限</label><div className="dsh-wb-row">{Object.entries(TOOLS).map(([name, label]) => <label key={name} className="dsh-wb-row"><input type="checkbox" checked={toolAllow.includes(name)} onChange={(e) => setToolAllow(e.target.checked ? [...toolAllow, name] : toolAllow.filter((x) => x !== name))} />{label}</label>)}</div></div></>}
      {modal === 'squad' && <><Field autoFocus label="小队名称" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
  <div className="dsh-wb-field"><label>小队说明(可选)</label><textarea className="dsh-wb-textarea" rows={2} value={form.description ?? ''} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
  <div className="dsh-wb-field"><label>步骤(每步选一个 Agent)</label>
    {(form.steps ?? '').split('\n').filter(Boolean).map((line, i) => {
      const [agentId, ...resp] = line.split('|');
      return <div key={i} className="dsh-wb-row" style={{ marginBottom: 4 }}>
        <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-caption)', minWidth: 20 }}>第{i + 1}步</span>
        <select className="dsh-wb-select" style={{ flex: 1 }} value={agentId} onChange={(e) => {
          const lines = (form.steps ?? '').split('\n').filter(Boolean);
          lines[i] = `${e.target.value}|${resp.join('|')}`;
          setForm({ ...form, steps: lines.join('\n') });
        }}>{overview.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        <input className="dsh-wb-input" style={{ flex: 1 }} placeholder="职责说明(可选)" value={resp.join('|')} onChange={(e) => {
          const lines = (form.steps ?? '').split('\n').filter(Boolean);
          lines[i] = `${agentId}|${e.target.value}`;
          setForm({ ...form, steps: lines.join('\n') });
        }} />
      </div>;
    })}
    <button type="button" className="dsh-wb-btn" onClick={() => setForm({ ...form, steps: (form.steps ? form.steps + '\n' : '') + (overview.agents[0]?.id ?? '') + '|' })}>+ 添加步骤</button>
  </div></>}
      {modal === 'automation' && <><Field autoFocus label="规则名称" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
  <div className="dsh-wb-field"><label>cron 表达式(分 时 日 月 周)</label><input className="dsh-wb-input" value={form.cron ?? ''} onChange={(e) => setForm({ ...form, cron: e.target.value })} placeholder="0 9 * * *(每天9点)或 0 */2 * * *(每2小时)" /></div>
  <div className="dsh-wb-field"><label>时区</label><input className="dsh-wb-input" value={form.timezone ?? 'Asia/Shanghai'} onChange={(e) => setForm({ ...form, timezone: e.target.value })} /></div>
  <div className="dsh-wb-field"><label>任务模板 · 项目</label><select className="dsh-wb-select" value={form.projectId ?? ''} onChange={(e) => setForm({ ...form, projectId: e.target.value })}>{overview.projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></div>
  <Field label="任务标题" value={form.title} onChange={(v) => setForm({ ...form, title: v })} />
  <div className="dsh-wb-field"><label>任务描述</label><textarea className="dsh-wb-textarea" rows={3} value={form.description ?? ''} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
  <div className="dsh-wb-field"><label>验收标准</label><textarea className="dsh-wb-textarea" rows={2} value={form.acceptanceCriteria ?? ''} onChange={(e) => setForm({ ...form, acceptanceCriteria: e.target.value })} /></div>
  <div className="dsh-wb-field"><label>分派 Agent</label><select className="dsh-wb-select" value={form.assigneeId ?? ''} onChange={(e) => setForm({ ...form, assigneeId: e.target.value })}>{overview.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div></>}
      {modal === 'task' && <><div className="dsh-wb-field"><label>项目</label>{editing ? <div>{overview.projects.find((p) => p.id === form.projectId)?.title}</div> : <select className="dsh-wb-select" value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })}>{overview.projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select>}</div><Field autoFocus label="任务标题" value={form.title} onChange={(v) => setForm({ ...form, title: v })} /><div className="dsh-wb-field"><label>任务描述</label><textarea className="dsh-wb-textarea" rows={Math.min(10, Math.max(3, (form.description ?? '').split('\n').length))} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div><div className="dsh-wb-field"><label>验收标准(必填)</label><textarea className="dsh-wb-textarea" rows={Math.min(10, Math.max(3, (form.acceptanceCriteria ?? '').split('\n').length))} value={form.acceptanceCriteria} onChange={(e) => setForm({ ...form, acceptanceCriteria: e.target.value })} /></div><div className="dsh-wb-field"><label>分派 Agent</label><select className="dsh-wb-select" value={form.assigneeId} onChange={(e) => setForm({ ...form, assigneeId: e.target.value })}><option value="">暂不分派</option>{overview.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}{squads.length > 0 && <optgroup label="小队">{squads.map((sq) => <option key={sq.id} value={sq.id}>☰ {sq.name}({sq.steps.length}步)</option>)}</optgroup>}</select><small className="dsh-wb-field-hint">分派后需到任务详情点「手动运行」才会启动子代理。</small></div></>}
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
