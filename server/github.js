// GitHub App access only. Tokens and provider response bodies must never be logged.
// API contracts: https://docs.github.com/en/rest/apps/apps
// https://docs.github.com/en/rest/apps/installations
const API = 'https://api.github.com';
const MAX_RESPONSE = 2 * 1024 * 1024;
const encoder = new TextEncoder();
const READ_PERMISSIONS = Object.freeze({ contents: 'read', metadata: 'read' });

export class GitHubError extends Error {
  constructor(code, message, status = 502, providerStatus) {
    super(message);
    this.name = 'GitHubError';
    this.code = code;
    this.status = status;
    if (providerStatus !== undefined) this.providerStatus = providerStatus;
  }
}

function invalid(message) { throw new GitHubError('github_invalid_input', message, 400); }
function id(value) {
  if (!/^[1-9]\d{0,15}$/.test(String(value)) || !Number.isSafeInteger(Number(value))) invalid('Invalid GitHub identifier.');
  return Number(value);
}
function text(value, label, max = 8192) {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\x00-\x20\x7f]/u.test(value)) invalid(`Invalid ${label}.`);
  return value;
}
function originUrl(origin) {
  let url;
  try { url = new URL(origin); } catch { invalid('Invalid site origin.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) invalid('A plain HTTPS site origin is required.');
  return url.origin;
}
function repoName(repository) {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/u.test(repository)) invalid('Use a GitHub owner/repository name.');
  const [owner, name] = repository.split('/');
  if (name === '.' || name === '..') invalid('Invalid repository name.');
  return { owner, name, full: `${owner}/${name}` };
}
function permissions(value, requireContents = true) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.metadata !== 'read' || (requireContents && value.contents !== 'read') || Object.entries(value).some(([key, access]) => !['contents', 'metadata'].includes(key) || access !== 'read')) {
    throw new GitHubError('github_permissions', 'The GitHub App must have only read-only contents and metadata access.', 409);
  }
}
function b64url(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/gu, '').replace(/\+/gu, '-').replace(/\//gu, '_');
}
function der(tag, bytes) {
  const length = bytes.length;
  const size = [];
  let n = length;
  while (n) { size.unshift(n & 255); n = Math.floor(n / 256); }
  return new Uint8Array([tag, ...(length < 128 ? [length] : [128 + size.length, ...size]), ...bytes]);
}
function pkcs8(pem) {
  if (typeof pem !== 'string' || pem.length > 16384) invalid('Invalid GitHub App signing key.');
  const match = pem.trim().match(/^-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----\s+([A-Za-z0-9+/=\s]+)\s+-----END \1-----$/u);
  if (!match) invalid('Invalid GitHub App signing key.');
  let bytes;
  try { bytes = Uint8Array.from(atob(match[2].replace(/\s/gu, '')), c => c.charCodeAt(0)); }
  catch { invalid('Invalid GitHub App signing key.'); }
  if (match[1] === 'PRIVATE KEY') return bytes;
  // Wrap PKCS#1 RSAPrivateKey in PKCS#8 PrivateKeyInfo (rsaEncryption OID).
  const version = [2, 1, 0];
  const algorithm = [48, 13, 6, 9, 42, 134, 72, 134, 247, 13, 1, 1, 1, 5, 0];
  return der(48, new Uint8Array([...version, ...algorithm, ...der(4, bytes)]));
}

// RS256, with clock-skew allowance and expiration within GitHub's 10-minute limit.
export async function appJwt(config, now = Date.now()) {
  const issuer = config.clientId ? text(config.clientId, 'GitHub client ID', 200) : String(id(config.appId));
  if (!Number.isFinite(now)) invalid('Invalid signing time.');
  const seconds = Math.floor(now / 1000);
  const header = b64url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = b64url(encoder.encode(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: issuer })));
  try {
    const key = await crypto.subtle.importKey('pkcs8', pkcs8(config.privateKey), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(`${header}.${payload}`));
    return `${header}.${payload}.${b64url(signature)}`;
  } catch {
    throw new GitHubError('github_signing', 'GitHub App signing is not configured correctly.', 503);
  }
}

async function jsonBody(response) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE) {
    await response.body?.cancel();
    throw new GitHubError('github_response_size', 'GitHub returned too much data.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new GitHubError('github_response', 'GitHub returned an empty response.');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE) {
        await reader.cancel();
        throw new GitHubError('github_response_size', 'GitHub returned too much data.');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof GitHubError) throw error;
    throw new GitHubError('github_response', 'GitHub returned an unreadable response.');
  } finally { reader.releaseLock(); }
}

async function request(env, path, { token, method = 'GET', body, oauth = false, expected = 200 } = {}) {
  const url = oauth ? 'https://github.com/login/oauth/access_token' : `${API}${path}`;
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'vibecheck-project-access', 'X-GitHub-Api-Version': '2026-03-10' };
  if (token) headers.Authorization = `Bearer ${text(token, 'GitHub token')}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (oauth) headers.Accept = 'application/json';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await (env.FETCH || fetch)(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: controller.signal });
    if (response.status !== expected) {
      await response.body?.cancel();
      throw new GitHubError('github_http', 'GitHub could not complete the request.', 502, response.status);
    }
    return expected === 204 ? null : await jsonBody(response);
  } catch (error) {
    if (error instanceof GitHubError) throw error;
    throw new GitHubError('github_network', 'GitHub is unavailable. Try again.');
  } finally { clearTimeout(timer); }
}

export function manifest({ origin, owner, name = 'Vibecheck project access' }) {
  const base = originUrl(origin);
  if (owner !== undefined && !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u.test(owner)) invalid('Invalid GitHub App owner.');
  if (typeof name !== 'string' || !name.trim() || name.length > 34 || /[\x00-\x1f\x7f]/u.test(name)) invalid('Invalid GitHub App name.');
  // The owner selects the GitHub registration endpoint; it is not a manifest field.
  return {
    name: name.trim(), url: base, public: true,
    description: 'Read the project you share for your Vibecheck review.',
    redirect_url: `${base}/api/connect/github/manifest`,
    callback_urls: [`${base}/api/connect/github/callback`],
    setup_url: `${base}/api/connect/github/installed`,
    setup_on_update: true, request_oauth_on_install: false,
    hook_attributes: { url: `${base}/api/connect/github/webhook`, active: false },
    default_events: [], default_permissions: { ...READ_PERMISSIONS }
  };
}

export async function appFromManifest(env, code) {
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/u.test(code)) invalid('Invalid GitHub manifest code.');
  const app = await request(env, `/app-manifests/${encodeURIComponent(code)}/conversions`, { method: 'POST', expected: 201 });
  permissions(app.permissions);
  if (!app.owner || typeof app.owner.login !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u.test(app.owner.login) || !['User', 'Organization'].includes(app.owner.type)) {
    throw new GitHubError('github_app_owner', 'GitHub App ownership could not be verified.', 409);
  }
  const config = {
    appId: id(app.id), clientId: text(app.client_id, 'GitHub client ID', 200),
    clientSecret: text(app.client_secret, 'GitHub client secret', 512),
    privateKey: app.pem, slug: text(app.slug, 'GitHub App slug', 100),
    owner: { id: id(app.owner.id), login: app.owner.login, type: app.owner.type },
    permissions: { ...app.permissions }
  };
  // Reject malformed keys before callers persist a broken connection configuration.
  await appJwt(config);
  return config;
}

export function authorizationUrl(config, { origin, state, challenge }) {
  const base = originUrl(origin);
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(state || '')) invalid('Invalid OAuth state.');
  if (!/^[A-Za-z0-9_-]{43}$/u.test(challenge || '')) invalid('Invalid PKCE challenge.');
  const url = new URL('https://github.com/login/oauth/authorize');
  url.search = new URLSearchParams({ client_id: text(config.clientId, 'GitHub client ID', 200), redirect_uri: `${base}/api/connect/github/callback`, state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
  return url.href;
}

export async function exchangeCode(env, config, { origin, code, verifier }) {
  const base = originUrl(origin);
  if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier || '')) invalid('Invalid PKCE verifier.');
  const result = await request(env, '', { oauth: true, method: 'POST', body: {
    client_id: text(config.clientId, 'GitHub client ID', 200),
    client_secret: text(config.clientSecret, 'GitHub client secret', 512),
    code: text(code, 'GitHub authorization code', 512), code_verifier: verifier,
    redirect_uri: `${base}/api/connect/github/callback`
  } });
  if (result.error || String(result.token_type).toLowerCase() !== 'bearer') throw new GitHubError('github_oauth', 'GitHub authorization failed. Start the connection again.', 401);
  return { accessToken: text(result.access_token, 'GitHub user token'), expiresIn: Number.isFinite(result.expires_in) ? result.expires_in : null };
}

async function installationToken(env, config, installationId, repository) {
  const body = { permissions: repository ? { ...READ_PERMISSIONS } : { metadata: 'read' } };
  if (repository) body.repositories = [repoName(repository).name];
  const result = await request(env, `/app/installations/${id(installationId)}/access_tokens`, { token: await appJwt(config), method: 'POST', body, expected: 201 });
  permissions(result.permissions, Boolean(repository));
  return text(result.token, 'GitHub installation token');
}

function exactlyOne(data, repository) {
  return data && data.total_count === 1 && Array.isArray(data.repositories) && data.repositories.length === 1 && typeof data.repositories[0].full_name === 'string' && data.repositories[0].full_name.toLowerCase() === repository.toLowerCase();
}

export async function validateInstallation(env, config, { installationId, userToken, repository }) {
  const installation = id(installationId);
  const expected = repoName(repository);
  const appId = id(config.appId);
  const accessible = await request(env, `/user/installations/${installation}/repositories?per_page=100`, { token: text(userToken, 'GitHub user token') });
  if (!Array.isArray(accessible?.repositories) || !accessible.repositories.some(repo => typeof repo.full_name === 'string' && repo.full_name.toLowerCase() === expected.full.toLowerCase())) throw new GitHubError('github_repository_access', 'The selected project is not accessible through this GitHub installation.', 409);
  const details = await request(env, `/app/installations/${installation}`, { token: await appJwt(config) });
  if (id(details.id) !== installation || id(details.app_id) !== appId || !details.account || typeof details.account.login !== 'string' || details.account.login.toLowerCase() !== expected.owner.toLowerCase() || !['User', 'Organization'].includes(details.account.type)) {
    throw new GitHubError('github_installation', 'This installation does not match the selected project and app.', 409);
  }
  const user = await request(env, '/user', { token: userToken });
  id(user.id);
  const accountId = id(details.account.id);
  if (details.account.type === 'User') {
    if (id(user.id) !== accountId) throw new GitHubError('github_installation_owner', 'Only the owner can connect a personal GitHub installation.', 403);
  } else {
    const authorizedRepo = await request(env, `/repos/${encodeURIComponent(expected.owner)}/${encodeURIComponent(expected.name)}`, { token: userToken });
    if (authorizedRepo?.permissions?.admin !== true || typeof authorizedRepo.full_name !== 'string' || authorizedRepo.full_name.toLowerCase() !== expected.full.toLowerCase() || id(authorizedRepo.owner?.id) !== accountId) {
      throw new GitHubError('github_installation_owner', 'Repository admin access is required to connect an organization project.', 403);
    }
  }
  // Only now may the caller consider cleanup on failure. It must still reject
  // installations already associated with another request before uninstalling.
  try {
    if (details.repository_selection !== 'selected' || details.suspended_at) throw new GitHubError('github_installation_scope', 'Select only this project in an active GitHub installation.', 409);
    permissions(details.permissions);
    // Do not restrict repository names here: that would hide extra installed repos.
    const token = await installationToken(env, config, installation);
    const actual = await request(env, '/installation/repositories?per_page=2', { token });
    if (!exactlyOne(actual, expected.full)) throw new GitHubError('github_installation_scope', 'The GitHub installation must contain exactly one project repository.', 409);
    return { installationId: installation, repository: actual.repositories[0].full_name, account: { id: accountId, login: details.account.login, type: details.account.type } };
  } catch (error) {
    if (error instanceof GitHubError) error.verifiedInstallationId = installation;
    throw error;
  }
}

export async function readRepository(env, config, installationId, repository, path = '') {
  const repo = repoName(repository);
  id(installationId);
  if (typeof path !== 'string' || path.length > 4096 || /[\\%\x00-\x1f\x7f]/u.test(path) || (path && path.split('/').some(segment => !segment || segment === '.' || segment === '..'))) invalid('Use a relative repository path without traversal.');
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const token = await installationToken(env, config, installationId, repo.full);
  return request(env, `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/contents${encodedPath ? `/${encodedPath}` : ''}`, { token });
}

function installationTime(value) {
  // Date.parse alone accepts impossible dates such as February 31. Require a
  // complete timestamp and verify the calendar before applying its UTC offset.
  const match = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/u);
  if (!match) throw new GitHubError('github_inventory', 'GitHub installation inventory is invalid.');
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const milliseconds = Number((match[7] || '').padEnd(3, '0'));
  const utc = Date.UTC(year, month - 1, day, hour, minute, second, milliseconds);
  const date = new Date(utc);
  if (year < 2008 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) throw new GitHubError('github_inventory', 'GitHub installation inventory is invalid.');
  let offset = 0;
  if (match[8] !== 'Z') {
    const offsetHours = Number(match[8].slice(1, 3)), offsetMinutes = Number(match[8].slice(4, 6));
    if (offsetHours > 23 || offsetMinutes > 59) throw new GitHubError('github_inventory', 'GitHub installation inventory is invalid.');
    offset = (offsetHours * 60 + offsetMinutes) * 60000 * (match[8][0] === '+' ? 1 : -1);
  }
  return utc - offset;
}

async function verifyApp(env, config, token) {
  const app = await request(env, '/app', { token });
  if (id(app?.id) !== id(config.appId)) throw new GitHubError('github_app_identity', 'GitHub App identity could not be verified.', 409);
}

// A complete authenticated inventory, never callback-supplied installation IDs.
// Numbered pages stay on our fixed API origin; untrusted Link URLs are ignored.
export async function listInstallations(env, config) {
  const appId = id(config.appId), token = await appJwt(config);
  await verifyApp(env, config, token);
  const installations = [], seen = new Set();
  for (let page = 1; page <= 10; page++) {
    const rows = await request(env, `/app/installations?per_page=100&page=${page}`, { token });
    if (!Array.isArray(rows) || rows.length > 100) throw new GitHubError('github_inventory', 'GitHub installation inventory is invalid.');
    for (const row of rows) {
      const installationId = id(row?.id);
      if (id(row?.app_id) !== appId || seen.has(installationId)) throw new GitHubError('github_inventory', 'GitHub installation inventory is inconsistent.');
      seen.add(installationId);
      installations.push({ installationId, createdAt: installationTime(row.created_at) });
    }
    if (rows.length < 100) return installations;
  }
  // Never return a truncated inventory to a caller making removal decisions.
  throw new GitHubError('github_inventory_limit', 'GitHub installation inventory exceeded the cleanup limit.', 503);
}

// Caller must supply a verified connection or an atomically claimed orphan from
// authenticated app inventory. A 202 is accepted work, not proof of removal.
export async function deleteInstallation(env, config, installationId) {
  const installation = id(installationId);
  const token = await appJwt(config);
  try {
    await request(env, `/app/installations/${installation}`, { method: 'DELETE', token, expected: 204 });
    return { removed: true, alreadyAbsent: false };
  } catch (error) {
    if (!(error instanceof GitHubError) || ![202, 404].includes(error.providerStatus)) throw error;
    if (error.providerStatus === 202) {
      try {
        await request(env, `/app/installations/${installation}`, { token });
        throw new GitHubError('github_removal_pending', 'GitHub is still removing this installation.', 503);
      } catch (verification) {
        if (!(verification instanceof GitHubError) || verification.providerStatus !== 404) throw verification;
      }
    }
    // Distinguish an absent installation from a bad signing key/app identity.
    await verifyApp(env, config, token);
    return { removed: true, alreadyAbsent: error.providerStatus === 404 };
  }
}
