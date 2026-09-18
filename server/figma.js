// Figma OAuth transport only. The caller owns state/PKCE storage, request
// authorization, encryption at rest, and removing credentials at the deadline.
// Public apps need Figma approval before customers can authorize them.
// https://developers.figma.com/docs/rest-api/oauth-apps/
// https://developers.figma.com/docs/rest-api/changelog/#may-16-2025
const TOKEN_URL = 'https://api.figma.com/v1/oauth/token';
const SCOPE = 'file_content:read';
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOKEN_BYTES = 64 * 1024;

const fail = (status, message, providerStatus) => {
  throw Object.assign(new Error(message), { status, ...(providerStatus ? { providerStatus } : {}) });
};

function opaque(value, label, max = 8192) {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\x00-\x20\x7f]/.test(value)) {
    fail(400, `Check the Figma ${label}.`);
  }
  return value;
}

function config(env) {
  const id = env?.FIGMA_CLIENT_ID;
  const secret = env?.FIGMA_CLIENT_SECRET;
  if (typeof id !== 'string' || !id.length || id.length > 1024 || /[:\s\x00-\x1f\x7f]/.test(id) ||
      typeof secret !== 'string' || !secret.length || secret.length > 8192 || /[\x00-\x20\x7f]/.test(secret)) {
    fail(503, 'Figma is not connected yet.');
  }
  return { id, secret };
}

function callback(value) {
  let url;
  try { url = new URL(value); } catch { fail(400, 'Check the Figma callback URL.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (typeof value !== 'string' || value.length > 2048 || url.username || url.password || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) {
    fail(400, 'Check the Figma callback URL.');
  }
  return value;
}

function basicAuth(env) {
  const { id, secret } = config(env);
  const bytes = new TextEncoder().encode(`${id}:${secret}`);
  return `Basic ${btoa(String.fromCharCode(...bytes))}`;
}

export function authorizationUrl(env, { redirectUri, state, challenge } = {}) {
  const { id } = config(env);
  if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{32,512}$/.test(state)) fail(400, 'Check the Figma authorization state.');
  if (typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) fail(400, 'Check the Figma PKCE challenge.');
  const url = new URL('https://www.figma.com/oauth');
  url.search = new URLSearchParams({
    client_id: id, redirect_uri: callback(redirectUri), scope: SCOPE,
    state, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256'
  }).toString();
  return url.href;
}

async function boundedJson(response, limit) {
  const declared = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => {});
    fail(502, 'The Figma response is too large to read here.');
  }
  if (!response.body) fail(502, 'Figma returned an unreadable response.');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        fail(502, 'The Figma response is too large to read here.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let result;
  try { result = JSON.parse(new TextDecoder().decode(bytes)); } catch { fail(502, 'Figma returned an unreadable response.'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) fail(502, 'Figma returned an unreadable response.');
  return result;
}

async function providerJson(env, url, options, limit, file = false) {
  let response;
  try {
    response = await (env.FETCH || fetch)(url, {
      ...options, redirect: 'error', signal: AbortSignal.timeout(15000)
    });
  } catch {
    // Fetch exceptions can include request URLs or headers. Never expose them.
    fail(502, 'Figma could not be reached. Please try again.');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 429) fail(429, 'Figma is limiting requests. Please try again later.', 429);
    if (file && [401, 403].includes(response.status)) fail(403, 'Figma did not allow access to this file. Check the connection and file permissions.', response.status);
    if (file && response.status === 404) fail(404, 'Figma could not find a file shared with this account.', 404);
    fail(502, file ? 'Figma could not load the file.' : 'Figma could not connect your account. Please start again.', response.status);
  }
  try { return await boundedJson(response, limit); } catch (error) {
    if (error.status === 502) throw error;
    fail(502, 'Figma returned an unreadable response.');
  }
}

function tokenResult(data, priorRefreshToken, initial = false) {
  const validToken = value => typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\x00-\x20\x7f]/.test(value);
  const refresh = data.refresh_token === undefined ? priorRefreshToken : data.refresh_token;
  if (!validToken(data.access_token) || !validToken(refresh) ||
      typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer' ||
      !Number.isSafeInteger(data.expires_in) || data.expires_in <= 0 || data.expires_in > Math.floor(Number.MAX_SAFE_INTEGER / 1000) ||
      (initial && (typeof data.user_id_string !== 'string' || !/^[0-9]{1,128}$/.test(data.user_id_string))) ||
      (data.user_id_string !== undefined && (typeof data.user_id_string !== 'string' || !/^[0-9]{1,128}$/.test(data.user_id_string)))) {
    fail(502, 'Figma returned incomplete connection details. Please reconnect.');
  }
  return {
    access_token: data.access_token, refresh_token: refresh,
    token_type: 'bearer', expires_in: data.expires_in,
    ...(data.user_id_string !== undefined ? { user_id_string: data.user_id_string } : {})
  };
}

async function tokenRequest(env, values) {
  return providerJson(env, TOKEN_URL, {
    method: 'POST', headers: {
      Authorization: basicAuth(env), 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json'
    }, body: new URLSearchParams(values)
  }, MAX_TOKEN_BYTES);
}

export async function exchangeCode(env, { code, redirectUri, verifier } = {}) {
  config(env);
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) fail(400, 'Check the Figma PKCE verifier.');
  // Exchange immediately: Figma authorization codes expire after 30 seconds.
  const data = await tokenRequest(env, {
    grant_type: 'authorization_code', code: opaque(code, 'authorization code', 2048),
    redirect_uri: callback(redirectUri), code_verifier: verifier
  });
  return tokenResult(data, undefined, true);
}

export async function refreshToken(env, refreshTokenValue) {
  config(env);
  const current = opaque(refreshTokenValue, 'refresh token');
  // Serialize refresh per Figma user/app and save the returned credentials
  // atomically: refreshing invalidates the previous access token. The current
  // guide permits a reusable refresh token; preserve it if no replacement is
  // returned, and retain a replacement if the provider rotates it.
  const data = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: current });
  return tokenResult(data, current);
}

export async function readFile(env, accessToken, fileKey) {
  config(env);
  const credential = opaque(accessToken, 'access token');
  if (typeof fileKey !== 'string' || !/^[A-Za-z0-9]{1,128}$/.test(fileKey)) fail(400, 'Use a valid Figma file key.');
  const data = await providerJson(env, `https://api.figma.com/v1/files/${fileKey}?depth=2`, {
    method: 'GET', headers: { Authorization: `Bearer ${credential}`, Accept: 'application/json' }
  }, MAX_FILE_BYTES, true);
  if (!data.document || data.document.type !== 'DOCUMENT') fail(502, 'Figma returned an unreadable file.');
  return data;
}

// No documented provider-side OAuth revocation endpoint was found. Removing
// stored tokens ends this service's use of them; it does not revoke the remote
// app grant. Users can revoke it in Figma Settings > Security > Connected apps.
// https://help.figma.com/hc/en-us/articles/15021280611607-How-do-I-keep-my-account-secure
