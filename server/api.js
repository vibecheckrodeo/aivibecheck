import {handleConnections,removeRequestConnections,retryConnectionCleanup} from './connections.js';
const DAY = 86400000;
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers }
});
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export const wordCount = value => String(value).trim().split(/\s+/u).filter(Boolean).length;
export const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, '0')).join('');
const token = () => [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
const audit = (env, id, event) => env.DB.prepare('INSERT INTO audit(request_id,event,created_at) VALUES(?,?,?)').bind(id, event, Date.now()).run();
const load = (env, id) => env.DB.prepare('SELECT * FROM requests WHERE id=?').bind(id).first();
const cookie = (request, credential) => `vc_session=${credential}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;

async function body(request) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) fail(415, 'Send JSON.');
  const raw = await request.text();
  if (raw.length > 40000) fail(413, 'That request is too large.');
  try { return JSON.parse(raw); } catch { fail(400, 'The request could not be read.'); }
}
function text(value, max, label, required = true) {
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) fail(400, `Check ${label}.`);
  return value.trim();
}
export function validateProject(data) {
  const description = text(data.description, 20000, 'your project description');
  if (wordCount(description) > 1000) fail(400, 'Keep the description to 1,000 words or less.');
  if (!Array.isArray(data.links) || !data.links.length || data.links.length > 10) fail(400, 'Share between one and ten project links.');
  const links = data.links.map(value => {
    const raw = text(value, 2048, 'the project links');
    let url; try { url = new URL(raw); } catch { fail(400, 'Use full project URLs, starting with https://.'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) fail(400, 'Share web links without passwords.');
    return url.href;
  });
  return { description, links: [...new Set(links)], notes: text(data.notes ?? '', 3000, 'access notes', false) };
}
async function authenticate(request, env, id) {
  const bearer = request.headers.get('Authorization')?.replace(/^Bearer /, '');
  const credential = bearer || request.headers.get('Cookie')?.split('; ').find(v => v.startsWith('vc_session='))?.slice(11);
  if (!credential || !/^[a-f0-9]{64}$/.test(credential)) fail(401, 'Open your private request link to continue.');
  const row = await load(env, id);
  if (!row || await digest(credential) !== row.token_hash) fail(401, 'Open your private request link to continue.');
  return row;
}
async function administrator(request, env) {
  const candidate = request.headers.get('Authorization')?.replace(/^Bearer /, '') || '';
  if (!env.ADMIN_TOKEN || !candidate || await digest(candidate) !== await digest(env.ADMIN_TOKEN)) fail(401, 'Enter your admin access key.');
}
async function stripe(env, path, values, key) {
  if (!env.STRIPE_SECRET_KEY) fail(503, 'Deposit payments are not connected yet. Your request is saved; there is nothing to pay now.');
  const headers = { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` };
  if (values) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (key) headers['Idempotency-Key'] = key;
  const response = await (env.FETCH || fetch)(`https://api.stripe.com/v1/${path}`, { method: values ? 'POST' : 'GET', headers, body: values ? new URLSearchParams(values) : undefined });
  if (!response.ok) fail(502, 'Stripe could not confirm the payment step. Please try again.');
  return response.json();
}
export async function confirmPayment(env, row) {
  if (!row.stripe_session_id || row.paid_at) return row;
  const session = await stripe(env, `checkout/sessions/${encodeURIComponent(row.stripe_session_id)}`);
  if (session.payment_status === 'paid') {
    if (session.metadata?.request_id !== row.id || session.amount_total !== 2500 || session.currency !== 'usd' || session.mode !== 'payment') fail(409, 'Payment details do not match this request.');
    // Stripe's server-retrieved result is authoritative, including a late webhook.
    await env.DB.prepare("UPDATE requests SET paid_at=?,status=CASE WHEN booked_slot_id IS NULL THEN 'paid' ELSE 'booked' END,updated_at=? WHERE id=? AND paid_at IS NULL").bind(Date.now(), Date.now(), row.id).run();
    await audit(env, row.id, 'deposit_verified');
  }
  return load(env, row.id);
}
async function removeDueAccess(env, id) {
  const grants = (await env.DB.prepare("SELECT * FROM access_grants WHERE request_id=? AND state!='removed'").bind(id).all()).results;
  for (const grant of grants) {
    let removed = false;
    if (grant.provider === 'github' && env.GITHUB_ACCESS_TOKEN && env.GITHUB_USERNAME && /^[\w.-]+\/[\w.-]+$/.test(grant.resource)) {
      try {
        const response = await (env.FETCH || fetch)(`https://api.github.com/repos/${grant.resource}/collaborators/${encodeURIComponent(env.GITHUB_USERNAME)}`, {
          method: 'DELETE', headers: { Authorization: `Bearer ${env.GITHUB_ACCESS_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'vibecheck-access-cleanup', 'X-GitHub-Api-Version': '2022-11-28' }
        });
        // A 404 is ambiguous; do not treat it as proof of revoked access.
        removed = response.status === 204;
      } catch { /* Keep a retryable removal task without blocking other requests. */ }
    }
    await env.DB.prepare('UPDATE access_grants SET state=?,resource=?,removed_at=?,last_error=? WHERE id=?').bind(removed ? 'removed' : 'cleanup_due', removed ? '' : grant.resource, removed ? Date.now() : null, removed ? null : 'External access requires verified removal in the provider account.', grant.id).run();
    if (removed) await audit(env, id, 'external_access_removed');
  }
}
export async function expireUnpaid(env, now = Date.now()) {
  const due = (await env.DB.prepare("SELECT * FROM requests WHERE expires_at<=? AND paid_at IS NULL AND status IN ('submitted','approved') LIMIT 100").bind(now).all()).results;
  let expired = 0;
  for (let row of due) {
    if (row.stripe_session_id) {
      try {
        row = await confirmPayment(env, row);
        if (row.paid_at) continue;
        const session = await stripe(env, `checkout/sessions/${encodeURIComponent(row.stripe_session_id)}`);
        if (session.status === 'open') {
          await stripe(env, `checkout/sessions/${encodeURIComponent(row.stripe_session_id)}/expire`, {});
          row = await confirmPayment(env, row);
          if (row.paid_at) continue;
        }
      } catch { continue; }
    }
    const result = await env.DB.prepare("UPDATE requests SET status='expired',links='[]',access_notes='',updated_at=? WHERE id=? AND paid_at IS NULL AND status IN ('submitted','approved')").bind(now, row.id).run();
    if (result.meta.changes) { expired++; await audit(env, row.id, 'unpaid_access_expired'); await removeRequestConnections(env,row.id); }
    await removeDueAccess(env, row.id);
  }
  const retry = (await env.DB.prepare("SELECT DISTINCT request_id FROM access_grants WHERE state='cleanup_due' LIMIT 100").all()).results;
  for (const row of retry) await removeDueAccess(env, row.request_id);
  await retryConnectionCleanup(env);
  return { expired };
}
async function visible(env, row) {
  const { token_hash, ip_hash, stripe_session_id, ...safe } = row;
  safe.links = JSON.parse(safe.links);
  safe.payment_ready = Boolean(env.STRIPE_SECRET_KEY);
  if (row.booked_slot_id) safe.booking = await env.DB.prepare('SELECT starts_at,ends_at,zoom_url FROM slots WHERE id=? AND request_id=?').bind(row.booked_slot_id, row.id).first();
  return safe;
}
async function openSlots(env, now = Date.now()) {
  return (await env.DB.prepare('SELECT id,starts_at,ends_at FROM slots WHERE request_id IS NULL AND starts_at>? AND starts_at<=? ORDER BY starts_at').bind(now, now + 7 * DAY).all()).results;
}
export function validSlot(start, end, now) {
  if (!Number.isFinite(start) || end - start !== 15 * 60000 || start <= now) return false;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone:'America/New_York', weekday:'short', hour:'2-digit',minute:'2-digit',hourCycle:'h23' }).formatToParts(new Date(start)).map(p => [p.type,p.value]));
  const m = Number(parts.hour)*60 + Number(parts.minute);
  return parts.weekday !== 'Sun' && m >= 780 && m + 15 <= 1080 && m % 15 === 0 && start % 60000 === 0;
}
async function webhook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) fail(503, 'Webhook not configured.');
  const payload = await request.text();
  if (payload.length > 200000) fail(413, 'Payload too large.');
  const entries = (request.headers.get('Stripe-Signature') || '').split(',').map(v => v.split('='));
  const stamp = entries.find(([k]) => k === 't')?.[1];
  if (!stamp || Math.abs(Date.now()/1000 - Number(stamp)) > 300) fail(400, 'Invalid webhook timestamp.');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET), {name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature = [...new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`${stamp}.${payload}`)))].map(b=>b.toString(16).padStart(2,'0')).join('');
  const signatures = entries.filter(([k])=>k==='v1').map(([,v])=>v);
  let valid = false;
  for (const supplied of signatures) if (await digest(supplied) === await digest(signature)) valid = true;
  if (!valid) fail(400, 'Invalid webhook signature.');
  const event = JSON.parse(payload);
  if (['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type)) {
    const row = await load(env, event.data.object.metadata?.request_id || '');
    if (row && row.stripe_session_id === event.data.object.id) await confirmPayment(env,row);
  }
  return json({received:true});
}
export async function handle(request, env) {
  try {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    const method = request.method;
    if (path[0] === 'health' && method === 'GET') {
      await env.DB.prepare('SELECT 1').first();
      return json({ok:true,version:env.CF_PAGES_COMMIT_SHA || env.RELEASE_SHA || 'dev',registration:true,payments:Boolean(env.STRIPE_SECRET_KEY)});
    }
    if (path[0] === 'stripe-webhook' && method === 'POST') return await webhook(request,env);
    if (!['GET','HEAD'].includes(method)) {
      const origin = request.headers.get('Origin');
      if (origin && origin !== url.origin) fail(403,'Use the form on this site.');
      if (request.headers.get('Sec-Fetch-Site') === 'cross-site') fail(403,'Use the form on this site.');
    }
    const connectionResponse=await handleConnections(request,env,path,method,{authenticate,administrator,body,expireUnpaid});
    if(connectionResponse)return connectionResponse;
    if (path[0] === 'register' && method === 'POST') {
      const data = await body(request);
      if (data.website) fail(400,'Unable to register.');
      const name = text(data.name,150,'your name');
      const email = text(data.email,254,'your email address').toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400,'Enter a valid email address.');
      const ipHash = await digest(`${request.headers.get('CF-Connecting-IP') || 'local'}:${env.ADMIN_TOKEN || 'local'}`);
      const recent = await env.DB.prepare('SELECT count(*) AS n FROM requests WHERE ip_hash=? AND created_at>?').bind(ipHash,Date.now()-3600000).first();
      if (recent.n >= 10) fail(429,'Too many registrations. Please try again later.');
      const id = crypto.randomUUID(), credential = token(), now = Date.now();
      await env.DB.prepare('INSERT INTO requests(id,token_hash,name,email,created_at,updated_at,ip_hash) VALUES(?,?,?,?,?,?,?)').bind(id,await digest(credential),name,email,now,now,ipHash).run();
      await audit(env,id,'registered');
      return json({id,token:credential,request:await visible(env,await load(env,id))},201,{'Set-Cookie':cookie(request,credential)});
    }
    if (path[0] === 'requests' && path[1]) {
      let row = await authenticate(request,env,path[1]);
      if (row.expires_at && row.expires_at <= Date.now() && !row.paid_at && ['submitted','approved'].includes(row.status)) {
        await expireUnpaid(env); row = await load(env,row.id);
      }
      if (method === 'GET' && path.length === 2) return json(await visible(env,row));
      if (method === 'PUT' && path.length === 2) {
        if (!['draft','submitted'].includes(row.status)) fail(409,'This request can no longer be edited.');
        const data = await body(request), project = validateProject(data);
        if (data.complete !== true && data.complete !== false) fail(400,'Choose whether you have finished sharing the project.');
        const completed = row.completed_at || (data.complete ? Date.now() : null);
        await env.DB.prepare('UPDATE requests SET description=?,links=?,access_notes=?,completed_at=?,expires_at=?,status=?,updated_at=? WHERE id=? AND status IN (\'draft\',\'submitted\')').bind(project.description,JSON.stringify(project.links),project.notes,completed,completed ? completed+7*DAY : null,completed ? 'submitted':'draft',Date.now(),row.id).run();
        await audit(env,row.id,completed ? 'request_submitted':'draft_saved');
        return json(await visible(env,await load(env,row.id)));
      }
      if (method === 'POST' && path[2] === 'checkout') {
        if (row.status !== 'approved' || row.paid_at || row.expires_at <= Date.now()+1800000) fail(409,'This request is not ready for a deposit payment.');
        if (!(await openSlots(env)).length) fail(409,'No review times are available in the next week. Please check back before paying.');
        if (row.stripe_session_id) {
          const existing = await stripe(env,`checkout/sessions/${encodeURIComponent(row.stripe_session_id)}`);
          if (existing.payment_status === 'paid') { await confirmPayment(env,row); return json({paid:true}); }
          if (existing.status === 'open') return json({url:existing.url});
        }
        const session = await stripe(env,'checkout/sessions',{
          mode:'payment', 'payment_method_types[0]':'card', customer_email:row.email,
          success_url:`${url.origin}/?request=${row.id}&payment=returned#request`, cancel_url:`${url.origin}/?request=${row.id}#request`,
          client_reference_id:row.id,'metadata[request_id]':row.id,
          'line_items[0][quantity]':'1','line_items[0][price_data][currency]':'usd','line_items[0][price_data][unit_amount]':'2500',
          'line_items[0][price_data][product_data][name]':'Vibe check — review deposit',
          expires_at:String(Math.floor(Math.min(Date.now()+3600000,row.expires_at)/1000))
        },`deposit-${row.id}-${row.stripe_session_id || 'first'}`);
        const result = await env.DB.prepare("UPDATE requests SET stripe_session_id=? WHERE id=? AND status='approved' AND paid_at IS NULL").bind(session.id,row.id).run();
        if (!result.meta.changes) fail(409,'The request changed. Refresh before paying.');
        return json({url:session.url});
      }
      if (method === 'POST' && path[2] === 'verify-payment') return json(await visible(env,await confirmPayment(env,row)));
      if (method === 'GET' && path[2] === 'slots') {
        if (!row.paid_at) fail(403,'The deposit must be verified before booking.');
        return json({slots:await openSlots(env)});
      }
      if (method === 'POST' && path[2] === 'book') {
        if (!row.paid_at || !['paid','booked'].includes(row.status)) fail(403,'The deposit must be verified before booking.');
        if (row.booked_slot_id) return json(await visible(env,row));
        const data = await body(request), now=Date.now();
        const slot = await env.DB.prepare('SELECT * FROM slots WHERE id=? AND starts_at>? AND starts_at<=? AND request_id IS NULL').bind(String(data.slotId),now,now+7*DAY).first();
        if (!slot) fail(409,'That time is no longer available. Choose another.');
        const result = await env.DB.batch([
          env.DB.prepare("UPDATE slots SET request_id=? WHERE id=? AND request_id IS NULL AND EXISTS(SELECT 1 FROM requests WHERE id=? AND paid_at IS NOT NULL AND booked_slot_id IS NULL)").bind(row.id,slot.id,row.id),
          env.DB.prepare("UPDATE requests SET booked_slot_id=?,status='booked',updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM slots WHERE id=? AND request_id=?)").bind(slot.id,now,row.id,slot.id,row.id)
        ]);
        if (!result[0].meta.changes) fail(409,'That time was just taken. Choose another.');
        await audit(env,row.id,'booked');
        return json(await visible(env,await load(env,row.id)));
      }
      fail(404,'Not found.');
    }
    if (path[0] === 'admin') {
      await administrator(request,env);
      if (path[1] === 'requests' && method === 'GET') {
        const rows=(await env.DB.prepare('SELECT * FROM requests ORDER BY created_at DESC LIMIT 200').all()).results;
        const grants=(await env.DB.prepare("SELECT * FROM access_grants WHERE state!='removed' ORDER BY created_at").all()).results;
        const slots=(await env.DB.prepare('SELECT * FROM slots WHERE starts_at>? ORDER BY starts_at LIMIT 100').bind(Date.now()).all()).results;
        return json({requests:await Promise.all(rows.map(row=>visible(env,row))),grants,slots,payments:Boolean(env.STRIPE_SECRET_KEY)});
      }
      if (path[1] === 'cleanup' && method === 'POST') return json(await expireUnpaid(env));
      if (path[1] === 'slots' && method === 'POST') {
        const data=await body(request), start=Number(data.startsAt), end=start+900000;
        if (!validSlot(start,end,Date.now())) fail(400,'Choose a future 15-minute slot, Monday–Saturday, 1–6pm Eastern.');
        let zoom; try { zoom=new URL(data.zoomUrl); } catch { fail(400,'Enter the real Zoom meeting URL.'); }
        if (zoom.protocol!=='https:' || !(zoom.hostname==='zoom.us'||zoom.hostname.endsWith('.zoom.us'))) fail(400,'Use an https:// Zoom meeting URL.');
        const id=crypto.randomUUID();
        await env.DB.prepare('INSERT INTO slots(id,starts_at,ends_at,zoom_url,created_at) VALUES(?,?,?,?,?)').bind(id,start,end,zoom.href,Date.now()).run();
        return json({id},201);
      }
      if (path[1] === 'slots' && path[2] && method === 'DELETE') {
        const result=await env.DB.prepare('DELETE FROM slots WHERE id=? AND request_id IS NULL').bind(path[2]).run();
        if (!result.meta.changes) fail(409,'Booked slots cannot be removed here.');
        return json({removed:true});
      }
      if (path[1] === 'requests' && path[2] && method === 'POST') {
        const row=await load(env,path[2]); if(!row) fail(404,'Request not found.');
        const data=await body(request);
        if (data.action==='approve') {
          const scope=text(data.scope,2000,'the agreed review scope');
          const result=await env.DB.prepare("UPDATE requests SET status='approved',scope=?,approved_at=?,updated_at=? WHERE id=? AND status='submitted' AND expires_at>?").bind(scope,Date.now(),Date.now(),row.id,Date.now()).run();
          if (!result.meta.changes) fail(409,'Only submitted, unexpired requests can be approved.');
          await audit(env,row.id,'approved');
        } else if(data.action==='decline') {
          if (row.paid_at || row.stripe_session_id) fail(409,'A request with a checkout session needs payment reconciliation before it can be declined.');
          await env.DB.prepare("UPDATE requests SET status='declined',links='[]',access_notes='',updated_at=? WHERE id=?").bind(Date.now(),row.id).run();
          await removeDueAccess(env,row.id); await removeRequestConnections(env,row.id); await audit(env,row.id,'declined');
        } else if(data.action==='track-access') {
          if(['expired','declined'].includes(row.status)) fail(409,'This request is closed.');
          const provider=text(data.provider,40,'the platform'), resource=text(data.resource,2048,'the access to remove');
          await env.DB.prepare('INSERT INTO access_grants(id,request_id,provider,resource,created_at) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),row.id,provider,resource,Date.now()).run();
          await audit(env,row.id,'external_access_recorded');
        } else fail(400,'Unknown action.');
        return json(await visible(env,await load(env,row.id)));
      }
      if(path[1]==='grants' && path[2] && method==='POST') {
        const data=await body(request);
        if(data.confirmRemoved!==true) fail(400,'Confirm that access was removed in the provider account.');
        const grant=await env.DB.prepare('SELECT * FROM access_grants WHERE id=?').bind(path[2]).first();
        if(!grant) fail(404,'Access record not found.');
        await env.DB.prepare("UPDATE access_grants SET state='removed',resource='',removed_at=?,last_error=NULL WHERE id=?").bind(Date.now(),grant.id).run();
        await audit(env,grant.request_id,'external_access_removal_confirmed');
        return json({removed:true});
      }
    }
    return json({error:'Not found.'},404);
  } catch (error) {
    if (!error.status) console.error('Vibecheck API failure:',error.name);
    return json({error:error.status ? error.message : 'Something went wrong. Your previous saved details are safe; please try again.'},error.status || 500);
  }
}
