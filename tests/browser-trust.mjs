import assert from 'node:assert/strict';
import { context, call } from './harness.mjs';
import { registerScholarRoutes } from '../dsh-scholar/dist/routes.js';
import { registerTrajRoutes } from '../dsh-trajectory/dist/routes.js';
import { apply as applyDashboard } from '../dsh-server-dashboard/dist/index.js';
const scholar=context(),traj=context(),dash=context();
const config={hosts:[],refreshIntervalS:30,staleMinutes:10,alertIdleMin:5};
dash.settings={register:()=>({get:()=>config,update:async()=>{}})};
dash.credentials={resolve:async()=>undefined};
registerScholarRoutes(scholar,async()=>({stats:()=>({papers:0,cards:0}),dir:'synthetic'}),()=>({}),async()=>{});
registerTrajRoutes(traj,async()=>({stats:()=>({projects:0,nodes:0})}),()=>({}),async()=>{});
applyDashboard(dash);
let passed=0;
try {
  for(const [ctx,path] of [[scholar,'/scholar/stats'],[traj,'/traj/stats'],[dash,'/dash/config']]) {
    for(const site of ['cross-site','same-site']) {
      const result=await call(ctx,path,'GET',undefined,{headers:{'sec-fetch-site':site}});
      assert.equal(result.statusCode,403,path+' must reject '+site+' even without Origin');passed++;
    }
    const origin=await call(ctx,path,'GET',undefined,{headers:{origin:'https://untrusted.invalid','sec-fetch-site':'same-origin'}});
    assert.equal(origin.statusCode,403);passed++;
    const forwarded=await call(ctx,path);
    assert.equal(forwarded.statusCode,200,path+' must accept the owned Desktop forwarding shape');passed++;
  }
  console.log('Browser trust: '+passed+' assertions passed');
} finally {
  for(const ctx of [scholar,traj,dash])for(const off of ctx.disposers.reverse())await off();
}
