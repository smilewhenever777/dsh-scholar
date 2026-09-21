import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium,deps,launchOptions} from './browser-runtime.mjs';
const out=resolve(process.env.DSH_TEST_OUTPUT??'repair-scroll-2026-09-21');
await mkdir(out,{recursive:true});
await createRequire(deps+'/esbuild/package.json')('esbuild').build({entryPoints:[resolve('tests/ui-fixture.tsx')],bundle:true,platform:'browser',format:'iife',outfile:out+'/bundle.js',nodePaths:[deps],jsx:'automatic',alias:{react:deps+'/react','react-dom':deps+'/react-dom'}});
// Fixed, clipped host panel: document scrolling must not mask a broken inner scroller.
const html='<!doctype html><html lang="zh"><meta charset="utf-8"><style>body{margin:0;overflow:hidden;font-family:sans-serif}main{overflow:hidden}button,input{font-family:inherit}</style><div id="root"></div><script src="/app.js"></script></html>';
const server=createServer(async(req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'application/javascript':'text/html;charset=utf-8');res.end(req.url==='/app.js'?await readFile(out+'/bundle.js'):html);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch(launchOptions),results=[],errors=[];
try{
 for(const width of [420,699,700,1000])for(const rail of [false,true]){
  const page=await browser.newPage({viewport:{width,height:640}});
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>r.request().url().startsWith(base)?r.continue():r.abort());
  await page.goto(base+'/?mode=library-scroll',{waitUntil:'networkidle'});
  const cards=page.locator('[data-dsh-part="paper-card"]');await cards.first().waitFor();
  if(!!(await page.locator('[data-dsh-part="collection-rail"]').count())!==rail)await page.getByRole('button',{name:'分区栏',exact:true}).click();
  const measure=()=>page.evaluate(()=>{
   const cards=[...document.querySelectorAll('[data-dsh-part="paper-card"]')],list=cards[0].closest('.sch-scroll'),last=cards.at(-1),rect=list.getBoundingClientRect(),end=last.getBoundingClientRect();
   const rail=document.querySelector('[data-dsh-part="collection-rail"]')?.getBoundingClientRect();
   return{count:cards.length,clientHeight:list.clientHeight,scrollHeight:list.scrollHeight,scrollTop:list.scrollTop,top:rect.top,bottom:rect.bottom,lastTop:end.top,lastBottom:end.bottom,viewport:innerHeight,railOnLeft:!rail||(rail.right<=rect.left+1&&Math.abs(rail.bottom-rect.bottom)<2)};
  });
  const before=await measure();
  await page.mouse.move(width/2,Math.min(610,before.top+40));await page.mouse.wheel(0,20000);
  // Wait for browser wheel delivery without hiding failed scrolling behind an auto-scroll click.
  await page.waitForTimeout(250);
  const after=await measure();
  const passed=after.railOnLeft&&after.count===40&&after.scrollTop>0&&after.clientHeight<after.scrollHeight&&after.bottom<=after.viewport+1&&after.lastBottom<=after.bottom+1&&after.lastTop>=after.top;
  results.push({width,rail,passed,before,after});console.log(JSON.stringify(results.at(-1)));
  await page.screenshot({path:out+`/library-${width}-${rail?'rail':'plain'}.png`});
  if(passed){
   await cards.last().click();await page.getByRole('button',{name:'返回',exact:true}).click();await cards.first().waitFor();
   const restored=await measure();
   const restoredPassed=restored.clientHeight<restored.scrollHeight&&restored.bottom<=restored.viewport+1;
   results.push({width,rail,case:'return-from-detail',passed:restoredPassed,observed:restored});
  }
  await page.close();
 }
}finally{await browser.close();await new Promise(r=>server.close(r));}
await writeFile(out+'/results.json',JSON.stringify({results,errors},null,2));
process.exitCode=results.some(r=>!r.passed)||errors.length?1:0;
