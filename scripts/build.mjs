import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

async function validate(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name.startsWith('.') || /\.md$/i.test(entry.name)) {
      throw new Error(`Not a public source asset: ${directory}/${entry.name}`);
    }
    if (entry.isDirectory()) await validate(`${directory}/${entry.name}`);
  }
}
await validate('site');
await mkdir('deploy-vibecheck', { recursive: true });
// This directory is generated output. Preserve Wrangler's local cache only.
for (const name of await readdir('deploy-vibecheck')) {
  if (name !== '.wrangler') await rm(`deploy-vibecheck/${name}`, { recursive: true, force: true });
}
for (const name of await readdir('site')) await cp(`site/${name}`, `deploy-vibecheck/${name}`, { recursive: true });
// Give changed scripts and styles new URLs so an older browser cache cannot
// combine a new page with the previous release's application code.
for (const name of (await readdir('site')).filter(name => name.endsWith('.html'))) {
  let html = await readFile(`site/${name}`, 'utf8');
  const paths = new Set([...html.matchAll(/(?:src|href)="(\/[a-zA-Z0-9_/-]+\.(?:js|css))"/g)].map(match => match[1]));
  for (const path of paths) {
    const digest = createHash('sha256').update(await readFile(`site${path}`)).digest('hex').slice(0, 16);
    html = html.replaceAll(`"${path}"`, `"${path}?v=${digest}"`);
  }
  await writeFile(`deploy-vibecheck/${name}`, html);
}
let commit = 'uncommitted';
try { commit = execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim(); } catch {}
await writeFile('deploy-vibecheck/version.json', JSON.stringify({commit})+'\n');
console.log('Built public site from site/.');
