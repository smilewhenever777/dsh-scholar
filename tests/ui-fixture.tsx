import {Modal as ScholarModal} from '../dsh-scholar/src/client/ui';
import {Modal as TrajectoryModal} from '../dsh-trajectory/src/client/ui';
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {PaperLibraryView} from '../dsh-scholar/src/client/PaperLibraryView';
import {BookshelfView} from '../dsh-scholar/src/client/BookshelfView';
import {GraphView} from '../dsh-scholar/src/client/GraphView';
import {deliverToComposer,DeepreadLauncher} from '../dsh-scholar/src/client/DeepreadLauncher';
import {navBus} from '../dsh-scholar/src/client/nav';
import {ServerDashboardSettings} from '../dsh-server-dashboard/src/client/SettingsSection';
import {DashboardPanel} from '../dsh-server-dashboard/src/client/DashboardPanel';
import {NodeEditorModal} from '../dsh-trajectory/src/client/NodeEditor';
import {TrajListView} from '../dsh-trajectory/src/client/TrajListView';
import {useDashProgress} from '../dsh-trajectory/src/client/dash';
import {zh as szh} from '../dsh-scholar/src/client/locales';
import {zh as dzh} from '../dsh-server-dashboard/src/client/locales';
import {zh as tzh} from '../dsh-trajectory/src/client/locales';
const mode=new URLSearchParams(location.search).get('mode')||'library';
const w=window as any;
const paper=(id:string)=>({id,title:'合成论文 '+id,authors:['测试作者'],year:2026,tags:['detection'],importance:2,source:'manual',readStatus:'want',abstract:'合成摘要 '+id,summary:'旧总结 '+id,notes:'旧笔记 '+id,createdAt:1,updatedAt:1});
const cards=[{id:'c1',title:'合成 Idea',insight:'测试想法',category:'method',status:'pending',importance:3,tags:['detection'],paperId:'A',createdAt:1,updatedAt:1}];
const host=(id:string)=>({id,name:'合成主机 '+id,host:id+'.invalid',port:22,username:'audit',authKind:'none',credentialRef:'',identityFile:'',logPath:'',pinned:false});
const node={id:'n1',title:'合成实验',projectId:'p1',kind:'experiment',status:'in_progress',tags:[],refs:{hostId:'s1',logPath:'/runs/ExpA/train.log'},createdAt:1,updatedAt:1};
const initial={project:{id:'p1',name:'合成研究',mainline:['n1'],researchQuestion:'方法是否有效？',status:'active',createdAt:1,updatedAt:1},nodes:[node],edges:[],goals:[],hypotheses:[{id:'h1',text:'合成假设',status:'active',track:'mainline'}],goalLog:[]};
const gpu={index:0,name:'合成 GPU',utilPercent:50,tempC:45,memoryUsedMiB:1024,memoryTotalMiB:8192,powerW:100,processes:[{pid:123,user:'audit',name:'python',cmd:'python /runs/expa/train.py',memoryMiB:1024}],log:{path:'/runs/expa/train.log',lines:['90/100 [=====]'],size:100,mtimeMs:Date.now(),fresh:true,changeAt:Date.now()}};
w.audit={requests:[],pending:{},papers:{A:paper('A'),B:paper('B')},cards,config:{hosts:[host('s1'),host('s2')],refreshIntervalS:30,staleMinutes:10,alertIdleMin:5},delay:{},fail:{},file:initial,dialogs:[],snapshots:{s1:{hostId:'s1',ok:true,at:Date.now(),gpus:[gpu]}}};
const a=w.audit;
if(mode==='library-scroll')a.papers=Object.fromEntries(Array.from({length:40},(_,i)=>{const id=String(i+1).padStart(2,'0');return[id,paper(id)];}));
const response=(v:any,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json'}});
window.fetch=async(url,init)=>{
 const u=String(url),method=init?.method||'GET',key=method+' '+u,body=typeof init?.body==='string'?JSON.parse(init.body):null;
 a.requests.push({url:u,method,body});
 if(a.delay[key])await new Promise(r=>(a.pending[key]??=[]).push(r));
 if(a.fail[key]||(mode==='dash-fail'&&key==='GET /dash/config'))return response({error:'合成网络错误'},503);
 if(u==='/dash/config'){
   a.revision??=1;
   if(method==='PATCH'||method==='PUT') {
     if(body.revision!==String(a.revision))return response({error:'配置已变化或缺少版本，请重新加载并核对后保存'},409);
     if(body.hosts)a.config.hosts=body.hosts;
     if(body.addHosts)a.config.hosts.push(...body.addHosts);
     if(body.updateHost)a.config.hosts=a.config.hosts.map((h:any)=>h.id===body.updateHost.id?{...h,...body.updateHost.changes}:h);
     if(body.removeHostId)a.config.hosts=a.config.hosts.filter((h:any)=>h.id!==body.removeHostId);
     for(const k of ['refreshIntervalS','staleMinutes','alertIdleMin'])if(body[k]!==undefined)a.config[k]=body[k];
     a.revision++;
   }
   return response({ok:true,config:a.config,revision:String(a.revision)});
 }
 if(u==='/dash/test')return response({ok:true,detail:'连接成功（合成）'});
 if(u==='/dash/discover-logs')return response({candidates:[]});
 if(u==='/dash/import-ssh')return response({hosts:[]});
 if(u.startsWith('/dash/snapshots'))return response({hosts:a.config.hosts,snapshots:a.snapshots,staleMinutes:10});
 if(u==='/scholar/config')return response({config:{defaultTags:[],paperDir:'/synthetic',researchFocus:'合成研究方向'}});
 if(u.startsWith('/scholar/collections'))return response({collections:[]});
 if(u==='/scholar/graph')return response({graph:{nodes:[{id:'A',kind:'paper',label:'合成论文 A'},{id:'c:detect',kind:'concept',label:'检测'}],edges:[{source:'A',target:'c:detect',kind:'uses'}]}});
 if(u==='/scholar/stats')return response({unsynced:[]});
 if(u==='/scholar/cards/c1'){
   if(method==='PUT')a.cards[0]={...a.cards[0],...body};
   return response({card:a.cards[0]});
 }
 if(u.startsWith('/scholar/cards'))return response({cards:u.includes('paperId=B')?[]:a.cards,tags:['detection']});
 if(u==='/scholar/papers'||u.startsWith('/scholar/papers?')){
   if(method==='POST'){const p={...paper('P'+a.requests.length),...body};a.papers[p.id]=p;return response({paper:p,created:true});}
   const q=new URL(u,location.origin).searchParams.get('q')||'';
   return response({papers:Object.values(a.papers).filter((p:any)=>p.title.includes(q)),tags:['detection']});
 }
 const match=/^\/scholar\/papers\/([^/]+)(.*)$/.exec(u);
 if(match){const [,id,suffix]=match;
  if(suffix==='/reports')return response({reports:[]});
  if(suffix==='/related')return response({similar:[],citations:[],references:[]});
  if(suffix==='/sidecar')return response({sidecar:null});
  if(method==='PUT')a.papers[id]={...a.papers[id],...body};
  return response({paper:a.papers[id]});
 }
 if(u.startsWith('/scholar/read/session'))return response({exists:a.sessionExists===true,qa:[]});
 if(u==='/scholar/read/compare')return body.paperIds.length<2?response({error:'对比需要选 2-10 篇论文'},400):response({ok:true,detached:true,started:2});
 if(u==='/scholar/read/run')return response({ok:true,detached:true,started:1});
 if(u.startsWith('/traj/nodes'))return response({node:{...node,...body}});
 return response({ok:true});
};
const t=(k:string,params?:Record<string,unknown>)=>{let s=(mode.startsWith('dash')?(dzh as any)[k]:mode.startsWith('traj')?(tzh as any)[k]:(szh as any)[k])??k;for(const [key,value]of Object.entries(params??{}))s=s.replaceAll('{'+key+'}',String(value));return s;};
function Progress(){const map=useDashProgress(initial.nodes as any,true);a.progress=Object.fromEntries(map);return <><pre data-testid="progress">{JSON.stringify(a.progress)}</pre><TrajListView t={t} file={initial as any} progress={map} onOpen={()=>{}} onDelete={()=>{}} onDeleteEntry={()=>{}} onStatus={()=>{}}/></>}
function Stack(){const[parent,setParent]=useState(true);const[child,setChild]=useState(false);return parent?<ScholarModal title="学者弹窗" onClose={()=>setParent(false)}><button onClick={()=>setChild(true)}>打开嵌套弹窗</button>{child&&<TrajectoryModal title="主线弹窗" onClose={()=>setChild(false)}>合成内容</TrajectoryModal>}</ScholarModal>:null;}
function App(){const[editor,setEditor]=useState(true);const[target,setTarget]=useState('n1');a.unmount=()=>setEditor(false);a.target=(v:string)=>setTarget(v);a.nav=(id:string)=>navBus.go('papers',id);a.reopen=()=>setEditor(true);
 if(mode==='modal-stack')return <Stack/>;
 if(mode==='deepread')return <DeepreadLauncher open current={a.papers.A} onClose={()=>a.closed=true} notify={(s)=>a.notice=s} t={t}/>;
 return <><header style={{padding:12,fontSize:13}}>DSH 深度体验 · 隔离合成数据 · {mode}</header><main style={{height:'calc(100vh - 50px)',display:'flex',flexDirection:'column',maxWidth:mode.startsWith('dash')?1000:780,margin:'auto'}}>
 {mode==='books'?<BookshelfView t={t}/>:mode==='graph'?<GraphView t={t}/>:mode==='dash-panel'?<DashboardPanel hosts={a.config.hosts} snapshots={a.snapshots} staleMinutes={10} t={t}/>:mode.startsWith('dash')?<ServerDashboardSettings t={t}/>:mode==='traj-progress'?<Progress/>:mode==='traj-editor'?<><button onClick={()=>setEditor(true)}>打开编辑器</button>{editor&&<NodeEditorModal t={t} file={initial as any} editing={target==='new'?null:{...node,id:target} as any} onSaved={()=>{}} onClose={()=>{a.closed=true;setEditor(false)}}/>}</>:mode==='composer'?<><textarea aria-label="宿主输入框" defaultValue="尚未发送的研究问题：请保留"/><button aria-label="发送" onClick={()=>a.sent=document.querySelector('textarea')?.value}>发送</button><button data-dsh-plugin="dsh-scholar" onClick={()=>deliverToComposer('基于合成报告建卡',r=>a.delivery=r)}>从报告建卡</button></>:<PaperLibraryView t={t}/>}
 </main></>;
}
createRoot(document.getElementById('root')!).render(<App/>);
