import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

async function moduleFor(file, globals = {}) {
  const result = await build({ entryPoints: [file], bundle: true, write: false, format: 'iife', globalName: 'desktopTest', platform: 'browser' });
  const context = vm.createContext({ console, setTimeout, clearTimeout, setInterval, clearInterval, AbortSignal, Headers, URLSearchParams, ...globals });
  vm.runInContext(result.outputFiles[0].text, context);
  return context.desktopTest;
}
const desktop = await moduleFor('shared-client/src/desktop.ts');
const source = value => ({ getSnapshot: () => value });
const items = [{workspaceId:'a',path:'E:/Research/A',title:'Research A'},{workspaceId:'b',path:'E:/Research/B',title:'Research B'}];
const workspace = source({items,recentWorkspaceId:'a'});

test('docked width keeps normal desktop editors readable and corrupt widths bounded', async () => {
  const mod=await moduleFor('shared-client/src/desktop.ts',{
    window:{innerWidth:1280},document:{querySelector:()=>({getBoundingClientRect:()=>({width:280})})},
  });
  assert.equal(mod.clampDockWidth(440),440);
  assert.equal(mod.clampDockWidth(NaN),440);
  assert.equal(mod.clampDockWidth(3000),532);
  assert.ok(mod.clampDockWidth(100)>=300);
});

test('0.2 mainView selection follows the on-screen session, not the recent workspace', () => {
  const sessions = source({byId:{a:{id:'a',cwd:items[0].path,retainedBy:{}},b:{id:'b',cwd:items[1].path,retainedBy:{mainView:1}}}});
  assert.equal(desktop.selectedWorkspace({list:sessions},{list:workspace}).cwd,items[1].path);
});
test('Desktop sidebar mounted identity wins over retained background sessions', () => {
  const sessions=source({current:'a',byId:{a:{id:'a',cwd:items[0].path,retainedBy:{mainView:1}},b:{id:'b',cwd:items[1].path,retainedBy:{mainView:1}}}});
  assert.equal(desktop.selectedWorkspace({list:sessions},{list:workspace},{mounted:source('b')}).cwd,items[1].path);
  assert.equal(desktop.selectedWorkspace({list:sessions},{list:workspace},{mounted:source(undefined)}),null);
});
test('absent or ambiguous current ownership never selects an arbitrary workspace', () => {
  assert.equal(desktop.selectedWorkspace({list:source({byId:{}})},{list:workspace}),null);
  const both={a:{id:'a',cwd:items[0].path,retainedBy:{mainView:1}},b:{id:'b',cwd:items[1].path,retainedBy:{mainView:1}}};
  assert.equal(desktop.selectedWorkspace({list:source({byId:both})},{list:workspace}),null);
});
test('legacy Web selection and Windows path normalization preserve workspace titles', () => {
  const sessions=source({current:'b',byId:{b:{id:'b',cwd:'e:\\research\\b\\'}}});
  assert.equal(desktop.selectedWorkspace({list:sessions},{list:workspace}).title,'Research B');
});
test('native path gesture reveals the exact displayed path; refused gestures copy visibly', async () => {
  const calls=[];const effects=[];
  const mod=await moduleFor('shared-client/src/desktop.ts',{navigator:{clipboard:{writeText:async text=>calls.push(['copy',text])}}});
  let ok=true;
  const ctx={inject(keys,fn){if(keys[0]==='remote')effects.push(fn({remote:{session:{openWorkspacePath:async request=>{calls.push(request);return{ok};}}}}));}};
  mod.bindDesktopServices(ctx);
  assert.equal(await mod.revealHostPath('E:/Research/output'),'revealed');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])),{path:'E:/Research/output',action:'reveal'});
  ok=false;
  assert.equal(await mod.revealHostPath('E:/Research/output'),'copied');
  assert.deepEqual(calls.at(-1),['copy','E:/Research/output']);
  effects.forEach(off=>off?.());
  await assert.rejects(mod.revealHostPath('bad\u0000path'),/Invalid file path/);
});
test('native directory cancellation and service teardown do not choose a different path', async () => {
  const effects=[]; const mod=await moduleFor('shared-client/src/desktop.ts');
  mod.bindDesktopServices({inject(keys,fn){if(keys[0]==='uiWorkspace')effects.push(fn({uiWorkspace:{pickDirectory:async()=>null}}));}});
  assert.equal(mod.canPickDirectory(),true);
  assert.equal(await mod.pickDirectory(),null);
  effects.forEach(off=>off?.());
  assert.equal(mod.canPickDirectory(),false);
});
test('native composer uses the selected session and preserves drafts, attachments and submission locks', async () => {
  const mod=await moduleFor('shared-client/src/desktop.ts');
  let selected='a';let state={draft:'',phase:'plain',attachmentIds:[],occurrences:[]};const writes=[];
  const off=[];
  mod.bindDesktopServices({inject(keys,fn){if(keys[0]==='conversation') off.push(fn({
    sidebarRight:{mounted:source(selected)},
    sessions:{scope:id=>({id})},
    conversation:{input:{for:scope=>({state:source(state),setDraft:text=>writes.push([scope.id,text])})}},
  }));}});
  assert.equal(mod.tryFillComposer('Read this paper'),'filled');
  assert.deepEqual(writes,[['a','Read this paper']]);
  off.forEach(fn=>fn?.());
  for(const value of [{draft:'Unsent draft',phase:'plain',attachmentIds:[],occurrences:[]},{draft:'',phase:'plain',attachmentIds:['attachment'],occurrences:[]},{draft:'',phase:'submitting',attachmentIds:[],occurrences:[]}]) {
    mod.bindDesktopServices({inject(keys,fn){if(keys[0]==='conversation')fn({sidebarRight:{mounted:source('a')},sessions:{scope:()=>({id:'a'})},conversation:{input:{for:()=>({state:source(value),setDraft:()=>assert.fail('must preserve input')})}}});}});
    assert.equal(mod.tryFillComposer('Read this paper'),'blocked');
  }
});
test('HTTP request helper preserves caller cancellation and HTTP error status', async () => {
  let signal;
  const mod=await moduleFor('shared-client/src/index.ts',{fetch:async (_path,init)=>{signal=init.signal;return{ok:true,json:async()=>({ok:true})};}});
  const controller=new AbortController();
  await mod.api('/scholar/stats',{signal:controller.signal});
  controller.abort();
  assert.equal(signal.aborted,true);
  const rejected=await moduleFor('shared-client/src/index.ts',{fetch:async()=>({ok:false,status:409,json:async()=>({error:'Changed',code:'CONFLICT'})})});
  await assert.rejects(rejected.api('/dash/config'),error=>error.status===409&&error.code==='CONFLICT');
});

test('floating geometry rejects corrupt saved values and stays below native caption controls', async () => {
  const mod=await moduleFor('shared-client/src/index.ts',{
    window:{innerWidth:960,innerHeight:640},
    document:{documentElement:{hasAttribute:()=>false,dataset:{platform:'win32'}}},
    getComputedStyle:()=>({getPropertyValue:key=>key==='--dsh-windows-titlebar-height'?'40px':''}),
  });
  for(const input of [{x:NaN,y:Infinity,w:undefined,h:null},{x:9000,y:-100,w:4000,h:9000}]) {
    const value=mod.clampFloat(input);
    assert.equal(Object.values(value).every(Number.isFinite),true);
    assert.ok(value.y>=48);
    assert.ok(value.x+value.w<=952);
    assert.ok(value.y+value.h<=632);
  }
});

for (const plugin of ['dsh-scholar','dsh-server-dashboard','dsh-trajectory']) {
  test(plugin+' exports a real native volatile config and follows live SettingsForms values', async () => {
    const mod=await import(pathToFileURL(resolve(plugin,'dist/index.js')).href);
    const validated=mod.Config['~standard'].validate({});
    assert.equal(validated.issues,undefined);
    assert.equal(typeof validated.value.get,'function','A plain object with meta.volatile silently stops receiving native config updates');
    let value={enabled:true},revision=0;
    const fiber={runtime:{name:plugin},config:{enabled:false}};
    const settings={describe:()=>[{ns:plugin,value,revision}],async update(ns,patch,expected){assert.equal(ns,plugin);assert.equal(expected,revision);value={...value,...patch};revision++;}};
    const scope=mod.attachConfigScope({settings,fiber},plugin,{});
    assert.equal(scope.get().enabled,true);
    await scope.update({enabled:false});
    assert.equal(scope.get().enabled,false);
    value={enabled:'external editor'};revision++;
    assert.equal(scope.get().enabled,'external editor');
  });
}
