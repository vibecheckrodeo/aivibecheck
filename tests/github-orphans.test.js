import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { generateKeyPairSync, verify } from 'node:crypto';
import { cleanupGitHubOrphans } from '../server/github-orphans.js';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const config = { appId: 42, clientId: 'Iv1.orphans-fixture', privateKey: keys.privateKey.export({ type: 'pkcs1', format: 'pem' }) };
const now = Date.parse('2026-09-18T12:00:00Z');
const day = 86400000;
const item = (id, createdAt = now - 8 * day) => ({ id, app_id: 42, created_at: new Date(createdAt).toISOString() });

function fixture(t, inventory = []) {
  const sql = new DatabaseSync(':memory:');
  t.after(() => sql.close());
  for (const file of readdirSync('migrations').filter(name => name.endsWith('.sql')).sort()) sql.exec(readFileSync(`migrations/${file}`, 'utf8'));
  const f = { sql, inventory, calls: [], before: () => {}, remove: () => new Response(null, { status: 204 }) };
  const statement = (query, values = []) => ({
    bind(...args) { return statement(query, args); },
    async first() { await f.before(query, 'first', values); return sql.prepare(query).get(...values) || null; },
    async all() { await f.before(query, 'all', values); return { results: sql.prepare(query).all(...values) }; },
    async run() { await f.before(query, 'run', values); return { meta: { changes: Number(sql.prepare(query).run(...values).changes) } }; }
  });
  f.env = { DB: { prepare: statement }, FETCH: async (raw, init) => {
    const url = new URL(raw);
    f.calls.push({ url, method: init.method });
    assert.equal(url.origin, 'https://api.github.com');
    const [header, claims, signature] = init.headers.Authorization.slice(7).split('.');
    assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), keys.publicKey, Buffer.from(signature, 'base64url')), true);
    if (init.method === 'DELETE') return f.remove(Number(url.pathname.split('/').at(-1)));
    if (url.pathname === '/app') return Response.json({ id: 42 });
    if (url.pathname === '/app/installations') {
      const page = Number(url.searchParams.get('page'));
      assert.equal(url.searchParams.get('per_page'), '100');
      return Response.json(f.inventory.slice((page - 1) * 100, page * 100));
    }
    assert.fail(`Unexpected GitHub request ${url.pathname}`);
  } };
  f.connect = (id, state = 'active') => {
    sql.prepare('INSERT INTO requests(id,token_hash,name,email,created_at,updated_at,ip_hash) VALUES(?,?,?,?,?,?,?)').run(`request-${id}`, 'fixture', 'Test', 'test@example.com', now, now, 'fixture');
    sql.prepare('INSERT INTO connections(id,request_id,provider,external_id,resource,state,created_at) VALUES(?,?,?,?,?,?,?)').run(`connection-${id}`, `request-${id}`, 'github', String(id), '{}', state, now);
  };
  f.claim = id => sql.prepare('SELECT * FROM github_installation_cleanup WHERE installation_id=?').get(String(id));
  f.deleted = () => f.calls.filter(call => call.method === 'DELETE').map(call => Number(call.url.pathname.split('/').at(-1)));
  f.run = (options = {}) => cleanupGitHubOrphans(f.env, config, { now, ...options });
  return f;
}

test('only verified installations strictly older than seven days and without a live binding are removed', async t => {
  const f = fixture(t, [item(1), item(2), item(3), item(4, now - 7 * day), item(5, now - 1), item(6, now + day), item(7)]);
  f.connect(2); f.connect(3, 'cleanup_due'); f.connect(7, 'removed');
  const result = await f.run();
  assert.deepEqual(f.deleted(), [1, 7]);
  assert.equal(result.scanned, 7); assert.equal(result.eligible, 4);
  assert.equal(result.skippedBound, 2); assert.equal(result.skippedRecent, 3);
  assert.equal(result.claimed, 2); assert.equal(result.removed, 2); assert.equal(result.pending, 0);
  assert.equal(f.claim(1).removed_at, now); assert.equal(f.claim(2), undefined);
  // A permanent success tombstone prevents another uninstall even if a stale
  // provider inventory response temporarily includes the installation again.
  assert.equal((await f.run()).skippedRemoved, 2);
  assert.deepEqual(f.deleted(), [1, 7]);
});

test('a live connection winning immediately before the claim prevents removal', async t => {
  const f = fixture(t, [item(7)]);
  f.before = query => {
    if (query.startsWith('INSERT INTO github_installation_cleanup')) { f.before = () => {}; f.connect(7); }
  };
  const result = await f.run();
  assert.equal(result.skippedBound, 1); assert.equal(f.claim(7), undefined);
  assert.deepEqual(f.deleted(), []);
});

test('the final binding recheck protects an existing pending claim', async t => {
  const f = fixture(t, [item(7)]);
  f.before = query => {
    if (query.startsWith('SELECT removed_at FROM github_installation_cleanup')) { f.before = () => {}; f.connect(7, 'cleanup_due'); }
  };
  const result = await f.run();
  assert.equal(result.skippedBound, 1); assert.equal(f.claim(7).removed_at, null);
  assert.deepEqual(f.deleted(), []);
});

test('a cleanup claim winning first blocks the reciprocal atomic connection insert', async t => {
  const f = fixture(t, [item(7)]);
  f.sql.prepare('INSERT INTO requests(id,token_hash,name,email,created_at,updated_at,ip_hash) VALUES(?,?,?,?,?,?,?)').run('racing-request', 'fixture', 'Test', 'test@example.com', now, now, 'fixture');
  f.remove = id => {
    assert.equal(id, 7);
    const result = f.sql.prepare("INSERT INTO connections(id,request_id,provider,external_id,resource,created_at) SELECT 'race','racing-request','github','7','{}',? WHERE NOT EXISTS (SELECT 1 FROM github_installation_cleanup WHERE installation_id='7')").run(now);
    assert.equal(result.changes, 0);
    return new Response(null, { status: 204 });
  };
  assert.equal((await f.run()).removed, 1);
  assert.equal(f.sql.prepare('SELECT count(*) AS count FROM connections').get().count, 0);
});

test('failed cleanup is retried from its verified claim even when the installation disappears from inventory', async t => {
  const f = fixture(t, [item(7)]);
  f.remove = () => { throw new Error('private-fixture-secret'); };
  const failed = await f.run();
  assert.equal(failed.failed, 1); assert.equal(failed.pending, 1); assert.equal(f.claim(7).removed_at, null);
  assert.ok(!f.claim(7).last_error.includes('secret'));
  f.inventory = [];
  f.remove = () => Response.json({}, { status: 404 });
  const retried = await f.run({ now: now + 1 });
  assert.equal(retried.removed, 1); assert.equal(retried.pending, 0);
  assert.equal(f.claim(7).removed_at, now + 1); assert.equal(f.claim(7).last_error, null);
  assert.equal(f.calls.at(-1).url.pathname, '/app');
});

test('bound and removed inventory entries never consume the removal budget', async t => {
  const f = fixture(t, Array.from({ length: 121 }, (_, index) => item(index + 1)));
  for (let id = 1; id <= 60; id++) f.connect(id, id % 2 ? 'active' : 'cleanup_due');
  for (let id = 61; id <= 120; id++) f.sql.prepare('INSERT INTO github_installation_cleanup(installation_id,requested_at,removed_at) VALUES(?,?,?)').run(String(id), now - day, now - day);
  const result = await f.run({ limit: 1 });
  assert.deepEqual(f.deleted(), [121]);
  assert.equal(result.skippedBound, 60); assert.equal(result.skippedRemoved, 60);
  assert.equal(result.removed, 1); assert.equal(result.limited, false);
});

test('repeated provider failures rotate behind old installations rather than starving them', async t => {
  const f = fixture(t, [item(7), item(8), item(9)]);
  f.remove = id => id === 7 ? Response.json({}, { status: 503 }) : new Response(null, { status: 204 });
  assert.equal((await f.run({ limit: 1 })).failed, 1);
  assert.equal((await f.run({ now: now + 1, limit: 1 })).removed, 1);
  assert.equal((await f.run({ now: now + 2, limit: 1 })).removed, 1);
  assert.deepEqual(f.deleted(), [7, 8, 9]);
  assert.equal((await f.run({ now: now + 3, limit: 1 })).failed, 1);
  assert.equal(f.claim(7).requested_at, now + 3);
});

test('more than 100 pending orphan claims cannot hide a later removable installation', async t => {
  const f = fixture(t, []);
  const insert = f.sql.prepare('INSERT INTO github_installation_cleanup(installation_id,requested_at) VALUES(?,1)');
  for (let id = 1; id <= 101; id++) insert.run(String(id));
  f.remove = id => id === 101 ? new Response(null, { status: 204 }) : Response.json({}, { status: 503 });
  const result = await f.run({ now: 900000, limit: 100 });
  assert.equal(result.removed, 1);
  assert.equal(f.claim(101).removed_at, 900000);
  assert.equal(f.claim(100).removed_at, null);
});

test('malformed inventory fails before any deletion or claim and also blocks pending retries', async t => {
  const f = fixture(t, [item(7), { ...item(8), created_at: '2026-02-31T00:00:00Z' }]);
  f.sql.prepare('INSERT INTO github_installation_cleanup(installation_id,requested_at) VALUES(?,?)').run('9', now - day);
  await assert.rejects(f.run(), { code: 'github_inventory' });
  assert.deepEqual(f.deleted(), []);
  assert.equal(f.sql.prepare('SELECT count(*) AS count FROM github_installation_cleanup').get().count, 1);
  assert.equal(f.claim(9).requested_at, now - day);
});

test('an inventory creation time inside the grace period cannot be overridden by an old pending claim', async t => {
  const f = fixture(t, [item(7, now - day)]);
  f.sql.prepare('INSERT INTO github_installation_cleanup(installation_id,requested_at) VALUES(?,?)').run('7', now - 10 * day);
  assert.equal((await f.run()).removed, 0);
  assert.deepEqual(f.deleted(), []); assert.equal(f.claim(7).removed_at, null);
});

test('invalid sweep bounds fail before contacting GitHub', async t => {
  const f = fixture(t, []);
  for (const options of [{ now: NaN }, { now: -1 }, { limit: 0 }, { limit: 101 }, { limit: 1.5 }]) await assert.rejects(f.run(options), TypeError);
  assert.equal(f.calls.length, 0);
});
