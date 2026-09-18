import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizationUrl, exchangeCode, refreshToken, readFile } from '../server/figma.js';

const callback = 'https://vibecheck.example/api/integrations/figma/callback';
const state = 'a'.repeat(64);
const verifier = 'v'.repeat(64);
const challenge = 'c'.repeat(43);
const initial = {
  access_token: 'fixture-access', refresh_token: 'fixture-refresh', token_type: 'bearer',
  expires_in: 7776000, user_id_string: '99999999999999999999', user_id: 1
};
const setup = FETCH => ({ FIGMA_CLIENT_ID: 'fixture-client', FIGMA_CLIENT_SECRET: 'fixture-secret', FETCH });

test('Figma authorization uses only read scope and requires PKCE plus a substantial state', () => {
  const url = new URL(authorizationUrl(setup(), { redirectUri: callback, state, challenge }));
  assert.equal(url.origin + url.pathname, 'https://www.figma.com/oauth');
  assert.equal(url.searchParams.get('scope'), 'file_content:read');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), challenge);
  assert.equal(url.searchParams.get('state'), state);
  assert.equal(url.searchParams.get('redirect_uri'), callback);
  assert.equal(url.searchParams.has('client_secret'), false);
  for (const invalid of [{ state: 'short' }, { challenge: '' }, { redirectUri: ['https://', 'user:password', '@example.com/callback'].join('') }, { redirectUri: 'http://example.com/callback' }, { redirectUri: `${callback}#fragment` }]) {
    assert.throws(() => authorizationUrl(setup(), { redirectUri: callback, state, challenge, ...invalid }), { status: 400 });
  }
});

test('unconfigured Figma fails before any provider call', async () => {
  let calls = 0;
  const env = { FETCH: async () => { calls++; throw new Error('must not call'); } };
  assert.throws(() => authorizationUrl(env, { redirectUri: callback, state, challenge }), { status: 503 });
  await assert.rejects(exchangeCode(env, { code: 'code', redirectUri: callback, verifier }), { status: 503 });
  await assert.rejects(refreshToken(env, 'refresh'), { status: 503 });
  await assert.rejects(readFile(env, 'access', 'Ab123'), { status: 503 });
  assert.equal(calls, 0);
});

test('Figma code exchange uses Basic credentials, form encoding, and the PKCE verifier', async () => {
  let calls = 0;
  const env = setup(async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.figma.com/v1/oauth/token');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers.Authorization, `Basic ${btoa('fixture-client:fixture-secret')}`);
    assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
    const body = new URLSearchParams(options.body);
    assert.equal(body.get('code'), 'code+with/symbols=');
    assert.equal(body.get('redirect_uri'), callback);
    assert.equal(body.get('code_verifier'), verifier);
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.has('client_secret'), false);
    return Response.json(initial);
  });
  const result = await exchangeCode(env, { code: 'code+with/symbols=', redirectUri: callback, verifier });
  assert.equal(result.user_id_string, initial.user_id_string);
  assert.equal(result.user_id, undefined);
  assert.equal(result.access_token, initial.access_token);
  assert.equal(calls, 1);
});

test('Figma refresh uses the current token endpoint and saves rotated credentials when returned', async () => {
  let rotated = false;
  const env = setup(async (url, options) => {
    assert.equal(url, 'https://api.figma.com/v1/oauth/token');
    assert.equal(options.headers.Authorization, `Basic ${btoa('fixture-client:fixture-secret')}`);
    const body = new URLSearchParams(options.body);
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('refresh_token'), 'old-refresh');
    return Response.json({ access_token: 'new-access', token_type: 'Bearer', expires_in: 3600, ...(rotated ? { refresh_token: 'new-refresh' } : {}) });
  });
  assert.equal((await refreshToken(env, 'old-refresh')).refresh_token, 'old-refresh');
  rotated = true;
  const result = await refreshToken(env, 'old-refresh');
  assert.equal(result.refresh_token, 'new-refresh');
  assert.equal(result.access_token, 'new-access');
});

test('Figma failures never include upstream credentials, responses, or fetch errors', async () => {
  const sensitive = 'must-never-be-in-an-error';
  for (const FETCH of [
    async () => Response.json({ error: sensitive }, { status: 400 }),
    async () => { throw new Error(sensitive); },
    async () => new Response(`<html>${sensitive}</html>`),
    async () => Response.json({ ...initial, expires_in: -1 }),
    async () => Response.json({ ...initial, user_id_string: undefined }),
    async () => Response.json({ ...initial, refresh_token: '' }),
    async () => Response.json({ ...initial, token_type: 'not-bearer' })
  ]) {
    await assert.rejects(exchangeCode(setup(FETCH), { code: 'code', redirectUri: callback, verifier }), error => {
      assert.equal(error.status, 502);
      assert.equal(error.message.includes(sensitive), false);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test('Figma file reads use a fixed read-only endpoint and reject arbitrary URLs or path injection', async () => {
  let calls = 0;
  const file = { name: 'Example design', document: { type: 'DOCUMENT', children: [] } };
  const env = setup(async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.figma.com/v1/files/Ab123XYZ?depth=2');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer fixture-access');
    return Response.json(file);
  });
  assert.deepEqual(await readFile(env, 'fixture-access', 'Ab123XYZ'), file);
  for (const key of ['https://evil.example/secret', '../me', 'file?depth=100', 'abc/def', '', 'x'.repeat(129)]) {
    await assert.rejects(readFile(env, 'fixture-access', key), { status: 400 });
  }
  assert.equal(calls, 1);
});

test('Figma file responses are bounded even without an honest Content-Length', async () => {
  let cancelled = false;
  const hugeStream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(5 * 1024 * 1024 + 1)); },
    cancel() { cancelled = true; }
  });
  const env = setup(async () => new Response(hugeStream, { headers: { 'Content-Length': '1' } }));
  await assert.rejects(readFile(env, 'fixture-access', 'Ab123'), /too large/);
  assert.equal(cancelled, true);
  await assert.rejects(readFile(setup(async () => Response.json({ document: { type: 'DOCUMENT' } }, { headers: { 'Content-Length': String(6 * 1024 * 1024) } })), 'fixture-access', 'Ab123'), /too large/);
});

test('Figma file permission and rate errors remain actionable without leaking provider bodies', async () => {
  for (const [providerStatus, status] of [[401, 403], [403, 403], [404, 404], [429, 429], [500, 502]]) {
    const env = setup(async () => Response.json({ private: 'not returned' }, { status: providerStatus }));
    await assert.rejects(readFile(env, 'fixture-access', 'Ab123'), error => {
      assert.equal(error.status, status);
      assert.equal(error.providerStatus, providerStatus);
      assert.equal(error.message.includes('not returned'), false);
      return true;
    });
  }
});
