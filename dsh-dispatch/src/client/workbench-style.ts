/**
 * 工作台视觉体系(Wave 2 重写):
 * - 全部颜色经 dsw-alias-* 设计令牌(带暗色 fallback)+ color-mix 同色派生,
 *   亮色宿主自动适配;不再硬编码品牌色
 * - 动效令牌(--dsp-dur/--dsp-ease):交互过渡、列表 stagger 入场、
 *   modal 弹入、抽屉滑入、看板拖拽物理;全部受 prefers-reduced-motion 关断
 * - 排版节奏:标题/正文/meta 三级 + tabular-nums;状态语义色
 *   (执行中=蓝/待验收=琥珀/受阻=红/完成=绿)统一映射
 */
export const workbenchCss = `
.dsh-wb {
  --dsp-accent: var(--dsw-alias-state-business-primary, #4d6bfe);
  --dsp-ok: var(--dsw-alias-state-success-primary, #30a46c);
  --dsp-warn: var(--dsw-alias-state-warn-primary, #f5a524);
  --dsp-bad: var(--dsw-alias-state-error-primary, #e5484d);
  --dsp-dur-fast: 140ms; --dsp-dur: 220ms; --dsp-dur-slow: 320ms;
  --dsp-ease: cubic-bezier(.2,0,0,1);
  --dsp-spring: cubic-bezier(.34,1.3,.64,1);
  position: fixed; inset: var(--dsh-desktop-titlebar-inset, 0px) 0 0 0; z-index: 110; display: flex;
  background: var(--dsw-alias-bg-base, #101216); color: var(--dsw-alias-label-primary, #f2f3f5);
  font: 13px/1.5 Inter, system-ui, sans-serif;
  animation: dsp-fade var(--dsp-dur) var(--dsp-ease);
}
.dsh-wb * { box-sizing: border-box; }
.dsh-wb button,.dsh-wb input,.dsh-wb textarea,.dsh-wb select { font: inherit; }
.dsh-wb button { cursor: pointer; transition: background var(--dsp-dur-fast) var(--dsp-ease), border-color var(--dsp-dur-fast) var(--dsp-ease), color var(--dsp-dur-fast) var(--dsp-ease), transform var(--dsp-dur-fast) var(--dsp-ease), opacity var(--dsp-dur-fast) var(--dsp-ease); }
.dsh-wb button:disabled { opacity: .45; cursor: not-allowed; }
.dsh-wb button:focus-visible,.dsh-wb input:focus-visible,.dsh-wb textarea:focus-visible,.dsh-wb select:focus-visible { outline: 2px solid color-mix(in srgb, var(--dsp-accent) 85%, white); outline-offset: 2px; }
.dsh-wb strong { font-variant-numeric: tabular-nums; }

/* ---------- 导航 ---------- */
.dsh-wb-nav { width: 216px; flex: 0 0 216px; padding: 18px 12px 14px; border-right: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.24)); background: color-mix(in srgb, var(--dsp-accent) 3%, var(--dsw-alias-bg-base, #101216)); display: flex; flex-direction: column; gap: 3px; }
.dsh-wb-brand { padding: 2px 12px 18px; font-weight: 730; font-size: 16px; letter-spacing: -.3px; }
.dsh-wb-brand small { display: block; font-size: 9.5px; color: var(--dsw-alias-label-caption, #8d95a3); letter-spacing: 2px; margin-bottom: 4px; }
.dsh-wb-navbtn { position: relative; border: 0; background: transparent; color: var(--dsw-alias-label-secondary, #b6bcc7); text-align: left; padding: 9px 12px; border-radius: 9px; display: flex; align-items: center; gap: 9px; font-size: 12.5px; }
.dsh-wb-navbtn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); color: var(--dsw-alias-label-primary); }
.dsh-wb-navbtn.active { background: color-mix(in srgb, var(--dsp-accent) 16%, transparent); color: color-mix(in srgb, var(--dsp-accent) 55%, white); font-weight: 650; }
.dsh-wb-navbtn.active:before { content: ''; position: absolute; left: 0; top: 20%; bottom: 20%; width: 3px; border-radius: 99px; background: var(--dsp-accent); }
.dsh-wb-navbtn .dsp-nav-ico { flex: none; width: 16px; text-align: center; opacity: .8; font-size: 13px; }
.dsh-wb-navfoot { margin-top: auto; padding: 12px 12px 0; color: var(--dsw-alias-label-caption, #9299a5); font-size: 10.5px; border-top: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.2)); line-height: 1.6; }

/* ---------- 主体与页头 ---------- */
.dsh-wb-main { flex: 1; min-width: 0; overflow: auto; padding: 22px clamp(18px, 3vw, 44px) 44px; animation: dsp-slide-up var(--dsp-dur-slow) var(--dsp-ease); }
.dsh-wb-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 22px; }
.dsh-wb-kicker { text-transform: uppercase; color: color-mix(in srgb, var(--dsp-accent) 65%, white); font-size: 10px; letter-spacing: 2px; font-weight: 750; }
.dsh-wb h1 { margin: 3px 0 0; font-size: clamp(21px, 2vw, 27px); line-height: 1.2; letter-spacing: -.5px; }
.dsh-wb h2 { font-size: 16px; margin: 0 0 12px; letter-spacing: -.2px; }
.dsh-wb h3 { font-size: 13.5px; margin: 0 0 8px; }
.dsh-wb-head-actions,.dsh-wb-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

/* ---------- 按钮 ---------- */
.dsh-wb-btn { border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.08)); color: inherit; border-radius: 8px; padding: 6px 12px; min-height: 32px; font-weight: 550; }
.dsh-wb-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.16)); border-color: color-mix(in srgb, var(--dsp-accent) 40%, var(--dsw-alias-border-l2, rgba(127,127,127,.3))); }
.dsh-wb-btn:active:not(:disabled) { transform: scale(.97); }
.dsh-wb-btn.primary { background: linear-gradient(180deg, color-mix(in srgb, var(--dsp-accent) 88%, white), var(--dsp-accent)); border-color: color-mix(in srgb, var(--dsp-accent) 80%, black); color: white; font-weight: 650; }
.dsh-wb-btn.primary:hover:not(:disabled) { background: linear-gradient(180deg, color-mix(in srgb, var(--dsp-accent) 78%, white), color-mix(in srgb, var(--dsp-accent) 92%, white)); }
.dsh-wb-btn.danger { color: var(--dsp-bad); border-color: color-mix(in srgb, var(--dsp-bad) 40%, transparent); }
.dsh-wb-btn.danger:hover:not(:disabled) { background: color-mix(in srgb, var(--dsp-bad) 12%, transparent); }
.dsh-wb-btn.ghost { border-color: transparent; background: transparent; }
.dsh-wb-btn.ghost:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); }

/* ---------- 统计卡(可点)与面板 ---------- */
.dsh-wb-grid { display: grid; grid-template-columns: repeat(5, minmax(120px, 1fr)); gap: 10px; margin-bottom: 24px; }
.dsh-wb-stat,.dsh-wb-panel,.dsh-wb-card { border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22)); background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06)); border-radius: 12px; }
.dsh-wb-stat { padding: 13px 15px; display: block; width: 100%; text-align: left; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22)); position: relative; overflow: hidden; }
.dsh-wb-stat:before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--dsp-stat-color, var(--dsp-accent)); opacity: .85; }
.dsh-wb-stat span { display: block; font-size: 11px; color: var(--dsw-alias-label-secondary, #a0a8b5); }
.dsh-wb-stat strong { font-size: 25px; line-height: 1.45; display: block; margin-top: 1px; color: var(--dsp-stat-color, var(--dsw-alias-label-primary)); }
.dsh-wb-stat[data-tone="todo"] { --dsp-stat-color: var(--dsw-alias-label-caption, #8f96a3); }
.dsh-wb-stat[data-tone="in_progress"] { --dsp-stat-color: var(--dsp-accent); }
.dsh-wb-stat[data-tone="in_review"] { --dsp-stat-color: var(--dsp-warn); }
.dsh-wb-stat[data-tone="blocked"] { --dsp-stat-color: var(--dsp-bad); }
.dsh-wb-stat[data-tone="done"] { --dsp-stat-color: var(--dsp-ok); }
.dsh-wb-stat:hover { border-color: color-mix(in srgb, var(--dsp-stat-color, var(--dsp-accent)) 45%, transparent); background: color-mix(in srgb, var(--dsp-stat-color, var(--dsp-accent)) 6%, var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))); }
.dsh-wb-panel { padding: 16px 18px; margin-bottom: 14px; }

/* ---------- 工具栏 / 表单 ---------- */
.dsh-wb-toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; }
.dsh-wb-input,.dsh-wb-select,.dsh-wb-textarea { border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); background: var(--dsw-alias-bg-base, #141820); color: inherit; border-radius: 8px; padding: 8px 10px; min-height: 34px; transition: border-color var(--dsp-dur-fast) var(--dsp-ease), box-shadow var(--dsp-dur-fast) var(--dsp-ease); }
.dsh-wb-input:focus,.dsh-wb-select:focus,.dsh-wb-textarea:focus { border-color: var(--dsp-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsp-accent) 22%, transparent); outline: none; }
.dsh-wb-textarea { width: 100%; min-height: 84px; resize: vertical; line-height: 1.6; }
.dsh-wb-field { display: flex; flex-direction: column; gap: 5px; margin: 12px 0; }
.dsh-wb-field label { color: var(--dsw-alias-label-secondary, #a3acba); font-size: 11px; font-weight: 650; }
.dsh-wb-field input,.dsh-wb-field select { width: 100%; }
.dsh-wb-field-hint { display: block; color: var(--dsw-alias-label-caption, #9aa2b0); font-size: 10px; margin-top: 3px; line-height: 1.5; }

/* ---------- 看板 ---------- */
.dsh-wb-board { display: grid; grid-template-columns: repeat(5, minmax(170px, 1fr)); gap: 11px; align-items: start; overflow-x: auto; padding-bottom: 10px; }
.dsh-wb-col { min-height: 180px; border: 1px dashed var(--dsw-alias-border-l2, rgba(127,127,127,.28)); border-radius: 12px; padding: 10px; background: color-mix(in srgb, var(--dsp-accent) 2%, var(--dsw-alias-bg-base, transparent)); transition: border-color var(--dsp-dur-fast) var(--dsp-ease), background var(--dsp-dur-fast) var(--dsp-ease); }
.dsh-wb-col.over { border-style: solid; border-color: color-mix(in srgb, var(--dsp-accent) 60%, transparent); background: color-mix(in srgb, var(--dsp-accent) 9%, transparent); }
.dsh-wb-col[data-accepts="no"] { opacity: .78; }
.dsh-wb-col-head { display: flex; justify-content: space-between; font-size: 11.5px; font-weight: 700; padding: 4px 4px 12px; letter-spacing: .02em; }
.dsh-wb-col-head em { font-style: normal; color: var(--dsw-alias-label-caption, #9199a6); font-weight: 500; font-variant-numeric: tabular-nums; }
.dsh-wb-card { padding: 11px 12px; margin-bottom: 8px; background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.07)); border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18)); border-radius: 10px; transition: border-color var(--dsp-dur-fast) var(--dsp-ease), transform var(--dsp-dur-fast) var(--dsp-ease), box-shadow var(--dsp-dur-fast) var(--dsp-ease); }
.dsh-wb-card:hover { border-color: color-mix(in srgb, var(--dsp-accent) 45%, transparent); transform: translateY(-1px); box-shadow: 0 4px 14px rgba(0,0,0,.14); }
.dsh-wb-card-title { border: 0; padding: 0; background: none; color: inherit; text-align: left; font-weight: 650; width: 100%; font-size: 12.5px; line-height: 1.45; }
.dsh-wb-card-title:hover { color: color-mix(in srgb, var(--dsp-accent) 55%, white); }
.dsh-wb-card-desc { color: var(--dsw-alias-label-secondary, #b7bdc7); font-size: 10.5px; line-height: 1.5; margin-top: 5px; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.dsh-wb-card-live { width: 8px; height: 8px; border-radius: 99px; flex: none; margin-left: auto; background: var(--dsp-accent); animation: dsp-pulse 1.6s ease-in-out infinite; }
.dsh-wb-muted { color: var(--dsw-alias-label-caption, #929aa7); font-size: 11px; margin-top: 4px; }
.dsh-wb-drag { border: 0; background: transparent; color: var(--dsw-alias-label-caption, #9aa2b0); padding: 2px 4px; cursor: grab; font-size: 12px; line-height: 1; }

/* ---------- 表格 / 链接 ---------- */
.dsh-wb-table { width: 100%; border-collapse: collapse; }
.dsh-wb-table th,.dsh-wb-table td { text-align: left; padding: 10px 9px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.16)); vertical-align: top; }
.dsh-wb-table th { font-size: 10.5px; color: var(--dsw-alias-label-caption, #9aa2b0); text-transform: uppercase; letter-spacing: .05em; }
.dsh-wb-table tbody tr { transition: background var(--dsp-dur-fast) var(--dsp-ease); }
.dsh-wb-table tbody tr:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08)); }
.dsh-wb-link { background: none; border: 0; color: color-mix(in srgb, var(--dsp-accent) 65%, white); padding: 0; text-align: left; font-weight: 550; }
.dsh-wb-link:hover { color: color-mix(in srgb, var(--dsp-accent) 80%, white); text-decoration: underline; text-underline-offset: 3px; }

/* ---------- 任务详情抽屉 / 遮罩 / 弹窗 ---------- */
.dsh-wb-backdrop { position: fixed; z-index: 111; inset: 0; background: rgba(0,0,0,.38); border: 0; animation: dsp-fade var(--dsp-dur) var(--dsp-ease); }
.dsh-wb-detail { position: fixed; z-index: 112; top: var(--dsh-desktop-titlebar-inset, 0px); right: 0; bottom: 0; width: min(880px, 100vw); overflow: auto; background: var(--dsw-alias-bg-base, #161a21); box-shadow: -18px 0 42px rgba(0,0,0,.35); border-left: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.26)); padding: 22px 26px; animation: dsp-slide-in var(--dsp-dur-slow) var(--dsp-ease); }
.dsh-wb-modal { position: fixed; z-index: 113; top: 50%; left: 50%; transform: translate(-50%,-50%); width: min(540px, calc(100vw - 24px)); max-height: calc(100vh - 28px); overflow: auto; padding: 20px 22px; background: var(--dsw-alias-bg-base, #20242c); border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); border-radius: 14px; box-shadow: 0 24px 65px rgba(0,0,0,.45); animation: dsp-pop var(--dsp-dur) var(--dsp-spring); }

.dsh-wb-code { white-space: pre-wrap; overflow-wrap: anywhere; font: 11px/1.55 ui-monospace, Consolas, monospace; padding: 10px; border-radius: 8px; background: color-mix(in srgb, black 14%, transparent); margin: 6px 0; }
.dsh-wb-error { border: 1px solid color-mix(in srgb, var(--dsp-bad) 45%, transparent); color: color-mix(in srgb, var(--dsp-bad) 70%, white); background: color-mix(in srgb, var(--dsp-bad) 10%, transparent); padding: 10px 12px; border-radius: 8px; margin-bottom: 14px; font-size: 12px; line-height: 1.6; animation: dsp-shake var(--dsp-dur) var(--dsp-ease); }
.dsh-wb-empty { color: var(--dsw-alias-label-caption, #9aa2b0); padding: 26px 10px; text-align: center; line-height: 1.8; }

/* ---------- Run 面板 ---------- */
.dsh-wb-run { margin-bottom: 16px; }
.dsh-wb-run-state { border: 1px solid color-mix(in srgb, var(--dsp-accent) 32%, transparent); border-left: 4px solid var(--dsp-accent); border-radius: 12px; background: color-mix(in srgb, var(--dsp-accent) 7%, var(--dsw-alias-bg-base, transparent)); padding: 17px 19px; margin-bottom: 10px; }
.dsh-wb-run-state.success { border-color: color-mix(in srgb, var(--dsp-ok) 34%, transparent); border-left-color: var(--dsp-ok); background: color-mix(in srgb, var(--dsp-ok) 7%, var(--dsw-alias-bg-base, transparent)); }
.dsh-wb-run-state.warning { border-color: color-mix(in srgb, var(--dsp-warn) 36%, transparent); border-left-color: var(--dsp-warn); background: color-mix(in srgb, var(--dsp-warn) 7%, var(--dsw-alias-bg-base, transparent)); }
.dsh-wb-run-state-top { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.dsh-wb-run-state h3 { font-size: 21px; margin: 4px 0 2px; letter-spacing: -.3px; }
.dsh-wb-run-state-top span { color: var(--dsw-alias-label-secondary, #c0c8d4); font-size: 12px; }
.dsh-wb-run-state p { margin: 7px 0 0; color: var(--dsw-alias-label-secondary, #ccd5df); line-height: 1.65; }
.dsh-wb-run-latest { font-size: 12px; opacity: .9; }
.dsh-wb-run-progress { display: grid; grid-template-columns: auto minmax(0,1fr) auto; align-items: baseline; gap: 9px; margin-top: 12px; padding: 10px 11px; border-radius: 8px; background: color-mix(in srgb, white 5%, transparent); }
.dsh-wb-run-progress b { color: color-mix(in srgb, var(--dsp-accent) 45%, white); white-space: nowrap; }
.dsh-wb-run-progress span { line-height: 1.55; }
.dsh-wb-run-progress time { color: var(--dsw-alias-label-caption, #9db0c5); font-size: 11px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.dsh-wb-run-state .dsh-wb-row { margin-top: 15px; }
.dsh-wb-run-facts { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 8px; margin-bottom: 13px; }
.dsh-wb-run-facts > div { min-width: 0; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18)); border-radius: 9px; background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.05)); }
.dsh-wb-run-facts span { display: block; color: var(--dsw-alias-label-caption, #99a8bb); font-size: 10.5px; margin-bottom: 3px; }
.dsh-wb-run-facts strong { display: block; font-weight: 600; font-size: 12px; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.dsh-wb-run-tabs { display: flex; gap: 3px; padding: 4px; border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18)); border-radius: 9px; background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.05)); margin-bottom: 10px; }
.dsh-wb-run-tabs button { flex: 1; border: 0; border-radius: 6px; color: var(--dsw-alias-label-secondary, #aeb9c7); background: transparent; min-height: 32px; font-weight: 640; }
.dsh-wb-run-tabs button.active { color: white; background: color-mix(in srgb, var(--dsp-accent) 72%, black); }
.dsh-wb-run-content { min-height: 160px; animation: dsp-fade var(--dsp-dur) var(--dsp-ease); }
.dsh-wb-run-content h3 { font-size: 14px; margin: 15px 0 8px; }
.dsh-wb-run-content h3:first-child { margin-top: 0; }
.dsh-wb-run-result { border-left: 3px solid var(--dsp-accent); padding: 9px 12px; margin-bottom: 16px; background: color-mix(in srgb, var(--dsp-accent) 8%, transparent); border-radius: 0 8px 8px 0; }
.dsh-wb-run-result p,.dsh-wb-run-next p { margin: 5px 0 0; line-height: 1.65; white-space: pre-wrap; }
.dsh-wb-copy { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.7; }
.dsh-wb-run-next { margin: 16px 0; padding: 11px 14px; border-radius: 9px; background: color-mix(in srgb, var(--dsp-ok) 8%, transparent); border: 1px solid color-mix(in srgb, var(--dsp-ok) 26%, transparent); }
.dsh-wb-evidence-list { display: grid; gap: 7px; }
.dsh-wb-evidence { display: grid; grid-template-columns: 56px minmax(0,1fr) auto; gap: 11px; align-items: start; padding: 10px 11px; border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18)); border-radius: 8px; background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.04)); overflow-wrap: anywhere; }
.dsh-wb-evidence > span { color: color-mix(in srgb, var(--dsp-accent) 55%, white); font-size: 10.5px; font-weight: 700; }
.dsh-wb-evidence b { font-weight: 600; }
.dsh-wb-evidence small { display: block; color: var(--dsw-alias-label-caption, #9ba6b4); margin-top: 4px; font: 10.5px/1.5 ui-monospace,Consolas,monospace; }
.dsh-wb-evidence .dsh-wb-link { white-space: nowrap; font-size: 11px; }
.dsh-wb-technical { margin-top: 18px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18)); padding-top: 10px; color: var(--dsw-alias-label-secondary, #aeb9c7); font-size: 11px; overflow-wrap: anywhere; }
.dsh-wb-technical summary { cursor: pointer; width: fit-content; }
.dsh-wb-technical div { margin-top: 6px; }
.dsh-wb-run-section-head { display: flex; justify-content: space-between; align-items: start; gap: 12px; margin-bottom: 11px; }
.dsh-wb-run-section-head h3 { margin: 0 0 3px; }
.dsh-wb-run-section-head p { margin: 0; color: var(--dsw-alias-label-caption, #9ba8b8); font-size: 11px; }
.dsh-wb-run-section-head > span { color: var(--dsw-alias-label-caption, #9ba8b8); font-size: 11px; white-space: nowrap; font-variant-numeric: tabular-nums; }

/* ---------- 执行活动 ---------- */
.dsh-wb-filter { display: flex; flex-wrap: wrap; gap: 5px; margin: 0 0 13px; }
.dsh-wb-filter button { border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); border-radius: 999px; color: var(--dsw-alias-label-secondary, #afbac8); background: transparent; padding: 4px 11px; font-size: 11px; }
.dsh-wb-filter button.active { background: color-mix(in srgb, var(--dsp-accent) 24%, transparent); border-color: color-mix(in srgb, var(--dsp-accent) 55%, transparent); color: color-mix(in srgb, var(--dsp-accent) 70%, white); }
.dsh-wb-activity { border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2)); border-left: 3px solid color-mix(in srgb, var(--dsp-accent) 50%, transparent); border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.03)); animation: dsp-slide-up var(--dsp-dur) var(--dsp-ease); }
.dsh-wb-activity.tool { border-left-color: var(--dsp-warn); }
.dsh-wb-activity.error { border-color: color-mix(in srgb, var(--dsp-bad) 40%, transparent); border-left-color: var(--dsp-bad); }
.dsh-wb-activity-head { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
.dsh-wb-activity-head time { color: var(--dsw-alias-label-caption, #8f9aa8); font-size: 10.5px; margin-left: auto; font-variant-numeric: tabular-nums; }
.dsh-wb-activity-head strong { color: color-mix(in srgb, var(--dsp-bad) 75%, white); font-size: 11px; }
.dsh-wb-activity-kind { color: var(--dsw-alias-label-primary, #d6e2f1); font-size: 11px; font-weight: 700; }
.dsh-wb-expand { min-width: 0; }
.dsh-wb-expand summary { cursor: pointer; color: var(--dsw-alias-label-secondary, #b9c8da); font-size: 11px; line-height: 1.5; }
.dsh-wb-expand summary span { color: var(--dsw-alias-label-caption, #8796a8); font-weight: 400; }
.dsh-wb-expand pre { max-height: 420px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; padding: 10px; border-radius: 8px; background: color-mix(in srgb, black 16%, transparent); font: 11px/1.55 ui-monospace,Consolas,monospace; }
.dsh-wb-raw-event { padding: 10px 0; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.16)); }
.dsh-wb-raw-event:last-of-type { border-bottom: 0; }

/* ---------- Run 历史/对比 ---------- */
.dsh-wb-run-list { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 8px; }
.dsh-wb-run-choice { display: flex; flex-direction: column; gap: 5px; min-width: 0; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28)); border-radius: 9px; text-align: left; color: inherit; background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.04)); }
.dsh-wb-run-choice:hover { border-color: color-mix(in srgb, var(--dsp-accent) 42%, transparent); }
.dsh-wb-run-choice.active { border-color: color-mix(in srgb, var(--dsp-accent) 62%, transparent); background: color-mix(in srgb, var(--dsp-accent) 9%, transparent); box-shadow: 0 0 0 1px color-mix(in srgb, var(--dsp-accent) 40%, transparent) inset; }
.dsh-wb-run-choice-top { display: flex; gap: 8px; justify-content: space-between; align-items: center; }
.dsh-wb-run-choice small { color: var(--dsw-alias-label-caption, #9da9b8); font-variant-numeric: tabular-nums; }
.dsh-wb-run-choice > span:last-child { color: var(--dsw-alias-label-secondary, #bbc8d6); font-size: 11px; }
.dsh-wb-run-pill { display: inline-block; border: 1px solid color-mix(in srgb, var(--dsp-accent) 42%, transparent); border-radius: 999px; color: color-mix(in srgb, var(--dsp-accent) 65%, white); padding: 1px 8px; font-size: 10px; white-space: nowrap; }
.dsh-wb-compare { margin-top: 16px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18)); padding-top: 14px; }
.dsh-wb-compare-controls { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px; }
.dsh-wb-compare-controls label { display: flex; flex-direction: column; gap: 4px; color: var(--dsw-alias-label-secondary, #a4b2c2); font-size: 11px; }
.dsh-wb-compare-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 9px; }
.dsh-wb-compare-col { min-width: 0; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28)); border-radius: 9px; padding: 12px; background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.04)); }
.dsh-wb-compare-col dl { margin: 10px 0 0; }
.dsh-wb-compare-col dt { color: var(--dsw-alias-label-caption, #91a5bc); font-size: 10.5px; margin-top: 10px; }
.dsh-wb-compare-col dd { margin: 3px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6; }

/* ---------- 验收/任务卡 ---------- */
.dsh-wb-review { border-color: color-mix(in srgb, var(--dsp-ok) 32%, transparent); background: color-mix(in srgb, var(--dsp-ok) 5%, var(--dsw-alias-bg-base, transparent)); }
.dsh-wb-review p { color: var(--dsw-alias-label-secondary, #c3d4ca); margin: 0 0 12px; }
.dsh-wb-task-brief { padding: 0; }
.dsh-wb-task-brief summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; cursor: pointer; list-style-position: inside; }
.dsh-wb-task-brief summary span { color: var(--dsw-alias-label-caption, #aab9c9); font-size: 11px; font-weight: 400; text-align: right; }
.dsh-wb-task-brief h3,.dsh-wb-task-brief p { margin-left: 16px; margin-right: 16px; }
.dsh-wb-task-brief p:last-child { margin-bottom: 16px; }
.dsh-wb-assignment { padding: 11px 15px; }
.dsh-wb-assignment .dsh-wb-row { align-items: center; }
.dsh-wb-task-timeline { border-left: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28)); margin: 15px 0 13px 5px; padding-left: 16px; }
.dsh-wb-task-event { position: relative; padding: 0 0 14px; }
.dsh-wb-task-event:before { content: ''; position: absolute; left: -20px; top: 4px; width: 7px; height: 7px; border-radius: 50%; background: color-mix(in srgb, var(--dsp-accent) 55%, transparent); }
.dsh-wb-task-event .dsh-wb-link { margin-top: 5px; font-size: 11px; }

/* ---------- 骨架屏 ---------- */
.dsh-wb-skel { border-radius: 8px; background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.08)); position: relative; overflow: hidden; }
.dsh-wb-skel:after { content: ''; position: absolute; inset: 0; background: linear-gradient(90deg, transparent, color-mix(in srgb, white 6%, transparent), transparent); animation: dsp-shimmer 1.4s infinite; }

/* ---------- 动效(表演性动效全部受 prefers-reduced-motion 关断) ---------- */
@keyframes dsp-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes dsp-slide-up { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@keyframes dsp-slide-in { from { transform: translateX(48px); opacity: .4; } to { transform: none; opacity: 1; } }
@keyframes dsp-pop { from { transform: translate(-50%,-50%) scale(.94); opacity: 0; } to { transform: translate(-50%,-50%) scale(1); opacity: 1; } }
@keyframes dsp-pulse { 0%,100% { opacity: 1; box-shadow: 0 0 0 0 color-mix(in srgb, var(--dsp-accent) 45%, transparent); } 50% { opacity: .55; box-shadow: 0 0 0 4px transparent; } }
@keyframes dsp-shimmer { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
@keyframes dsp-shake { 0%,100% { transform: none; } 25% { transform: translateX(-3px); } 75% { transform: translateX(3px); } }
@media (prefers-reduced-motion: no-preference) {
  .dsp-stagger > * { animation: dsp-slide-up var(--dsp-dur) var(--dsp-ease) both; animation-delay: calc(var(--dsp-i, 0) * 40ms); }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-wb, .dsh-wb-main, .dsh-wb-backdrop, .dsh-wb-detail, .dsh-wb-modal, .dsh-wb-run-content, .dsh-wb-activity, .dsh-wb-card-live, .dsh-wb-error, .dsh-wb-skel:after, .dsp-stagger > * { animation: none !important; }
  .dsh-wb button { transition: none; }
}

/* ---------- 窄屏 ---------- */
@media (max-width: 760px) { .dsh-wb-run-facts { grid-template-columns: repeat(2,minmax(0,1fr)); } .dsh-wb-run-list,.dsh-wb-compare-grid { grid-template-columns: 1fr; } .dsh-wb-run-progress,.dsh-wb-evidence { grid-template-columns: 1fr; gap: 2px; } }
@media (max-width: 850px) {
  .dsh-wb-nav { width: 54px; flex-basis: 54px; padding: 12px 6px; }
  .dsh-wb-brand { padding: 4px 2px 12px; font-size: 0; }
  .dsh-wb-brand:after { content: '◈'; font-size: 16px; }
  .dsh-wb-brand small,.dsh-wb-navfoot,.dsh-wb-navbtn span { display: none; }
  .dsh-wb-navbtn { justify-content: center; padding: 11px 0; font-size: 14px; }
  .dsh-wb-grid { grid-template-columns: repeat(2,1fr); }
}
@media print { .dsh-wb-nav,.dsh-wb-head-actions { display: none; } }

/* ---------- Wave 3:对话时间线与自动跟随 ---------- */
.dsh-wb-activity-scroll { position: relative; max-height: min(72vh, 900px); overflow-y: auto; scroll-behavior: smooth; }
.dsh-wb-chat { display: flex; gap: 10px; margin-bottom: 10px; animation: dsp-slide-up var(--dsp-dur) var(--dsp-ease); }
.dsh-wb-chat-avatar { flex: none; width: 26px; height: 26px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 12px; color: white; background: linear-gradient(160deg, color-mix(in srgb, var(--dsp-accent, #4d6bfe) 80%, white), var(--dsp-accent, #4d6bfe)); margin-top: 2px; }
.dsh-wb-chat-body { flex: 1; min-width: 0; border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2)); border-radius: 4px 12px 12px 12px; background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.05)); padding: 9px 13px 10px; }
.dsh-wb-chat.error .dsh-wb-chat-body { border-color: color-mix(in srgb, var(--dsp-bad, #e5484d) 40%, transparent); }
.dsh-wb-chat-meta { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
.dsh-wb-chat-meta b { font-size: 10.5px; font-weight: 700; color: color-mix(in srgb, var(--dsp-accent, #4d6bfe) 55%, white); letter-spacing: .02em; }
.dsh-wb-chat-meta time { font-size: 10px; color: var(--dsw-alias-label-caption, #8f9aa8); margin-left: auto; font-variant-numeric: tabular-nums; }
.dsh-wb-chat-text { font-size: 12px; color: var(--dsw-alias-label-primary); }
.dsh-wb-new-events { position: sticky; bottom: 12px; left: 50%; transform: translateX(-50%); display: block; margin: 0 auto; border: 1px solid color-mix(in srgb, var(--dsp-accent, #4d6bfe) 55%, transparent); background: color-mix(in srgb, var(--dsp-accent, #4d6bfe) 18%, var(--dsw-alias-bg-base, #161616)); color: color-mix(in srgb, var(--dsp-accent, #4d6bfe) 75%, white); border-radius: 999px; padding: 5px 14px; font-size: 11px; font-weight: 650; box-shadow: 0 6px 18px rgba(0,0,0,.3); }

/* ---------- P0:任务/Run 状态分离、总览行动区、预览 ---------- */
.dsh-wb-status-split { display: flex; gap: 8px; margin: 10px 0 0; flex-wrap: wrap; }
.dsh-wb-status-chip { display: inline-flex; align-items: center; gap: 5px; border-radius: 999px; padding: 3px 10px; font-size: 11px; font-weight: 650; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); }
.dsh-wb-status-chip[data-tone='in_review'] { color: var(--dsp-warn); border-color: color-mix(in srgb, var(--dsp-warn) 40%, transparent); background: color-mix(in srgb, var(--dsp-warn) 8%, transparent); }
.dsh-wb-status-chip[data-tone='blocked'] { color: var(--dsp-bad); border-color: color-mix(in srgb, var(--dsp-bad) 40%, transparent); background: color-mix(in srgb, var(--dsp-bad) 8%, transparent); }
.dsh-wb-status-chip[data-tone='done'] { color: var(--dsp-ok); border-color: color-mix(in srgb, var(--dsp-ok) 40%, transparent); background: color-mix(in srgb, var(--dsp-ok) 8%, transparent); }
.dsh-wb-status-chip[data-tone='in_progress'] { color: var(--dsp-accent); border-color: color-mix(in srgb, var(--dsp-accent) 40%, transparent); background: color-mix(in srgb, var(--dsp-accent) 8%, transparent); }
.dsh-wb-status-chip[data-tone='run'] { color: var(--dsw-alias-label-secondary); }
.dsh-wb-next-steps { border-left: 3px solid var(--dsp-accent); }
.dsh-wb-next-steps h2 { font-size: 14px; margin: 0 0 10px; }
.dsh-wb-guide-steps { display: flex; flex-direction: column; gap: 7px; margin: 0 0 14px; color: var(--dsw-alias-label-secondary); font-size: 12.5px; line-height: 1.6; }
.dsh-wb-guide-steps b { color: color-mix(in srgb, var(--dsp-accent) 60%, white); margin-right: 4px; }
.dsh-wb-action-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.14)); }
.dsh-wb-action-row:last-of-type { border-bottom: 0; }
.dsh-wb-action-why { flex: none; font-size: 10.5px; color: var(--dsw-alias-label-caption); white-space: nowrap; }
.dsh-wb-action-row .dsh-wb-link { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-wb-preview { z-index: 115; display: flex; flex-direction: column; gap: 8px; width: min(720px, calc(100vw - 40px)); }
.dsh-wb-preview-content { max-height: 60vh; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.65 ui-monospace, Consolas, monospace; padding: 12px; border-radius: 8px; background: color-mix(in srgb, black 14%, transparent); border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18)); }

`;
