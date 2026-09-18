import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { checkPath, checkText } from '../scripts/check-public.mjs';

test('publication guard rejects Markdown regardless of case or nesting', () => {
  for (const extension of ['md', 'MD', 'Md', 'mD']) {
    assert.ok(checkPath(`nested/notes.${extension}`).length);
  }
  assert.ok(checkPath('nested/notes.MD/inside.txt').length);
  assert.deepEqual(checkPath('README.txt'), []);
  assert.deepEqual(checkPath('LICENSE'), []);
});

test('publication guard rejects private state and CI/deployment paths', () => {
  for (const name of ['.env.local', '.dev.vars', '.secrets/token', '.wrangler/cache.json',
    'admin-access.txt', 'client.pem', 'customer.sqlite', '.github/workflows/check.yml',
    '.circleci/config.yml', 'scripts/deploy.sh', 'deploy-vibecheck/version.json']) {
    assert.ok(checkPath(name).length, name);
  }
  assert.deepEqual(checkPath('wrangler.cleanup.jsonc'), []);
  assert.deepEqual(checkPath('server/cleanup.js'), []);
});

test('publication guard recognizes credentials without returning their values', () => {
  const key = ['sk', 'live', 'X'.repeat(32)].join('_');
  const link = 'https://example.com/#' + 'access=' + 'a'.repeat(64);
  for (const value of [key, link]) {
    const result = checkText('example.txt', value);
    assert.ok(result.length);
    assert.equal(result.join(' ').includes(value), false);
  }
  assert.deepEqual(checkText('example.js', "const key = env.STRIPE_SECRET_KEY;"), []);
});

test('publication guard rejects deployment package scripts and allows local checks', () => {
  const good = JSON.stringify({ scripts: { build: 'node scripts/build.mjs', test: 'node --test' } });
  assert.deepEqual(checkText('package.json', good), []);
  const bad = JSON.stringify({ scripts: { deploy: ['wrangler', 'pages', 'deploy', 'assets'].join(' ') } });
  assert.ok(checkText('package.json', bad).includes('deployment or publication npm script'));
});

test('publication guard rejects generated integration encryption keys without echoing them', () => {
  const value = randomBytes(32).toString('hex');
  for (const assignment of [
    `INTEGRATION_ENCRYPTION_KEY=${JSON.stringify(value)}`,
    JSON.stringify({ INTEGRATION_ENCRYPTION_KEY: value }),
  ]) {
    const findings = checkText('configuration.txt', assignment);
    assert.ok(findings.includes('assigned secret'));
    assert.equal(findings.join(' ').includes(value), false);
  }
  assert.deepEqual(checkText('server.js', 'const key = env.INTEGRATION_ENCRYPTION_KEY;'), []);
});
