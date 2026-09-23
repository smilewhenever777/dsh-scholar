export const workbenchCss = `
.dsh-wb { position: fixed; inset: var(--dsh-desktop-titlebar-inset, 0px) 0 0 0; z-index: 110; display: flex; background: var(--dsw-alias-bg-base, #101216); color: var(--dsw-alias-label-primary, #f2f3f5); font: 13px/1.5 Inter, system-ui, sans-serif; }
.dsh-wb * { box-sizing: border-box; }
.dsh-wb button,.dsh-wb input,.dsh-wb textarea,.dsh-wb select { font: inherit; }
.dsh-wb button { cursor: pointer; }
.dsh-wb button:disabled { opacity: .45; cursor: not-allowed; }
.dsh-wb button:focus-visible,.dsh-wb input:focus-visible,.dsh-wb textarea:focus-visible,.dsh-wb select:focus-visible { outline: 2px solid #7189ff; outline-offset: 2px; }
.dsh-wb-nav { width: 220px; flex: 0 0 220px; padding: 20px 12px; border-right: 1px solid var(--dsw-alias-border-l2, #343942); background: var(--dsw-alias-bg-layer-1, #171a20); display: flex; flex-direction: column; gap: 4px; }
.dsh-wb-brand { padding: 2px 12px 20px; font-weight: 730; font-size: 17px; letter-spacing: -.3px; }
.dsh-wb-brand small { display: block; font-size: 10px; color: var(--dsw-alias-label-caption, #8d95a3); letter-spacing: 2px; margin-bottom: 4px; }
.dsh-wb-navbtn { border: 0; background: transparent; color: inherit; text-align: left; padding: 10px 12px; border-radius: 9px; }
.dsh-wb-navbtn:hover,.dsh-wb-navbtn.active { background: var(--dsw-alias-bg-layer-2, #292e39); }
.dsh-wb-navbtn.active { color: #a9b8ff; font-weight: 650; }
.dsh-wb-navfoot { margin-top: auto; padding: 14px 12px 0; color: var(--dsw-alias-label-caption, #9299a5); font-size: 11px; border-top: 1px solid var(--dsw-alias-border-l2, #343942); }
.dsh-wb-main { flex: 1; min-width: 0; overflow: auto; padding: 24px clamp(18px, 3vw, 44px) 44px; }
.dsh-wb-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 24px; }
.dsh-wb-kicker { text-transform: uppercase; color: #8fa2ff; font-size: 10px; letter-spacing: 2px; font-weight: 750; }
.dsh-wb h1 { margin: 3px 0 0; font-size: clamp(22px, 2vw, 30px); line-height: 1.2; letter-spacing: -.6px; }
.dsh-wb h2 { font-size: 17px; margin: 0 0 14px; }
.dsh-wb h3 { font-size: 14px; margin: 0 0 8px; }
.dsh-wb-head-actions,.dsh-wb-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-wb-btn { border: 1px solid var(--dsw-alias-border-l2, #414651); background: var(--dsw-alias-bg-layer-1, #242832); color: inherit; border-radius: 8px; padding: 7px 11px; min-height: 34px; }
.dsh-wb-btn:hover { background: var(--dsw-alias-bg-layer-2, #303642); }
.dsh-wb-btn.primary { background: #5d74ec; border-color: #5d74ec; color: white; font-weight: 650; }
.dsh-wb-btn.primary:hover { background: #6e83f2; }
.dsh-wb-btn.danger { color: #f29a9a; }
.dsh-wb-btn.ghost { border-color: transparent; background: transparent; }
.dsh-wb-grid { display: grid; grid-template-columns: repeat(5, minmax(125px, 1fr)); gap: 12px; margin-bottom: 28px; }
.dsh-wb-stat,.dsh-wb-panel,.dsh-wb-card { border: 1px solid var(--dsw-alias-border-l2, #363b45); background: var(--dsw-alias-bg-layer-1, #1c2028); border-radius: 12px; }
.dsh-wb-stat { padding: 16px; }
.dsh-wb-stat span { display: block; font-size: 11px; color: var(--dsw-alias-label-secondary, #a0a8b5); }
.dsh-wb-stat strong { font-size: 27px; line-height: 1.5; }
.dsh-wb-panel { padding: 18px; margin-bottom: 16px; }
.dsh-wb-toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
.dsh-wb-input,.dsh-wb-select,.dsh-wb-textarea { border: 1px solid var(--dsw-alias-border-l2, #454b56); background: var(--dsw-alias-bg-base, #141820); color: inherit; border-radius: 8px; padding: 8px 10px; min-height: 35px; }
.dsh-wb-textarea { width: 100%; min-height: 90px; resize: vertical; }
.dsh-wb-field { display: flex; flex-direction: column; gap: 5px; margin: 12px 0; }
.dsh-wb-field label { color: var(--dsw-alias-label-secondary, #a3acba); font-size: 11px; font-weight: 650; }
.dsh-wb-field input,.dsh-wb-field select { width: 100%; }
.dsh-wb-board { display: grid; grid-template-columns: repeat(5, minmax(170px, 1fr)); gap: 12px; align-items: start; overflow-x: auto; padding-bottom: 10px; }
.dsh-wb-col { min-height: 180px; border: 1px solid var(--dsw-alias-border-l2, #343942); border-radius: 12px; padding: 10px; background: var(--dsw-alias-bg-layer-1, #1b1e25); }
.dsh-wb-col.over { border-color: #8fa2ff; background: rgba(110,130,255,.13); }
.dsh-wb-col-head { display: flex; justify-content: space-between; font-size: 12px; font-weight: 700; padding: 5px 4px 13px; }
.dsh-wb-col-head em { font-style: normal; color: var(--dsw-alias-label-caption, #9199a6); }
.dsh-wb-card { padding: 12px; margin-bottom: 9px; box-shadow: 0 4px 12px rgba(0,0,0,.09); }
.dsh-wb-card:hover { border-color: #667cda; }
.dsh-wb-card-title { border: 0; padding: 0; background: none; color: inherit; text-align: left; font-weight: 680; width: 100%; }
.dsh-wb-card-title:hover { color: #a9b8ff; }
.dsh-wb-muted { color: var(--dsw-alias-label-caption, #929aa7); font-size: 11px; }
.dsh-wb-drag { border: 0; background: transparent; color: var(--dsw-alias-label-caption, #9aa2b0); padding: 2px 4px; cursor: grab; }
.dsh-wb-table { width: 100%; border-collapse: collapse; }
.dsh-wb-table th,.dsh-wb-table td { text-align: left; padding: 11px 9px; border-bottom: 1px solid var(--dsw-alias-border-l2, #343942); vertical-align: top; }
.dsh-wb-table th { font-size: 11px; color: var(--dsw-alias-label-caption, #9aa2b0); }
.dsh-wb-link { background: none; border: 0; color: #9eb0ff; padding: 0; text-align: left; }
.dsh-wb-detail { position: fixed; z-index: 112; top: var(--dsh-desktop-titlebar-inset, 0px); right: 0; bottom: 0; width: min(900px, 100vw); overflow: auto; background: var(--dsw-alias-bg-base, #161a21); box-shadow: -18px 0 42px rgba(0,0,0,.35); border-left: 1px solid var(--dsw-alias-border-l2, #454b55); padding: 24px; }
.dsh-wb-backdrop { position: fixed; z-index: 111; inset: 0; background: rgba(0,0,0,.38); border: 0; }
.dsh-wb-modal { position: fixed; z-index: 113; top: 50%; left: 50%; transform: translate(-50%,-50%); width: min(560px, calc(100vw - 24px)); max-height: calc(100vh - 28px); overflow: auto; padding: 22px; background: var(--dsw-alias-bg-layer-1, #20242c); border: 1px solid var(--dsw-alias-border-l2, #414650); border-radius: 14px; box-shadow: 0 24px 65px rgba(0,0,0,.45); }
.dsh-wb-timeline { border-left: 1px solid var(--dsw-alias-border-l2, #454b56); padding-left: 17px; margin-left: 4px; }
.dsh-wb-timeline-item { position: relative; margin-bottom: 15px; white-space: pre-wrap; overflow-wrap: anywhere; }
.dsh-wb-timeline-item:before { content: ''; position: absolute; left: -22px; top: 6px; width: 8px; height: 8px; border-radius: 50%; background: #7e93ef; }
.dsh-wb-code { white-space: pre-wrap; overflow-wrap: anywhere; font: 11px/1.5 ui-monospace, Consolas, monospace; padding: 10px; border-radius: 8px; background: rgba(0,0,0,.2); margin: 6px 0; }
.dsh-wb-error { border: 1px solid #905258; color: #ffb6ba; background: rgba(183,70,78,.14); padding: 10px 12px; border-radius: 8px; margin-bottom: 15px; }
.dsh-wb-empty { color: var(--dsw-alias-label-caption, #9aa2b0); padding: 24px 10px; text-align: center; }
.dsh-wb-run { margin-bottom: 16px; }
.dsh-wb-run-state { border: 1px solid #526b91; border-left: 4px solid #80a7e9; border-radius: 12px; background: #1b2736; padding: 19px 20px; margin-bottom: 10px; }
.dsh-wb-run-state.success { border-color: #466f61; border-left-color: #78c3a0; background: #192b28; }
.dsh-wb-run-state.warning { border-color: #786247; border-left-color: #e2b06c; background: #302720; }
.dsh-wb-run-state-top { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.dsh-wb-run-state h3 { font-size: 23px; margin: 5px 0 3px; letter-spacing: -.3px; }
.dsh-wb-run-state-top span { color: #c7d2df; font-size: 12px; }
.dsh-wb-run-state p { margin: 7px 0 0; color: #d7e0e9; line-height: 1.65; }
.dsh-wb-run-latest { font-size: 12px; opacity: .9; }
.dsh-wb-run-progress { display: grid; grid-template-columns: auto minmax(0,1fr) auto; align-items: baseline; gap: 9px; margin-top: 12px; padding: 10px 11px; border-radius: 8px; background: rgba(255,255,255,.07); }
.dsh-wb-run-progress b { color: #c1d7f3; white-space: nowrap; }
.dsh-wb-run-progress span { line-height: 1.55; }
.dsh-wb-run-progress time { color: #9db0c5; font-size: 11px; white-space: nowrap; }
.dsh-wb-run-state .dsh-wb-row { margin-top: 16px; }
.dsh-wb-run-facts { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 8px; margin-bottom: 14px; }
.dsh-wb-run-facts > div { min-width: 0; padding: 11px 13px; border: 1px solid var(--dsw-alias-border-l2,#363b45); border-radius: 9px; background: var(--dsw-alias-bg-layer-1,#1c2028); }
.dsh-wb-run-facts span { display: block; color: #99a8bb; font-size: 11px; margin-bottom: 4px; }
.dsh-wb-run-facts strong { display: block; font-weight: 600; font-size: 12px; overflow-wrap: anywhere; }
.dsh-wb-run-tabs { display: flex; gap: 3px; padding: 4px; border: 1px solid var(--dsw-alias-border-l2,#363b45); border-radius: 9px; background: var(--dsw-alias-bg-layer-1,#1c2028); margin-bottom: 10px; }
.dsh-wb-run-tabs button { flex: 1; border: 0; border-radius: 6px; color: #aeb9c7; background: transparent; min-height: 35px; font-weight: 650; }
.dsh-wb-run-tabs button.active { color: #f3f6fb; background: #3b4d70; }
.dsh-wb-run-content { min-height: 160px; }
.dsh-wb-run-content h3 { font-size: 15px; margin: 16px 0 9px; }
.dsh-wb-run-content h3:first-child { margin-top: 0; }
.dsh-wb-run-result { border-left: 3px solid #80a7e9; padding: 9px 12px; margin-bottom: 18px; background: rgba(128,167,233,.09); }
.dsh-wb-run-result p,.dsh-wb-run-next p { margin: 5px 0 0; line-height: 1.65; white-space: pre-wrap; }
.dsh-wb-copy { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.7; }
.dsh-wb-run-next { margin: 17px 0; padding: 12px 14px; border-radius: 9px; background: rgba(120,195,160,.09); border: 1px solid rgba(120,195,160,.25); }
.dsh-wb-evidence-list { display: grid; gap: 8px; }
.dsh-wb-evidence { display: grid; grid-template-columns: 60px minmax(0,1fr) auto; gap: 11px; align-items: start; padding: 11px; border: 1px solid var(--dsw-alias-border-l2,#363b45); border-radius: 8px; background: rgba(255,255,255,.025); overflow-wrap: anywhere; }
.dsh-wb-evidence > span { color: #9bb6e0; font-size: 11px; font-weight: 700; }
.dsh-wb-evidence b { font-weight: 600; }
.dsh-wb-evidence small { display: block; color: #9ba6b4; margin-top: 4px; font: 11px/1.5 ui-monospace,Consolas,monospace; }
.dsh-wb-evidence .dsh-wb-link { white-space: nowrap; font-size: 11px; }
.dsh-wb-technical { margin-top: 20px; border-top: 1px solid var(--dsw-alias-border-l2,#363b45); padding-top: 10px; color: #aeb9c7; font-size: 11px; overflow-wrap: anywhere; }
.dsh-wb-technical summary { cursor: pointer; width: fit-content; }
.dsh-wb-technical div { margin-top: 6px; }
.dsh-wb-run-section-head { display: flex; justify-content: space-between; align-items: start; gap: 12px; margin-bottom: 12px; }
.dsh-wb-run-section-head h3 { margin: 0 0 3px; }
.dsh-wb-run-section-head p { margin: 0; color: #9ba8b8; font-size: 11px; }
.dsh-wb-run-section-head > span { color: #9ba8b8; font-size: 11px; white-space: nowrap; }
.dsh-wb-filter { display: flex; flex-wrap: wrap; gap: 5px; margin: 0 0 15px; }
.dsh-wb-filter button { border: 1px solid var(--dsw-alias-border-l2,#414651); border-radius: 20px; color: #afbac8; background: transparent; padding: 5px 10px; font-size: 11px; }
.dsh-wb-filter button.active { background: #344966; border-color: #7191bf; color: #f3f7fb; }
.dsh-wb-activity { border: 1px solid var(--dsw-alias-border-l2,#363b45); border-left: 3px solid #7694c0; border-radius: 8px; padding: 11px 13px; margin-bottom: 8px; background: rgba(255,255,255,.018); }
.dsh-wb-activity.tool { border-left-color: #b59a6a; }
.dsh-wb-activity.error { border-color: #a35e61; border-left-color: #ec8c8f; }
.dsh-wb-activity-head { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
.dsh-wb-activity-head time { color: #8f9aa8; font-size: 11px; margin-left: auto; }
.dsh-wb-activity-head strong { color: #ffb8bb; font-size: 11px; }
.dsh-wb-activity-kind { color: #d6e2f1; font-size: 11px; font-weight: 750; }
.dsh-wb-expand { min-width: 0; }
.dsh-wb-expand summary { cursor: pointer; color: #b9c8da; font-size: 11px; line-height: 1.5; }
.dsh-wb-expand summary span { color: #8796a8; font-weight: 400; }
.dsh-wb-expand pre { max-height: 420px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; padding: 11px; border-radius: 8px; background: rgba(0,0,0,.24); font: 11px/1.55 ui-monospace,Consolas,monospace; }
.dsh-wb-raw-event { padding: 10px 0; border-bottom: 1px solid var(--dsw-alias-border-l2,#363b45); }
.dsh-wb-raw-event:last-of-type { border-bottom: 0; }
.dsh-wb-run-list { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 8px; }
.dsh-wb-run-choice { display: flex; flex-direction: column; gap: 6px; min-width: 0; padding: 11px 12px; border: 1px solid var(--dsw-alias-border-l2,#414651); border-radius: 9px; text-align: left; color: inherit; background: rgba(255,255,255,.018); }
.dsh-wb-run-choice:hover,.dsh-wb-run-choice.active { border-color: #86a4d9; background: rgba(125,158,217,.10); }
.dsh-wb-run-choice-top { display: flex; gap: 8px; justify-content: space-between; align-items: center; }
.dsh-wb-run-choice small { color: #9da9b8; }
.dsh-wb-run-choice > span:last-child { color: #bbc8d6; font-size: 11px; }
.dsh-wb-run-pill { display: inline-block; border: 1px solid #6484b0; border-radius: 12px; color: #d8e7f9; padding: 2px 7px; font-size: 10px; white-space: nowrap; }
.dsh-wb-compare { margin-top: 17px; border-top: 1px solid var(--dsw-alias-border-l2,#414651); padding-top: 15px; }
.dsh-wb-compare-controls { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px; }
.dsh-wb-compare-controls label { display: flex; flex-direction: column; gap: 4px; color: #a4b2c2; font-size: 11px; }
.dsh-wb-compare-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 9px; }
.dsh-wb-compare-col { min-width: 0; border: 1px solid var(--dsw-alias-border-l2,#414651); border-radius: 9px; padding: 12px; background: rgba(255,255,255,.018); }
.dsh-wb-compare-col dl { margin: 10px 0 0; }
.dsh-wb-compare-col dt { color: #91a5bc; font-size: 11px; margin-top: 11px; }
.dsh-wb-compare-col dd { margin: 3px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6; }
.dsh-wb-review { border-color: #577968; background: #1c2b26; }
.dsh-wb-review p { color: #c3d4ca; margin: 0 0 12px; }
.dsh-wb-task-brief { padding: 0; }
.dsh-wb-task-brief summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; cursor: pointer; list-style-position: inside; }
.dsh-wb-task-brief summary span { color: #aab9c9; font-size: 11px; font-weight: 400; text-align: right; }
.dsh-wb-task-brief h3,.dsh-wb-task-brief p { margin-left: 16px; margin-right: 16px; }
.dsh-wb-task-brief p:last-child { margin-bottom: 16px; }
.dsh-wb-assignment { padding: 11px 15px; }
.dsh-wb-assignment .dsh-wb-row { align-items: center; }
.dsh-wb-task-timeline { border-left: 1px solid var(--dsw-alias-border-l2,#414651); margin: 16px 0 14px 5px; padding-left: 16px; }
.dsh-wb-task-event { position: relative; padding: 0 0 15px; }
.dsh-wb-task-event:before { content: ''; position: absolute; left: -21px; top: 4px; width: 7px; height: 7px; border-radius: 50%; background: #86a4d9; }
.dsh-wb-task-event .dsh-wb-link { margin-top: 5px; font-size: 11px; }
@media (max-width: 760px) { .dsh-wb-run-facts { grid-template-columns: repeat(2,minmax(0,1fr)); } .dsh-wb-run-list,.dsh-wb-compare-grid { grid-template-columns: 1fr; } .dsh-wb-run-progress,.dsh-wb-evidence { grid-template-columns: 1fr; gap: 2px; } }
@media (max-width: 850px) { .dsh-wb-nav { width: 62px; flex-basis: 62px; padding: 12px 4px; } .dsh-wb-brand { padding: 6px; font-size: 0; } .dsh-wb-brand:after { content: 'DSH'; font-size: 13px; } .dsh-wb-brand small,.dsh-wb-navfoot { display: none; } .dsh-wb-navbtn { font-size: 10px; text-align: center; padding: 10px 2px; } .dsh-wb-grid { grid-template-columns: repeat(2,1fr); } .dsh-wb-board { grid-template-columns: repeat(5,minmax(175px,1fr)); } }
.dsh-wb-card-desc { color: var(--dsw-alias-label-secondary, #b7bdc7); font-size: 10.5px; line-height: 1.5; margin-top: 5px; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.dsh-wb-card-live { width: 8px; height: 8px; border-radius: 99px; flex: none; margin-left: auto; background: var(--dsw-alias-state-business-primary, #4d6bfe); animation: dsp-pulse 1.6s ease-in-out infinite; }
.dsh-wb-field-hint { display: block; color: var(--dsw-alias-label-caption, #9aa2b0); font-size: 10px; margin-top: 3px; line-height: 1.5; }
.dsh-wb-col[data-accepts="no"] { opacity: .82; }
@keyframes dsp-pulse { 0%,100% { opacity: 1; box-shadow: 0 0 0 0 rgba(77,107,254,.45); } 50% { opacity: .55; box-shadow: 0 0 0 4px rgba(77,107,254,0); } }
@media (prefers-reduced-motion: reduce) { .dsh-wb-card-live { animation: none; } }
`;
