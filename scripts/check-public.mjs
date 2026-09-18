#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const maximumFileBytes = 10 * 1024 * 1024;

// Report categories, never matching strings or surrounding source lines.
const credentialPatterns = [
  ['private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
  ['Stripe credential', /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/],
  ['Stripe webhook credential', /\bwhsec_[A-Za-z0-9]{16,}\b/],
  ['GitHub credential', /\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b/],
  ['AWS access identifier', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['Figma credential', /\bfigd_[A-Za-z0-9_-]{20,}\b/],
  ['Slack credential', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ['Google API credential', /\bAIza[A-Za-z0-9_-]{30,}\b/],
  ['literal bearer credential', /\bBearer\s+[A-Za-z0-9+/_=-]{20,}/],
  ['private link credential', /[?&#](?:access|access_token|refresh_token|token|secret|key)=[A-Za-z0-9_%+./=-]{16,}/i],
  ['URL password', /https?:\/\/[^\s/:'"]+:[^\s/@'"]+@/i],
  ['assigned secret', /\b(?:ADMIN_TOKEN|INTEGRATION_ENCRYPTION_KEY|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|GITHUB_ACCESS_TOKEN|GITHUB_APP_PRIVATE_KEY|GITHUB_CLIENT_SECRET|FIGMA_CLIENT_SECRET|CLOUDFLARE_API_TOKEN|AWS_SECRET_ACCESS_KEY)["']?\s*[:=]\s*["'][A-Za-z0-9+/_=-]{16,}["']/],
];

export function checkPath(name) {
  const normalized = name.replaceAll('\\', '/');
  const issues = [];
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) issues.push('path outside source root');
  if (/\.md(?:\/|$)/i.test(normalized)) issues.push('Markdown file or directory');
  if (/(?:^|\/)(?:\.git|node_modules|\.wrangler|\.secrets?|secrets|private-ops|\.aws|\.ssh)(?:\/|$)/i.test(normalized)) issues.push('private or generated path');
  if (/(?:^|\/)(?:\.env[^/]*|\.dev\.vars[^/]*|credentials(?:\.[^/]*)?|admin-(?:access|token)(?:\.[^/]*)?)(?:\/|$)/i.test(normalized)) issues.push('credential path');
  if (/\.(?:pem|key|p12|pfx|sqlite3?|db|log)$/i.test(normalized)) issues.push('credential, database, or log file');
  if (/(?:^|\/)version\.json$/i.test(normalized)) issues.push('generated revision metadata');
  if (/(?:^|\/)\.github\/workflows(?:\/|$)/i.test(normalized) || /(?:^|\/)\.circleci(?:\/|$)/i.test(normalized)) issues.push('CI or deployment workflow');
  if (/(?:^|\/)(?:\.gitlab-ci\.yml|azure-pipelines\.ya?ml|bitbucket-pipelines\.ya?ml|Jenkinsfile|\.travis\.yml|appveyor\.ya?ml|cloudbuild\.ya?ml)$/i.test(normalized)) issues.push('CI or deployment workflow');
  if (/(?:^|\/)(?:deploy|release|publish)(?:[._-][^/]*)?\.(?:m?js|cjs|ts|sh|ya?ml)$/i.test(normalized)) issues.push('deployment or publication automation');
  return issues;
}

export function checkText(name, content) {
  const issues = credentialPatterns.filter(([, pattern]) => pattern.test(content)).map(([category]) => category);
  if (/(?:^|\/)package\.json$/i.test(name)) {
    try {
      const { scripts = {} } = JSON.parse(content);
      for (const [key, value] of Object.entries(scripts)) {
        if (/(?:^|:)(?:deploy|release|publish)(?:$|:)/i.test(key)
          || /\bwrangler\s+(?:pages\s+)?deploy\b|\b(?:vercel|netlify)\s+deploy\b|\b(?:npm|pnpm|yarn)\s+publish\b/i.test(String(value))) {
          issues.push('deployment or publication npm script');
        }
      }
    } catch { issues.push('unreadable package manifest'); }
  }
  return [...new Set(issues)];
}

function git(args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function standaloneRepository() {
  try { return resolve(git(['rev-parse', '--show-toplevel']).trim()) === root; }
  catch { return false; }
}

async function treeFiles(directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (directory === root && entry.name === '.git') continue;
    const absolute = resolve(directory, entry.name);
    const name = relative(root, absolute).replaceAll('\\', '/');
    if (entry.isDirectory()) {
      const issues = checkPath(name);
      if (issues.length) files.push({ name, issues });
      else files.push(...await treeFiles(absolute));
    } else files.push({ name });
  }
  return files;
}

async function readWorkingFile(name) {
  const absolute = resolve(root, name);
  const stat = await lstat(absolute);
  if (!stat.isFile()) return { issues: ['symbolic link or non-regular file'] };
  if (stat.size > maximumFileBytes) return { issues: ['file exceeds manual-review size limit'] };
  return { content: await readFile(absolute, 'utf8') };
}

export async function main(args = process.argv.slice(2)) {
  if (args.length > 1 || args.some(arg => !['--tree', '--staged'].includes(arg))) {
    console.error('Usage: node scripts/check-public.mjs [--tree|--staged]');
    return 2;
  }
  const ownRepository = standaloneRepository();
  if (args[0] === '--staged' && !ownRepository) {
    console.error('Public guard failed: staged checks require a standalone repository at this source root.');
    return 1;
  }
  const useTree = args[0] === '--tree' || !ownRepository;
  const failures = [];
  let checked = 0;
  const inspect = (name, material, surface) => {
    const issues = [...checkPath(name), ...(material.issues || [])];
    if (material.content !== undefined) issues.push(...checkText(name, material.content));
    checked++;
    for (const category of new Set(issues)) failures.push(`${JSON.stringify(name)} (${surface}): ${category}`);
  };

  if (useTree) {
    for (const file of await treeFiles()) {
      inspect(file.name, file.issues ? file : await readWorkingFile(file.name), 'tree');
    }
  } else {
    const entries = git(['ls-files', '--stage', '-z']).split('\0').filter(Boolean);
    for (const entry of entries) {
      const match = entry.match(/^(\d+) ([a-f0-9]+) (\d)\t([\s\S]*)$/);
      if (!match) { failures.push('Unreadable Git index entry.'); continue; }
      const [, mode, , stage, name] = match;
      if (stage !== '0' || !['100644', '100755'].includes(mode)) {
        inspect(name, { issues: ['unmerged, symbolic-link, or submodule index entry'] }, 'index');
        continue;
      }
      const size = Number(git(['cat-file', '-s', `:${name}`]).trim());
      const material = size > maximumFileBytes
        ? { issues: ['file exceeds manual-review size limit'] }
        : { content: git(['show', `:${name}`]) };
      inspect(name, material, 'index');
      if (args[0] !== '--staged') {
        try { inspect(name, await readWorkingFile(name), 'working copy'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    if (!entries.length) failures.push('Git index is empty; no publication content was checked.');
  }

  if (failures.length) {
    console.error(`Public guard failed with ${failures.length} finding(s):`);
    for (const message of failures) console.error(`- ${message}`);
    return 1;
  }
  console.log(`Public guard passed: ${checked} file content checks (${useTree ? 'source tree only; Git history not checked' : args[0] === '--staged' ? 'complete index' : 'complete index and tracked working files'}).`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch { console.error('Public guard failed: a file or Git object could not be inspected.'); process.exitCode = 1; }
}
