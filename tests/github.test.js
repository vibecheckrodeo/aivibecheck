import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { manifest, appFromManifest, authorizationUrl, exchangeCode, appJwt, validateInstallation, readRepository, deleteInstallation, listInstallations } from '../server/github.js';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = keys.privateKey.export({ type: 'pkcs1', format: 'pem' });
const config = { appId: 42, clientId: 'Iv1.fixture', clientSecret: 'fixture-secret', privateKey: pem, slug: 'vibecheck-test', owner: { id: 100, login: 'vibecheckrodeo', type: 'Organization' }, permissions: { metadata: 'read', contents: 'read' } };
const repo = { id: 300, full_name: 'person/project' };
const installation = { id: 7, app_id: 42, repository_selection: 'selected', permissions: { metadata: 'read', contents: 'read' }, account: { id: 10, login: 'person', type: 'User' }, suspended_at: null };
const tokenResponse = permissions => Response.json({ token: 'installation-fixture', permissions }, { status: 201 });
function mock(routes) {
  const calls = [];
  return { calls, FETCH: async (url, init) => {
    calls.push({ url, ...init });
    const route = routes.shift();
    assert.ok(route, `Unexpected request ${new URL(url).pathname}`);
    assert.equal(init.method, route.method || 'GET');
    assert.equal(url, route.url || `https://api.github.com${route.path}`);
    assert.equal(init.redirect, 'manual');
    if (route.check) route.check(init);
    if (route.error) throw route.error;
    return route.response || Response.json(route.data);
  } };
}
function validationRoutes({ user = { total_count: 1, repositories: [repo] }, identity = { id: 10, login: 'person' }, details = installation, actual = { total_count: 1, repositories: [repo] } } = {}) {
  return [
    { path: '/user/installations/7/repositories?per_page=100', data: user, check: init => assert.equal(init.headers.Authorization, 'Bearer user-fixture') },
    { path: '/app/installations/7', data: details },
    { path: '/user', data: identity },
    { path: '/app/installations/7/access_tokens', method: 'POST', response: tokenResponse({ metadata: 'read' }), check: init => assert.deepEqual(JSON.parse(init.body), { permissions: { metadata: 'read' } }) },
    { path: '/installation/repositories?per_page=2', data: actual }
  ];
}
const validate = env => validateInstallation(env, config, { installationId: 7, userToken: 'user-fixture', repository: 'person/project' });

test('manifest requests only contents/metadata read, no webhooks, and explicit separate OAuth setup', () => {
  const data = manifest({ origin: 'https://vibecheck.rodeo', owner: 'ashrocket' });
  assert.deepEqual(data.default_permissions, { contents: 'read', metadata: 'read' });
  assert.deepEqual(data.default_events, []);
  assert.equal(data.hook_attributes.active, false);
  assert.equal(data.public, true);
  assert.equal(data.request_oauth_on_install, false);
  assert.equal(data.setup_url, 'https://vibecheck.rodeo/api/connect/github/installed');
  assert.equal(data.redirect_url, 'https://vibecheck.rodeo/api/connect/github/manifest');
  assert.deepEqual(data.callback_urls, ['https://vibecheck.rodeo/api/connect/github/callback']);
  assert.throws(() => manifest({ origin: 'https://good.test@evil.test/path' }));
});

test('RS256 JWT verifies for both GitHub PKCS1 and PKCS8 keys with bounded time claims', async () => {
  for (const type of ['pkcs1', 'pkcs8']) {
    const jwt = await appJwt({ ...config, privateKey: keys.privateKey.export({ type, format: 'pem' }) }, 2_000_000_000_000);
    const [header, claims, signature] = jwt.split('.');
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' });
    assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url')), { iat: 1999999940, exp: 2000000540, iss: config.clientId });
    assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), keys.publicKey, Buffer.from(signature, 'base64url')), true);
  }
  await assert.rejects(appJwt({ ...config, privateKey: 'bad-secret' }), error => error.code === 'github_signing' && !error.message.includes('bad-secret'));
});

test('manifest conversion validates provider permissions and returns normalized private config', async () => {
  const env = mock([{ method: 'POST', path: '/app-manifests/code123/conversions', response: Response.json({ id: 42, client_id: config.clientId, client_secret: config.clientSecret, pem, slug: config.slug, owner: config.owner, permissions: installation.permissions }, { status: 201 }) }]);
  assert.deepEqual(await appFromManifest(env, 'code123'), config);
  assert.equal(env.calls[0].headers.Authorization, undefined);
  const bad = mock([{ method: 'POST', path: '/app-manifests/code123/conversions', response: Response.json({ permissions: { metadata: 'read', contents: 'write' } }, { status: 201 }) }]);
  await assert.rejects(appFromManifest(bad, 'code123'), { code: 'github_permissions' });
  const noOwner = mock([{ method: 'POST', path: '/app-manifests/code123/conversions', response: Response.json({ permissions: installation.permissions }, { status: 201 }) }]);
  await assert.rejects(appFromManifest(noOwner, 'code123'), { code: 'github_app_owner' });
});

test('OAuth uses PKCE and exchanges the code with a server-side secret at the fixed endpoint', async () => {
  const url = new URL(authorizationUrl(config, { origin: 'https://vibecheck.rodeo', state: 's'.repeat(64), challenge: 'c'.repeat(43) }));
  assert.equal(url.origin, 'https://github.com');
  assert.equal(url.pathname, '/login/oauth/authorize');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.has('client_secret'), false);
  const env = mock([{ method: 'POST', url: 'https://github.com/login/oauth/access_token', data: { access_token: 'user-fixture', token_type: 'bearer', expires_in: 28800 }, check: init => {
    assert.deepEqual(JSON.parse(init.body), { client_id: config.clientId, client_secret: config.clientSecret, code: 'code123', code_verifier: 'v'.repeat(64), redirect_uri: 'https://vibecheck.rodeo/api/connect/github/callback' });
  } }]);
  assert.deepEqual(await exchangeCode(env, config, { origin: 'https://vibecheck.rodeo', code: 'code123', verifier: 'v'.repeat(64) }), { accessToken: 'user-fixture', expiresIn: 28800 });
});

test('installation binding checks user visibility, our app, and actual unrestricted installation repository list', async () => {
  const env = mock(validationRoutes());
  assert.deepEqual(await validate(env), { installationId: 7, repository: 'person/project', account: { id: 10, login: 'person', type: 'User' } });
  assert.equal(env.calls.length, 5);
});

test('spoofed installation not accessible to user fails before minting an installation token', async () => {
  const env = mock([{ path: '/user/installations/7/repositories?per_page=100', response: Response.json({}, { status: 404 }) }]);
  await assert.rejects(validate(env), error => error.providerStatus === 404);
  assert.equal(env.calls.length, 1);
});

test('wrong repo, another app, all repositories and write permissions are rejected', async () => {
  const wrongRepo = mock(validationRoutes({ user: { total_count: 1, repositories: [{ full_name: 'person/other' }] } }));
  await assert.rejects(validate(wrongRepo), { code: 'github_repository_access' });
  const wrongApp = mock(validationRoutes({ details: { ...installation, app_id: 99 } }));
  await assert.rejects(validate(wrongApp), error => error.code === 'github_installation' && error.verifiedInstallationId === undefined);
  assert.equal(wrongApp.calls.length, 2);
  for (const details of [ { ...installation, repository_selection: 'all' }, { ...installation, permissions: { metadata: 'read', contents: 'write' } }, { ...installation, permissions: { metadata: 'read', contents: 'read', issues: 'write' } } ]) {
    const env = mock(validationRoutes({ details }));
    await assert.rejects(validate(env), error => error.verifiedInstallationId === 7);
    assert.equal(env.calls.length, 3);
  }
});

test('extra installed repository hidden from user still prevents acceptance', async () => {
  const env = mock(validationRoutes({ actual: { total_count: 2, repositories: [repo, { full_name: 'person/private-other' }] } }));
  await assert.rejects(validate(env), { code: 'github_installation_scope', verifiedInstallationId: 7 });
});

test('a collaborator cannot bind a personal account installation or cause cleanup', async () => {
  const env = mock(validationRoutes({ identity: { id: 11, login: 'collaborator' } }));
  await assert.rejects(validate(env), error => error.code === 'github_installation_owner' && error.verifiedInstallationId === undefined);
  assert.equal(env.calls.length, 3);
});

test('organization projects require repository-admin proof before cleanup is allowed', async () => {
  for (const admin of [false, true]) {
    const routes = validationRoutes({ details: { ...installation, account: { ...installation.account, type: 'Organization' } }, identity: { id: 99, login: 'member' } });
    routes.splice(3, 0, { path: '/repos/person/project', data: { ...repo, owner: { id: 10 }, permissions: { admin } }, check: init => assert.equal(init.headers.Authorization, 'Bearer user-fixture') });
    const env = mock(routes);
    if (admin) assert.equal((await validate(env)).account.type, 'Organization');
    else {
      await assert.rejects(validate(env), error => error.code === 'github_installation_owner' && error.verifiedInstallationId === undefined);
      assert.equal(env.calls.length, 4);
    }
  }
});

test('repository reads mint a repository-scoped read-only token and encode relative paths', async () => {
  const env = mock([
    { method: 'POST', path: '/app/installations/7/access_tokens', response: tokenResponse(installation.permissions), check: init => assert.deepEqual(JSON.parse(init.body), { permissions: installation.permissions, repositories: ['project'] }) },
    { path: '/repos/person/project/contents/src/a%20b.js', data: { type: 'file', encoding: 'base64', content: 'YQ==' } }
  ]);
  assert.equal((await readRepository(env, config, 7, 'person/project', 'src/a b.js')).content, 'YQ==');
  for (const path of ['../secret', '/absolute', 'a/../b', 'a//b', '%2e%2e/secret', 'a\\b', 'https://evil.test/file']) {
    await assert.rejects(readRepository({ FETCH: () => assert.fail('must reject before network') }, config, 7, 'person/project', path), { code: 'github_invalid_input' });
  }
});

test('network failures and oversized provider responses fail without leaking tokens or response bodies', async () => {
  const env = mock([{ path: '/user/installations/7/repositories?per_page=100', error: new Error('user-fixture secret provider error') }]);
  await assert.rejects(validate(env), error => error.code === 'github_network' && !error.message.includes('fixture'));
  const huge = mock([{ path: '/user/installations/7/repositories?per_page=100', response: new Response('x'.repeat(2 * 1024 * 1024 + 1)) }]);
  await assert.rejects(validate(huge), { code: 'github_response_size' });
});

test('validated ownership is preserved on later provider failure for safe caller cleanup', async () => {
  const routes = validationRoutes();
  routes[3] = { method: 'POST', path: '/app/installations/7/access_tokens', error: new Error('provider unavailable') };
  await assert.rejects(validate(mock(routes)), { code: 'github_network', verifiedInstallationId: 7 });
});

test('invalid identifiers and elevated token responses fail closed', async () => {
  const env = { FETCH: () => assert.fail('invalid input must not reach provider') };
  for (const installationId of ['7/../9', '01', -1, Number.MAX_SAFE_INTEGER + 1, null]) {
    await assert.rejects(deleteInstallation(env, config, installationId), { code: 'github_invalid_input' });
  }
  const elevated = mock([{ method: 'POST', path: '/app/installations/7/access_tokens', response: tokenResponse({ metadata: 'read', contents: 'write' }) }]);
  await assert.rejects(readRepository(elevated, config, 7, 'person/project'), { code: 'github_permissions' });
  assert.equal(elevated.calls.length, 1);
});

test('provider redirects are not followed with credentials', async () => {
  const env = mock([{ path: '/user/installations/7/repositories?per_page=100', response: new Response(null, { status: 302, headers: { Location: 'https://elsewhere.test' } }) }]);
  await assert.rejects(validate(env), error => error.providerStatus === 302);
  assert.equal(env.calls.length, 1);
});

test('uninstall uses app JWT DELETE and accepts confirmed 204', async () => {
  const env = mock([{ method: 'DELETE', path: '/app/installations/7', response: new Response(null, { status: 204 }), check: init => assert.equal(init.headers.Authorization.split('.').length, 3) }]);
  assert.deepEqual(await deleteInstallation(env, config, 7), { removed: true, alreadyAbsent: false });
  const failure = mock([{ method: 'DELETE', path: '/app/installations/7', response: Response.json({}, { status: 403 }) }]);
  await assert.rejects(deleteInstallation(failure, config, 7), error => error.providerStatus === 403);
});

test('uninstall 404 requires independently authenticated app identity', async () => {
  const env = mock([{ method: 'DELETE', path: '/app/installations/7', response: Response.json({}, { status: 404 }) }, { path: '/app', data: { id: 42 } }]);
  assert.deepEqual(await deleteInstallation(env, config, 7), { removed: true, alreadyAbsent: true });
  const wrong = mock([{ method: 'DELETE', path: '/app/installations/7', response: Response.json({}, { status: 404 }) }, { path: '/app', data: { id: 99 } }]);
  await assert.rejects(deleteInstallation(wrong, config, 7), { code: 'github_app_identity' });
});

test('asynchronous uninstall 202 stays pending until absence and app identity are confirmed', async () => {
  const pending = mock([
    { method: 'DELETE', path: '/app/installations/7', response: new Response(null, { status: 202 }) },
    { path: '/app/installations/7', data: installation }
  ]);
  await assert.rejects(deleteInstallation(pending, config, 7), { code: 'github_removal_pending' });
  const removed = mock([
    { method: 'DELETE', path: '/app/installations/7', response: new Response(null, { status: 202 }) },
    { path: '/app/installations/7', response: Response.json({}, { status: 404 }) },
    { path: '/app', data: { id: 42 } }
  ]);
  assert.deepEqual(await deleteInstallation(removed, config, 7), { removed: true, alreadyAbsent: false });
  const wrong = mock([
    { method: 'DELETE', path: '/app/installations/7', response: new Response(null, { status: 202 }) },
    { path: '/app/installations/7', response: Response.json({}, { status: 404 }) },
    { path: '/app', data: { id: 99 } }
  ]);
  await assert.rejects(deleteInstallation(wrong, config, 7), { code: 'github_app_identity' });
});

const inventoryRow = (id, created_at = '2026-09-01T12:00:00Z') => ({ id, app_id: 42, created_at });
test('inventory verifies app JWT identity and uses bounded fixed-origin numbered pages', async () => {
  const first = Array.from({ length: 100 }, (_, index) => inventoryRow(index + 1));
  const env = mock([
    { path: '/app', data: { id: 42 }, check: init => {
      const [header, claims, signature] = init.headers.Authorization.slice(7).split('.');
      assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), keys.publicKey, Buffer.from(signature, 'base64url')), true);
    } },
    { path: '/app/installations?per_page=100&page=1', response: Response.json(first, { headers: { Link: '<https://evil.test/steal>; rel="next"' } }) },
    { path: '/app/installations?per_page=100&page=2', data: [inventoryRow(101, '2026-09-01T08:00:00-04:00')] }
  ]);
  const result = await listInstallations(env, config);
  assert.equal(result.length, 101);
  assert.deepEqual(result[100], { installationId: 101, createdAt: Date.parse('2026-09-01T12:00:00Z') });
  assert.equal(env.calls.length, 3);
});

test('inventory fails closed on app mismatch, malformed dates, wrong-app IDs and duplicate pages', async () => {
  const wrongApp = mock([{ path: '/app', data: { id: 99 } }]);
  await assert.rejects(listInstallations(wrongApp, config), { code: 'github_app_identity' });
  assert.equal(wrongApp.calls.length, 1);
  for (const created of ['2026-02-31T12:00:00Z', '2026-09-01', 'yesterday', '2026-09-01T25:00:00Z', '2026-09-01T12:00:00+04:60', null]) {
    const env = mock([{ path: '/app', data: { id: 42 } }, { path: '/app/installations?per_page=100&page=1', data: [inventoryRow(1, created)] }]);
    await assert.rejects(listInstallations(env, config), { code: 'github_inventory' });
  }
  for (const rows of [[{ ...inventoryRow(1), app_id: 99 }], [inventoryRow(1), inventoryRow(1)], {}]) {
    const env = mock([{ path: '/app', data: { id: 42 } }, { path: '/app/installations?per_page=100&page=1', data: rows }]);
    await assert.rejects(listInstallations(env, config), { code: 'github_inventory' });
  }
  const rows = Array.from({ length: 100 }, (_, index) => inventoryRow(index + 1));
  const repeated = mock([{ path: '/app', data: { id: 42 } }, { path: '/app/installations?per_page=100&page=1', data: rows }, { path: '/app/installations?per_page=100&page=2', data: rows }]);
  await assert.rejects(listInstallations(repeated, config), { code: 'github_inventory' });
});

test('inventory never returns partial results after pagination limit or network failure', async () => {
  const routes = [{ path: '/app', data: { id: 42 } }];
  for (let page = 1; page <= 10; page++) routes.push({ path: `/app/installations?per_page=100&page=${page}`, data: Array.from({ length: 100 }, (_, index) => inventoryRow((page - 1) * 100 + index + 1)) });
  const env = mock(routes);
  await assert.rejects(listInstallations(env, config), { code: 'github_inventory_limit' });
  assert.equal(env.calls.length, 11);
  const failure = mock([{ path: '/app', data: { id: 42 } }, { path: '/app/installations?per_page=100&page=1', error: new Error('private-provider-data') }]);
  await assert.rejects(listInstallations(failure, config), error => error.code === 'github_network' && !error.message.includes('private-provider-data'));
});
