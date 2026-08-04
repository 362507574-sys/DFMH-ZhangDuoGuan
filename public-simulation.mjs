import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const root=process.cwd();
const contract=JSON.parse(await readFile(path.join(root,'PUBLIC_PACKAGE_CONTRACT.json'),'utf8'));
if(contract.repoName!=='DFMH-ZhangDuoGuan'||contract.fullSystemEquivalent!==false||contract.simulationLevel!=='standalone-contract') throw new Error('Public package contract mismatch');
const required=["AGENTS.md","QUICKSTART.md","PUBLIC_PACKAGE_CONTRACT.json","examples/REQUEST.md","examples/DELIVERABLE_CHECKLIST.md","public-simulation.mjs"];
for(const relative of required){if(!(await stat(path.join(root,relative))).isFile()) throw new Error('Missing distribution file: '+relative);}
for(const relative of contract.primaryEntrypoints){if(!(await stat(path.join(root,relative))).isFile()) throw new Error('Missing primary entrypoint: '+relative);}
const denied=new Set(contract.excludedPrivateDirectories);
let longest='';
async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){if(entry.name==='.git'||entry.name==='node_modules') continue;const full=path.join(dir,entry.name);const relative=path.relative(root,full).replaceAll('\\','/');if(relative.length>longest.length) longest=relative;if(entry.isDirectory()){if(denied.has(entry.name)) throw new Error('Denied private directory: '+relative);await walk(full);}}}
await walk(root);
if(longest.length>contract.maxRelativePathLength) throw new Error('Relative path too long: '+longest.length+' '+longest);
for(const relative of ['AGENTS.md','QUICKSTART.md','examples/REQUEST.md','examples/DELIVERABLE_CHECKLIST.md']){const text=await readFile(path.join(root,relative),'utf8');if(text.trim().length<80) throw new Error('Distribution guidance is too small: '+relative);}
console.log('PASS: DFMH-ZhangDuoGuan standalone public contract simulation; fullSystemEquivalent=false; maxRelativePathLength='+longest.length);
