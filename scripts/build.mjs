import { cp, readdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
for (const name of await readdir('site')) await cp(`site/${name}`, `deploy-vibecheck/${name}`);
let commit = 'uncommitted';
try { commit = execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim(); } catch {}
await writeFile('deploy-vibecheck/version.json', JSON.stringify({commit})+'\n');
console.log('Built public site from site/.');
