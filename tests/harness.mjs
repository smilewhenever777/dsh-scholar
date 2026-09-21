import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export function context() {
  const routes = new Map(), disposers = [], listeners = new Map(), registeredTools = new Map();
  return { routes, disposers, listeners, registeredTools,
    effect(fn) { const off = fn(); if (typeof off === 'function') disposers.push(off); },
    webServer: { register(r) { routes.set(r.path, r); return () => routes.delete(r.path); }, port: 9999 },
    logger: { info() {}, warn() {} }, on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name); },
    get() {}, systemPrompt: { section() { return () => {}; } },
    tools: { register(t) { registeredTools.set(t.name, t); return () => registeredTools.delete(t.name); } },
  };
}
export async function call(ctx, prefix, method = 'GET', body, opts = {}) {
  const chunks = opts.chunks ?? (body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  const req = Readable.from(chunks);
  req.method = method; req.url = opts.url ?? prefix;
  req.headers = { 'content-type': 'application/json', host: 'localhost', ...opts.headers };
  req.socket = { remoteAddress: opts.remote ?? '127.0.0.1' };
  const res = { statusCode: 200, headers: {}, text: '', setHeader(k,v) { this.headers[k]=v; },
    writeHead(code,headers) { this.statusCode=code; Object.assign(this.headers,headers); }, end(data) { this.text=String(data??''); }, on() {} };
  await ctx.routes.get(prefix).handler(req,res);
  try { res.json=JSON.parse(res.text); } catch {}
  return res;
}
export async function loadIsolated(file, mocks = {}, globals = {}, extraExports = '') {
  const url=pathToFileURL(resolve(file)), req=createRequire(url);
  const sandbox=vm.createContext({ console, Buffer, URL, URLSearchParams, AbortSignal, AbortController, process,
    setTimeout, clearTimeout, setInterval, clearInterval, ...globals });
  const synthetic=(id,exports)=>new vm.SyntheticModule(Object.keys(exports),function(){
    for(const [key,value] of Object.entries(exports)) this.setExport(key,value);
  },{context:sandbox,identifier:id});
  const mod=new vm.SourceTextModule(await readFile(url,'utf8')+'\n'+extraExports,{
    context:sandbox,identifier:url.href,initializeImportMeta(meta){meta.url=url.href;},
    importModuleDynamically:async spec=>import(spec.startsWith('.')?new URL(spec,url).href:spec),
  });
  await mod.link(async spec=>{
    if(spec in mocks) return synthetic(spec,mocks[spec]);
    const target=spec.startsWith('.')?new URL(spec,url).href:spec.startsWith('node:')?spec:pathToFileURL(req.resolve(spec)).href;
    return synthetic(spec,await import(target));
  });
  await mod.evaluate(); return mod.namespace;
}
export const quick={kind:'quick',title:'Synthetic report',summary:'Synthetic summary',thesis:'',arguments:[],concepts:[],questions:[],caveats:[],
  meta:{mode:'quick',chars:20,chunks:1,durationMs:1,chunksText:['Synthetic private passage']}};
