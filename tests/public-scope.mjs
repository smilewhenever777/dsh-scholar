// Enforce the complete public tree, including ancestry when publishing refs.
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:64*1024*1024});
const roots=new Set(['dsh-scholar','dsh-server-dashboard','dsh-trajectory','shared-client','tests','.githooks']);
const files=new Set(['.gitignore','README.md','package.json','package-lock.json']);
const allowed=path=>path.includes('/')?roots.has(path.split('/')[0]):files.has(path);
const bad=new Set(git('ls-files','--cached','-z').split('\0').filter(path=>path&&!allowed(path)));
if(process.argv.includes('--history')) {
  const refs=process.argv.slice(2).filter(arg=>!arg.startsWith('--'));
  for(const path of git('log','--format=','--name-only',...(refs.length?refs:['--all'])).split('\n'))if(path&&!allowed(path))bad.add(path);
}
if(bad.size){console.error('Public scope rejected unexpected paths:\n'+[...bad].join('\n'));process.exitCode=1;}
else console.log('Public scope verified: three plugin directories plus shared code, tests and documentation.');
