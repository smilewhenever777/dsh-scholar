// Shared UI visual acceptance: existing real components with synthetic data only.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, deps, launchOptions } from './browser-runtime.mjs';
const out=resolve(process.env.DSH_TEST_OUTPUT??'.verify/workbench-visual');
await mkdir(out,{recursive:true});
const {build}=createRequire(deps+'/esbuild/package.json')('esbuild');
await build({entryPoints:[resolve('tests/ui-fixture.tsx')],bundle:true,platform:'browser',format:'iife',outfile:out+'/bundle.js',nodePaths:[deps],jsx:'automatic',alias:{react:deps+'/react','react-dom':deps+'/react-dom'}});
const html=`<!doctype html><html lang="zh"><meta charset="utf-8"><style>
:root{--dsw-alias-label-primary:#202329;--dsw-alias-label-secondary:#5d6573;--dsw-alias-label-caption:#737c89;--dsw-alias-border-l1:#d7dce4;--dsw-alias-border-l2:#e3e7ed;--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-1:#f5f6f8;--dsw-alias-bg-layer-2:#fff;--dsw-alias-state-business-primary:#4d6bfe;--dsw-alias-interactive-bg-hover:#eff2f7;--dsw-alias-state-error-primary:#dc3545}
body{font-family:'Microsoft YaHei',sans-serif;margin:0;background:#f6f7f9}button,input,textarea{font-family:inherit}main{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
@media(prefers-color-scheme:dark){:root{--dsw-alias-label-primary:#e8ecf2;--dsw-alias-label-secondary:#b1b9c7;--dsw-alias-label-caption:#939daa;--dsw-alias-border-l1:#454b55;--dsw-alias-border-l2:#363c46;--dsw-alias-bg-base:#1e2229;--dsw-alias-bg-layer-1:#272d35;--dsw-alias-bg-layer-2:#222831;--dsw-alias-interactive-bg-hover:#303945}body{background:#161a20;color:#e8ecf2}}
</style><div id="root"></div><script src="/app.js"></script></html>`;
const server=createServer(async(req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'application/javascript':'text/html; charset=utf-8');res.end(req.url==='/app.js'?await readFile(out+'/bundle.js'):html);});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const base='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch(launchOptions),results=[],errors=[];
try {
  for(const theme of ['light','dark']) for(const width of [300,440,900]) for(const mode of ['library','dash-panel','traj-progress']) {
    const page=await browser.newPage({viewport:{width:Math.max(width,1000),height:800},colorScheme:theme,reducedMotion:'reduce'});
    page.on('pageerror',error=>errors.push(error.message));
    // Any unexpected resource request fails closed; visual polish stays offline.
    await page.route('**/*',route=>route.request().url().startsWith(base)?route.continue():route.abort());
    await page.goto(base+'/?mode='+mode,{waitUntil:'networkidle'});
    await page.locator('main').evaluate((el,width)=>{el.style.width=width+'px';el.style.maxWidth='none';},width);
    await page.waitForTimeout(100);
    const geometry=await page.locator('main').evaluate(el=>{
      const rail=el.querySelector('[data-dsh-part="collection-rail"]'),card=el.querySelector('[data-dsh-part="paper-card"]');
      return {width:el.clientWidth,scroll:el.scrollWidth,railOverflow:rail?rail.scrollWidth-rail.clientWidth:0,left:!rail||rail.getBoundingClientRect().right<=card.getBoundingClientRect().left};
    });
    assert.ok(geometry.scroll<=geometry.width+1,`${mode}/${theme}/${width} overflows horizontally`);
    assert.equal(geometry.left,true);assert.ok(geometry.railOverflow<=1);
    if(mode==='dash-panel')assert.equal(await page.locator('[data-dsh-part="fleet-summary"] > div').count(),3);
    results.push({mode,theme,width,passed:true,...geometry});
    await page.locator('main').screenshot({path:resolve(out,`${mode}-${theme}-${width}.png`),animations:'disabled'});
    await page.close();
  }
  assert.deepEqual(errors,[]);
} catch(error) { results.push({passed:false,error:error.message});throw error; }
finally {await writeFile(resolve(out,'visual-results.json'),JSON.stringify({results,errors},null,2));await browser.close();await new Promise(done=>server.close(done));}
console.log(`Workbench visual acceptance: ${results.length} cases passed`);
