import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,readdirSync } from 'node:fs';
import { handle, expireUnpaid, confirmPayment, validateProject, validSlot } from '../server/api.js';

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

import {availableReviewSlots,reconcilePendingReviews} from '../server/review-payments.js';

async function fixture(){
 const t=setup(),u=await t.register();await t.submit(u);await t.approve(u);
 t.sql.prepare("UPDATE requests SET paid_at=?,status='paid' WHERE id=?").run(Date.now(),u.id);
 const first=t.addSlot('s0'),start=t.sql.prepare('SELECT starts_at FROM slots WHERE id=?').get(first).starts_at;
 for(let i=1;i<8;i++)t.sql.prepare('INSERT INTO slots(id,starts_at,ends_at,zoom_url,created_at) VALUES(?,?,?,?,?)').run('s'+i,start+i*900000,start+(i+1)*900000,'https://meet.proton.me/join/id-TESTROOM01#pwd-TESTPASS0001',Date.now());
 t.env.STRIPE_SECRET_KEY='test-key';t.env.STRIPE_WEBHOOK_SECRET='test-webhook';
 const sessions=new Map(),creates=[];
 t.env.FETCH=async(url,opts)=>{
  if(url.endsWith('/checkout/sessions')){
   const values=new URLSearchParams(opts.body),key=opts.headers['Idempotency-Key'];creates.push({key,values:String(values)});
   if(sessions.has(key))return Response.json(sessions.get(key));
   const session={id:'cs_'+sessions.size,status:'open',payment_status:'unpaid',mode:'payment',currency:'usd',amount_total:Number(values.get('line_items[0][price_data][unit_amount]')),metadata:{request_id:values.get('metadata[request_id]'),review_payment_id:values.get('metadata[review_payment_id]')},url:'https://checkout.stripe.com/test'};
   sessions.set(key,session);return Response.json(session);
  }
  const found=[...sessions.values()].find(s=>url.includes('/'+s.id));assert.ok(found,'Known session only');
  if(url.endsWith('/expire'))found.status='expired';return Response.json(found);
 };
 const upgrade=(minutes=30,slotId='s0')=>t.call('requests/'+u.id+'/upgrade-checkout','POST',{minutes,slotId},u.token);
 const verify=()=>t.call('requests/'+u.id+'/verify-payment','POST',{},u.token);
 const row=()=>t.sql.prepare('SELECT * FROM requests WHERE id=?').get(u.id);
 return {...t,u,start,sessions,creates,upgrade,verify,row};
}

test('upgrade holds continuous time, charges remaining20, and finalizes30 only after verified payment',async()=>{
 const t=await fixture();const original=t.row().stripe_session_id;
 assert.equal((await t.upgrade()).status,200);assert.equal(t.row().status,'paid');
 assert.equal(t.sql.prepare("SELECT count(*) n FROM slot_claims WHERE state='held'").get().n,2);
 let view=(await t.call('requests/'+t.u.id,'GET',null,t.u.token)).data;
 assert.deepEqual(view.billing,{minutes:15,paid_cents:2500,options:[{minutes:15,total_cents:2500,due_cents:0},{minutes:30,total_cents:4500,due_cents:2000},{minutes:60,total_cents:8000,due_cents:5500}]});
 assert.equal(view.pending_upgrade.minutes,30);assert.equal(view.pending_upgrade.stripe_payload,undefined);
 const session=[...t.sessions.values()][0];assert.equal(session.amount_total,2000);session.payment_status='paid';session.status='complete';
 const paid=await t.verify();assert.equal(paid.status,200);assert.equal(paid.data.status,'booked');assert.equal(paid.data.review_minutes,30);assert.equal(paid.data.billing.paid_cents,4500);assert.equal(paid.data.booking.ends_at-t.start,1800000);
 assert.equal(t.row().stripe_session_id,original);assert.equal(t.sql.prepare("SELECT count(*) n FROM slot_claims WHERE state='booked'").get().n,2);
 await t.verify();assert.equal(t.sql.prepare("SELECT count(*) n FROM audit WHERE event='review_upgrade_verified'").get().n,1);
});

test('60min costs55 after deposit and35 after a confirmed30min review',async()=>{
 const t=await fixture();await t.upgrade(30);[...t.sessions.values()][0].payment_status='paid';await t.verify();
 assert.equal((await t.upgrade(60)).status,200);const later=[...t.sessions.values()][1];assert.equal(later.amount_total,3500);later.payment_status='paid';
 const result=await t.verify();assert.equal(result.data.billing.paid_cents,8000);assert.equal(result.data.review_minutes,60);assert.equal(result.data.booking.ends_at-t.start,3600000);
 const other=await fixture();await other.upgrade(60);assert.equal([...other.sessions.values()][0].amount_total,5500);
});

test('missing, mismatched meeting links, taken, too late and unsupported durations cannot open upgrade',async()=>{
 const t=await fixture();t.sql.prepare("UPDATE slots SET zoom_url='https://meet.proton.me/join/id-OTHERROOM1#pwd-TESTPASS0002' WHERE id='s1'").run();assert.equal((await t.upgrade()).status,409);
 t.sql.prepare("UPDATE slots SET zoom_url='https://meet.proton.me/join/id-TESTROOM01#pwd-TESTPASS0001' WHERE id='s1'").run();t.sql.prepare("DELETE FROM slots WHERE id='s1'").run();assert.equal((await t.upgrade()).status,409);
 assert.equal((await t.upgrade(45)).status,400);assert.equal((await t.upgrade('30')).status,400);assert.equal(t.creates.length,0);
 const late=await fixture();assert.equal((await availableReviewSlots(late.env,late.row(),30,late.start-30*60000)).length,6);
 assert.ok(!(await availableReviewSlots(late.env,late.row(),30,late.start-30*60000)).some(s=>s.id==='s0'));
});

test('held time excludes otherbuyers, directbooking, admin deletion; duplicateclick reusescheckout',async()=>{
 const t=await fixture(),b=await t.register();t.sql.prepare("UPDATE requests SET paid_at=?,status='paid' WHERE id=?").run(Date.now(),b.id);
 await t.upgrade();await t.upgrade();assert.equal(t.creates.length,1);
 const slots=(await t.call('requests/'+b.id+'/slots','GET',null,b.token)).data.slots;assert.ok(!slots.some(s=>['s0','s1'].includes(s.id)));
 assert.equal((await t.call('requests/'+b.id+'/book','POST',{slotId:'s1'},b.token)).status,409);
 assert.equal((await t.call('admin/slots/s1','DELETE',null,'test-admin')).status,409);
 assert.equal((await t.upgrade(60)).status,409);
 assert.equal((await t.call('requests/'+t.u.id+'/book','POST',{slotId:'s3'},t.u.token)).status,409);
});

test('cancel requires Stripe expired-unpaid proof and preserves previous15minutebooking',async()=>{
 const t=await fixture();assert.equal((await t.call('requests/'+t.u.id+'/book','POST',{slotId:'s0'},t.u.token)).status,200);await t.upgrade();
 const old=t.env.FETCH;t.env.FETCH=async()=>{throw new Error('provider down');};
 assert.equal((await t.call('requests/'+t.u.id+'/cancel-upgrade','POST',{},t.u.token)).status,500);assert.equal(t.sql.prepare('SELECT count(*) n FROM slot_claims').get().n,2);
 t.env.FETCH=old;const cancelled=await t.call('requests/'+t.u.id+'/cancel-upgrade','POST',{},t.u.token);
 assert.equal(cancelled.status,200);assert.equal(cancelled.data.review_minutes,15);assert.equal(cancelled.data.status,'booked');assert.equal(cancelled.data.pending_upgrade,null);assert.equal(t.sql.prepare('SELECT count(*) n FROM slot_claims').get().n,1);
 assert.equal((await t.call('admin/slots/s0','DELETE',null,'test-admin')).status,409);
});

test('wrong amount, metadata, currency or mode cannot fulfill an upgrade',async()=>{
 for(const mutation of [{amount_total:1},{currency:'eur'},{mode:'setup'},{metadata:{request_id:'other',review_payment_id:'other'}}]){
  const t=await fixture();await t.upgrade();Object.assign([...t.sessions.values()][0],mutation,{payment_status:'paid'});assert.equal((await t.verify()).status,409);assert.equal(t.row().review_minutes,15);assert.equal(t.sql.prepare("SELECT count(*) n FROM slot_claims WHERE state='held'").get().n,2);
 }
});

test('lost creation response retries identical payload/key and keeps claims while uncertain',async()=>{
 const t=await fixture(),old=t.env.FETCH;let lost=true;t.env.FETCH=async(...args)=>{const result=await old(...args);if(args[0].endsWith('/checkout/sessions')&&lost){lost=false;throw new Error('lost response');}return result;};
 assert.equal((await t.upgrade()).status,500);assert.equal(t.sql.prepare('SELECT count(*) n FROM slot_claims').get().n,2);
 assert.equal((await t.upgrade()).status,200);assert.equal(t.creates.length,2);assert.deepEqual(t.creates[0],t.creates[1]);assert.equal(t.sessions.size,1);
});

test('cron retains unknown payments and reconciles latepaid before releasing inventory',async()=>{
 const t=await fixture();await t.upgrade();const old=t.env.FETCH;t.env.FETCH=async()=>{throw new Error('offline');};
 const future=Date.now()+3600000;assert.equal((await reconcilePendingReviews(t.env,future)).deferred,1);assert.equal(t.sql.prepare('SELECT count(*) n FROM slot_claims').get().n,2);
 t.env.FETCH=old;[...t.sessions.values()][0].payment_status='paid';assert.equal((await reconcilePendingReviews(t.env,future)).confirmed,1);assert.equal(t.row().status,'booked');
 const unpaid=await fixture();await unpaid.upgrade();assert.equal((await reconcilePendingReviews(unpaid.env,future)).released,1);assert.equal(unpaid.sql.prepare('SELECT count(*) n FROM slot_claims').get().n,0);
 assert.equal((await unpaid.call('admin/slots/s0','DELETE',null,'test-admin')).status,409);
});

test('existingupgrade withoutwebhook can reconcile but cannot expose unpaidCheckout URL',async()=>{
 const t=await fixture();await t.upgrade();delete t.env.STRIPE_WEBHOOK_SECRET;assert.equal((await t.upgrade()).status,503);[...t.sessions.values()][0].payment_status='paid';assert.equal((await t.verify()).data.status,'booked');
});

test('concurrent directbookings and upgrades for one request leave one coherent reservation',async()=>{
 for(let i=0;i<5;i++){
  const t=await fixture();await Promise.all([t.call('requests/'+t.u.id+'/book','POST',{slotId:'s0'},t.u.token),t.call('requests/'+t.u.id+'/book','POST',{slotId:'s4'},t.u.token)]);
  assert.equal(t.sql.prepare('SELECT count(*) n FROM slot_claims').get().n,1);assert.equal(t.sql.prepare('SELECT count(*) n FROM slots WHERE request_id=?').get(t.u.id).n,1);
  const q=await fixture();await Promise.all([q.call('requests/'+q.u.id+'/book','POST',{slotId:'s4'},q.u.token),q.upgrade()]);
  const booked=q.row().booked_slot_id,active=q.sql.prepare("SELECT * FROM review_payments WHERE status IN ('creating','open')").get();
  assert.ok(!(booked&&active&&booked!==active.slot_id));
  assert.equal(q.sql.prepare('SELECT count(*) n FROM slot_claims').get().n,active?2:booked?1:0);
 }
});

test('crash before provider creation recovers complete claims, while stale uncreated attempts release safely',async()=>{
 for(const stale of [false,true]){
  const t=await fixture(),prepare=t.env.DB.prepare;let crash=true;
  t.env.DB.prepare=query=>{const statement=prepare(query);if(query.startsWith('UPDATE review_payments SET claims_ready=1')){const bind=statement.bind;statement.bind=(...args)=>{const bound=bind(...args),run=bound.run;bound.run=async()=>{if(crash){crash=false;throw new Error('worker interrupted before provider call');}return run();};return bound;};}return statement;};
  assert.equal((await t.upgrade()).status,500);assert.equal(t.creates.length,0);assert.equal(t.sql.prepare('SELECT claims_ready FROM review_payments').get().claims_ready,0);
  t.env.DB.prepare=prepare;
  if(stale)t.sql.prepare('UPDATE review_payments SET checkout_expires_at=?').run(Date.now()-1);
  await reconcilePendingReviews(t.env);
  assert.equal(t.creates.length,stale?0:1);assert.equal(t.sql.prepare('SELECT count(*) n FROM slot_claims').get().n,stale?0:2);
 }
});

test('booking mismatch rolls back the whole paid finalization and retains pending payment for attention',async()=>{
 const t=await fixture();await t.upgrade();[...t.sessions.values()][0].payment_status='paid';
 // Force an invalid legacy/operator state after payment began: the DB invariant
 // must reject it rather than label a different appointment correctly reserved.
 t.sql.prepare("UPDATE requests SET booked_slot_id='s4' WHERE id=?").run(t.u.id);
 assert.equal((await t.verify()).status,500);
 assert.equal(t.sql.prepare('SELECT status FROM review_payments').get().status,'open');
 assert.equal(t.sql.prepare("SELECT count(*) n FROM slot_claims WHERE state='held'").get().n,2);
 assert.equal(t.sql.prepare("SELECT count(*) n FROM audit WHERE event='review_upgrade_verified'").get().n,0);
});

test('signed Stripe upgrade webhook retrieves authoritative payment and duplicate delivery is harmless',async()=>{
 const t=await fixture();await t.upgrade();const session=[...t.sessions.values()][0];session.payment_status='paid';
 const event={type:'checkout.session.completed',data:{object:{id:session.id,metadata:session.metadata}}},payload=JSON.stringify(event),stamp=String(Math.floor(Date.now()/1000));
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(t.env.STRIPE_WEBHOOK_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const signature=[...new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`${stamp}.${payload}`)))].map(v=>v.toString(16).padStart(2,'0')).join('');
 for(let i=0;i<2;i++)assert.equal((await t.call('stripe-webhook','POST',event,null,{'Stripe-Signature':`t=${stamp},v1=${signature}`})).status,200);
 assert.equal(t.row().review_minutes,30);assert.equal(t.sql.prepare("SELECT count(*) n FROM audit WHERE event='review_upgrade_verified'").get().n,1);
});

test('customer availability does not reconcile other customers Stripe attempts',async()=>{
 const t=await fixture();await t.upgrade();const other=await t.register();t.sql.prepare("UPDATE requests SET paid_at=?,status='paid' WHERE id=?").run(Date.now(),other.id);
 t.env.FETCH=async()=>{throw new Error('must not access another customer payment');};
 assert.equal((await t.call('requests/'+other.id+'/slots?minutes=30','GET',null,other.token)).status,200);
});

test('a booked room belongs to one customer, including later slots with another password',async()=>{
 const t=await fixture(),other=await t.register();
 t.sql.prepare("UPDATE requests SET paid_at=?,status='paid' WHERE id=?").run(Date.now(),other.id);
 assert.equal((await t.call('requests/'+t.u.id+'/book','POST',{slotId:'s0'},t.u.token)).status,200);
 t.sql.prepare("UPDATE slots SET zoom_url='https://meet.proton.me/join/id-TESTROOM01#pwd-TESTPASS0002' WHERE id='s4'").run();
 assert.deepEqual((await t.call('requests/'+other.id+'/slots','GET',null,other.token)).data.slots,[]);
 assert.equal((await t.call('requests/'+other.id+'/book','POST',{slotId:'s4'},other.token)).status,409);
 const admin=(await t.call('admin/requests','GET',null,'test-admin')).data;
 assert.equal(admin.slots.find(s=>s.id==='s4').room_reserved,1);
 const unpaid=await t.register();await t.submit(unpaid);await t.approve(unpaid);
 assert.equal((await t.call('requests/'+unpaid.id+'/checkout','POST',{},unpaid.token)).status,409,'do not offer a deposit when only another customer’s room remains');
 assert.equal((await t.upgrade(30)).status,200,'the original customer can extend their appointment');
 t.sql.prepare("UPDATE slots SET zoom_url='https://meet.proton.me/join/id-OTHERROOM1#pwd-TESTPASS0002' WHERE id='s4'").run();
 assert.equal((await t.call('requests/'+other.id+'/book','POST',{slotId:'s4'},other.token)).status,200);
});

test('an unpaid checkout reserves the room until Stripe confirms expiration',async()=>{
 const t=await fixture(),other=await t.register();
 t.sql.prepare("UPDATE requests SET paid_at=?,status='paid' WHERE id=?").run(Date.now(),other.id);
 assert.equal((await t.upgrade()).status,200);
 assert.deepEqual((await t.call('requests/'+other.id+'/slots','GET',null,other.token)).data.slots,[]);
 assert.equal((await t.call('requests/'+t.u.id+'/cancel-upgrade','POST',{},t.u.token)).status,200);
 assert.ok((await t.call('requests/'+other.id+'/slots','GET',null,other.token)).data.slots.length>0);
});

test('concurrent buyers cannot claim different times in the same room',async()=>{
 const t=await fixture(),other=await t.register();
 t.sql.prepare("UPDATE requests SET paid_at=?,status='paid' WHERE id=?").run(Date.now(),other.id);
 const results=await Promise.all([
  t.call('requests/'+t.u.id+'/book','POST',{slotId:'s0'},t.u.token),
  t.call('requests/'+other.id+'/book','POST',{slotId:'s4'},other.token)
 ]);
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 assert.equal(t.sql.prepare('SELECT count(DISTINCT request_id) n FROM slot_claims').get().n,1);
});

test('cron expiry while foreground is paused cannot revive an uncreated attempt or strand holds',async()=>{
 const t=await fixture(),prepare=t.env.DB.prepare;let pause=true;
 t.env.DB.prepare=query=>{const statement=prepare(query);if(query.startsWith('UPDATE review_payments SET claims_ready=1')){const bind=statement.bind;statement.bind=(...args)=>{const bound=bind(...args),run=bound.run;bound.run=async()=>{if(pause){pause=false;t.sql.prepare('UPDATE review_payments SET checkout_expires_at=?').run(Date.now()-1);await reconcilePendingReviews(t.env);}return run();};return bound;};}return statement;};
 assert.equal((await t.upgrade()).status,409);assert.equal(t.creates.length,0);assert.equal(t.sql.prepare('SELECT status FROM review_payments').get().status,'expired');assert.equal(t.sql.prepare('SELECT count(*) n FROM slot_claims').get().n,0);
});
