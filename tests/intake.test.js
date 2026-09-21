import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,readdirSync } from 'node:fs';
import { handle, expireUnpaid, confirmPayment, validateProject, validSlot } from '../server/api.js';
import {campaignAttribution} from '../server/campaigns.js';

function setup() {
  const sql=new DatabaseSync(':memory:');for(const file of readdirSync('migrations').filter(name=>name.endsWith('.sql')).sort())sql.exec(readFileSync('migrations/'+file,'utf8'));
  const statement=(query,args=[])=>({bind(...values){return statement(query,values);},async first(){return sql.prepare(query).get(...args)||null;},async all(){return {results:sql.prepare(query).all(...args)};},async run(){const r=sql.prepare(query).run(...args);return {meta:{changes:Number(r.changes)}};}});
  const env={ADMIN_TOKEN:'test-admin',DB:{prepare:statement,async batch(items){sql.exec('BEGIN');try{const results=[];for(const item of items)results.push(await item.run());sql.exec('COMMIT');return results;}catch(error){sql.exec('ROLLBACK');throw error;}}}};
  const call=async(path,method='GET',data,credential,headers={})=>{const response=await handle(new Request('https://vibecheck.test/api/'+path,{method,headers:{...(data?{'Content-Type':'application/json'}:{}),...(credential?{Authorization:'Bearer '+credential}:{}),...headers},body:data?JSON.stringify(data):undefined}),env);return {status:response.status,data:await response.json(),headers:response.headers};};
  const register=async()=>{const r=await call('register','POST',{name:'QA example',email:'qa@example.com'});assert.equal(r.status,201);return r.data;};
  const submit=async(user,complete=true)=>call('requests/'+user.id,'PUT',{description:'My example project fails during deployment.',links:['https://example.com/project'],notes:'Read-only link.',complete},user.token);
  const approve=async(user)=>call('admin/requests/'+user.id,'POST',{action:'approve',scope:'Review the deployment failure.'},'test-admin');
  const addSlot=(id='slot-1')=>{let start=Date.now()+86400000;start=Math.floor(start/900000)*900000;while(!validSlot(start,start+900000,Date.now()))start+=900000;sql.prepare('INSERT INTO slots(id,starts_at,ends_at,zoom_url,created_at) VALUES(?,?,?,?,?)').run(id,start,start+900000,'https://meet.proton.me/join/id-TESTROOM01#pwd-TESTPASS0001',Date.now());return id;};
  return {sql,env,call,register,submit,approve,addSlot};
}
test('campaign labels discard unknown values and retain no arbitrary customer text',()=>{
 assert.deepEqual(campaignAttribution({theme:'ribbon',source:'linkedin',medium:'paid_social',campaign:'launch_theme_01',content:'butter',request:'private-token',email:'private@example.com'}),{theme:'ribbon',source:'linkedin',medium:'paid_social',campaign:'launch_theme_01',content:'butter'});
 for(const input of [null,[],{source:'https://private.example',theme:'private@example.com',content:'private-token'},'private-token'])assert.deepEqual(campaignAttribution(input),{});
});
test('registration attribution stays fixed through editing and is hidden from customer responses',async()=>{
 const t=setup(),labels={theme:'butter',source:'linkedin',medium:'paid_social',campaign:'launch_theme_01',content:'ribbon'};
 const registered=await t.call('register','POST',{name:'QA example',email:'qa@example.com',attribution:labels});
 assert.equal(registered.status,201);const u=registered.data;assert.equal(u.request.attribution,undefined);
 await t.call('requests/'+u.id,'PUT',{description:'My deployment needs help.',links:[],notes:'',complete:true,attribution:{theme:'geometric'}},u.token);
 assert.deepEqual(JSON.parse(t.sql.prepare('SELECT attribution FROM requests WHERE id=?').get(u.id).attribution),labels);
 assert.equal((await t.call('requests/'+u.id,'GET',null,u.token)).data.attribution,undefined);
});
test('campaign report requires admin and counts payments without multiplying registrations',async()=>{
 const t=setup(),labels={theme:'butter',source:'linkedin',medium:'paid_social',campaign:'launch_theme_01',content:'butter'};
 const u=(await t.call('register','POST',{name:'QA example',email:'qa@example.com',attribution:labels})).data;
 await t.submit(u);await t.approve(u);const slot=t.addSlot('campaign-slot');
 t.sql.prepare("UPDATE requests SET paid_at=?,booked_slot_id=?,status='booked',review_minutes=60 WHERE id=?").run(Date.now(),slot,u.id);
 const insert=t.sql.prepare("INSERT INTO review_payments(id,request_id,minutes,from_minutes,amount_cents,total_cents,slot_id,status,checkout_expires_at,stripe_payload,created_at,paid_at) VALUES(?,?,?,?,?,?,?,'paid',?,'{}',?,?)");
 insert.run('upgrade30',u.id,30,15,2000,4500,slot,Date.now(),Date.now(),Date.now());
 insert.run('upgrade60',u.id,60,30,3500,8000,slot,Date.now(),Date.now(),Date.now());
 await t.register();
 assert.equal((await t.call('admin/campaigns')).status,401);
 assert.equal((await t.call('admin/campaigns','GET',null,u.token)).status,401);
 const result=(await t.call('admin/campaigns','GET',null,'test-admin')).data;
 const ad=result.campaigns.find(row=>row.source==='linkedin');
 assert.deepEqual(ad,{source:'linkedin',campaign:'launch_theme_01',content:'butter',theme:'butter',registrations:1,submissions:1,approvals:1,deposits:1,bookings:1,gross_cents:8000});
 assert.equal(result.campaigns.find(row=>row.source==='unattributed').gross_cents,0);
 assert.ok(!JSON.stringify(result).includes(u.id));assert.ok(!JSON.stringify(result).includes('qa@example.com'));
});
test('registration persists identity, protects requests, and does not imply payment',async()=>{const t=setup(),u=await t.register();assert.equal(u.request.status,'draft');assert.equal(u.request.paid_at,null);assert.equal(u.request.expires_at,null);assert.equal(u.request.token_hash,undefined);assert.equal((await t.call('requests/'+u.id)).status,401);assert.equal((await t.call('requests/'+u.id,'GET',null,'a'.repeat(64))).status,401);assert.equal((await t.call('requests/'+u.id,'GET',null,u.token)).status,200);assert.equal((await t.call('requests/'+u.id+'/checkout','POST',{},u.token)).status,409);});
test('validates the real word limit and prevents unsafe project URLs',()=>{assert.equal(validateProject({description:Array(1000).fill('word').join(' '),links:['https://example.com']}).links.length,1);assert.throws(()=>validateProject({description:Array(1001).fill('word').join(' '),links:['https://example.com']}),/1,000/);for(const link of ['javascript:alert(1)',['https://','username',':','secret','@example.com'].join('')])assert.throws(()=>validateProject({description:'Example',links:[link]}));});
test('deadline begins only after completion and editing never restarts it',async()=>{const t=setup(),u=await t.register();assert.equal((await t.submit(u,false)).data.expires_at,null);const sent=(await t.submit(u)).data;assert.equal(sent.status,'submitted');assert.equal(sent.expires_at-sent.completed_at,7*86400000);const edit=(await t.submit(u,false)).data;assert.equal(edit.expires_at,sent.expires_at);assert.equal(edit.status,'submitted');});
test('approval requires admin auth and complete intake; missing Stripe cannot pretend success',async()=>{const t=setup(),u=await t.register();assert.equal((await t.approve(u)).status,409);await t.submit(u);assert.equal((await t.call('admin/requests/'+u.id,'POST',{action:'approve',scope:'Example'},'wrong')).status,401);assert.equal((await t.approve(u)).data.status,'approved');t.addSlot();assert.equal((await t.call('requests/'+u.id+'/checkout','POST',{},u.token)).status,503);assert.equal(t.sql.prepare('SELECT paid_at FROM requests').get().paid_at,null);});
test('Stripe checkout is bound to the approved request and checked server-side',async()=>{const t=setup(),u=await t.register();await t.submit(u);await t.approve(u);t.addSlot();t.env.STRIPE_SECRET_KEY='test-key';t.env.STRIPE_WEBHOOK_SECRET='test-webhook';let session={id:'cs_test_fixture',status:'open',payment_status:'unpaid',url:'https://checkout.stripe.com/test',metadata:{request_id:u.id},amount_total:2500,currency:'usd',mode:'payment'};t.env.FETCH=async(url,opts)=>{if(url.endsWith('/checkout/sessions')){assert.match(String(opts.body),/unit_amount%5D=2500/);assert.match(String(opts.body),new RegExp(u.id));}return Response.json(session);};assert.equal((await t.call('requests/'+u.id+'/checkout','POST',{},u.token)).status,200);session={...session,payment_status:'paid',amount_total:1};assert.equal((await t.call('requests/'+u.id+'/verify-payment','POST',{},u.token)).status,409);session={...session,amount_total:2500};assert.equal((await t.call('requests/'+u.id+'/verify-payment','POST',{},u.token)).data.status,'paid');});
test('booking rejects unpaid requests and reserves a slot only once',async()=>{const t=setup(),a=await t.register(),b=await t.register();const slotId=t.addSlot();assert.equal((await t.call('requests/'+a.id+'/book','POST',{slotId},a.token)).status,403);t.sql.prepare("UPDATE requests SET paid_at=?,status='paid'").run(Date.now());assert.equal((await t.call('requests/'+a.id+'/book','POST',{slotId},a.token)).data.status,'booked');assert.equal((await t.call('requests/'+b.id+'/book','POST',{slotId},b.token)).status,409);assert.equal((await t.call('requests/'+a.id+'/book','POST',{slotId},a.token)).data.booking.zoom_url,'https://meet.proton.me/join/id-TESTROOM01#pwd-TESTPASS0001');assert.equal((await t.call('requests/'+b.id+'/slots','GET',null,b.token)).data.slots.length,0);});
test('expiry removes stored access at the cutoff, preserves paid projects, and tracks external cleanup',async()=>{const t=setup(),a=await t.register(),b=await t.register();await t.submit(a);await t.submit(b);const due=Date.now()+1000;t.sql.prepare('UPDATE requests SET expires_at=?').run(due);t.sql.prepare("UPDATE requests SET paid_at=?,status='paid' WHERE id=?").run(Date.now(),b.id);await t.call('admin/requests/'+a.id,'POST',{action:'track-access',provider:'figma',resource:'Private Figma invitation'},'test-admin');assert.equal((await expireUnpaid(t.env,due-1)).expired,0);assert.equal((await expireUnpaid(t.env,due)).expired,1);const row=t.sql.prepare('SELECT * FROM requests WHERE id=?').get(a.id);assert.equal(row.links,'[]');assert.equal(row.access_notes,'');assert.equal(row.status,'expired');assert.equal(t.sql.prepare('SELECT links FROM requests WHERE id=?').get(b.id).links,'["https://example.com/project"]');assert.equal(t.sql.prepare('SELECT state FROM access_grants').get().state,'cleanup_due');assert.equal((await expireUnpaid(t.env,due+1)).expired,0);});
test('GitHub cleanup requires verified success and retries network failures',async()=>{const t=setup(),u=await t.register();await t.submit(u);await t.call('admin/requests/'+u.id,'POST',{action:'track-access',provider:'github',resource:'someone/project'},'test-admin');t.sql.prepare('UPDATE requests SET expires_at=?').run(Date.now()-1);t.env.GITHUB_ACCESS_TOKEN='test';t.env.GITHUB_USERNAME='ashrocket';t.env.FETCH=async()=>{throw new Error('Network unavailable');};await expireUnpaid(t.env);assert.equal(t.sql.prepare('SELECT state FROM access_grants').get().state,'cleanup_due');t.env.FETCH=async()=>new Response(null,{status:404});await expireUnpaid(t.env);assert.equal(t.sql.prepare('SELECT state FROM access_grants').get().state,'cleanup_due');t.env.FETCH=async()=>new Response(null,{status:204});await expireUnpaid(t.env);assert.equal(t.sql.prepare('SELECT state FROM access_grants').get().state,'removed');});
test('uncertain Stripe payment defers only that request, not other due requests',async()=>{const t=setup(),a=await t.register(),b=await t.register();await t.submit(a);await t.submit(b);t.sql.prepare('UPDATE requests SET expires_at=?').run(Date.now()-1);t.sql.prepare("UPDATE requests SET stripe_session_id='cs_existing' WHERE id=?").run(a.id);t.env.STRIPE_SECRET_KEY='test';t.env.FETCH=async()=>{throw new Error('Stripe unavailable');};assert.equal((await expireUnpaid(t.env)).expired,1);assert.equal(t.sql.prepare('SELECT status FROM requests WHERE id=?').get(a.id).status,'submitted');assert.equal(t.sql.prepare('SELECT status FROM requests WHERE id=?').get(b.id).status,'expired');});
test('expiry reconciles a completed Stripe payment before removing links',async()=>{const t=setup(),u=await t.register();await t.submit(u);t.sql.prepare("UPDATE requests SET stripe_session_id='cs_existing',expires_at=?").run(Date.now()-1);t.env.STRIPE_SECRET_KEY='test';t.env.FETCH=async()=>Response.json({payment_status:'paid',metadata:{request_id:u.id},amount_total:2500,currency:'usd',mode:'payment'});assert.equal((await expireUnpaid(t.env)).expired,0);assert.equal(t.sql.prepare('SELECT status FROM requests').get().status,'paid');assert.notEqual(t.sql.prepare('SELECT links FROM requests').get().links,'[]');});
test('rejects cross-origin writes and unauthenticated admin access',async()=>{const t=setup();assert.equal((await t.call('register','POST',{name:'QA',email:'qa@example.com'},null,{Origin:'https://evil.example'})).status,403);assert.equal((await t.call('admin/requests')).status,401);assert.equal((await t.call('admin/cleanup','POST',{})).status,401);});
test('webhook rejects unsigned requests instead of marking payments received',async()=>{const t=setup();t.env.STRIPE_WEBHOOK_SECRET='test';assert.equal((await t.call('stripe-webhook','POST',{type:'checkout.session.completed'})).status,400);});
test('available slots honor Eastern time, weekends, closing time, and DST',()=>{const now=Date.parse('2026-01-01T00:00:00Z');for(const iso of ['2026-09-21T13:00:00-04:00','2026-12-21T13:00:00-05:00']){const n=Date.parse(iso);assert.equal(validSlot(n,n+900000,now),true);}for(const iso of ['2026-09-20T13:00:00-04:00','2026-09-21T12:45:00-04:00','2026-09-21T18:00:00-04:00']){const n=Date.parse(iso);assert.equal(validSlot(n,n+900000,now),false);}});


test('new deposits require both Stripe keys while existing payments can still reconcile',async()=>{
  const t=setup(),u=await t.register();await t.submit(u);await t.approve(u);t.addSlot();
  t.env.STRIPE_SECRET_KEY='test-key';
  assert.equal((await t.call('health')).data.payments,false);
  assert.equal((await t.call('admin/requests','GET',null,'test-admin')).data.payments,false);
  assert.equal((await t.call('requests/'+u.id,'GET',null,u.token)).data.payment_ready,false);
  let calls=0;t.env.FETCH=async()=>{calls++;throw new Error('Should not create checkout');};
  assert.equal((await t.call('requests/'+u.id+'/checkout','POST',{},u.token)).status,503);
  assert.equal(calls,0);
  t.sql.prepare("UPDATE requests SET stripe_session_id='cs_existing' WHERE id=?").run(u.id);
  t.env.FETCH=async()=>Response.json({payment_status:'paid',metadata:{request_id:u.id},amount_total:2500,currency:'usd',mode:'payment'});
  assert.equal((await t.call('requests/'+u.id+'/verify-payment','POST',{},u.token)).data.status,'paid');
  t.env.STRIPE_WEBHOOK_SECRET='test-webhook';
  assert.equal((await t.call('health')).data.payments,true);
  assert.equal((await t.call('admin/requests','GET',null,'test-admin')).data.payments,true);
  delete t.env.STRIPE_SECRET_KEY;
  assert.equal((await t.call('health')).data.payments,false);
});

test('an existing unpaid Checkout URL is not offered without the webhook configuration',async()=>{
  const t=setup(),u=await t.register();await t.submit(u);await t.approve(u);t.addSlot();
  t.sql.prepare("UPDATE requests SET stripe_session_id='cs_existing' WHERE id=?").run(u.id);
  t.env.STRIPE_SECRET_KEY='test-key';
  t.env.FETCH=async()=>Response.json({status:'open',payment_status:'unpaid',url:'https://checkout.stripe.com/test'});
  const result=await t.call('requests/'+u.id+'/checkout','POST',{},u.token);
  assert.equal(result.status,503);assert.equal(result.data.url,undefined);
});

test('admin accepts complete Proton links and preserves the private fragment through booking',async()=>{
  const t=setup();t.addSlot('find-time');
  const start=t.sql.prepare("SELECT starts_at FROM slots WHERE id='find-time'").get().starts_at;
  t.sql.prepare("DELETE FROM slots WHERE id='find-time'").run();
  const meetingUrl='https://meet.proton.me/join/id-TESTROOM01#pwd-TESTPASS0001';
  assert.equal((await t.call('admin/slots','POST',{startsAt:start,meetingUrl},'wrong')).status,401);
  const slot=await t.call('admin/slots','POST',{startsAt:start,meetingUrl},'test-admin');
  assert.equal(slot.status,201);
  const a=await t.register(),b=await t.register();
  assert.equal((await t.call('requests/'+a.id,'GET',null,a.token)).data.booking,undefined);
  t.sql.prepare("UPDATE requests SET paid_at=?,status='paid'").run(Date.now());
  const available=await t.call('requests/'+b.id+'/slots','GET',null,b.token);
  assert.equal(JSON.stringify(available).includes('TESTPASS'),false);
  const booked=(await t.call('requests/'+a.id+'/book','POST',{slotId:slot.data.id},a.token)).data;
  assert.equal(booked.booking.meeting_url,meetingUrl);
  assert.equal(booked.booking.zoom_url,meetingUrl); // Existing clients keep working.
  assert.equal((await t.call('requests/'+a.id,'GET',null,b.token)).status,401);
});

test('admin rejects unsupported providers, deceptive URLs, and incomplete Proton links',async()=>{
  const t=setup();t.addSlot('find-time');
  const start=t.sql.prepare("SELECT starts_at FROM slots WHERE id='find-time'").get().starts_at;
  const valid='https://meet.proton.me/join/id-TESTROOM01#pwd-TESTPASS0001';
  const credentialUrl=new URL(valid);credentialUrl.username='user';credentialUrl.password='pass';
  const links=[undefined,{},'https://zoom.us/j/example','https://meet.google.com/abc',
    'https://meet.proton.me/','https://meet.proton.me/guest/dashboard',valid.split('#')[0],
    valid.replace('https:','http:'),valid.replace('meet.proton.me','meet.proton.me.evil.example'),
    valid.replace('meet.proton.me','meet.proton.me:8443'),credentialUrl.href,
    valid.replace('#','?redirect=https://evil.example#'),valid.replace('id-TESTROOM01','id-short'),
    valid.replace('pwd-TESTPASS0001','pwd-short'),'javascript:alert(1)'];
  for(const meetingUrl of links){
    const result=await t.call('admin/slots','POST',{startsAt:start,meetingUrl},'test-admin');
    assert.equal(result.status,400);assert.match(result.data.error,/Proton Meet/);
  }
  assert.equal(t.sql.prepare('SELECT count(*) AS n FROM slots').get().n,1);
});
