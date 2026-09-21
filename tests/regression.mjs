// Third-round adversarial checks. All hosts, secrets, models and paper data are synthetic.
// Expected=true means the desired safe behavior. No network / actual vault is accessed.
import * as fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createDeflateRaw,constants,inflateRawSync} from 'node:zlib';
import {createPdfTools} from '../dsh-scholar/dist/read/pdf.js';
import {deflateSync} from 'node:zlib';
import {context,call as rawCall,loadIsolated,quick} from './harness.mjs';
import {PaperStore} from '../dsh-scholar/dist/store.js';
import {createPaper,createCard,applyCardPatch} from '../dsh-scholar/dist/domain.js';
import {sessionPath} from '../dsh-scholar/dist/read/session.js';
import {registerScholarRoutes} from '../dsh-scholar/dist/routes.js';
import {createLlmRuntime} from '../dsh-scholar/dist/read/llm.js';
import {archiveReadResult} from '../dsh-scholar/dist/read/archive.js';
import {logIdleMinutes,logStalled} from '../dsh-server-dashboard/dist/client/thresholds.js';
async function call(ctx, prefix, method = 'GET', body, opts = {}) {
  if (prefix === '/dash/config' && ['PUT', 'PATCH'].includes(method) && body && !('revision' in body)) {
    const current = await rawCall(ctx, prefix);
    body = { ...body, revision: current.json.revision };
  }
  return rawCall(ctx, prefix, method, body, opts);
}
const out=resolve(process.env.DSH_TEST_OUTPUT ?? 'audit-fix-2026-09-21');await fs.mkdir(out,{recursive:true});
const fixture=await fs.mkdtemp(join(out,'regression-synthetic-')),results=[];
const check=(id,passed,observed)=>{results.push({id,passed,observed});console.log((passed?'PASS ':'FAIL ')+id+' '+JSON.stringify(observed));};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject};};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const capture=[],vault=new Map([['SD_victim','SYNTHETIC_OTHER_HOST_SECRET']]);
const dash=await loadIsolated('dsh-server-dashboard/dist/index.js',{
 '@deepseek-ai/dsh-credentials':{credentialRef:x=>x},
 './host/collector.js':{collectSnapshot:async r=>({hostId:r.id,ok:true,gpus:[],at:Date.now()}),testConnection:async a=>{capture.push(a);return{ok:true}},discoverLogs:async a=>{capture.push(a);return[]},disposeState(){}},
},{},'export {resolveAuth as auditResolveAuth,derivedCredName as auditDerived};');
const dc=context();let config={hosts:[],refreshIntervalS:30,staleMinutes:10,alertIdleMin:5};
dc.settings={register:()=>({get:()=>config,update:async p=>{config={...config,...p}}})};
dc.credentials={resolve:async r=>vault.has(r)?{value:vault.get(r)}:undefined,set:async(r,v)=>vault.set(r,v),unset:async r=>{vault.delete(r);}};
dash.apply(dc);
const host=(id,extra={})=>({id,name:id,host:'saved.invalid',port:22,username:'audit',authKind:'password',credentialRef:'',identityFile:'',logPath:'',pinned:false,archived:false,...extra});
try{
 const victim=host('victim',{credentialRef:'SD_victim'});
 const cfg=await call(dc,'/dash/config','PUT',{hosts:[victim,host('newhost',{host:'attacker.invalid',credentialRef:'SD_victim'})]});
 const auth=await dash.auditResolveAuth(dc,config.hosts.find(h=>h.id==='newhost')).catch(e=>({error:e.message}));
 check('D01.migration-cannot-borrow-other-host-secret',auth.password!==vault.get('SD_victim'),{status:cfg.statusCode,target:auth.host,sentOtherHostSecret:auth.password===vault.get('SD_victim'),copiedIntoNewHost:vault.get('SD_newhost')===vault.get('SD_victim')});
 const keyHost=host('keyhost',{authKind:'key'});
 await call(dc,'/dash/config','PUT',{hosts:[keyHost],secrets:{keyhost:{privateKey:'SYNTHETIC_PRIVATE_KEY_TEXT'}}});
 await call(dc,'/dash/test','POST',{...config.hosts[0],authKind:'password'});
 check('D02.auth-kind-is-bound-to-saved-credential',capture.at(-1)?.password!=='SYNTHETIC_PRIVATE_KEY_TEXT',{savedKind:'key',requestedKind:'password',privateKeyPlacedInPassword:capture.at(-1)?.password==='SYNTHETIC_PRIVATE_KEY_TEXT'});
 const wrongKindSave=await call(dc,'/dash/config','PUT',{hosts:[{...config.hosts[0],authKind:'password'}]});
 check('D02.saved-kind-change-needs-new-secret',wrongKindSave.statusCode===400&&config.hosts[0].authKind==='key',{status:wrongKindSave.statusCode});
 await call(dc,'/dash/test','POST',config.hosts[0]);
 check('D02.correct-key-auth-still-works',capture.at(-1)?.privateKey==='SYNTHETIC_PRIVATE_KEY_TEXT',{});
 const pinned=host('pinned',{hostKeyFingerprint:'SHA256:SYNTHETIC_A'});
 await call(dc,'/dash/config','PUT',{hosts:[pinned],secrets:{pinned:{password:'SYNTHETIC_PINNED_PASSWORD'}}});
 for(const route of ['/dash/test','/dash/discover-logs']){
  const callsBefore=capture.length;
  const r=await call(dc,route,'POST',{...config.hosts[0],hostKeyFingerprint:'SHA256:SYNTHETIC_B'});
  check('D03.saved-pin-cannot-be-overridden.'+route,r.statusCode===400&&capture.length===callsBefore,{status:r.statusCode,connectionAttempted:capture.length!==callsBefore});
 }
 await call(dc,'/dash/test','POST',config.hosts[0]);
 check('D03.same-pin-and-saved-password-still-work',capture.at(-1)?.hostKeyFingerprint==='SHA256:SYNTHETIC_A'&&capture.at(-1)?.password==='SYNTHETIC_PINNED_PASSWORD',{});
 const defaultAuth=await call(dc,'/dash/config','PUT',{hosts:[{...config.hosts[0],authKind:'none'}]});
 check('D02.default-identity-mode-detaches-vault-secret',defaultAuth.statusCode===200&&config.hosts[0].credentialRef==='',{status:defaultAuth.statusCode});

 const lc=context();let legacyConfig={...config,hosts:[host('audit-a',{credentialRef:'SD_audit_2da'})]};
 vault.set('SD_audit_2da','SYNTHETIC_LEGACY_PASSWORD');
 lc.credentials=dc.credentials;lc.settings={register:()=>({get:()=>legacyConfig,update:async p=>{legacyConfig={...legacyConfig,...p}}})};
 dash.apply(lc);
 try {
  await call(lc,'/dash/config','GET');
  const old=legacyConfig.hosts[0],polled=await dash.auditResolveAuth(lc,old);
  await call(lc,'/dash/test','POST',old);
  check('D04.migrated-host-test-uses-same-credential-as-poll',capture.at(-1)?.password===polled.password&&!!polled.password&&old.credentialRef===dash.auditDerived(old.id),{pollHasPassword:!!polled.password,testHasPassword:!!capture.at(-1)?.password,configRef:old.credentialRef});
 }finally{lc.disposers.reverse().forEach(f=>f());}

}finally{dc.disposers.reverse().forEach(f=>f());}

const papers=new PaperStore(join(fixture,'papers'));await papers.init();
const p=createPaper({title:'Synthetic concurrency',summary:'initial',source:'manual',importance:3});await papers.upsertPaper(p);
const st=await loadIsolated('dsh-scholar/dist/tools.js',{'@deepseek-ai/dsh-tools':{defineTool:x=>x}}),sc=context();
st.registerScholarTools(sc,async()=>papers,()=>({paperDir:papers.dir,defaultTags:[]}));
const saver=sc.registeredTools.get('paper_save');
await Promise.all([saver.execute({title:p.title,update:true,summary:'tool new'}),saver.execute({title:p.title,update:true,importance:5})]);
let current=papers.papers.get(p.id);
check('D05.paper-save-merge-is-transactional',current.summary==='tool new'&&current.importance===5,{summary:current.summary,importance:current.importance});
const rc=context();registerScholarRoutes(rc,async()=>papers,()=>({paperDir:papers.dir,defaultTags:[]}),async()=>{});
const rs=await Promise.all([call(rc,'/scholar/papers','POST',{title:p.title,update:true,summary:'rest new'}),call(rc,'/scholar/papers','POST',{title:p.title,update:true,importance:2})]);
current=papers.papers.get(p.id);
check('D05.rest-post-merge-is-transactional',current.summary==='rest new'&&current.importance===2,{statuses:rs.map(r=>r.statusCode),summary:current.summary,importance:current.importance});
const p2=createPaper({title:'Synthetic second source',source:'manual'});await papers.upsertPaper(p2);
let card=createCard({title:'Synthetic source-changing card',insight:'Synthetic',paperId:p.id});await papers.upsertCard(card);
card=applyCardPatch(card,{paperId:p2.id});await papers.upsertCard(card);
const edges=papers.graph.edges.filter(e=>e.source===card.id&&e.kind==='derives_from');
check('D06.replaced-auto-edge-is-removed',edges.length===1&&edges[0].target===p2.id,{edges,expectedSource:p2.id});
let aCard=createCard({title:'Synthetic related A',insight:'A'}),bCard=createCard({title:'Synthetic related B',insight:'B'});
await papers.upsertCard(aCard);await papers.upsertCard(bCard);
aCard=applyCardPatch(aCard,{relatedCardIds:[bCard.id]});await papers.upsertCard(aCard);
bCard=applyCardPatch(bCard,{relatedCardIds:[aCard.id]});await papers.upsertCard(bCard);
const related=()=>papers.graph.edges.find(e=>e.kind==='related'&&[e.source,e.target].includes(aCard.id)&&[e.source,e.target].includes(bCard.id));
aCard=applyCardPatch(aCard,{relatedCardIds:[]});await papers.upsertCard(aCard);
check('D06.shared-relation-keeps-other-owner',related()?.auto?.includes(bCard.id)&&!related()?.auto?.includes(aCard.id),{owners:related()?.auto});
const reloaded=new PaperStore(papers.dir);await reloaded.init();
check('D06.edge-owners-survive-reload',reloaded.graph.edges.some(e=>e.kind==='related'&&e.auto?.includes(bCard.id)),{});
bCard=applyCardPatch(bCard,{relatedCardIds:[]});await papers.upsertCard(bCard);
check('D06.last-owner-removes-related-edge',!related(),{});

const race=createPaper({title:'Synthetic archive race',source:'manual'});await papers.upsertPaper(race);
const started=deferred(),release=deferred();let intercepted=false;
const ar=await loadIsolated('dsh-scholar/dist/read/archive.js',{'node:fs/promises':{...fs,mkdir:async(...args)=>{if(!intercepted&&resolve(args[0])===resolve(join(papers.dir,'reports'))){intercepted=true;started.resolve();await release.promise;}return fs.mkdir(...args);}}});
const archive=ar.archiveReadResult(papers,race,quick);await started.promise;
const deleting=papers.deletePaper(race.id);release.resolve();const archived=await archive;await deleting;
check('D07.delete-and-archive-cannot-recreate-artifacts',!existsSync(sessionPath(papers.dir,race.id))&&(!archived.file||!existsSync(join(papers.dir,'reports',archived.file))),{recordPresent:papers.papers.has(race.id),sessionRecreated:existsSync(sessionPath(papers.dir,race.id)),reportRecreated:!!archived.file&&existsSync(join(papers.dir,'reports',archived.file)),summaryUpdated:archived.summaryUpdated});

const uploadPaper=createPaper({title:'Synthetic upload race',source:'manual'});await papers.upsertPaper(uploadPaper);
const uploadEntered=deferred(),uploadRelease=deferred();let uploadIntercepted=false;
const uploadRoutes=await loadIsolated('dsh-scholar/dist/routes.js',{'node:fs/promises':{...fs,mkdir:async(...args)=>{if(!uploadIntercepted&&resolve(args[0])===resolve(join(papers.dir,'attachments'))){uploadIntercepted=true;uploadEntered.resolve();await uploadRelease.promise;}return fs.mkdir(...args);}}});
const uc=context();uploadRoutes.registerScholarRoutes(uc,async()=>papers,()=>({paperDir:papers.dir,defaultTags:[]}),async()=>{});
const uploading=call(uc,'/scholar/papers','PUT',undefined,{url:'/scholar/papers/'+uploadPaper.id+'/pdf',headers:{'content-type':'application/octet-stream'},chunks:[Buffer.from('%PDF-1.7\nSYNTHETIC PRIVATE DOCUMENT\n%%EOF')]});
await uploadEntered.promise;const deleteUpload=papers.deletePaper(uploadPaper.id);uploadRelease.resolve();const uploaded=await uploading;await deleteUpload;
check('D07.delete-and-upload-cannot-recreate-attachment',!existsSync(join(papers.dir,'attachments',uploadPaper.id+'.pdf')),{status:uploaded.statusCode,recordPresent:papers.papers.has(uploadPaper.id),attachmentRecreated:existsSync(join(papers.dir,'attachments',uploadPaper.id+'.pdf'))});
const replacement={...race};await papers.upsertPaper(replacement);
const late=await archiveReadResult(papers,race,quick);
check('D07.old-generation-cannot-write-recreated-id',late.file===null&&!existsSync(sessionPath(papers.dir,race.id)),{sameCreatedAt:replacement.createdAt===race.createdAt,file:late.file});
const live=await archiveReadResult(papers,replacement,quick);await papers.deletePaper(replacement.id);
check('D07.new-generation-can-archive-and-delete',!!live.file&&!existsSync(sessionPath(papers.dir,replacement.id))&&!existsSync(join(papers.dir,'reports',live.file)),{});


// Exercise public PDF extraction with valid compressed/stored/mixed streams and
// small injectable budgets. This uses the shipped parser, not a copied function.
function pdf(streams){
 const entries=['1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
 '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
 '3 0 obj << /Type /Page /Parent 2 0 R /Contents ['+streams.map((_,i)=>(i+4)+' 0 R').join(' ')+'] >> endobj'];
 streams.forEach((buf,i)=>entries.push((i+4)+' 0 obj << /Length '+buf.length+' /Filter /FlateDecode >> stream\n'+buf.toString('latin1')+'\nendstream\nendobj'));
 return '%PDF-1.4\n'+entries.join('\n')+'\ntrailer << /Root 1 0 R >>\n%%EOF';
}
function rejectsBudget(streams,limits){try{createPdfTools(()=>0,limits).extractPdfText(pdf(streams));return false;}catch(e){return /预算|超限/.test(e.message);}}
const payload=Buffer.from('BT ('+'A'.repeat(2048)+') Tj ET');
check('D08.compressed-block-enforces-test-budget',rejectsBudget([deflateSync(payload)],{streamBytes:1024}),{isolatedBudget:1024});
check('D08.stored-block-enforces-test-budget',rejectsBudget([deflateSync(payload,{level:0})],{streamBytes:1024}),{isolatedBudget:1024});
const z=createDeflateRaw({level:9}),zparts=[];z.on('data',b=>zparts.push(b));
z.write(Buffer.alloc(512,65));await new Promise((r,j)=>z.flush(constants.Z_SYNC_FLUSH,e=>e?j(e):r()));z.destroy();
const tail=Buffer.alloc(5+2048,66);tail[0]=1;tail.writeUInt16LE(2048,1);tail.writeUInt16LE(0xffff^2048,3);
const mixed=Buffer.concat([...zparts,tail]);
check('D08.mixed-block-stream-enforces-test-budget',inflateRawSync(mixed).length===2560&&rejectsBudget([Buffer.concat([Buffer.from([0x78,0x9c]),mixed,Buffer.alloc(4)])],{streamBytes:1024}),{isolatedBudget:1024});
const small=deflateSync(Buffer.from('BT ('+'A'.repeat(1100)+') Tj ET'));
check('D08.cumulative-document-budget',rejectsBudget([small,small],{streamBytes:1500,documentBytes:2000}),{streamBytes:1500,documentBytes:2000});
check('D08.object-count-budget',rejectsBudget([small],{objects:2}),{objects:2});
const normal=deflateSync(Buffer.from('BT (Synthetic normal text) Tj ET'));
check('D08.normal-document-remains-readable',createPdfTools(()=>0).extractPdfText(pdf([normal])).includes('Synthetic normal text'),{});
check('D08.stream-count-budget',rejectsBudget([normal,normal],{streams:1}),{});
const reusableParser=createPdfTools(()=>0,{documentBytes:2000});
try{reusableParser.extractPdfText(pdf([small,small]));}catch{}
check('D08.budget-resets-for-next-document',reusableParser.extractPdfText(pdf([normal])).includes('Synthetic normal text'),{});
const realNow=Date.now;let clock=0;
try{Date.now=()=>++clock;check('D08.processing-deadline',rejectsBudget([normal],{timeMs:1}),{});}finally{Date.now=realNow;}

// Text provider honors AbortSignal: cancellation must actually settle without
// releasing the provider manually. No real LLM call.
let textSignal;const entered=deferred(),flag={aborted:false};
const runtime=createLlmRuntime({ctx:{get(){},llm:{stream(options){textSignal=options.signal;return(async function*(){entered.resolve();await new Promise((_,reject)=>{if(options.signal?.aborted)reject(new Error('synthetic aborted'));else options.signal?.addEventListener('abort',()=>reject(new Error('synthetic aborted')),{once:true});});})();}}},estimateTokens:()=>1,llmCallStats:{calls:0,ms:0},recordCalibration(){}});
const textCall=runtime.callModelJson({provider:'synthetic',model:'synthetic'},'system','synthetic',100,flag).then(()=>({settled:true}),e=>({settled:true,error:e.message}));
await entered.promise;flag.aborted=true;const textResult=await Promise.race([textCall,delay(1000).then(()=>({settled:false}))]);
check('D09.text-cancellation-actually-settles',textSignal?.aborted&&textResult.settled,{signalAborted:textSignal?.aborted,...textResult});

// Real VLM reader, fake attachment store/provider. Engine supplies no cancellation
// argument; verify its model options and the pending request after cancellation.
const vr=await loadIsolated('dsh-scholar/dist/read/vlm.js',{'./llm.js':{createLlmRuntime:()=>({pickConfig:async()=>({provider:'synthetic',model:'synthetic'})})}});
let vlmSignal,vlmFinished=false;const vlmFlag={aborted:false};const vlmEntered=deferred(),vlmRelease=deferred();
const reader=vr.createFigureReader({attachments:{saveImage:async()=>({attachmentId:'synthetic',mediaType:'image/png'})},llm:{stream(o){vlmSignal=o.signal;return(async function*(){vlmEntered.resolve();await new Promise((resolve,reject)=>{vlmRelease.promise.then(resolve);o.signal?.addEventListener('abort',()=>reject(new Error('synthetic cancelled')),{once:true});});yield{type:'text-delta',text:'这是一张完全合成的科研图像，仅用于本地取消测试。'};})();}}});
const vlmCall=reader.describeFigure({b64:'AA==',mime:'image/png',w:64,h:64,obj:'1'},'',vlmFlag).catch(e=>e.message).finally(()=>{vlmFinished=true});
await vlmEntered.promise;vlmFlag.aborted=true;await delay(200);
check('D09.vlm-provider-receives-cancel-signal',!!vlmSignal?.aborted&&vlmFinished,{hasSignal:!!vlmSignal,finishedBeforeManualRelease:vlmFinished,readerUsableAfterCancel:reader.usable});
vlmRelease.resolve();await vlmCall;

// Exercise real engine orchestration: cancel during image 1, then finish that
// image. Image 2 must not start. Only input extraction/model services are fake.
const llmModule=await import('../dsh-scholar/dist/read/llm.js');
let imageCalls=0;const image1Entered=deferred(),image1Release=deferred(),engineFlag={aborted:false};
const figure={b64:'AA==',mime:'image/png',w:64,h:64,obj:'1'};
const engineModule=await loadIsolated('dsh-scholar/dist/read/engine.js',{
 './pdf.js':{createPdfTools:()=>({bytesToLatin1:()=>'%PDF synthetic',extractPdfText:()=>('synthetic text '.repeat(100))})},
 './figures.js':{extractPdfFigures:()=>({images:[figure,{...figure,obj:'2'}]})},
 './vlm.js':{createFigureReader:()=>({usable:true,describeFigure:async()=>{imageCalls++;if(imageCalls===1){image1Entered.resolve();await image1Release.promise;}return'Synthetic figure description';}})},
 './llm.js':{...llmModule,createLlmRuntime:()=>({pickConfig:async()=>({provider:'fake',model:'fake'}),callModelJson:async(_a,_b,_c,_d,s)=>{if(s.aborted)throw new Error('synthetic cancelled');return{};}})},
});
const engineCall=engineModule.createReadEngine({get(){},fs:{resolve:async p=>p,readBytes:async()=>Buffer.from('synthetic')}}).readSync({path:'synthetic.pdf',mode:'paper'},null,engineFlag).catch(e=>e.message);
await image1Entered.promise;engineFlag.aborted=true;image1Release.resolve();await engineCall;
check('D09.cancel-stops-subsequent-images',imageCalls===1,{imageCalls,cancelledDuringImage:1,availableImages:2});
const now=1_000_000,log={mtimeMs:now-3600000,changeAt:now-12*60000,fresh:false};
check('D12.toast-duration-uses-observation-clock',logIdleMinutes(log,now)===12,{minutes:logIdleMinutes(log,now)});
check('D12.future-remote-clock-does-not-hide-stall',logStalled({...log,mtimeMs:now+3600000},10,now),{});
await fs.writeFile(join(out,'regression-results.json'),JSON.stringify({fixture,results},null,2));
process.exitCode=results.some(r=>!r.passed)?1:0;
