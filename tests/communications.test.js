import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {initializeContact,saveReply,requestMaterials,queueEmail,updateEmailConsent,processEmails,handleEmailLink,emailStatus,resendVerification} from '../server/communications.js';
import {decrypt,sha256} from '../server/vault.js';
import {handle} from '../server/api.js';
import {verifyResendSignature} from '../server/resend-webhook.js';
const DAY=86400000;
function setup(){
  const sql=new DatabaseSync(':memory:');for(const file of readdirSync('migrations').filter(x=>x.endsWith('.sql')).sort())sql.exec(readFileSync(`migrations/${file}`,'utf8'));
  const statement=(query,args=[])=>({bind(...values){return statement(query,values);},async first(){return sql.prepare(query).get(...args)||null;},async all(){return{results:sql.prepare(query).all(...args)};},async run(){return{meta:{changes:Number(sql.prepare(query).run(...args).changes)}};}});
  const env={DB:{prepare:statement},INTEGRATION_ENCRYPTION_KEY:'ab'.repeat(32),RESEND_API_KEY:'fixture',RESEND_WEBHOOK_SECRET:'whsec_'+btoa('test-signing-secret'),EMAIL_FROM:'Ashley <ashley@example.com>',EMAIL_POSTAL_ADDRESS:'Test business address',PUBLIC_ORIGIN:'https://vibecheck.test'};
  const now=Date.now(),id=crypto.randomUUID();sql.prepare("INSERT INTO requests(id,token_hash,name,email,ip_hash,status,paid_at,created_at,updated_at) VALUES(?,'fixture','Example','example@example.com','fixture','paid',?,?,?)").run(id,now-2*DAY,now-3*DAY,now);
  sql.prepare('INSERT INTO email_contacts(request_id,auto_email_enabled) VALUES(?,1)').run(id);
  const row=()=>sql.prepare('SELECT * FROM requests WHERE id=?').get(id);
  const calls=[];env.EMAIL_FETCH=async(url,options)=>{calls.push({url,options});return Response.json(options.method==='POST'?{id:'message-'+calls.length}:{id:url.split('/').pop(),last_event:'sent'});};
  return{sql,env,id,row,calls,now,available:async()=>[{id:'real-slot'}]};
}
async function campaign(t,count=3){await initializeContact(t.env,t.row(),true);t.sql.prepare('UPDATE email_contacts SET verified_at=?,consent_at=?').run(t.now-2*DAY,t.now-2*DAY);await saveReply(t.env,t.row(),{reply:'I can help trace the deployment failure.',estimatedMinutes:60,upsellEnabled:true,upsellCount:count});t.sql.prepare('UPDATE requests SET reply_updated_at=?').run(t.now-2*DAY);}
async function delivery(t,providerId,type){
  const raw=JSON.stringify({type,created_at:new Date().toISOString(),data:{email_id:providerId,from:t.env.EMAIL_FROM,to:['example@example.com']}});
  const stamp=String(Math.floor(Date.now()/1000)),id='msg_test_webhook';
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode('test-signing-secret'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`${id}.${stamp}.${raw}`)))));
  return handle(new Request('https://vibecheck.test/api/resend-webhook',{method:'POST',headers:{'svix-id':id,'svix-timestamp':stamp,'svix-signature':`v1,${signature}`},body:raw}),t.env);
}
test('Svix fixture signature verifies without changing the raw body',async()=>{
  const raw='{"event_type":"ping","data":{"success":true}}';
  // Fixed HMAC-SHA256 vector for the clearly synthetic key "fixture".
  const headers=new Headers({'svix-id':'msg_fixture','svix-timestamp':'1731705121','svix-signature':'v1,96Afdu3MKaIHMGdLk4ocBZAcNOh8nKPKZOUqqfADzII='});
  await verifyResendSignature(raw,headers,'whsec_Zml4dHVyZQ==',1731705121000);
  await assert.rejects(verifyResendSignature(raw+' ',headers,'whsec_Zml4dHVyZQ==',1731705121000),{status:400});
});
test('missing sender never pretends to send; materials are separate and visible on the request',async()=>{const t=setup();delete t.env.RESEND_API_KEY;await initializeContact(t.env,t.row());t.sql.prepare("UPDATE requests SET status='submitted',paid_at=NULL").run();await requestMaterials(t.env,t.row(),'Please share the deployment log.');assert.equal((await processEmails(t.env)).configured,false);assert.equal(t.calls.length,0);const status=await emailStatus(t.env,t.id);assert.match(status.materialRequests[0].message,/deployment log/);assert.equal(status.messages[0].category,'transactional');assert.equal(status.messages[0].state,'queued');});
test('email confirmation requires a valid token and a POST, not a scanner GET',async()=>{const t=setup();await initializeContact(t.env,t.row(),true);await processEmails(t.env);const post=t.calls.find(c=>c.options.method==='POST');const data=JSON.parse(post.options.body);const link=data.text.match(/https:\/\/vibecheck.test\/api\/email\/verify\?\S+/)[0];assert.equal(t.sql.prepare('SELECT verified_at FROM email_contacts').get().verified_at,null);assert.equal((await handleEmailLink(new Request(link),t.env)).status,200);assert.equal(t.sql.prepare('SELECT verified_at FROM email_contacts').get().verified_at,null);assert.equal((await handleEmailLink(new Request(link,{method:'POST'}),t.env)).status,200);assert.ok(t.sql.prepare('SELECT verified_at FROM email_contacts').get().verified_at);assert.equal((await handleEmailLink(new Request(link.replace(/token=.*/,'token='+'a'.repeat(64)),{method:'POST'}),t.env)).status,400);});
test('the sequence requires consent, verified email, Ashley recommendation, payment and real availability',async()=>{const t=setup();await campaign(t);await updateEmailConsent(t.env,t.row(),false);await processEmails(t.env,t.available,t.now);assert.equal(t.sql.prepare("SELECT count(*) AS n FROM email_outbox WHERE category='marketing'").get().n,0);await updateEmailConsent(t.env,t.row(),true);await processEmails(t.env,async()=>[],t.now);assert.equal(t.sql.prepare("SELECT count(*) AS n FROM email_outbox WHERE category='marketing'").get().n,0);t.sql.prepare('UPDATE email_contacts SET consent_at=?').run(t.now-2*DAY);await processEmails(t.env,t.available,t.now);assert.equal(t.sql.prepare("SELECT count(*) AS n FROM email_outbox WHERE category='marketing'").get().n,3);assert.equal(t.sql.prepare("SELECT count(*) AS n FROM email_outbox WHERE category='marketing' AND state='accepted'").get().n,1);});
test('answer deposits get a receipt without call upgrade marketing',async()=>{
  const t=setup();await campaign(t);
  t.sql.prepare("UPDATE requests SET review_mode='answer' WHERE id=?").run(t.id);
  await processEmails(t.env,t.available,Date.now()+1000);
  assert.equal(t.sql.prepare("SELECT count(*) AS n FROM email_outbox WHERE category='marketing'").get().n,0);
  const receipt=t.calls.filter(c=>c.options.method==='POST').map(c=>JSON.parse(c.options.body)).find(p=>p.subject==='Your Vibe Check deposit is confirmed');
  assert.ok(receipt);
  assert.match(receipt.text,/deposit has been verified for a written answer/);
  assert.doesNotMatch(receipt.text,/appointment is booked|meeting link/);
});
test('three or four optional messages are spaced, transactional messages do not use their quota',async()=>{const t=setup();await campaign(t,4);await processEmails(t.env,t.available,t.now);await processEmails(t.env,t.available,t.now+6*DAY);assert.equal(t.sql.prepare("SELECT count(*) AS n FROM email_outbox WHERE category='marketing' AND state='accepted'").get().n,2);await processEmails(t.env,t.available,t.now+6*DAY+60000);assert.equal(t.sql.prepare("SELECT count(*) AS n FROM email_outbox WHERE category='marketing' AND state='accepted'").get().n,2);assert.ok(t.sql.prepare("SELECT count(*) AS n FROM email_outbox WHERE category='transactional' AND state='accepted'").get().n);const marketing=t.calls.filter(c=>c.options.method==='POST').map(c=>JSON.parse(c.options.body)).find(p=>p.headers);assert.ok(marketing.headers['List-Unsubscribe']);assert.match(marketing.text,/\$45/);});
test('unsubscribe stops optional mail across requests but does not cancel transactional updates',async()=>{const t=setup();await campaign(t);await processEmails(t.env,t.available,t.now);const c=t.sql.prepare('SELECT * FROM email_contacts').get();const tokens=await decrypt(t.env,c.encrypted_tokens,`email-contact:${t.id}`);await handleEmailLink(new Request(`https://vibecheck.test/api/email/unsubscribe?id=${t.id}&token=${tokens.unsubscribe}`,{method:'POST'}),t.env);await queueEmail(t.env,t.row(),{kind:'new-project-update',subject:'Project update',message:'Your review details are ready.'});await processEmails(t.env,t.available,t.now+4*DAY);assert.equal(t.sql.prepare("SELECT count(*) AS n FROM email_outbox WHERE category='marketing' AND state='accepted'").get().n,1);assert.equal(t.sql.prepare("SELECT state FROM email_outbox WHERE kind='new-project-update'").get().state,'accepted');});
test('provider timeouts retry identical encrypted payload with one key and stop outside idempotency window',async()=>{
  const t=setup();
  await initializeContact(t.env,t.row());
  t.sql.prepare('UPDATE email_contacts SET verified_at=?').run(t.now);
  await queueEmail(t.env,t.row(),{kind:'deposit-confirmed',subject:'Your deposit',message:'Your deposit was verified.'});
  // Start after asynchronous setup has queued the message, even under load.
  const firstAttempt=Date.now();
  const calls=[];
  t.env.EMAIL_FETCH=async(url,options)=>{calls.push(options);throw new Error('provider timeout');};
  await processEmails(t.env,t.available,firstAttempt);
  assert.equal(calls.length,1);
  t.env.EMAIL_FROM='Changed <changed@example.com>';
  await processEmails(t.env,t.available,firstAttempt+900000);
  assert.equal(calls.length,2);
  assert.equal(calls[0].body,calls[1].body);
  assert.equal(calls[0].headers['Idempotency-Key'],calls[1].headers['Idempotency-Key']);
  await processEmails(t.env,t.available,firstAttempt+DAY);
  assert.equal(calls.length,2);
  assert.equal(t.sql.prepare('SELECT state FROM email_outbox').get().state,'review');
});
test('acceptance is not delivery; signed bounce suppresses optional mail',async()=>{const t=setup();await campaign(t);await processEmails(t.env,t.available,t.now);assert.equal(t.sql.prepare("SELECT count(*) AS n FROM email_outbox WHERE state='delivered'").get().n,0);const id=t.sql.prepare("SELECT provider_id FROM email_outbox WHERE state='accepted' LIMIT 1").get().provider_id;assert.equal((await delivery(t,id,'email.bounced')).status,200);assert.equal(t.sql.prepare('SELECT reason FROM email_suppressions').get().reason,'bounced');await processEmails(t.env,t.available,t.now+4*DAY);assert.equal(t.sql.prepare("SELECT count(*) AS n FROM email_outbox WHERE category='marketing' AND state='queued'").get().n,0);});
test('no upgrades are marketed within 24 hours of the appointment or without a mailing address',async()=>{const t=setup();await campaign(t);delete t.env.EMAIL_POSTAL_ADDRESS;await processEmails(t.env,t.available,t.now);assert.equal(t.sql.prepare("SELECT count(*) AS n FROM email_outbox WHERE category='marketing'").get().n,0);t.env.EMAIL_POSTAL_ADDRESS='Test address';t.sql.prepare("INSERT INTO slots(id,starts_at,ends_at,zoom_url,request_id,created_at) VALUES('booked',?,?,'https://meet.proton.me/join/id-TESTROOM01#pwd-TESTPASS0001',?,?)").run(t.now+3600000,t.now+4500000,t.id,t.now);t.sql.prepare("UPDATE requests SET booked_slot_id='booked',status='booked'").run();await processEmails(t.env,t.available,t.now);assert.equal(t.sql.prepare("SELECT count(*) AS n FROM email_outbox WHERE category='marketing'").get().n,0);});
test('a reduced campaign cancels its fourth message; unconfirmed contacts never get private replies',async()=>{const t=setup();await campaign(t,4);await processEmails(t.env,t.available,t.now);t.sql.prepare('UPDATE requests SET upsell_count=3').run();await processEmails(t.env,t.available,t.now+6*DAY);assert.equal(t.sql.prepare("SELECT state FROM email_outbox WHERE kind='upgrade-4'").get().state,'cancelled');const other=setup();await saveReply(other.env,other.row(),{reply:'Private project advice',estimatedMinutes:30,upsellEnabled:true,upsellCount:3});await processEmails(other.env,other.available,other.now);const sent=other.calls.filter(c=>c.options.method==='POST');assert.equal(sent.length,1);assert.doesNotMatch(sent[0].options.body,/Private project advice/);});
test('a signed complaint after delivery suppresses future mail',async()=>{const t=setup();await campaign(t);await processEmails(t.env,t.available,t.now);const id=t.sql.prepare("SELECT provider_id FROM email_outbox WHERE state='accepted' LIMIT 1").get().provider_id;await delivery(t,id,'email.delivered');assert.ok(t.sql.prepare("SELECT count(*) AS n FROM email_outbox WHERE state='delivered'").get().n);await delivery(t,id,'email.complained');assert.equal(t.sql.prepare('SELECT reason FROM email_suppressions').get().reason,'complained');});
test('a webhook arriving before send acceptance is applied when the provider ID is saved',async()=>{
  const t=setup();await campaign(t);
  t.env.EMAIL_FETCH=async()=>{await delivery(t,'early-message-123','email.delivered');return Response.json({id:'early-message-123'});};
  await processEmails(t.env,t.available,t.now);
  assert.equal(t.sql.prepare("SELECT state FROM email_outbox WHERE provider_id='early-message-123'").get().state,'delivered');
});
test('signed provider failure needs review and stops optional mail',async()=>{
  const t=setup();await campaign(t);await processEmails(t.env,t.available,t.now);
  const id=t.sql.prepare("SELECT provider_id FROM email_outbox WHERE state='accepted' LIMIT 1").get().provider_id;
  assert.equal((await delivery(t,id,'email.failed')).status,200);
  assert.equal(t.sql.prepare('SELECT state FROM email_outbox WHERE provider_id=?').get(id).state,'review');
  assert.equal(t.sql.prepare('SELECT reason FROM email_suppressions').get().reason,'delivery-failed');
});
test('unsigned delivery and old migrated contacts cannot trigger mail',async()=>{
  const t=setup();t.sql.prepare('UPDATE email_contacts SET auto_email_enabled=0').run();
  await queueEmail(t.env,t.row(),{kind:'old-receipt',subject:'Old receipt',message:'Old'});
  await processEmails(t.env,t.available,t.now);
  assert.equal(t.calls.length,0);
  assert.equal(t.sql.prepare("SELECT state FROM email_outbox WHERE kind='old-receipt'").get().state,'queued');
  const bad=await handle(new Request('https://vibecheck.test/api/resend-webhook',{method:'POST',headers:{'svix-id':'msg_test','svix-timestamp':String(Math.floor(Date.now()/1000)),'svix-signature':'v1,invalid'},body:'{}'}),t.env);
  assert.equal(bad.status,400);
});
test('reply and email routes enforce admin and request ownership',async()=>{
  const t=setup();t.env.ADMIN_TOKEN='admin-fixture';const credential='a'.repeat(64);t.sql.prepare('UPDATE requests SET token_hash=?').run(await sha256(credential));
  const call=(path,key,body)=>handle(new Request(`https://vibecheck.test/api/${path}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${key}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined}),t.env);
  const reply={reply:'I estimate half an hour.',estimatedMinutes:30,upsellEnabled:true,upsellCount:3};
  assert.equal((await call(`admin/requests/${t.id}/reply`,credential,reply)).status,401);
  assert.equal((await call(`admin/requests/${t.id}/reply`,'admin-fixture',reply)).status,200);
  assert.equal((await call(`requests/${t.id}/email`,'b'.repeat(64))).status,401);
  const own=await (await call(`requests/${t.id}`,credential)).json();assert.equal(own.reply,reply.reply);assert.equal(own.estimated_minutes,30);
  assert.equal((await call(`requests/${t.id}/email`,credential,{consent:false})).status,200);
});
test('campaign settings do not send another reply; edited advice replaces an unsent reply',async()=>{
  const t=setup(), data={reply:'I suggest half an hour.',estimatedMinutes:30,upsellEnabled:true,upsellCount:3};
  await saveReply(t.env,t.row(),data);
  await saveReply(t.env,t.row(),{...data,upsellCount:4});
  assert.equal(t.sql.prepare("SELECT count(*) AS n FROM email_outbox WHERE kind LIKE 'reply-%'").get().n,1);
  await saveReply(t.env,t.row(),{...data,reply:'An hour will cover both issues.',estimatedMinutes:60});
  const jobs=t.sql.prepare("SELECT state,message FROM email_outbox WHERE kind LIKE 'reply-%'").all();
  assert.equal(jobs.filter(j=>j.state==='queued').length,1);
  assert.match(jobs.find(j=>j.state==='queued').message,/An hour/);
});
test('approval removes outstanding materials prompts and cancels unsent material email',async()=>{
  const t=setup();await initializeContact(t.env,t.row());t.sql.prepare("UPDATE requests SET status='submitted'").run();
  await requestMaterials(t.env,t.row(),'Please share the log.');
  t.sql.prepare("UPDATE requests SET status='approved'").run();
  assert.deepEqual((await emailStatus(t.env,t.id)).materialRequests,[]);
  await processEmails(t.env,t.available,t.now+100);
  assert.equal(t.sql.prepare("SELECT state FROM email_outbox WHERE kind LIKE 'materials-%'").get().state,'cancelled');
  assert.ok(t.calls.every(c=>!c.options.body?.includes('Please share the log.')));
});
test('a pending paid extension pauses optional upgrade messages',async()=>{
  const t=setup();await campaign(t);
  t.sql.prepare("INSERT INTO slots(id,starts_at,ends_at,zoom_url,created_at) VALUES('held',?,?,'https://meet.proton.me/join/id-TESTROOM01#pwd-TESTPASS0001',?)").run(t.now+3*DAY,t.now+3*DAY+900000,t.now);
  t.sql.prepare("INSERT INTO review_payments(id,request_id,minutes,from_minutes,amount_cents,total_cents,slot_id,status,checkout_expires_at,stripe_payload,created_at) VALUES('pending',?,30,15,2000,4500,'held','open',?,'{}',?)").run(t.id,t.now+1800000,t.now);
  await processEmails(t.env,t.available,t.now+100);
  assert.equal(t.sql.prepare("SELECT count(*) AS n FROM email_outbox WHERE category='marketing'").get().n,0);
});

test('written-answer buyers do not receive call-upgrade drips or booking instructions',async()=>{
  const t=setup();
  if(!t.sql.prepare('PRAGMA table_info(requests)').all().some(column=>column.name==='review_mode'))t.sql.exec('ALTER TABLE requests ADD COLUMN review_mode TEXT');
  t.sql.prepare("UPDATE requests SET review_mode='answer'").run();
  await campaign(t);
  await processEmails(t.env,t.available,t.now);
  assert.equal(t.sql.prepare("SELECT count(*) AS n FROM email_outbox WHERE category='marketing'").get().n,0);
  const receipt=t.sql.prepare("SELECT message FROM email_outbox WHERE kind='deposit-confirmed'").get();
  assert.ok(receipt);
  assert.match(receipt.message,/written answer/);
  assert.doesNotMatch(receipt.message,/choose an available appointment/i);
});

test('booking email preserves the full Proton link and does not describe it as Zoom',async()=>{
  const t=setup();await initializeContact(t.env,t.row());
  t.sql.prepare('UPDATE email_contacts SET verified_at=?').run(t.now);
  const meetingUrl='https://meet.proton.me/join/id-TESTROOM01#pwd-TESTPASS0001';
  t.sql.prepare('INSERT INTO slots(id,starts_at,ends_at,zoom_url,request_id,created_at) VALUES(?,?,?,?,?,?)')
    .run('proton-slot',t.now+86400000,t.now+87300000,meetingUrl,t.id,t.now);
  t.sql.prepare("UPDATE requests SET booked_slot_id='proton-slot',status='booked'").run();
  await processEmails(t.env,t.available,t.now+1000);
  const receipt=t.calls.filter(c=>c.options.method==='POST').map(c=>JSON.parse(c.options.body)).find(p=>p.subject==='Your Vibe Check appointment');
  assert.ok(receipt);assert.ok(receipt.text.includes(meetingUrl));assert.doesNotMatch(receipt.text,/Zoom/);
});
