// Opt-in acceptance against an installed official Desktop; all data is synthetic.
import assert from 'node:assert/strict';
import { _electron } from 'playwright';
import { mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const executablePath=process.env.DSH_DESKTOP_EXE;
if(!executablePath) throw Error('Set DSH_DESKTOP_EXE to the installed official Desktop executable; see tests/README.md.');
const out=resolve(process.env.DSH_TEST_OUTPUT??resolve(root,'.verify','desktop-'+Date.now()));
// Unique home on every run: never reuse the user's profile, credentials or libraries.
const home=resolve(out,'home-'+Date.now());
const profile=resolve(home,'profiles/desktop');
const fixture=resolve(home,'fixture-plugin');
const workspaceA=resolve(home,'workspace-A'),workspaceB=resolve(home,'workspace-B');
for(const dir of [profile,fixture,workspaceA,workspaceB,resolve(profile,'node_modules')])await mkdir(dir,{recursive:true});
await writeFile(resolve(fixture,'package.json'),JSON.stringify({name:'dsh-desktop-fixture',version:'0.0.0',type:'module',main:'index.js',exports:{'.':'./index.js','./client':'./client.js'},dsh:{bundle:{patch:'./cordis.patch.yml'},client:{platform:'web',inject:['@deepseek-ai/dsh-api-remotes','@deepseek-ai/dsh-api-session-controller','@deepseek-ai/dsh-api-workspace-controller','@deepseek-ai/dsh-client-ui-workspace','@deepseek-ai/dsh-client-ui-sidebar-right']}}}));
await writeFile(resolve(fixture,'index.js'),"export const name='dsh-desktop-fixture';export function apply(){}\n");
await writeFile(resolve(fixture,'cordis.patch.yml'),'- insert:\n    - id: dsh-desktop-fixture\n      name: dsh-desktop-fixture\n');
await writeFile(resolve(fixture,'client.js'),`window.__ModuleLoader__.load({id:'dsh-desktop-fixture',factory:()=>({inject:['remote','remote.settings','sessions','workspaces','uiWorkspace','sidebarRight','conversation'],apply(ctx){window.__dshDesktopTest=ctx;ctx.effect(()=>()=>{delete window.__dshDesktopTest})}})});`);
const plugins=[['dsh-scholar-desk','dsh-scholar'],['dsh-server-dashboard','dsh-server-dashboard'],['dsh-trajectory','dsh-trajectory'],['dsh-desktop-fixture',fixture]];
for(const [name,dir] of plugins)await symlink(resolve(root,dir),resolve(profile,'node_modules',name),process.platform==='win32'?'junction':'dir');
await writeFile(resolve(profile,'package.json'),JSON.stringify({name:'dsh-profile-desktop',private:true,dependencies:Object.fromEntries(plugins.map(([name,dir])=>[name,'link:'+resolve(root,dir).replaceAll('\\','/')])),dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app',...plugins.map(([name])=>name)]}}},null,2));
await writeFile(resolve(profile,'cordis.patch.yml'),JSON.stringify([
  {id:'dsh-scholar',config:{paperDir:resolve(home,'papers')}},
  {id:'dsh-trajectory',config:{dataDir:resolve(home,'trajectory')}},
  {id:'dsh-server-dashboard',config:{hosts:[]}},
]));
const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!/(?:TOKEN|API_KEY|SECRET|PASSWORD)/i.test(key))),DSH_HOME:home,DEEPSEEK_API_KEY:'dsh-desktop-synthetic-fixture',DSH_DESKTOP_DIAGNOSTIC_FILE:resolve(out,'diagnostic.json')};
delete env.ELECTRON_RUN_AS_NODE;
let app;
const results=[],errors=[];
const pass=(id,detail={})=>{results.push({id,passed:true,...detail});console.log('PASS '+id);};
try {
  app=await _electron.launch({executablePath,args:['--user-data-dir='+resolve(home,'electron-user-data'),'--no-sandbox'],env,timeout:60000});
  app.on('window',page=>page.on('pageerror',error=>errors.push(error.message)));
  await app.evaluate(({BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows())window.hide();});
  const page=app.windows().find(p=>p.url().startsWith('dsh-app://app/'))??await app.firstWindow();
  page.on('pageerror',error=>errors.push(error.message));
  page.setDefaultTimeout(12000);
  await page.waitForFunction(()=>document.querySelectorAll('[data-dsh-part="sidebar-entry"]').length===3&&window.__dshDesktopTest,{},{timeout:60000});
  assert.equal(page.url(),'dsh-app://app/');
  pass('official-desktop-loads-three-real-client-bundles');
  pass('installed-desktop-version',{version:await app.evaluate(({app})=>app.getVersion())});
  async function request(path,method='GET',body) {
    return page.evaluate(async ({path,method,body})=>{
      const response=await fetch(path,{method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
      return {status:response.status,body:await response.json()};
    },{path,method,body});
  }
  const stats=await request('/scholar/stats');
  assert.equal(stats.status,200);assert.equal(stats.body.dir,resolve(home,'papers'));assert.equal(stats.body.papers,0);
  pass('private-application-origin-forwards-to-isolated-library');
  const scholarConfig=await request('/scholar/config');
  assert.equal((await request('/scholar/config','PUT',{...scholarConfig.body.config,researchFocus:'Synthetic desktop validation'})).status,200);
  assert.equal((await request('/scholar/config')).body.config.researchFocus,'Synthetic desktop validation');
  const trajConfig=await request('/traj/config');
  const nextDir=resolve(home,'trajectory-updated');
  assert.equal((await request('/traj/config','PUT',{dataDir:nextDir})).status,200);
  assert.equal((await request('/traj/config')).body.config.dataDir,nextDir);
  assert.notEqual(nextDir,trajConfig.body.config.dataDir);
  const before=await request('/dash/config');
  const saved=await request('/dash/config','PATCH',{revision:before.body.revision,refreshIntervalS:31});
  assert.equal(saved.status,200);assert.equal(saved.body.config.refreshIntervalS,31);assert.notEqual(saved.body.revision,before.body.revision);
  assert.equal((await request('/dash/config')).body.revision,saved.body.revision);
  assert.equal((await request('/dash/config','PATCH',{revision:before.body.revision,refreshIntervalS:32})).status,409);
  const described=await page.evaluate(()=>window.__dshDesktopTest.remote.settings.describe());
  assert.equal(described.ok,true);
  assert.equal(described.value.namespaces.find(row=>row.ns==='dsh-server-dashboard').value.refreshIntervalS,31);
  pass('three-settings-roundtrips-and-dashboard-stale-revision-rejection');
  // A real native catalog and main-view selection; no language-model request is sent.
  const projectA=await request('/traj/projects','POST',{ws:workspaceA,name:'Desktop Project A'});
  const projectB=await request('/traj/projects','POST',{ws:workspaceB,name:'Desktop Project B'});
  assert.equal(projectA.status,201);assert.equal(projectB.status,201);
  assert.equal((await request('/traj/nodes','POST',{ws:workspaceB,title:'Synthetic Desktop Experiment',kind:'experiment',status:'in_progress',tags:[],mainline:true})).status,201);
  await page.evaluate(async ({a,b})=>{
    const ctx=window.__dshDesktopTest;
    const wa=await ctx.workspaces.create({path:a});const wb=await ctx.workspaces.create({path:b});
    window.__dshDesktopWorkspaces={a:wa.workspaceId,b:wb.workspaceId};
    await ctx.uiWorkspace.openWorkspace(wa.workspaceId);
  },{a:workspaceA,b:workspaceB});
  const trajEntry=page.locator('[data-dsh-plugin="dsh-trajectory"][data-dsh-part="sidebar-entry"]');
  await trajEntry.click();
  const trajDrawer=page.locator('[data-dsh-plugin="dsh-trajectory"][data-dsh-surface="drawer"]');
  await trajDrawer.getByText('Desktop Project A',{exact:false}).first().waitFor();
  await page.evaluate(()=>window.__dshDesktopTest.uiWorkspace.openWorkspace(window.__dshDesktopWorkspaces.b));
  await trajDrawer.getByText('Desktop Project B',{exact:false}).first().waitFor();
  pass('workspace-switch-follows-desktop-main-view-without-sending-a-message');
  const paper=await request('/scholar/papers','POST',{title:'Synthetic Desktop Paper',authors:['Synthetic Author'],year:2026});
  assert.equal(paper.status,201);
  const paperId=paper.body.paper.id;
  const reportName=paperId+'-desktop-report.html';
  await mkdir(resolve(home,'papers/reports'),{recursive:true});
  await writeFile(resolve(home,'papers/reports',reportName),'<html><body><h1>Synthetic Desktop Report</h1><script>parent.__unsafeScholarReport=true</script></body></html>');
  // Upload a valid minimal one-page PDF through the actual binary route.
  const content='BT /F1 14 Tf 20 100 Td (Synthetic Desktop PDF) Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let pdf='%PDF-1.4\n';const offsets=[0];
  for(let i=0;i<objects.length;i++){offsets.push(pdf.length);pdf+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
  const xref=pdf.length;pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const upload=await page.evaluate(async ({id,pdf})=>{const r=await fetch('/scholar/papers/'+encodeURIComponent(id)+'/pdf',{method:'PUT',headers:{'content-type':'application/octet-stream'},body:new TextEncoder().encode(pdf)});return{status:r.status,body:await r.json()};},{id:paperId,pdf});
  assert.equal(upload.status,200);
  await page.locator('[data-dsh-plugin="dsh-scholar"][data-dsh-part="sidebar-entry"]').click();
  const scholarDrawer=page.locator('[data-dsh-plugin="dsh-scholar"][data-dsh-surface="drawer"]');
  await scholarDrawer.locator('[data-dsh-part="paper-card"]').first().waitFor();
  const libraryGeometry=await scholarDrawer.evaluate(root=>{
    const rail=root.querySelector('[data-dsh-part="collection-rail"]').getBoundingClientRect();
    const card=root.querySelector('[data-dsh-part="paper-card"]').getBoundingClientRect();
    const panel=root.querySelector('[data-dsh-part="drawer-panel"]').getBoundingClientRect();
    const railElement=root.querySelector('[data-dsh-part="collection-rail"]');
    return {railRight:rail.right,cardLeft:card.left,width:panel.width,railOverflow:railElement.scrollWidth-railElement.clientWidth,overflow:Array.from(root.querySelectorAll('input,select,[data-dsh-part="paper-card"]')).filter(el=>el.getBoundingClientRect().right>panel.right+1).length};
  });
  assert.ok(libraryGeometry.railRight<=libraryGeometry.cardLeft);
  assert.ok(libraryGeometry.width>=400);
  assert.equal(libraryGeometry.overflow,0);
  assert.ok(libraryGeometry.railOverflow<=1);
  pass('scholar-keeps-left-collections-and-readable-desktop-editor',libraryGeometry);
  await page.screenshot({path:resolve(out,'desktop-scholar-library.png'),animations:'disabled'});
  await scholarDrawer.getByText('Synthetic Desktop Paper',{exact:true}).first().click();
  const pdfLink=scholarDrawer.locator('a[target="_blank"][href$="/pdf"]').first();
  await pdfLink.click();
  const iframe=page.locator('iframe[src$="/pdf"]');
  await iframe.waitFor();
  assert.equal(app.windows().length,1);
  assert.equal(page.url(),'dsh-app://app/');
  pass('pdf-opens-inside-owned-desktop-without-external-auth-loss');
  await page.waitForTimeout(700);
  await page.screenshot({path:resolve(out,'desktop-pdf.png')});
  await page.keyboard.press('Escape');
  await scholarDrawer.locator('a[target="_blank"][href*="/reports/"]').first().click();
  await page.frameLocator('iframe[src$="'+reportName+'"]').getByText('Synthetic Desktop Report',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.__unsafeScholarReport),undefined);
  const policy=await page.evaluate(async path=>(await fetch(path)).headers.get('content-security-policy'),'/scholar/papers/'+paperId+'/reports/'+reportName);
  assert.equal(policy,'sandbox');
  pass('report-preview-retains-script-sandbox-on-private-origin');
  await page.keyboard.press('Escape');
  await page.evaluate(()=>{
    window.__desktopClipboard=[];
    navigator.clipboard.writeText=async text=>{window.__desktopClipboard.push(text);};
  });
  await scholarDrawer.getByRole('button',{name:'从报告建卡',exact:true}).click();
  await page.waitForFunction(()=>{
    const ctx=window.__dshDesktopTest,id=ctx.sidebarRight.mounted.getSnapshot();
    return ctx.conversation.input.for(ctx.sessions.scope(id)).state.getSnapshot().draft.includes('paper_read');
  });
  const inputResult=await page.evaluate(()=>{
    const ctx=window.__dshDesktopTest,id=ctx.sidebarRight.mounted.getSnapshot();
    const input=ctx.conversation.input.for(ctx.sessions.scope(id));
    const result={draft:input.state.getSnapshot().draft,running:ctx.sessions.list.getSnapshot().byId[id].running};
    input.setDraft('Unsent desktop draft');
    return result;
  });
  assert.ok(inputResult.draft.includes(paperId));assert.equal(inputResult.running,false);
  await scholarDrawer.getByRole('button',{name:'从报告建卡',exact:true}).click();
  await page.waitForFunction(()=>window.__desktopClipboard.length===1);
  assert.equal(await page.evaluate(()=>{
    const ctx=window.__dshDesktopTest,id=ctx.sidebarRight.mounted.getSnapshot();
    return ctx.conversation.input.for(ctx.sessions.scope(id)).state.getSnapshot().draft;
  }),'Unsent desktop draft');
  pass('native-composer-fills-empty-input-and-preserves-an-existing-draft-without-sending');
  await page.locator('[data-dsh-plugin="dsh-server-dashboard"][data-dsh-part="sidebar-entry"]').click();
  await page.waitForTimeout(300);
  const geometry=await page.evaluate(()=>({width:innerWidth,reserved:parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dsh-squeeze'))||0,managers:document.querySelectorAll('style[data-dsh-plugin-dock-layout]').length}));
  assert.equal(geometry.managers,1);assert.ok(geometry.width-geometry.reserved>=320);
  for(const plugin of ['dsh-scholar','dsh-server-dashboard','dsh-trajectory']) assert.equal(await page.locator(`[data-dsh-plugin="${plugin}"][data-dsh-part="sidebar-entry"]`).isVisible(),true);
  const footprints=await page.evaluate(()=>window.__dshDock);
  assert.equal(Object.values(footprints).filter(x=>x.open&&x.width>64).length,1);
  pass('three-drawers-share-one-layout-owner-and-keep-centre-usable',geometry);
  const headerGeometry=await page.evaluate(()=>{
    const style=getComputedStyle(document.documentElement);
    return {chrome:style.getPropertyValue('--dsh-frame-chrome-top'),overlay:style.getPropertyValue('--dsh-frame-overlay-top'),
      surfaces:Array.from(document.querySelectorAll('[data-dsh-part="drawer-panel"],[data-dsh-part="drawer-rail"]')).map(el=>({top:el.getBoundingClientRect().top,cssTop:getComputedStyle(el).top})),
      title:Array.from(document.querySelectorAll('[data-dsh-plugin="dsh-server-dashboard"] span')).find(el=>el.textContent==='服务器看板')?.getBoundingClientRect().width};
  });
  const chrome=parseFloat(headerGeometry.chrome)||0;
  assert.equal(headerGeometry.surfaces.length,3);
  for(const surface of headerGeometry.surfaces) assert.ok(Math.abs(surface.top-chrome)<1,'drawers and rails start directly below native chrome');
  assert.ok(headerGeometry.title>=65,'dashboard title remains readable at minimum width');
  pass('plugin-headers-remove-extra-band-and-align-with-native-chrome',headerGeometry);
  await page.screenshot({path:resolve(out,'desktop-three-plugins.png')});
  await page.screenshot({path:resolve(out,'desktop-compact-header.png'),clip:{x:geometry.width-geometry.reserved-12,y:0,width:geometry.reserved+12,height:220}});
  const dashboardDrawer=page.locator('[data-dsh-plugin="dsh-server-dashboard"][data-dsh-surface="drawer"]');
  const more=dashboardDrawer.getByRole('button',{name:'更多面板操作',exact:true});
  await more.click();
  const menu=page.getByRole('menu',{name:'更多面板操作',exact:true});
  await menu.waitFor();
  await page.keyboard.press('End');
  await page.waitForFunction(()=>document.querySelector('[data-dsh-plugin="panel-menu"] button:last-child')===document.activeElement);
  await page.keyboard.press('Escape');
  assert.equal(await menu.count(),0);
  assert.equal(await more.evaluate(el=>el===document.activeElement),true);
  await more.click();
  await page.getByRole('menuitem',{name:'浮为窗口',exact:true}).click();
  await page.waitForFunction(()=>window.__dshDock['server-dashboard'].open===false);
  await dashboardDrawer.getByRole('button',{name:'更多面板操作',exact:true}).click();
  await page.getByRole('menuitem',{name:'回贴侧栏',exact:true}).click();
  await page.waitForFunction(()=>window.__dshDock['server-dashboard'].open===true);
  await more.click();
  await page.locator('[data-dsh-plugin-shell-frame]').click({position:{x:450,y:110}});
  assert.equal(await menu.count(),0);
  pass('secondary-panel-actions-support-keyboard-escape-outside-click-and-float-dock');
  await trajEntry.click();
  await page.screenshot({path:resolve(out,'desktop-trajectory.png'),animations:'disabled'});
  await trajDrawer.getByRole('button',{name:'更多面板操作',exact:true}).click();
  await page.getByRole('menuitem',{name:'全页视图',exact:true}).click();
  const downloaded=resolve(out,'desktop-trajectory-export.md');
  await app.evaluate(({BrowserWindow},file)=>{
    BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()==='dsh-app://app/').webContents.session.once('will-download',(_event,item)=>item.setSavePath(file));
  },downloaded);
  await page.getByRole('button',{name:'导出 Markdown',exact:true}).click();
  let markdown='';
  for(let i=0;i<40;i++){markdown=await readFile(downloaded,'utf8').catch(()=>'');if(markdown)break;await page.waitForTimeout(100);}
  assert.match(markdown,/Desktop Project B/);
  pass('native-download-delivers-workspace-markdown-to-disk');
  await page.keyboard.press('Escape');
  await page.evaluate(id=>window.__dshDesktopTest.sidebarRight.openTab('dsh-scholar.paper',{params:{id}}),paperId);
  const rightbar=page.locator('[class*="rightbarCol"]').first();
  await rightbar.getByText('Synthetic Desktop Paper',{exact:true}).waitFor();
  await page.evaluate(()=>window.__dshDesktopTest.sidebarRight.openTab('dsh-server-dashboard.gpu'));
  await rightbar.getByText('还没有配置任何服务器。到设置 → 服务器看板 添加主机。',{exact:true}).waitFor();
  await page.evaluate(()=>window.__dshDesktopTest.sidebarRight.openTab('dsh-trajectory.mainline'));
  await rightbar.getByText('Desktop Project B',{exact:true}).waitFor();
  await page.waitForFunction(()=>Object.values(window.__dshDock??{}).every(value=>!value.open));
  pass('three-native-right-sidebar-tabs-render-against-current-session');
  await page.screenshot({path:resolve(out,'desktop-native-rightbar.png'),animations:'disabled',timeout:20000});
  assert.deepEqual(errors,[]);
  pass('desktop-page-has-no-unhandled-errors');
} catch(error) {
  const page=app?.windows().find(p=>p.url().startsWith('dsh-app://app/'));
  if(page) await page.screenshot({path:resolve(out,'desktop-failure.png')}).catch(()=>{});
  if(page) await writeFile(resolve(out,'desktop-failure-layout.json'),JSON.stringify(await page.evaluate(()=>({nativeExpanded:window.__dshDesktopTest?.sidebarRight.isExpanded(),dock:window.__dshDock,columns:Array.from(document.querySelectorAll('[class*="sidebarCol"],[class*="rightbarCol"]')).map(el=>({className:el.className,width:el.getBoundingClientRect().width})),reserved:getComputedStyle(document.documentElement).getPropertyValue('--dsh-squeeze')})),null,2)).catch(()=>{});
  results.push({id:'installed-desktop-acceptance',passed:false,error:String(error.message)});
  throw error;
} finally {
  await writeFile(resolve(out,'desktop-results.json'),JSON.stringify({results,errors,home},null,2));
  await app?.close();
}
console.log('Desktop evidence: '+out);
