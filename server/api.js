import {availableReviewSlots,adminReviewSlots,reviewBilling,confirmReviewPayment,createReviewCheckout,cancelReviewUpgrade,bookReview,reviewWebhook,reconcilePendingReviews,validReviewMinutes} from './review-payments.js';
import {depositSlots,depositSummary,createDepositCheckout,confirmDepositPayment,expireDepositForRequest,depositWebhook,reconcilePendingDeposits,latestDeposit} from './deposit-payments.js';
import {campaignAttribution,campaignResults} from './campaigns.js';
export {availableReviewSlots,reconcilePendingReviews} from './review-payments.js';
export {reconcilePendingDeposits} from './deposit-payments.js';
import {validateMeetingUrl} from './meetings.js';
import {handleConnections,removeRequestConnections,retryConnectionCleanup} from './connections.js';
import {handleCommunications,handleEmailLink,initializeContact,emailConfiguration} from './communications.js';
import {calendarBusy,calendarConfiguration,overlapsBusy} from './calendar.js';
import {handleResendWebhook} from './resend-webhook.js';
const DAY = 86400000;
// Purge after six days so the 15-minute cron has room to complete within a week.
const PURGE_DELAY = 6 * DAY;
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
  let value;
  try { value = JSON.parse(raw); } catch { fail(400, 'The request could not be read.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Send a JSON object.');
  return value;
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
    if (url.protocol !== 'https:' || url.username || url.password) fail(400, 'Share secure https:// links without passwords.');
    return url.href;
  });
  return { description, links: [...new Set(links)], notes: text(data.notes ?? '', 3000, 'access notes', false) };
}
async function authenticate(request, env, id) {
  const bearer = request.headers.get('Authorization')?.replace(/^Bearer /, '');
  const credential = bearer || request.headers.get('Cookie')?.split('; ').find(v => v.startsWith('vc_session='))?.slice(11);
  if (!credential || !/^[a-f0-9]{64}$/.test(credential)) fail(401, 'This private request link is unavailable. It may have expired or been removed.');
  const row = await load(env, id);
  if (!row || await digest(credential) !== row.token_hash) fail(401, 'This private request link is unavailable. It may have expired or been removed.');
  return row;
}
async function administrator(request, env) {
  const candidate = request.headers.get('Authorization')?.replace(/^Bearer /, '') || '';
  if (!env.ADMIN_TOKEN || !candidate || await digest(candidate) !== await digest(env.ADMIN_TOKEN)) fail(401, 'Enter your admin access key.');
}
// Checkout needs both the server key and the asynchronous confirmation path.
// Cleanup only needs the key to reconcile previously created sessions.
const paymentReady = env => Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);
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
  if(await latestDeposit(env,row.id))return confirmDepositPayment(env,row);
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
  const dueWhere="expires_at<=? AND paid_at IS NULL AND status IN ('submitted','approved') AND NOT EXISTS(SELECT 1 FROM deposit_payments p WHERE p.request_id=requests.id AND p.status IN ('creating','open'))";
  const total=(await env.DB.prepare(`SELECT count(*) AS n FROM requests WHERE ${dueWhere}`).bind(now).first()).n;
  const limit=Math.min(100,total),offset=total?(Math.floor(now/900000)*100)%total:0;
  const due=limit?(await env.DB.prepare(`SELECT * FROM requests WHERE ${dueWhere} ORDER BY created_at,id LIMIT ? OFFSET ?`).bind(now,limit,offset).all()).results:[];
  if(due.length<limit){
    const wrap=(await env.DB.prepare(`SELECT * FROM requests WHERE ${dueWhere} ORDER BY created_at,id LIMIT ?`).bind(now,limit-due.length).all()).results;
    const seen=new Set(due.map(row=>row.id));
    due.push(...wrap.filter(row=>!seen.has(row.id)));
  }
  let expired = 0;
  for (let row of due) {
    const deposit=await latestDeposit(env,row.id);
    if(deposit){
      try{
        await expireDepositForRequest(env,row,now);
        row=await load(env,row.id);
        if(row.paid_at)continue;
        const current=await latestDeposit(env,row.id);
        if(current&&['creating','open'].includes(current.status))continue;
      }catch{continue;}
    }else if (row.stripe_session_id) {
      try {
        row = await confirmPayment(env, row);
        if (row.paid_at) continue;
        let session = await stripe(env, `checkout/sessions/${encodeURIComponent(row.stripe_session_id)}`);
        if (session.status === 'open') {
          await stripe(env, `checkout/sessions/${encodeURIComponent(row.stripe_session_id)}/expire`, {});
          row = await confirmPayment(env, row);
          if (row.paid_at) continue;
          session = await stripe(env, `checkout/sessions/${encodeURIComponent(row.stripe_session_id)}`);
        }
        // Async or uncertain Stripe payments must resolve before deleting the
        // identity and checkout context needed for reconciliation.
        if (session.status !== 'expired' || session.payment_status !== 'unpaid') continue;
      } catch { continue; }
    }
    const result = await env.DB.prepare("UPDATE requests SET status='expired',links='[]',access_notes='',finished_at=expires_at,purge_after=expires_at,updated_at=? WHERE id=? AND paid_at IS NULL AND status IN ('submitted','approved') AND NOT EXISTS(SELECT 1 FROM deposit_payments p WHERE p.request_id=requests.id AND p.status IN ('creating','open'))").bind(now, row.id).run();
    if (result.meta.changes) {
      expired++;
      await audit(env, row.id, 'unpaid_access_expired');
      await removeRequestConnections(env,row.id);
      await removeDueAccess(env, row.id);
    }
  }
  const retryTotal=(await env.DB.prepare("SELECT count(DISTINCT request_id) AS n FROM access_grants WHERE state='cleanup_due'").first()).n;
  const retryLimit=Math.min(100,retryTotal),retryOffset=retryTotal?(Math.floor(now/900000)*100)%retryTotal:0;
  const retry=retryLimit?(await env.DB.prepare("SELECT DISTINCT request_id FROM access_grants WHERE state='cleanup_due' ORDER BY request_id LIMIT ? OFFSET ?").bind(retryLimit,retryOffset).all()).results:[];
  if(retry.length<retryLimit){
    const wrap=(await env.DB.prepare("SELECT DISTINCT request_id FROM access_grants WHERE state='cleanup_due' ORDER BY request_id LIMIT ?").bind(retryLimit-retry.length).all()).results;
    const seen=new Set(retry.map(row=>row.request_id));
    retry.push(...wrap.filter(row=>!seen.has(row.request_id)));
  }
  for (const row of retry) await removeDueAccess(env, row.request_id);
  await retryConnectionCleanup(env,now);
  return { expired };
}
async function finishReview(env, row, finishedAt, answerText = null) {
  const result = await env.DB.prepare(`UPDATE requests SET answer_text=coalesce(?,answer_text),finished_at=?,purge_after=?,updated_at=?
    WHERE id=? AND finished_at IS NULL AND paid_at IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM review_payments p WHERE p.request_id=requests.id AND p.status IN ('creating','open'))
      AND NOT EXISTS(SELECT 1 FROM deposit_payments p WHERE p.request_id=requests.id AND p.status IN ('creating','open'))
      AND ((? IS NULL AND status='booked' AND booked_slot_id IS NOT NULL)
        OR (? IS NOT NULL AND status='paid' AND booked_slot_id IS NULL AND (review_mode IS NULL OR review_mode='answer')))`)
    .bind(answerText,finishedAt,finishedAt+PURGE_DELAY,Date.now(),row.id,answerText,answerText).run();
  if (!result.meta.changes) return false;
  await env.DB.prepare("UPDATE email_outbox SET state='cancelled',last_error='Review finished.' WHERE request_id=? AND state IN ('queued','sending')").bind(row.id).run();
  await removeRequestConnections(env,row.id);
  await removeDueAccess(env,row.id);
  await audit(env,row.id,'review_finished');
  return true;
}
export async function purgeFinishedReviews(env, now = Date.now()) {
  // Booked reviews end at the purchased duration, including verified upgrades.
  const booked=(await env.DB.prepare("SELECT r.*,s.starts_at FROM requests r JOIN slots s ON s.id=r.booked_slot_id WHERE r.status='booked' AND r.finished_at IS NULL AND s.starts_at+r.review_minutes*60000<=? AND NOT EXISTS(SELECT 1 FROM review_payments p WHERE p.request_id=r.id AND p.status IN ('creating','open')) AND NOT EXISTS(SELECT 1 FROM deposit_payments p WHERE p.request_id=r.id AND p.status IN ('creating','open')) LIMIT 100").bind(now).all()).results;
  let finished=0;
  for (const row of booked) if(await finishReview(env,row,row.starts_at+row.review_minutes*60000)) finished++;
  // Draft edits do not extend the lifetime of an unfinished registration.
  await env.DB.prepare("UPDATE requests SET status='expired',finished_at=created_at+?,purge_after=created_at+? WHERE status='draft' AND finished_at IS NULL AND created_at<=?").bind(7*DAY,7*DAY,now-7*DAY).run();
  await env.DB.prepare("UPDATE requests SET finished_at=updated_at,purge_after=updated_at+? WHERE status IN ('expired','declined') AND finished_at IS NULL").bind(PURGE_DELAY).run();
  const waiting=(await env.DB.prepare(`SELECT count(*) AS n FROM requests r WHERE r.purge_after<=? AND r.purged_at IS NULL
    AND (EXISTS(SELECT 1 FROM review_payments p WHERE p.request_id=r.id AND p.status IN ('creating','open'))
      OR EXISTS(SELECT 1 FROM deposit_payments p WHERE p.request_id=r.id AND p.status IN ('creating','open')))` ).bind(now).first()).n;
  const due=(await env.DB.prepare(`SELECT * FROM requests r WHERE r.purge_after<=? AND r.purged_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM review_payments p WHERE p.request_id=r.id AND p.status IN ('creating','open'))
    AND NOT EXISTS(SELECT 1 FROM deposit_payments p WHERE p.request_id=r.id AND p.status IN ('creating','open'))
    ORDER BY r.purge_after,r.id LIMIT 100`).bind(now).all()).results;
  let purged=0,waitingForAccess=0,waitingForPayments=waiting;
  for(const row of due){
    const pendingPayments=(await env.DB.prepare("SELECT (SELECT count(*) FROM review_payments WHERE request_id=? AND status IN ('creating','open'))+(SELECT count(*) FROM deposit_payments WHERE request_id=? AND status IN ('creating','open')) AS count").bind(row.id,row.id).first()).count;
    if(pendingPayments){waitingForPayments++;continue;}
    await removeRequestConnections(env,row.id);
    await removeDueAccess(env,row.id);
    const pending=(await env.DB.prepare("SELECT (SELECT count(*) FROM connections WHERE request_id=? AND state!='removed')+(SELECT count(*) FROM access_grants WHERE request_id=? AND state!='removed') AS count").bind(row.id,row.id).first()).count;
    if(pending)waitingForAccess++;
    // Keep only payment references, amounts, timestamps, categorical campaign
    // labels, and audit event names. Provider failures retain a retryable task.
    const result=await env.DB.batch([
      env.DB.prepare(`UPDATE requests SET token_hash='',name='',email='',description='',links='[]',access_notes='',scope='',reply='',answer_text='',ip_hash='',purged_at=?,updated_at=?
        WHERE id=? AND purged_at IS NULL AND purge_after<=?
          AND NOT EXISTS(SELECT 1 FROM review_payments p WHERE p.request_id=requests.id AND p.status IN ('creating','open'))
          AND NOT EXISTS(SELECT 1 FROM deposit_payments p WHERE p.request_id=requests.id AND p.status IN ('creating','open'))`).bind(now,now,row.id,now),
      env.DB.prepare('DELETE FROM email_outbox WHERE request_id=? AND EXISTS(SELECT 1 FROM requests WHERE id=? AND purged_at=?)').bind(row.id,row.id,now),
      env.DB.prepare('DELETE FROM email_contacts WHERE request_id=? AND EXISTS(SELECT 1 FROM requests WHERE id=? AND purged_at=?)').bind(row.id,row.id,now),
      env.DB.prepare('DELETE FROM oauth_states WHERE request_id=? AND EXISTS(SELECT 1 FROM requests WHERE id=? AND purged_at=?)').bind(row.id,row.id,now),
      env.DB.prepare("UPDATE review_payments SET stripe_payload='{}',checkout_url=NULL WHERE request_id=? AND status IN ('paid','expired') AND EXISTS(SELECT 1 FROM requests WHERE id=? AND purged_at=?)").bind(row.id,row.id,now),
      env.DB.prepare("UPDATE deposit_payments SET stripe_payload='{}',checkout_url=NULL WHERE request_id=? AND status IN ('paid','expired') AND EXISTS(SELECT 1 FROM requests WHERE id=? AND purged_at=?)").bind(row.id,row.id,now),
      env.DB.prepare(`UPDATE slots SET zoom_url=substr(zoom_url,1,instr(zoom_url||'#','#')-1)
        WHERE instr(zoom_url,'#')>0 AND substr(zoom_url,1,instr(zoom_url||'#','#')-1)=
          (SELECT substr(booked.zoom_url,1,instr(booked.zoom_url||'#','#')-1)
           FROM slots booked JOIN requests r ON r.booked_slot_id=booked.id WHERE r.id=? AND r.purged_at=?)
          AND (request_id=? OR (request_id IS NULL
            AND NOT EXISTS(SELECT 1 FROM slot_claims c WHERE c.slot_id=slots.id)
            AND NOT EXISTS(SELECT 1 FROM review_payments p WHERE p.slot_id=slots.id)
            AND NOT EXISTS(SELECT 1 FROM deposit_payments p WHERE p.slot_id=slots.id AND p.status IN ('creating','open'))))`).bind(row.id,now,row.id),
      env.DB.prepare("INSERT INTO audit(request_id,event,created_at) SELECT ?,'content_purged',? WHERE EXISTS(SELECT 1 FROM requests WHERE id=? AND purged_at=?)").bind(row.id,now,row.id,now)
    ]);
    if(result[0].meta.changes)purged++;
  }
  return {finished,purged,waitingForAccess,waitingForPayments};
}
async function visible(env, row) {
  const { token_hash, ip_hash, stripe_session_id, attribution, ...safe } = row;
  safe.links = JSON.parse(safe.links);
  safe.payment_ready = paymentReady(env);
  Object.assign(safe,await reviewBilling(env,row));
  safe.pending_deposit=await depositSummary(env,row);
  if (row.booked_slot_id) safe.booking = await env.DB.prepare('SELECT starts_at,ends_at,zoom_url FROM slots WHERE id=? AND request_id=?').bind(row.booked_slot_id, row.id).first();
  if(safe.booking){
    safe.booking.ends_at=safe.booking.starts_at+(row.review_minutes||15)*60000;
    // Retain zoom_url for cached clients; the stored column predates Proton Meet.
    safe.booking.meeting_url=safe.booking.zoom_url;
  }
  return safe;
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
  if (['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.expired'].includes(event.type)) {
    if(await depositWebhook(env,event))return json({received:true});
    if(await reviewWebhook(env,event))return json({received:true});
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
      return json({ok:true,version:env.CF_PAGES_COMMIT_SHA || env.RELEASE_SHA || 'dev',registration:true,payments:paymentReady(env),email:emailConfiguration(env),calendar:calendarConfiguration(env)});
    }
    if (path[0] === 'stripe-webhook' && method === 'POST') return await webhook(request,env);
    if (path[0] === 'resend-webhook' && method === 'POST') return await handleResendWebhook(request,env);
    if (path[0] === 'email') return await handleEmailLink(request,env);
    if (!['GET','HEAD'].includes(method)) {
      const origin = request.headers.get('Origin');
      if (origin && origin !== url.origin) fail(403,'Use the form on this site.');
      if (request.headers.get('Sec-Fetch-Site') === 'cross-site') fail(403,'Use the form on this site.');
    }
    const communicationResponse=await handleCommunications(request,env,path,method,{authenticate,administrator,body},availableReviewSlots);
    if(communicationResponse)return communicationResponse;
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
      await env.DB.prepare('INSERT INTO requests(id,token_hash,name,email,created_at,updated_at,ip_hash,attribution) VALUES(?,?,?,?,?,?,?,?)').bind(id,await digest(credential),name,email,now,now,ipHash,JSON.stringify(campaignAttribution(data.attribution))).run();
      await audit(env,id,'registered');
      await initializeContact(env,await load(env,id),data.emailOptIn===true,true);
      return json({id,token:credential,request:await visible(env,await load(env,id))},201,{'Set-Cookie':cookie(request,credential)});
    }
    if (path[0] === 'requests' && path[1]) {
      let row = await authenticate(request,env,path[1]);
      if (row.expires_at && row.expires_at <= Date.now() && !row.paid_at && ['submitted','approved'].includes(row.status)) {
        await expireUnpaid(env); row = await load(env,row.id);
      }
      if (method === 'GET' && path.length === 2) return json(await visible(env,row));
      if (row.finished_at && method !== 'GET') fail(409,'This review is finished. Project details and messages are scheduled for deletion.');
      if (method === 'PUT' && path.length === 2) {
        if (!['draft','submitted'].includes(row.status)) fail(409,'This request can no longer be edited.');
        if(row.status==='draft'&&row.created_at+7*DAY<=Date.now())fail(410,'This unfinished registration has expired. Start a new request.');
        const data = await body(request), project = validateProject(data);
        if (data.complete !== true && data.complete !== false) fail(400,'Choose whether you have finished sharing the project.');
        const completed = row.completed_at || (data.complete ? Date.now() : null);
        const saved=await env.DB.prepare("UPDATE requests SET description=?,links=?,access_notes=?,completed_at=?,expires_at=?,status=?,updated_at=? WHERE id=? AND purged_at IS NULL AND finished_at IS NULL AND status IN ('draft','submitted') AND (status!='draft' OR created_at>?)").bind(project.description,JSON.stringify(project.links),project.notes,completed,completed ? completed+7*DAY : null,completed ? 'submitted':'draft',Date.now(),row.id,Date.now()-7*DAY).run();
        if(!saved.meta.changes)fail(409,'This request closed while you were saving.');
        await audit(env,row.id,completed ? 'request_submitted':'draft_saved');
        return json(await visible(env,await load(env,row.id)));
      }
      if (method === 'POST' && path[2] === 'checkout') {
        const data=await body(request);
        if(row.status!=='approved'||row.paid_at||row.expires_at<=Date.now()+1800000)fail(409,'This request is not ready for a deposit payment.');
        if (row.stripe_session_id && !(await latestDeposit(env,row.id))) {
          const existing = await stripe(env,`checkout/sessions/${encodeURIComponent(row.stripe_session_id)}`);
          if (existing.payment_status === 'paid') { await confirmPayment(env,row); return json({paid:true}); }
          if (!paymentReady(env)) fail(503,'Deposit payments are not fully connected yet. Your request is saved; there is nothing to pay now.');
          if (existing.status === 'open') return json({url:existing.url});
        }
        return json(await createDepositCheckout(env,row,data.mode,typeof data.slotId==='string'?data.slotId:'',url.origin));
      }
      if (method === 'POST' && path[2] === 'verify-payment') return json(await visible(env,await confirmReviewPayment(env,await confirmPayment(env,row))));
      if (method === 'POST' && path[2] === 'upgrade-checkout') {
        const data=await body(request);
        return json(await createReviewCheckout(env,row,String(data.slotId),data.minutes,url.origin));
      }
      if (method === 'POST' && path[2] === 'cancel-upgrade') return json(await visible(env,await cancelReviewUpgrade(env,row)));
      if (method === 'GET' && path[2] === 'slots') {
        if(row.finished_at)fail(409,'This review has been completed.');
        const minutes=Number(url.searchParams.get('minutes')||row.review_minutes||15);
        if(!validReviewMinutes(minutes))fail(400,'Choose 15, 30, or 60 minutes.');
        if(!row.paid_at){
          if(row.status==='approved'&&minutes===15)return json({slots:await depositSlots(env,row)});
          fail(403,'The deposit must be verified before booking more time.');
        }
        if(row.review_mode==='answer')fail(409,'This request is for an answer, not an appointment.');
        row=await confirmReviewPayment(env,row);
        return json({slots:await availableReviewSlots(env,row,minutes)});
      }
      if (method === 'POST' && path[2] === 'book') {
        if (!row.paid_at || !['paid','booked'].includes(row.status)) fail(403,'The deposit must be verified before booking.');
        if (row.booked_slot_id) return json(await visible(env,row));
        const data = await body(request);
        return json(await visible(env,await bookReview(env,row,String(data.slotId))));
      }
      fail(404,'Not found.');
    }
    if (path[0] === 'admin') {
      await administrator(request,env);
      if(path.length===2&&path[1]==='campaigns'&&method==='GET')return json(await campaignResults(env));
      if (path[1] === 'requests' && method === 'GET') {
        const rows=(await env.DB.prepare('SELECT * FROM requests ORDER BY created_at DESC LIMIT 200').all()).results;
        const grants=(await env.DB.prepare("SELECT * FROM access_grants WHERE state!='removed' ORDER BY created_at").all()).results;
        const slots=await adminReviewSlots(env);
        return json({requests:await Promise.all(rows.map(row=>visible(env,row))),grants,slots,payments:paymentReady(env)});
      }
      if (path[1] === 'cleanup' && method === 'POST') {
        const deposits=await reconcilePendingDeposits(env);
        const requests=await expireUnpaid(env);
        const reviews=await reconcilePendingReviews(env);
        return json({...requests,deposits,reviews,retention:await purgeFinishedReviews(env)});
      }
      if (path[1] === 'slots' && method === 'POST') {
        const data=await body(request), start=Number(data.startsAt), end=start+900000;
        if (!validSlot(start,end,Date.now())) fail(400,'Choose a future 15-minute slot, Monday–Saturday, 1–6pm Eastern.');
        if(overlapsBusy(await calendarBusy(env,start,end),start,end))fail(409,'Ashley’s calendar has a conflict at that time.');
        const meetingUrl=validateMeetingUrl(data.meetingUrl ?? data.zoomUrl);
        const id=crypto.randomUUID();
        await env.DB.prepare('INSERT INTO slots(id,starts_at,ends_at,zoom_url,created_at) VALUES(?,?,?,?,?)').bind(id,start,end,meetingUrl,Date.now()).run();
        return json({id},201);
      }
      if (path[1] === 'slots' && path[2] && method === 'DELETE') {
        const result=await env.DB.prepare('DELETE FROM slots WHERE id=? AND request_id IS NULL AND NOT EXISTS(SELECT 1 FROM slot_claims c WHERE c.slot_id=slots.id) AND NOT EXISTS(SELECT 1 FROM review_payments p WHERE p.slot_id=slots.id) AND NOT EXISTS(SELECT 1 FROM deposit_payments p WHERE p.slot_id=slots.id)').bind(path[2]).run();
        if (!result.meta.changes) fail(409,'Booked, held, or payment-referenced slots cannot be removed here.');
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
          const deposit=await latestDeposit(env,row.id);
          if (row.paid_at || (deposit&&['creating','open'].includes(deposit.status)) || (!deposit&&row.stripe_session_id)) fail(409,'A request with a checkout session needs payment reconciliation before it can be declined.');
          const now=Date.now();
          const declined=await env.DB.prepare(`UPDATE requests SET status='declined',links='[]',access_notes='',finished_at=?,purge_after=?,updated_at=?
            WHERE id=? AND status IN ('submitted','approved') AND paid_at IS NULL AND finished_at IS NULL AND purged_at IS NULL
              AND (stripe_session_id IS NULL OR EXISTS(SELECT 1 FROM deposit_payments p WHERE p.request_id=requests.id AND p.session_id=requests.stripe_session_id AND p.status='expired'))
              AND NOT EXISTS(SELECT 1 FROM deposit_payments p WHERE p.request_id=requests.id AND p.status IN ('creating','open','paid'))`)
            .bind(now,now+PURGE_DELAY,now,row.id).run();
          if(!declined.meta.changes)fail(409,'This request or its payment changed. Refresh and reconcile the payment before declining.');
          await removeDueAccess(env,row.id); await removeRequestConnections(env,row.id); await audit(env,row.id,'declined');
        } else if(data.action==='finish') {
          if(row.finished_at) fail(409,'This review is already finished.');
          let answer=null,finishedAt=Date.now();
          if(row.status==='paid') {
            if(row.booked_slot_id||(row.review_mode&&row.review_mode!=='answer'))fail(409,'Only a paid answer review can be completed with a written answer.');
            if(data.confirmDelivered!==true)fail(400,'Confirm that this is the final paid answer.');
            answer=text(data.answerText,10000,'the final paid answer');
          } else if(row.status==='booked') {
            const slot=await env.DB.prepare('SELECT starts_at FROM slots WHERE id=? AND request_id=?').bind(row.booked_slot_id,row.id).first();
            if(!slot || slot.starts_at+row.review_minutes*60000>Date.now()) fail(409,'Finish the appointment before closing this review.');
            finishedAt=slot.starts_at+row.review_minutes*60000;
          } else fail(409,'Only a paid answer or completed appointment can be marked finished.');
          if(await env.DB.prepare("SELECT 1 FROM review_payments WHERE request_id=? AND status IN ('creating','open')").bind(row.id).first())fail(409,'Reconcile the pending review payment first.');
          if(await env.DB.prepare("SELECT 1 FROM deposit_payments WHERE request_id=? AND status IN ('creating','open')").bind(row.id).first())fail(409,'Reconcile the pending deposit payment first.');
          if(!await finishReview(env,row,finishedAt,answer)) fail(409,'This review could not be marked finished. Refresh and try again.');
        } else if(data.action==='track-access') {
          if(['expired','declined'].includes(row.status)||row.finished_at||row.purged_at||(row.status==='draft'&&row.created_at+7*DAY<=Date.now())||(!row.paid_at&&row.expires_at&&row.expires_at<=Date.now())) fail(409,'This request is closed.');
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
