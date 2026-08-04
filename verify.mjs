import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const root=process.cwd();
const skillsRoot=path.join(root,'organizations','ai-helmsman','skills');
const skills=(await readdir(skillsRoot,{withFileTypes:true})).filter((entry)=>entry.isDirectory());
if(skills.length!==3) throw new Error('Expected exactly three core skills');
for(const skill of skills){const file=path.join(skillsRoot,skill.name,'SKILL.md');if((await stat(file)).size<20) throw new Error('Invalid SKILL.md: '+skill.name);}
const manifest=JSON.parse(await readFile(path.join(root,'PACKAGE_MANIFEST.json'),'utf8'));
if(manifest.repoName!=='DFMH-ZhangDuoGuan'||manifest.organizationId!=='ai-helmsman') throw new Error('Package manifest binding mismatch');
console.log('PASS: DFMH-ZhangDuoGuan package integrity; skills=3');
