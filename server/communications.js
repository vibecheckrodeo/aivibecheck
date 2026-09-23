import { encrypt, decrypt, randomSecret, sha256 } from './vault.js';

const DAY = 86400000;
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const get = (env, id) => env.DB.prepare('SELECT * FROM requests WHERE id=?').bind(id).first();
const contact = (env, id) => env.DB.prepare('SELECT * FROM email_contacts WHERE request_id=?').bind(id).first();
const requestLink = (env, id) => `${origin(env)}/?request=${encodeURIComponent(id)}#request`;
async function sendable(env, row, now = Date.now()) {
  if (!row || row.purged_at || row.finished_at || ['expired','declined'].includes(row.status)) return false;
  if (row.status === 'draft' && row.created_at + 7*DAY <= now) return false;
  if (!row.paid_at && row.expires_at && row.expires_at <= now) return false;
  if (row.booked_slot_id) {
    const slot = await env.DB.prepare('SELECT starts_at FROM slots WHERE id=? AND request_id=?').bind(row.booked_slot_id,row.id).first();
    if (!slot || slot.starts_at + (row.review_minutes || 15)*60000 <= now) return false;
  }
  return true;
}
function origin(env) {
  try { const url = new URL(env.PUBLIC_ORIGIN); if (url.protocol === 'https:' && !url.username && !url.password) return url.origin; } catch {}
  return 'https://vibecheck.rodeo';
}
export function emailConfiguration(env) {
  const transactional = Boolean(env.RESEND_API_KEY && env.RESEND_WEBHOOK_SECRET && env.EMAIL_FROM && /^[a-f0-9]{64}$/i.test(env.INTEGRATION_ENCRYPTION_KEY || ''));
  return { transactional, marketing: transactional && Boolean(env.EMAIL_POSTAL_ADDRESS), provider: 'resend' };
}
export async function initializeContact(env, row, consent = false, newRegistration = false) {
  if (!await sendable(env,row)) return;
  await env.DB.prepare('INSERT OR IGNORE INTO email_contacts(request_id,consent_at,auto_email_enabled) SELECT id,?,? FROM requests WHERE id=? AND purged_at IS NULL AND finished_at IS NULL').bind(consent === true ? Date.now() : null,Number(newRegistration),row.id).run();
}
export async function emailStatus(env, id) {
  const c = await contact(env, id);
  const messages = (await env.DB.prepare('SELECT category,kind,sequence,state,created_at,accepted_at,delivered_at,last_error FROM email_outbox WHERE request_id=? ORDER BY created_at').bind(id).all()).results;
  const row=await get(env,id);
  const materialRequests=['draft','submitted'].includes(row?.status)?(await env.DB.prepare("SELECT message,created_at FROM email_outbox WHERE request_id=? AND kind LIKE 'materials-%' ORDER BY created_at DESC LIMIT 10").bind(id).all()).results:[];
  return { ...emailConfiguration(env), consent: Boolean(c?.consent_at && !c?.unsubscribed_at), verified: Boolean(c?.verified_at), confirmationRequested: Boolean(c?.auto_email_enabled), messages, materialRequests };
}
export async function queueEmail(env, row, { kind, subject, message, category = 'transactional', dueAt = Date.now(), sequence = null }) {
  if (!await sendable(env,row)) return;
  await initializeContact(env, row);
  await env.DB.prepare('INSERT OR IGNORE INTO email_outbox(id,request_id,category,kind,sequence,subject,message,created_at,due_at) SELECT ?,id,?,?,?,?,?,?,? FROM requests WHERE id=? AND purged_at IS NULL AND finished_at IS NULL')
    .bind(crypto.randomUUID(), category, kind, sequence, subject, message, Date.now(), dueAt,row.id).run();
}
export async function saveReply(env, row, data) {
  if (!await sendable(env,row)) fail(409, 'This request is closed.');
  const reply = typeof data.reply === 'string' ? data.reply.trim() : '';
  if (!reply || reply.length > 4000 || ![15,30,60].includes(data.estimatedMinutes)) fail(400, 'Write your reply and choose a 15, 30, or 60 minute estimate.');
  if (typeof data.upsellEnabled !== 'boolean' || ![3,4].includes(data.upsellCount)) fail(400, 'Choose whether follow-ups are appropriate and select three or four.');
  if (data.upsellEnabled && data.estimatedMinutes === 15) fail(400, 'A 15-minute estimate does not need an upgrade campaign.');
  const now = Date.now();
  const saved=await env.DB.prepare(`UPDATE requests SET reply=?,estimated_minutes=?,reply_updated_at=?,upsell_enabled=?,upsell_count=?,updated_at=?
    WHERE id=? AND finished_at IS NULL AND purged_at IS NULL AND status NOT IN ('expired','declined')
      AND (status!='draft' OR created_at>?)
      AND (expires_at IS NULL OR paid_at IS NOT NULL OR expires_at>?)
      AND (booked_slot_id IS NULL OR EXISTS(SELECT 1 FROM slots WHERE id=booked_slot_id AND request_id=requests.id AND starts_at+requests.review_minutes*60000>?))`)
    .bind(reply, data.estimatedMinutes, now, Number(data.upsellEnabled), data.upsellCount, now, row.id,now-7*DAY,now,now).run();
  if(!saved.meta.changes)fail(409,'This request closed while saving the reply.');
  if(row.reply!==reply || row.estimated_minutes!==data.estimatedMinutes){
    await env.DB.prepare("UPDATE email_outbox SET state='cancelled',last_error='Replaced by the latest reply.' WHERE request_id=? AND kind LIKE 'reply-%' AND state='queued'").bind(row.id).run();
    await queueEmail(env, row, { kind: `reply-${now}-${crypto.randomUUID()}`, subject: 'My estimate for your project review', message: `${reply}\n\nI estimate ${data.estimatedMinutes} minutes. Your first $25 buys an answer or a 15-minute conversation. You can choose to keep it to 15 minutes.\n\nAshley` });
  }
  return get(env, row.id);
}
export async function requestMaterials(env, row, message) {
  if (!['draft','submitted'].includes(row.status) || !await sendable(env,row)) fail(409, 'Material requests are available while the project is being shared.');
  if (typeof message !== 'string' || !message.trim() || message.trim().length > 2000) fail(400, 'Describe the materials you need in 2,000 characters or less.');
  await queueEmail(env, row, { kind: `materials-${Date.now()}-${crypto.randomUUID()}`, subject: 'A few things I need for your project review', message: `${message.trim()}\n\nPlease add these to your private request page.\n\nAshley` });
}
export async function updateEmailConsent(env, row, consent) {
  if (!await sendable(env,row)) fail(409, 'This review is finished.');
  if (typeof consent !== 'boolean') fail(400, 'Choose your email preference.');
  await initializeContact(env, row);
  await env.DB.prepare('UPDATE email_contacts SET consent_at=?,unsubscribed_at=? WHERE request_id=?').bind(consent ? Date.now() : null, consent ? null : Date.now(), row.id).run();
  if (!consent) await suppressMarketing(env, row, 'unsubscribed');
  // A global opt-out cannot be undone just by registering again or clicking in a different request.
  if (consent && (await contact(env, row.id)).verified_at) await env.DB.prepare("DELETE FROM email_suppressions WHERE email_hash=? AND reason='unsubscribed'").bind(await sha256(row.email)).run();
  return emailStatus(env, row.id);
}
async function suppressMarketing(env, row, reason) {
  await env.DB.prepare('INSERT INTO email_suppressions(email_hash,reason,created_at) VALUES(?,?,?) ON CONFLICT(email_hash) DO UPDATE SET reason=excluded.reason,created_at=excluded.created_at').bind(await sha256(row.email), reason, Date.now()).run();
  await env.DB.prepare("UPDATE email_outbox SET state='cancelled',last_error='Marketing stopped.' WHERE category='marketing' AND state='queued' AND request_id IN (SELECT id FROM requests WHERE email=?)").bind(row.email).run();
}
async function tokens(env, c) {
  if (c.encrypted_tokens) return decrypt(env, c.encrypted_tokens, `email-contact:${c.request_id}`);
  const value = { verify: randomSecret(), unsubscribe: randomSecret() };
  const encrypted = await encrypt(env, value, `email-contact:${c.request_id}`);
  await env.DB.prepare("UPDATE email_contacts SET encrypted_tokens=?,verification_hash=?,verification_expires_at=?,unsubscribe_hash=? WHERE request_id=? AND encrypted_tokens=''")
    .bind(encrypted, await sha256(value.verify), Date.now()+7*DAY, await sha256(value.unsubscribe), c.request_id).run();
  return decrypt(env, (await contact(env, c.request_id)).encrypted_tokens, `email-contact:${c.request_id}`);
}
const page = (content, status = 200) => new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Email preferences — Vibe Check</title><body><main><h1>Vibe Check email</h1>${content}</main></body></html>`, { status, headers: { 'Content-Type':'text/html;charset=utf-8', 'Cache-Control':'no-store', 'Referrer-Policy':'no-referrer', 'Content-Security-Policy':"default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" } });
export async function handleEmailLink(request, env) {
  const url = new URL(request.url), action = url.pathname.split('/').pop();
  const id = url.searchParams.get('id') || '', token = url.searchParams.get('token') || '';
  if (!['verify','unsubscribe'].includes(action) || !/^[a-f0-9-]{36}$/.test(id) || !/^[a-f0-9]{64}$/.test(token)) return page('<p>This link is invalid.</p>',400);
  const row = await get(env,id), c = await contact(env,id);
  if (!row || !c || await sha256(token) !== c[action==='verify'?'verification_hash':'unsubscribe_hash']) return page('<p>This link is invalid.</p>',400);
  if (!['GET','POST'].includes(request.method)) return page('<p>Method not allowed.</p>',405);
  if (request.method === 'GET') return page(`<p>${action==='verify'?'Confirm this address to receive updates about your request.':'Stop optional emails about booking more time. Project and payment updates are separate.'}</p><form method="post"><button>${action==='verify'?'Confirm my email':'Unsubscribe'}</button></form>`);
  if (action==='verify') {
    if (c.verification_expires_at < Date.now()) return page('<p>This confirmation link has expired. Open your private request page to request another.</p>',410);
    await env.DB.prepare('UPDATE email_contacts SET verified_at=COALESCE(verified_at,?) WHERE request_id=?').bind(Date.now(),id).run();
    return page('<p>Your email is confirmed. Keep your private request link to open your project details.</p><a href="/">Return to Vibe Check</a>');
  }
  await env.DB.prepare('UPDATE email_contacts SET unsubscribed_at=? WHERE request_id IN (SELECT id FROM requests WHERE email=?)').bind(Date.now(),row.email).run();
  await suppressMarketing(env,row,'unsubscribed');
  return page('<p>You’re unsubscribed from optional upgrade emails. Project and payment updates are separate.</p><a href="/">Return to Vibe Check</a>');
}
export async function resendVerification(env, row, now = Date.now(), userRequested = false) {
  if (!await sendable(env,row,now)) fail(409, 'This review is finished.');
  if (!emailConfiguration(env).transactional) fail(503,'Email sending is not connected yet. Keep your private request link.');
  await initializeContact(env,row);
  if(userRequested)await env.DB.prepare('UPDATE email_contacts SET auto_email_enabled=1 WHERE request_id=?').bind(row.id).run();
  const c = await contact(env,row.id);
  if (c.verified_at) return;
  const prior = await env.DB.prepare("SELECT created_at FROM email_outbox WHERE request_id=? AND category='verification' ORDER BY created_at DESC LIMIT 1").bind(row.id).first();
  if (prior && Date.now()-prior.created_at < DAY) fail(429,'A confirmation email was already requested today.');
  if (c.verification_expires_at && c.verification_expires_at < Date.now()) await env.DB.prepare("UPDATE email_contacts SET encrypted_tokens='',verification_hash=NULL WHERE request_id=?").bind(row.id).run();
  await queueEmail(env,row,{category:'verification',kind:`verify-${Date.now()}`,dueAt:now,subject:'Confirm your Vibe Check email',message:'Confirm your email address to receive updates about your project. If you did not register, you can ignore this email.'});
}

export async function handleCommunications(request, env, path, method, helpers, available) {
  const json = value => new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  if (path[0]==='email') return handleEmailLink(request,env);
  if (path[0]==='requests' && path[1] && ['email','verify-email'].includes(path[2])) {
    const row=await helpers.authenticate(request,env,path[1]);
    if (method==='GET' && path[2]==='email') return json(await emailStatus(env,row.id));
    if (method==='POST' && path[2]==='email') return json(await updateEmailConsent(env,row,(await helpers.body(request)).consent));
    if (method==='POST' && path[2]==='verify-email') { await resendVerification(env,row,Date.now(),true); return json({queued:true}); }
  }
  if (path[0]==='admin' && path[1]==='email' && method==='POST') {
    await helpers.administrator(request,env);
    return json(await processEmails(env,available));
  }
  if (path[0]==='admin' && path[1]==='requests' && path[2] && ['reply','materials','email'].includes(path[3])) {
    await helpers.administrator(request,env);
    const row=await get(env,path[2]); if(!row) fail(404,'Request not found.');
    if (path[3]==='email' && method==='GET') return json(await emailStatus(env,row.id));
    if (method==='POST' && path[3]==='reply') { await saveReply(env,row,await helpers.body(request)); return json({saved:true}); }
    if (method==='POST' && path[3]==='materials') { await requestMaterials(env,row,(await helpers.body(request)).message); return json({queued:true}); }
  }
  return null;
}

export const dripCopy = [
  ['About the time for your review', 'I’ve sent you my estimate. If you’d like more time together, you can reserve 30 minutes for $45 or an hour for $80. Your $25 deposit counts toward either total. Keeping the first 15 minutes is fine too.'],
  ['What the extra time is for', 'A longer session gives us time to work through the problem together and discuss what to ask your coding agent next. I’ll spend the time you book with you. It doesn’t include implementation or a full audit.'],
  ['Choose the time that works for you', 'Thirty minutes is $45 total, a 10% discount. An hour is $80 total, a 20% discount. After the $25 deposit, that’s another $20 or $55. Extra time must be available, reserved, and paid for before the call. Upgrade payments are non-refundable.'],
  ['One last note before your review', 'This is my last note about booking more time. If you want a longer session, check the available times on your request page. Otherwise, we’ll use the 15 minutes for a conversation about your project.']
];
async function eligible(env, row, c, available, now) {
  if (!await sendable(env,row,now) || row.review_mode === 'answer' || !c?.auto_email_enabled || !c.verified_at || !c.consent_at || c.unsubscribed_at || !row.upsell_enabled || !row.reply || !row.paid_at || !['paid','booked'].includes(row.status)) return false;
  if (await env.DB.prepare('SELECT 1 FROM email_suppressions WHERE email_hash=?').bind(await sha256(row.email)).first()) return false;
  const minutes = row.review_minutes || 15;
  if (minutes > 15 || minutes >= row.estimated_minutes) return false;
  if (await env.DB.prepare("SELECT 1 FROM review_payments WHERE request_id=? AND status IN ('creating','open')").bind(row.id).first()) return false;
  if (row.booked_slot_id) {
    const booked = await env.DB.prepare('SELECT starts_at FROM slots WHERE id=?').bind(row.booked_slot_id).first();
    if (!booked || booked.starts_at <= now+DAY) return false;
  }
  try{return (await available(env,row,row.estimated_minutes,now)).length > 0;}
  catch{return false;}
}
async function scheduleDrips(env, available, now) {
  const rows = (await env.DB.prepare("SELECT * FROM requests WHERE upsell_enabled=1 AND finished_at IS NULL AND paid_at IS NOT NULL AND status IN ('paid','booked')").all()).results;
  for (const row of rows) {
    const c = await contact(env,row.id);
    if (!await eligible(env,row,c,available,now)) continue;
    const start = Math.max(row.paid_at,row.reply_updated_at || 0,c.consent_at,c.verified_at);
    for (let i=0;i<row.upsell_count;i++) await queueEmail(env,row,{category:'marketing',kind:`upgrade-${i+1}`,sequence:i+1,subject:dripCopy[i][0],message:dripCopy[i][1],dueAt:start+[1,3,5,6][i]*DAY});
  }
}
async function scheduleReceipts(env) {
  const rows=(await env.DB.prepare("SELECT r.* FROM requests r JOIN email_contacts c ON c.request_id=r.id WHERE r.finished_at IS NULL AND c.auto_email_enabled=1 AND r.status IN ('approved','paid','booked') ORDER BY r.updated_at DESC LIMIT 200").all()).results;
  for(const row of rows){
    if(!await sendable(env,row))continue;
    if(row.status==='approved') await queueEmail(env,row,{kind:'approved',subject:'Your Vibe Check request is approved',message:`I’ve approved your request.\n\nReview focus: ${row.scope}\n\nOpen your private request page to see the agreed scope and choose a written answer or a call when checkout is available. If you choose a call, select a time before paying the $25 deposit.\n\nAshley`});
    if(row.paid_at) await queueEmail(env,row,{kind:'deposit-confirmed',subject:'Your Vibe Check deposit is confirmed',message:row.review_mode==='answer'?'Your $25 deposit has been verified for a written answer. I’ll post the final answer on your private request page. Keep your private link to read it.':row.review_mode==='call'?'Your $25 deposit is confirmed and your selected 15-minute appointment is booked. The time and meeting link are on your private request page.':'Your $25 deposit has been verified. Open your private request page for the next step.'});
    if(row.booked_slot_id){
      const slot=await env.DB.prepare('SELECT * FROM slots WHERE id=? AND request_id=?').bind(row.booked_slot_id,row.id).first();
      if(slot){
        const minutes=row.review_minutes || 15;
        const date=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',weekday:'long',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(slot.starts_at));
        await queueEmail(env,row,{kind:`booked-${slot.id}-${minutes}`,subject:'Your Vibe Check appointment',message:`Your ${minutes}-minute review is booked for ${date}.\n\nJoin your review: ${slot.zoom_url}\n\nI’ll spend the time you booked with you.\n\nAshley`});
      }
    }
  }
}
async function payload(env, job, row, c) {
  const value = await tokens(env,c), link = `${origin(env)}/api/email/`;
  const unsubscribe = `${link}unsubscribe?id=${row.id}&token=${value.unsubscribe}`;
  let text = job.message;
  if (job.category==='verification') text += `\n\n${link}verify?id=${row.id}&token=${value.verify}`;
  else text += `\n\nOpen your request on the device you registered with: ${requestLink(env,row.id)}\nOn another device, use the private link you saved when registering.`;
  if (job.category==='marketing') text += `\n\nAshley Raiteri · Vibe Check\n${env.EMAIL_POSTAL_ADDRESS}\n\nStop upgrade emails: ${unsubscribe}`;
  return { from:env.EMAIL_FROM,to:[row.email],reply_to:env.EMAIL_REPLY_TO || 'ashley@vibecheck.rodeo',subject:job.subject,text,
    ...(job.category==='marketing'?{headers:{'List-Unsubscribe':`<${unsubscribe}>`,'List-Unsubscribe-Post':'List-Unsubscribe=One-Click'}}:{}) };
}
export async function processEmails(env, available = async()=>[], now = Date.now()) {
  await env.DB.prepare('DELETE FROM email_delivery_events WHERE received_at<?').bind(now-7*DAY).run();
  const config=emailConfiguration(env);
  if (!config.transactional) return { configured:false,accepted:0 };
  await scheduleReceipts(env);
  // New and migrated requests can confirm ownership before any project content is emailed.
  const contacts=(await env.DB.prepare('SELECT r.* FROM requests r JOIN email_contacts c ON c.request_id=r.id WHERE r.finished_at IS NULL AND r.purged_at IS NULL AND c.auto_email_enabled=1 AND c.verified_at IS NULL AND r.status NOT IN (\'expired\',\'declined\') AND NOT EXISTS(SELECT 1 FROM email_outbox o WHERE o.request_id=r.id AND o.category=\'verification\') LIMIT 20').all()).results;
  for (const row of contacts) if(await sendable(env,row,now)) await resendVerification(env,row,now);
  if (config.marketing) await scheduleDrips(env,available,now);
  let accepted=0;
  const jobs=(await env.DB.prepare("SELECT * FROM email_outbox WHERE (state='queued' AND due_at<=?) OR (state='sending' AND lease_until<=?) ORDER BY due_at LIMIT 50").bind(now,now).all()).results;
  for (const job of jobs) {
    const row=await get(env,job.request_id), c=await contact(env,job.request_id);
    if(!await sendable(env,row,now)){await env.DB.prepare("UPDATE email_outbox SET state='cancelled',last_error='Review finished.' WHERE id=? AND state IN ('queued','sending')").bind(job.id).run();continue;}
    if(!c?.auto_email_enabled)continue;
    const suppression=await env.DB.prepare('SELECT reason FROM email_suppressions WHERE email_hash=?').bind(await sha256(row.email)).first();
    if ((suppression && suppression.reason!=='unsubscribed') || ['declined','expired'].includes(row.status) || (job.kind.startsWith('materials-') && !['draft','submitted'].includes(row.status)) || (job.category==='marketing' && (job.sequence>row.upsell_count || !await eligible(env,row,c,available,now)))) {
      await env.DB.prepare("UPDATE email_outbox SET state='cancelled',last_error='Request or email preference changed.' WHERE id=? AND state IN ('queued','sending')").bind(job.id).run(); continue;
    }
    if (job.category!=='verification' && !c?.verified_at) continue;
    if (job.category==='marketing' && (!config.marketing || (c.last_marketing_at && now-c.last_marketing_at<DAY))) continue;
    // Past Resend's 24h idempotency window, an ambiguous send needs an operator, not another send.
    if (job.first_attempt_at && now-job.first_attempt_at >= 23*3600000) {
      await env.DB.prepare("UPDATE email_outbox SET state='review',last_error='Delivery is uncertain. Check the provider before any resend.' WHERE id=?").bind(job.id).run(); continue;
    }
    const lease=await env.DB.prepare("UPDATE email_outbox SET state='sending',lease_until=? WHERE id=? AND ((state='queued' AND due_at<=?) OR (state='sending' AND lease_until<=?))")
      .bind(now+120000,job.id,now,now).run();
    if (!lease.meta.changes) continue;
    if (job.category==='marketing') {
      const locked=await env.DB.prepare('UPDATE email_contacts SET marketing_lease_until=? WHERE request_id=? AND (marketing_lease_until IS NULL OR marketing_lease_until<=?) AND (last_marketing_at IS NULL OR last_marketing_at<=?)').bind(now+120000,row.id,now,now-DAY).run();
      if (!locked.meta.changes) { await env.DB.prepare("UPDATE email_outbox SET state='queued',lease_until=NULL WHERE id=?").bind(job.id).run(); continue; }
    }
    await env.DB.prepare('UPDATE email_outbox SET first_attempt_at=COALESCE(first_attempt_at,?) WHERE id=?').bind(now,job.id).run();
    try {
      let data;
      if (job.encrypted_payload) data=await decrypt(env,job.encrypted_payload,`email:${job.id}`);
      else {
        data=await payload(env,job,row,c);
        await env.DB.prepare('UPDATE email_outbox SET encrypted_payload=? WHERE id=?').bind(await encrypt(env,data,`email:${job.id}`),job.id).run();
      }
      if(!await sendable(env,await get(env,row.id),Date.now())){
        await env.DB.prepare("UPDATE email_outbox SET state='cancelled',last_error='Review finished.',encrypted_payload='' WHERE id=? AND state='sending'").bind(job.id).run();
        continue;
      }
      const response=await (env.EMAIL_FETCH || fetch)('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':`vibecheck-email/${job.id}`},body:JSON.stringify(data),signal:AbortSignal.timeout(20000)});
      const result=await response.json();
      if (!response.ok || typeof result.id!=='string') throw new Error('Email provider did not confirm acceptance.');
      await env.DB.prepare("UPDATE email_outbox SET state='accepted',provider_id=?,accepted_at=?,last_error=NULL,lease_until=NULL WHERE id=?").bind(result.id,now,job.id).run();
      await applyStoredDelivery(env,result.id);
      if (job.category==='marketing') await env.DB.prepare('UPDATE email_contacts SET last_marketing_at=?,marketing_lease_until=NULL WHERE request_id=?').bind(now,row.id).run();
      accepted++;
    } catch {
      await env.DB.prepare("UPDATE email_outbox SET state='queued',due_at=?,lease_until=NULL,last_error='Provider acceptance is unconfirmed; retry uses the same message key.' WHERE id=? AND state='sending'").bind(now+900000,job.id).run();
      if (job.category==='marketing') await env.DB.prepare('UPDATE email_contacts SET marketing_lease_until=? WHERE request_id=?').bind(now+900000,row.id).run();
    }
  }
  // API acceptance is not delivery. Signed Resend webhooks provide receipts.
  return {configured:true,accepted};
}

const deliveryRank={delivered:1,review:2,bounced:3,complained:4};
async function applyStoredDelivery(env,providerId){
  const event=await env.DB.prepare('SELECT state,received_at FROM email_delivery_events WHERE provider_id=?').bind(providerId).first();
  const job=await env.DB.prepare('SELECT * FROM email_outbox WHERE provider_id=?').bind(providerId).first();
  if(!event||!job)return;
  const existingRank=deliveryRank[job.state]||0;
  if(deliveryRank[event.state]<existingRank)return;
  await env.DB.prepare("UPDATE email_outbox SET state=?,checked_at=?,delivered_at=CASE WHEN ?='delivered' THEN coalesce(delivered_at,?) ELSE delivered_at END,last_error=CASE WHEN ?='review' THEN 'Delivery failed; Ashley needs to check the provider.' ELSE last_error END WHERE id=?").bind(event.state,event.received_at,event.state,event.received_at,event.state,job.id).run();
  if(['review','bounced','complained'].includes(event.state))await suppressMarketing(env,await get(env,job.request_id),event.state==='review'?'delivery-failed':event.state);
}
export async function recordEmailDelivery(env,providerId,state,receivedAt=Date.now()){
  if(!Object.hasOwn(deliveryRank,state)||typeof providerId!=='string'||providerId.length<8||providerId.length>200)return;
  await env.DB.prepare(`INSERT INTO email_delivery_events(provider_id,state,received_at) VALUES(?,?,?)
    ON CONFLICT(provider_id) DO UPDATE SET state=CASE WHEN
    CASE excluded.state WHEN 'complained' THEN 4 WHEN 'bounced' THEN 3 WHEN 'review' THEN 2 ELSE 1 END >
    CASE email_delivery_events.state WHEN 'complained' THEN 4 WHEN 'bounced' THEN 3 WHEN 'review' THEN 2 ELSE 1 END
    THEN excluded.state ELSE email_delivery_events.state END, received_at=excluded.received_at`).bind(providerId,state,receivedAt).run();
  await applyStoredDelivery(env,providerId);
}
