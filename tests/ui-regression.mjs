import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium,deps,launchOptions} from './browser-runtime.mjs';
const out=resolve(process.env.DSH_TEST_OUTPUT ?? 'repair-final-2026-09-21');
await mkdir(out,{recursive:true});
const {build}=createRequire(deps+'/esbuild/package.json')('esbuild');
await build({entryPoints:[resolve('tests/ui-fixture.tsx')],bundle:true,platform:'browser',format:'iife',outfile:out+'/bundle.js',nodePaths:[deps],jsx:'automatic',alias:{react:deps+'/react','react-dom':deps+'/react-dom'}});
const html='<!doctype html><html lang="zh"><meta charset="utf-8"><style>:root{--dsw-alias-label-primary:#222;--dsh-alias-label-primary:#222;--dsw-alias-label-secondary:#555;--dsw-alias-label-caption:#777;--dsw-alias-border-l2:#ddd;--dsw-alias-bg-layer-1:#f4f5f7;--dsw-alias-bg-layer-2:#fff;--dsw-alias-bg-page:#fff;--dsw-alias-state-business-primary:#4d6bfe;--dsw-alias-state-error-primary:#dc3545}body{font-family:"Microsoft YaHei",sans-serif;margin:0;background:#fafafa}button,input,textarea{font-family:inherit}</style><div id="root"></div><script src="/app.js"></script></html>';
const server=createServer(async(req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'application/javascript':'text/html; charset=utf-8');res.end(req.url==='/app.js'?await readFile(out+'/bundle.js'):html);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch(launchOptions),results=[],errors=[],contracts=[];
try{
 const page=await browser.newPage({viewport:{width:1100,height:850}});page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',r=>r.request().url().startsWith(base)?r.continue():r.abort());
 const go=async(mode)=>page.goto(base+'/?mode='+mode,{waitUntil:'networkidle'});
 const flush=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 const check=(id,passed,observed)=>{results.push({id,passed,observed});console.log(JSON.stringify({id,passed,observed}));};
 const shot=name=>page.screenshot({path:out+'/'+name+'.png',fullPage:true,animations:'disabled'});
 const paperCard=id=>page.locator('[data-dsh-part="paper-card"]').filter({hasText:'合成论文 '+id});
 const back=()=>page.getByRole('button',{name:'返回',exact:true});
 // Normal settings load should enable writing.
 await go('dash-settings');await page.getByRole('button',{name:'编辑',exact:true}).first().waitFor();
 const disabled=await page.getByRole('button',{name:'保存',exact:true}).isDisabled();
 await page.getByRole('button',{name:'编辑',exact:true}).first().click();
 await page.locator('input[readonly]').locator('..').locator('input').first().fill('合成修改名');
 await page.getByRole('button',{name:'保存',exact:true}).last().click();await flush();
 const putCount=await page.evaluate(()=>window.audit.requests.filter(r=>r.method==='PATCH').length);
 contracts.push(await page.evaluate(()=>window.audit.requests.find(r=>r.method==='PATCH')));
 check('R01-config-ready-after-success',!disabled&&putCount>0,{thresholdSaveDisabled:disabled,hostSaveRequests:putCount});await shot('R01-normal-save-locked');
 await go('dash-fail');await page.getByText('合成网络错误',{exact:true}).waitFor();
 check('E04-top-save-blocked-on-error',await page.getByRole('button',{name:'保存',exact:true}).isDisabled(),{});
 const importDisabled=await page.getByRole('button',{name:'从 ~/.ssh/config 导入',exact:true}).isDisabled();
 check('R02-import-blocked-on-load-error',importDisabled&&await page.evaluate(()=>!window.audit.requests.some(r=>['PUT','PATCH'].includes(r.method))),{importDisabled});
 // Original navigation race.
 await go('library');await page.evaluate(()=>window.audit.delay['GET /scholar/papers/A']=true);
 await paperCard('A').click();await page.waitForFunction(()=>window.audit.pending['GET /scholar/papers/A']?.length);
 await paperCard('B').click();await back().waitFor();await page.evaluate(()=>window.audit.pending['GET /scholar/papers/A'].shift()());await flush();
 check('E01-A-response-cannot-replace-B',(await page.getByText('旧总结 B',{exact:true}).count())===1&&await back().count()===1,{});
 // Rating narrow update.
 await go('library');await paperCard('A').click();await back().waitFor();
 await page.evaluate(()=>{window.audit.papers.A.summary='后台新总结';window.audit.papers.A.notes='后台新笔记';});
 await page.getByText('★',{exact:true}).nth(4).click();await page.waitForFunction(()=>window.audit.requests.some(r=>r.method==='PUT'));await flush();
 const rating=await page.evaluate(()=>({paper:window.audit.papers.A,body:window.audit.requests.find(r=>r.method==='PUT').body}));
 check('E02-rating-preserves-background-content',rating.paper.summary==='后台新总结'&&Object.keys(rating.body).length===1,rating);
 // Mutation response ordering: latest UI request token doesn't order server commits.
 await page.evaluate(()=>window.audit.delay['PUT /scholar/papers/A']=true);
 await page.getByText('★',{exact:true}).nth(1).click();await page.getByText('★',{exact:true}).nth(4).click();
 await page.waitForFunction(()=>window.audit.pending['PUT /scholar/papers/A']?.length===1);
 check('R03-ratings-serialized',await page.evaluate(()=>window.audit.pending['PUT /scholar/papers/A'].length===1),{});
 await page.evaluate(()=>window.audit.pending['PUT /scholar/papers/A'].shift()());await flush();
 await page.waitForFunction(()=>window.audit.pending['PUT /scholar/papers/A']?.length===1);
 await page.evaluate(()=>window.audit.pending['PUT /scholar/papers/A'].shift()());await flush();
 const order=await page.evaluate(()=>({persisted:window.audit.papers.A.importance}));
 check('R03-latest-rating-persists',order.persisted===5,order);await shot('R03-ui-rating-before-reload');
 await back().click();await paperCard('A').click();await back().waitFor();await shot('R03-rating-after-reopen');
 // Card dependency outage can degrade.
 await go('library');await page.evaluate(()=>window.audit.fail['GET /scholar/cards?paperId=A']=true);await paperCard('A').click();await back().waitFor();await flush();
 check('E03-paper-opens-with-cards-error',await back().count()===1,{text:await page.locator('body').innerText()});
 // Saved read status response still resurrects the wrong detail.
 await go('library');await paperCard('A').click();await back().waitFor();await page.evaluate(()=>window.audit.delay['PUT /scholar/papers/A']=true);
 await page.locator('[data-dsh-part="read-status-btn"]').filter({hasText:'在读'}).click();await page.waitForFunction(()=>window.audit.pending['PUT /scholar/papers/A']?.length===1);
 await back().click();await paperCard('B').click();await back().waitFor();
 await page.evaluate(()=>window.audit.pending['PUT /scholar/papers/A'].pop()());await flush();
 check('R04-status-response-cannot-replace-B',await page.getByText('旧总结 B',{exact:true}).count()===1,{currentAText:await page.getByText('旧总结 A',{exact:true}).count()});await shot('R04-status-pulls-back-A');
 // Background reload now clears the whole detail and loses its draft.
 await go('library');await page.evaluate(()=>window.audit.sessionExists=true);await paperCard('A').click();await back().waitFor();
 await page.evaluate(()=>{window.audit.delay['GET /scholar/papers/A']=true;});
 const askInput=page.locator('input:not([type=file])');
 await askInput.last().fill('未提交的问题草稿');
 await page.evaluate(()=>window.dispatchEvent(new Event('scholar:read-done')));
 await page.waitForFunction(()=>window.audit.pending['GET /scholar/papers/A']?.length===1);
 await page.evaluate(()=>window.audit.pending['GET /scholar/papers/A'].pop()());await back().waitFor();await flush();
 const draft=await page.locator('input:not([type=file])').last().inputValue();
 check('R05-background-refresh-preserves-question',draft==='未提交的问题草稿',{draft});await shot('R05-refresh-draft');
 // Failure must propagate from saveCard to its caller.
 await go('books');await page.getByRole('button',{name:'看板',exact:true}).click();await page.evaluate(()=>window.audit.fail['PUT /scholar/cards/c1']=true);
 await page.locator('[data-dsh-part="kanban-card"]').dragTo(page.locator('[data-dsh-part="kanban-col"][data-status="validated"]'));
 await page.waitForFunction(()=>window.audit.requests.some(r=>r.method==='PUT'));await flush();
 const drop=await page.evaluate(()=>({alert:document.querySelector('[role=alert]')?.textContent??'',animation:!!document.querySelector('.sch-dropped')}));
 check('R06-kanban-failure-visible',!!drop.alert&&!drop.animation,drop);await shot('R06-failure-animates-success');
 // Existing draft guard works for title, not refs.
 await go('traj-editor');let dialogs=[];const dismiss=async d=>{if(d.type()==='beforeunload'){await d.accept();return;}dialogs.push(d.message());await d.dismiss();};page.on('dialog',dismiss);
 await page.locator('input').first().fill('未保存标题');await page.getByRole('button',{name:'关闭',exact:true}).click();
 check('E05-title-draft-guard',dialogs.length===1&&await page.getByRole('button',{name:'关闭',exact:true}).count()===1,{dialogs});
 await go('traj-editor');dialogs=[];
 await page.locator('input[value="/runs/ExpA/train.log"]').fill('/runs/new/train.log');
 await page.getByRole('button',{name:'关闭',exact:true}).click();
 check('R07-log-binding-draft-guard',dialogs.length>0&&await page.getByRole('button',{name:'关闭',exact:true}).count()===1,{dialogs,closed:await page.evaluate(()=>window.audit.closed??false)});await shot('R07-binding-draft-lost');
 page.off('dialog',dismiss);
 await go('traj-progress');await flush();check('E06-case-sensitive-log-match',await page.evaluate(()=>!window.audit.progress.n1),{});
 // Each host stays independently pending.
 await go('dash-settings');await page.evaluate(()=>window.audit.delay['POST /dash/test']=true);await page.getByRole('button',{name:'测试',exact:true}).first().click();await page.getByRole('button',{name:'测试',exact:true}).click();
 check('E08-two-host-pending',await page.getByRole('button',{name:'测试',exact:true}).count()===0,{});
 // Safe clipboard fallback, then absent clipboard API must settle.
 await go('composer');await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async t=>window.audit.copied=t}}));
 await page.getByRole('button',{name:'从报告建卡'}).click();await page.waitForFunction(()=>window.audit.delivery);
 check('E07-nonempty-composer-preserved',await page.locator('textarea').inputValue()==='尚未发送的研究问题：请保留',{delivery:await page.evaluate(()=>window.audit.delivery)});
 await go('composer');await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined}));await page.getByRole('button',{name:'从报告建卡'}).click();await flush();
 check('R08-no-clipboard-settles',await page.evaluate(()=>window.audit.delivery==='failed'),{result:await page.evaluate(()=>window.audit.delivery??null)});
 await go('composer');await page.locator('textarea').fill('');await page.evaluate(()=>{
   Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async t=>window.audit.copied=t}});
   for(let i=0;i<2;i++){const el=document.createElement('div');el.contentEditable='true';el.style.cssText='height:40px;width:300px;border:1px solid gray';document.body.append(el);}
 });
 await page.getByRole('button',{name:'从报告建卡'}).click();await flush();
 const multi=await page.evaluate(()=>({delivery:window.audit.delivery,textarea:document.querySelector('textarea').value,editableCount:document.querySelectorAll('[contenteditable=true]').length+1}));
 check('R11-ambiguous-composer-not-selected',multi.textarea===''&&multi.delivery==='clipboard',multi);await shot('R11-multiple-editor-selection');
 await go('composer');await page.evaluate(()=>{
   document.querySelector('textarea').style.display='none';
   Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async t=>window.audit.copied=t}});
   const ce=document.createElement('div');ce.contentEditable='true';ce.id='rich-editor';ce.style.cssText='height:80px;width:300px;border:1px solid gray';
   const img=document.createElement('img');img.alt='合成待发送附件';img.src='data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="50" height="30"%3E%3Crect width="50" height="30" fill="blue"/%3E%3C/svg%3E';ce.append(img);document.body.append(ce);
 });await page.getByRole('button',{name:'从报告建卡'}).click();await flush();
 const rich=await page.evaluate(()=>({delivery:window.audit.delivery,images:document.querySelectorAll('#rich-editor img').length,text:document.querySelector('#rich-editor').textContent}));
 check('R12-rich-attachment-preserved',rich.images===1,rich);await shot('R12-rich-attachment-removed');
 await go('deepread');await page.getByRole('button',{name:'多篇对比（2-10 篇）',exact:true}).click();await page.getByText('直接对比已有精读成果（不重读，1-3 分钟出对比报告）',{exact:true}).click();await page.getByRole('button',{name:'单篇：合成论文 A',exact:true}).click();await page.getByRole('button',{name:'启动精读',exact:true}).click();await page.waitForFunction(()=>window.audit.requests.some(r=>r.method==='POST'));
 check('E12-single-read-correct-endpoint',await page.evaluate(()=>window.audit.requests.find(r=>r.method==='POST').url==='/scholar/read/run'),{});
 // Retry cards in place, preserving the same question input.
 await go('library');await page.evaluate(()=>{window.audit.sessionExists=true;window.audit.fail['GET /scholar/cards?paperId=A']=true;});await paperCard('A').click();await back().waitFor();
 await page.locator('input:not([type=file])').last().fill('关联重试保留草稿');await page.evaluate(()=>delete window.audit.fail['GET /scholar/cards?paperId=A']);
 await page.getByRole('button',{name:'重试',exact:true}).click();await flush();
 check('UX03-card-retry-label-and-draft',await page.locator('input:not([type=file])').last().inputValue()==='关联重试保留草稿',{});
 // Keyboard rating is an actual focusable radio group.
 await page.getByRole('radio',{name:'2 / 5',exact:true}).focus();await page.keyboard.press('End');await page.waitForFunction(()=>window.audit.papers.A.importance===5);
 check('UX03-rating-keyboard',await page.getByRole('radio',{name:'5 / 5',exact:true}).getAttribute('aria-checked')==='true',{});
 // A details-level failure is visible inside the modal, not behind its backdrop.
 await go('books');await page.getByText('合成 Idea',{exact:true}).first().click();await page.getByRole('dialog').waitFor();
 await page.evaluate(()=>window.audit.fail['PUT /scholar/cards/c1']=true);await page.getByRole('radio',{name:'5 / 5',exact:true}).click();await page.getByRole('dialog').getByRole('alert').waitFor();
 check('R06-card-detail-error-visible',await page.getByRole('dialog').getByRole('alert').isVisible(),{});
 // Focus stays inside the dialog for Tab and Shift+Tab; Escape restores focus.
 await go('traj-editor');const dialog=page.getByRole('dialog');await dialog.waitFor();
 await page.getByRole('button',{name:'保存',exact:true}).focus();await page.keyboard.press('Tab');
 const forward=await page.evaluate(()=>document.querySelector('[role=dialog]').contains(document.activeElement));
 await page.getByRole('button',{name:'关闭',exact:true}).focus();await page.keyboard.press('Shift+Tab');
 const reverse=await page.evaluate(()=>document.querySelector('[role=dialog]').contains(document.activeElement));
 await page.keyboard.press('Escape');
 check('UX03-modal-focus-and-escape',forward&&reverse&&await page.getByRole('dialog').count()===0,{forward,reverse});
 // Every refs-only change asks before discard; saving blocks all close paths.
 await go('traj-editor');let guarded=0;const decline=async d=>{if(d.type()==='beforeunload'){await d.accept();return;}guarded++;await d.dismiss();};page.on('dialog',decline);
 await page.locator('input[value="/runs/ExpA/train.log"]').fill('/new/experiment.log');await page.keyboard.press('Escape');
 check('R07-escape-uses-dirty-guard',guarded===1&&await page.getByRole('dialog').count()===1,{});
 await page.evaluate(()=>window.audit.delay['PUT /traj/nodes/n1']=true);await page.getByRole('button',{name:'保存',exact:true}).click();await page.waitForFunction(()=>window.audit.pending['PUT /traj/nodes/n1']?.length===1);
 await page.getByRole('button',{name:'关闭',exact:true}).click();await page.keyboard.press('Escape');
 check('R07-saving-blocks-close',await page.getByRole('dialog').count()===1,{});
 await page.evaluate(()=>window.audit.pending['PUT /traj/nodes/n1'].shift()());await page.getByRole('dialog').waitFor({state:'hidden'});
 check('R07-node-save-single-transaction',await page.evaluate(()=>window.audit.requests.filter(r=>r.method==='PUT').length===1&&window.audit.requests.find(r=>r.method==='PUT').body.mainline===true),{});
 page.off('dialog',decline);
 // Host-triggered unmount/reopen restores only that project/node's draft.
 await go('traj-editor');await page.locator('input').first().fill('会话草稿');await page.evaluate(()=>window.audit.unmount());await page.getByRole('dialog').waitFor({state:'hidden'});await page.getByRole('button',{name:'打开编辑器'}).click();
 check('R07-unmount-draft-restored',await page.locator('input').first().inputValue()==='会话草稿',{});
 await page.evaluate(()=>window.audit.target('n2'));await flush();check('R07-target-has-own-baseline',await page.locator('input').first().inputValue()==='合成实验',{});
 await page.getByRole('button',{name:'关闭',exact:true}).click();
 // Name-based paper/card/host selection persists IDs; preview is cache-only.
 await go('traj-editor');await page.getByLabel('关联论文', {exact:true}).fill('合成论文 B');await page.getByRole('button',{name:'合成论文 B (B)',exact:true}).click();
 await page.getByRole('button',{name:'保存',exact:true}).click();await page.waitForFunction(()=>window.audit.requests.some(r=>r.method==='PUT'));
 const ref=await page.evaluate(()=>({body:window.audit.requests.find(r=>r.method==='PUT').body,cached:window.audit.requests.some(r=>r.url==='/dash/snapshots?cached=1'),ssh:window.audit.requests.some(r=>['/dash/test','/dash/discover-logs'].includes(r.url))}));
 check('UX02-paper-name-to-id-and-cache-preview',ref.body.refs.paperId==='B'&&ref.body.refs.paperLabel==='合成论文 B'&&ref.cached&&!ref.ssh,ref);
 // No source is chosen when the same binding matches two GPUs.
 await go('traj-progress');await page.evaluate(()=>{const a=window.audit;a.snapshots.s1.gpus[0].log.path='/runs/ExpA/train.log';a.snapshots.s1.gpus.push({...a.snapshots.s1.gpus[0],index:1});});
 await page.waitForTimeout(8100);check('UX02-ambiguous-progress-hidden',await page.evaluate(()=>!window.audit.progress.n1),{});
 // Thresholds submit no host list; empty import submits no write.
 await go('dash-settings');await page.locator('input[type=number]').first().fill('60');await page.getByRole('button',{name:'保存',exact:true}).click();await page.waitForFunction(()=>window.audit.requests.some(r=>r.method==='PATCH'));
 check('R09-ui-partial-threshold-body',await page.evaluate(()=>{const b=window.audit.requests.find(r=>r.method==='PATCH').body;return !('hosts'in b)&&b.refreshIntervalS===60&&!!b.revision;}),{});
 contracts.push(await page.evaluate(()=>window.audit.requests.find(r=>r.method==='PATCH')));
 const writesBefore=await page.evaluate(()=>window.audit.requests.filter(r=>r.method==='PATCH').length);await page.getByRole('button',{name:'从 ~/.ssh/config 导入',exact:true}).click();await flush();
 check('R02-empty-import-does-not-write',await page.evaluate(()=>window.audit.requests.filter(r=>r.method==='PATCH').length)===writesBefore,{});
 // Config conflict keeps the edit draft and requires an explicit reload.
 await page.getByRole('button',{name:'编辑',exact:true}).first().click();await page.locator('input[readonly]').locator('..').locator('input').first().fill('保留编辑草稿');
 await page.evaluate(()=>{window.audit.config.hosts[1].name='其他窗口的新名字';window.audit.revision++;});await page.getByRole('button',{name:'保存',exact:true}).last().click();await page.getByRole('alert').waitFor();
 check('R10-conflict-keeps-draft',await page.locator('input[readonly]').locator('..').locator('input').first().inputValue()==='保留编辑草稿',{});
 await page.getByRole('button',{name:'重新加载配置（保留编辑草稿）'}).click();await page.getByRole('button',{name:'保存',exact:true}).last().click();await flush();
 check('R10-reloaded-edit-preserves-other-host',await page.evaluate(()=>window.audit.config.hosts[1].name==='其他窗口的新名字'),{});
 // Empty editors may be filled, but never automatically sent.
 await go('composer');await page.locator('textarea').fill('');await page.getByRole('button',{name:'从报告建卡'}).click();await flush();
 check('E07-empty-composer-no-auto-send',await page.evaluate(()=>window.audit.delivery==='filled'&&!window.audit.sent&&document.querySelector('textarea').value==='基于合成报告建卡'),{});
 await go('composer');await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('synthetic denied')}}}));await page.getByRole('button',{name:'从报告建卡'}).click();await flush();
 check('R08-clipboard-rejection-settles',await page.evaluate(()=>window.audit.delivery==='failed'),{});
 // A modal must remain above a floating plugin panel.
 await go('traj-editor');await page.evaluate(()=>{const el=document.createElement('div');el.id='synthetic-float';el.style.cssText='position:fixed;inset:0;background:pink;z-index:2147483000';document.body.append(el);});
 const topmost=await page.getByRole('dialog').evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+20));});
 check('UX03-modal-above-floating-panel',topmost,{});await page.evaluate(()=>document.querySelector('#synthetic-float').remove());
 // Nested modals from the two independently bundled plugins share focus and Escape ownership.
 await go('modal-stack');await page.getByRole('button',{name:'打开嵌套弹窗'}).click();await page.keyboard.press('Escape');
 check('UX03-cross-plugin-modal-stack',await page.getByRole('dialog').count()===1&&await page.getByRole('dialog',{name:'学者弹窗'}).count()===1,{});
 await page.keyboard.press('Escape');check('UX03-parent-modal-closes-after-child',await page.getByRole('dialog').count()===0,{});
 // Manual rail preference survives container resizing.
 await go('library');await page.locator('main').evaluate(el=>el.style.width='360px');await flush();await page.getByRole('button',{name:"分区栏",exact:true}).click();
 await page.locator('main').evaluate(el=>el.style.width='1000px');await flush();await page.locator('main').evaluate(el=>el.style.width='360px');await flush();
 check('UX01-manual-rail-preference-retained',await page.locator('[data-dsh-part=collection-rail]').count()===0,{});
 // Kanban/table overflow stays in the bookshelf scroll area.
 for(const label of ['看板','表格']){await go('books');await page.locator('main').evaluate(el=>el.style.width='360px');await page.getByRole('button',{name:label,exact:true}).click();await flush();
   check('UX01-contained-'+label,await page.locator('main').evaluate(el=>el.scrollWidth<=el.clientWidth+1),{});}
 // Saving a host cannot discard the unsaved threshold draft.
 await go('dash-settings');await page.locator('input[type=number]').first().fill('90');await page.getByRole('button',{name:'编辑',exact:true}).first().click();await page.locator('input[readonly]').locator('..').locator('input').first().fill('修改主机');await page.getByRole('button',{name:'保存',exact:true}).last().click();await flush();
 check('R10-host-save-preserves-threshold-draft',await page.locator('input[type=number]').first().inputValue()==='90'&&await page.evaluate(()=>window.audit.config.refreshIntervalS===30),{});
 // Simultaneous DOM clicks still cause one connection test per host.
 await go('dash-settings');await page.evaluate(()=>{window.audit.delay['POST /dash/test']=true;const b=[...document.querySelectorAll('button')].find(b=>b.textContent==='测试');b.click();b.click();});await flush();
 check('E08-synchronous-per-host-test-lock',await page.evaluate(()=>window.audit.requests.filter(r=>r.url==='/dash/test').length===1),{});
 // The retry for related cards issues no redundant paper detail request.
 await go('library');await page.evaluate(()=>window.audit.fail['GET /scholar/cards?paperId=A']=true);await paperCard('A').click();await back().waitFor();const detailCount=await page.evaluate(()=>window.audit.requests.filter(r=>r.url==='/scholar/papers/A').length);
 await page.getByRole('button',{name:'重试',exact:true}).click();await flush();check('R05-card-retry-is-independent',await page.evaluate(()=>window.audit.requests.filter(r=>r.url==='/scholar/papers/A').length)===detailCount,{});

 // Container widths, dark theme, and 200% text are checked independently of viewport width.
 for(const mode of ['library','books','dash-settings'])for(const width of [360,420,520,768,1100]){
   await page.setViewportSize({width:1200,height:900});await go(mode);await page.locator('main').evaluate((el,w)=>{el.style.width=w+'px';el.style.maxWidth='none';},width);await flush();
   const sizes=await page.locator('main').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth}));
   check('UX01-'+mode+'-'+width,sizes.scroll<=sizes.width+1,sizes);
   if(width===360||width===520)await shot('layout-'+mode+'-'+width);
 }
 await go('library');await page.locator('main').evaluate(el=>el.style.width='360px');await page.addStyleTag({content:'body{background:#161616;color:#eee}:root{--dsw-alias-label-primary:#eee;--dsw-alias-label-secondary:#bbb;--dsw-alias-bg-layer-1:#222;--dsw-alias-bg-layer-2:#333}'});await flush();
 await page.locator('main').evaluate(root=>{const sizes=[...root.querySelectorAll('*')].filter(el=>el instanceof HTMLElement).map(el=>[el,parseFloat(getComputedStyle(el).fontSize)]);for(const [el,size]of sizes)el.style.fontSize=(size*2)+'px';});await flush();
 const large=await page.locator('main').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth}));check('UX01-dark-200-percent-text',large.scroll<=large.width+1,large);await shot('layout-dark-large-text');

}catch(e){console.error(e);errors.push(String(e));}
finally{await writeFile(out+'/ui-results.json',JSON.stringify({results,errors},null,2));await writeFile(out+'/ui-config-contracts.json',JSON.stringify(contracts,null,2));process.exitCode=errors.length||results.some(r=>!r.passed)?1:0;await browser.close();await new Promise(r=>server.close(r));}
