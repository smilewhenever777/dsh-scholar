import {context,call,loadIsolated} from './harness.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const out=resolve(process.env.DSH_TEST_OUTPUT??'repair-ssh-2026-09-21');await mkdir(out,{recursive:true});
const captured=[],results=[];
const mod=await loadIsolated('dsh-server-dashboard/dist/index.js',{
 '@deepseek-ai/dsh-credentials':{credentialRef:x=>x},
 './host/collector.js':{collectSnapshot:async()=>({ok:true,gpus:[]}),testConnection:async auth=>{captured.push(auth);return{ok:true};},discoverLogs:async()=>[],disposeState(){}},
},{},'export {resolveAuth as auditResolveAuth};');
const row=(id,ref)=>({id,name:id,host:id+'.invalid',port:22,username:'synthetic',authKind:'key',credentialRef:ref,identityFile:'',logPath:'',pinned:false,archived:false});
const a=row('gpu-a','SD_CUSTOM_KEY'),b=row('gpu-b','SD_FOREIGN_KEY');
const vault=new Map([['SD_CUSTOM_KEY','LEGACY_SECRET'],['SD_gpu_2d_a','CANONICAL_OWN_SECRET'],['SD_FOREIGN_KEY','OTHER_SECRET']]);
let config={hosts:[a,b],refreshIntervalS:30,staleMinutes:10,alertIdleMin:5};const writes=[];
const ctx=context();ctx.settings={register:()=>({get:()=>config,update:async p=>{config={...config,...p};}})};
ctx.credentials={resolve:async r=>vault.has(r)?{value:vault.get(r)}:undefined,set:async(r,v)=>{writes.push(r);vault.set(r,v);}};
mod.apply(ctx);const check=(id,passed)=>{results.push({id,passed});console.log((passed?'PASS ':'FAIL ')+id);};
try{
 const read=await call(ctx,'/dash/config');const first=read.json.config.hosts[0];
 check('existing-canonical-entry-normalizes-custom-alias',first.credentialRef==='SD_gpu_2d_a');
 const auth=await mod.auditResolveAuth(ctx,first);
 check('poll-uses-own-canonical-key-not-custom-alias-value',auth.privateKey==='CANONICAL_OWN_SECRET');
 await call(ctx,'/dash/test','POST',first);
 check('test-and-poll-use-identical-canonical-key',captured.at(-1).privateKey===auth.privateKey);
 check('alias-normalization-does-not-overwrite-vault',writes.length===0&&vault.get('SD_CUSTOM_KEY')==='LEGACY_SECRET');
 let error;try{await mod.auditResolveAuth(ctx,config.hosts[1]);}catch(e){error=e.message;}
 check('unknown-alias-without-own-entry-is-not-copied',config.hosts[1].credentialRef==='SD_FOREIGN_KEY'&&!vault.has('SD_gpu_2d_b'));
 check('missing-bound-credential-reports-specific-error',!!error?.includes('未找到该主机的已绑定凭据'));
}finally{ctx.disposers.reverse().forEach(f=>f());}
await writeFile(out+'/credential-compat-results.json',JSON.stringify({results},null,2));process.exitCode=results.some(r=>!r.passed)?1:0;
