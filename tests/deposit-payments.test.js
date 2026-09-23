import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {handle,validSlot,reconcilePendingDeposits} from '../server/api.js';

function setup(){
  const sql=new DatabaseSync(':memory:');
  for(const file of readdirSync('migrations').filter(name=>name.endsWith('.sql')).sort())sql.exec(readFileSync('migrations/'+file,'utf8'));
  const statement=(query,args=[])=>({bind(...values){return statement(query,values);},async first(){return sql.prepare(query).get(...args)||null;},async all(){return {results:sql.prepare(query).all(...args)};},async run(){const r=sql.prepare(query).run(...args);return {meta:{changes:Number(r.changes)}};}});
  const sessions=new Map(),createCalls=[];
  const env={ADMIN_TOKEN:'test-admin',STRIPE_SECRET_KEY:'test-key',STRIPE_WEBHOOK_SECRET:'test-webhook',DB:{prepare:statement,async batch(items){sql.exec('BEGIN');try{const result=[];for(const item of items)result.push(await item.run());sql.exec('COMMIT');return result;}catch(error){sql.exec('ROLLBACK');throw error;}}}};
  env.FETCH=async(url,options)=>{
    if(url.endsWith('/checkout/sessions')){
      const values=new URLSearchParams(options.body),key=options.headers['Idempotency-Key'];
      createCalls.push({key,payload:String(values)});
      if(sessions.has(key))return Response.json(sessions.get(key));
      const session={id:`cs_fixture_${sessions.size}`,status:'open',payment_status:'unpaid',url:'https://checkout.stripe.com/test',mode:'payment',currency:'usd',amount_total:Number(values.get('line_items[0][price_data][unit_amount]')),metadata:{request_id:values.get('metadata[request_id]'),deposit_payment_id:values.get('metadata[deposit_payment_id]'),review_mode:values.get('metadata[review_mode]')}};
      sessions.set(key,session);return Response.json(session);
    }
    const session=[...sessions.values()].find(value=>url.includes('/'+value.id));
    assert.ok(session,'Known Stripe session only');
    if(url.endsWith('/expire')){
      if(session.status!=='open'||session.payment_status!=='unpaid')return Response.json({error:'Only open sessions can expire'},{status:400});
      session.status='expired';
    }
    return Response.json(session);
  };
  const call=async(path,method='GET',data,credential)=>{const response=await handle(new Request('https://vibecheck.test/api/'+path,{method,headers:{...(data?{'Content-Type':'application/json'}:{}),...(credential?{Authorization:'Bearer '+credential}:{})},body:data?JSON.stringify(data):undefined}),env);return {status:response.status,data:await response.json()};};
  const approved=async()=>{const registered=await call('register','POST',{name:'QA Example',email:'qa@example.com'}),u=registered.data;await call(`requests/${u.id}`,'PUT',{description:'Project needs review',links:['https://example.com'],notes:'',complete:true},u.token);assert.equal((await call(`admin/requests/${u.id}`,'POST',{action:'approve',scope:'Review the project'},'test-admin')).status,200);return u;};
  const addSlot=()=>{let start=Math.floor((Date.now()+86400000)/900000)*900000;while(!validSlot(start,start+900000,Date.now()))start+=900000;sql.prepare('INSERT INTO slots(id,starts_at,ends_at,zoom_url,created_at) VALUES(?,?,?,?,?)').run('one-slot',start,start+900000,'https://meet.proton.me/join/id-TESTROOM01#pwd-TESTPASS0001',Date.now());return 'one-slot';};
  const pay=(u,mode,slotId)=>call(`requests/${u.id}/checkout`,'POST',{mode,...(slotId?{slotId}:{})},u.token);
  const verify=u=>call(`requests/${u.id}/verify-payment`,'POST',{},u.token);
  return {sql,env,sessions,createCalls,call,approved,addSlot,pay,verify};
}

test('two approved call buyers cannot both pay for the last appointment',async()=>{
  const t=setup(),a=await t.approved(),b=await t.approved(),slotId=t.addSlot();
  const listing=await t.call(`requests/${a.id}/slots?minutes=15`,'GET',null,a.token);
  assert.deepEqual(listing.data.slots.map(slot=>slot.id),[slotId]);
  assert.equal(JSON.stringify(listing.data).includes('TESTPASS'),false);
  assert.equal((await t.call(`requests/${a.id}/slots?minutes=30`,'GET',null,a.token)).status,403);
  const results=await Promise.all([t.pay(a,'call',slotId),t.pay(b,'call',slotId)]);
  assert.deepEqual(results.map(result=>result.status).sort(),[200,409]);
  assert.equal(t.sessions.size,1);
  assert.equal(t.sql.prepare("SELECT count(*) AS n FROM slot_claims WHERE state='held'").get().n,1);
  const winner=results[0].status===200?a:b,loser=winner===a?b:a;
  const session=[...t.sessions.values()][0];session.payment_status='paid';session.status='complete';
  const verified=await t.verify(winner);
  assert.equal(verified.data.status,'booked');assert.equal(verified.data.review_mode,'call');
  assert.equal(verified.data.booking.starts_at,t.sql.prepare('SELECT starts_at FROM slots WHERE id=?').get(slotId).starts_at);
  assert.equal((await t.pay(loser,'call',slotId)).status,409);
  assert.deepEqual((await t.call(`requests/${loser.id}/slots?minutes=15`,'GET',null,loser.token)).data.slots,[]);
});

test('Stripe-confirmed expiration releases a call hold for another buyer',async()=>{
  const t=setup(),a=await t.approved(),b=await t.approved(),slotId=t.addSlot();
  assert.equal((await t.pay(a,'call',slotId)).status,200);
  assert.equal((await t.pay(b,'call',slotId)).status,409);
  const result=await reconcilePendingDeposits(t.env,Date.now()+3600000);
  assert.equal(result.released,1);
  assert.equal(t.sql.prepare('SELECT count(*) AS n FROM slot_claims').get().n,0);
  assert.equal((await t.pay(b,'call',slotId)).status,200);
  assert.equal(t.sessions.size,2);
});

test('lost Stripe creation response keeps the hold and reuses the same provider request',async()=>{
  const t=setup(),a=await t.approved(),b=await t.approved(),slotId=t.addSlot(),original=t.env.FETCH;
  let lose=true;t.env.FETCH=async(...args)=>{const response=await original(...args);if(args[0].endsWith('/checkout/sessions')&&lose){lose=false;throw new Error('Lost response');}return response;};
  assert.equal((await t.pay(a,'call',slotId)).status,500);
  assert.equal(t.sql.prepare("SELECT count(*) AS n FROM slot_claims WHERE state='held'").get().n,1);
  assert.equal((await t.pay(b,'call',slotId)).status,409);
  assert.equal((await t.pay(a,'call',slotId)).status,200);
  assert.equal(t.createCalls.length,2);
  assert.deepEqual(t.createCalls[0],t.createCalls[1]);
  assert.equal(t.sessions.size,1);
  const session=[...t.sessions.values()][0];session.payment_status='paid';session.status='complete';
  assert.equal((await t.verify(a)).data.status,'booked');
});

test('an uncertain creation past provider idempotency retention stays held for operator review',async()=>{
  const t=setup(),a=await t.approved(),b=await t.approved(),slotId=t.addSlot(),original=t.env.FETCH;
  t.env.FETCH=async(...args)=>{const response=await original(...args);if(args[0].endsWith('/checkout/sessions'))throw new Error('Lost response');return response;};
  assert.equal((await t.pay(a,'call',slotId)).status,500);
  t.sql.prepare('UPDATE deposit_payments SET created_at=?').run(Date.now()-24*3600000);
  assert.equal((await reconcilePendingDeposits(t.env)).deferred,1);
  assert.equal(t.sql.prepare("SELECT count(*) AS n FROM slot_claims WHERE state='held'").get().n,1);
  assert.equal((await t.pay(b,'call',slotId)).status,409);
  assert.equal(t.sessions.size,1);
});

test('answer deposit needs no slot and cannot become a booking or upgrade',async()=>{
  const t=setup(),u=await t.approved();
  assert.equal((await t.pay(u,'call','missing-slot')).status,409);
  assert.equal((await t.pay(u,'answer')).status,200);
  assert.equal(t.sql.prepare('SELECT count(*) AS n FROM slot_claims').get().n,0);
  const session=[...t.sessions.values()][0];session.payment_status='paid';session.status='complete';
  const verified=await t.verify(u);
  assert.equal(verified.data.status,'paid');assert.equal(verified.data.review_mode,'answer');
  assert.equal(verified.data.booking,undefined);
  assert.equal((await t.call(`requests/${u.id}/slots?minutes=15`,'GET',null,u.token)).status,409);
  assert.equal((await t.call(`requests/${u.id}/book`,'POST',{slotId:'any'},u.token)).status,409);
  assert.equal((await t.call(`requests/${u.id}/upgrade-checkout`,'POST',{slotId:'any',minutes:30},u.token)).status,409);
});

test('answer checkout cannot open after a concurrent admin decline',async()=>{
  const t=setup(),u=await t.approved(),prepare=t.env.DB.prepare;let declined=false;
  t.env.DB.prepare=query=>{
    if(!declined&&query.includes('INSERT INTO deposit_payments')){
      declined=true;t.sql.prepare("UPDATE requests SET status='declined',finished_at=? WHERE id=?").run(Date.now(),u.id);
    }
    return prepare(query);
  };
  const result=await t.pay(u,'answer');t.env.DB.prepare=prepare;
  assert.equal(declined,true);assert.equal(result.status,409);
  assert.equal(t.sql.prepare('SELECT status FROM requests WHERE id=?').get(u.id).status,'declined');
  assert.equal(t.sql.prepare('SELECT count(*) AS n FROM deposit_payments WHERE request_id=?').get(u.id).n,0);
  assert.equal(t.sessions.size,0);
});

test('Stripe mode mismatch cannot fulfill an answer deposit',async()=>{
  const t=setup(),u=await t.approved();await t.pay(u,'answer');
  const session=[...t.sessions.values()][0];session.payment_status='paid';session.status='complete';session.metadata.review_mode='call';
  assert.equal((await t.verify(u)).status,409);
  assert.equal(t.sql.prepare('SELECT paid_at FROM requests WHERE id=?').get(u.id).paid_at,null);
  assert.equal(t.sql.prepare("SELECT status FROM deposit_payments WHERE request_id=?").get(u.id).status,'open');
});

test('call checkout fails closed when the required calendar is unavailable, while answer checkout works',async()=>{
  const t=setup(),u=await t.approved(),slotId=t.addSlot();
  t.env.PUBLIC_ORIGIN='https://vibecheck.rodeo';
  assert.equal((await t.call(`requests/${u.id}/slots?minutes=15`,'GET',null,u.token)).status,503);
  assert.equal((await t.pay(u,'call',slotId)).status,503);
  assert.equal(t.sessions.size,0);
  assert.equal(t.sql.prepare('SELECT count(*) AS n FROM slot_claims').get().n,0);
  assert.equal((await t.pay(u,'answer')).status,200);
  const session=[...t.sessions.values()][0];session.payment_status='paid';session.status='complete';
  assert.equal((await t.verify(u)).data.review_mode,'answer');
});

test('paid call with a calendar outage keeps Stripe proof and the hold without claiming a booking',async()=>{
  const t=setup(),u=await t.approved(),other=await t.approved(),slotId=t.addSlot();
  assert.equal((await t.pay(u,'call',slotId)).status,200);
  t.env.PUBLIC_ORIGIN='https://vibecheck.rodeo';
  const session=[...t.sessions.values()][0];session.payment_status='paid';session.status='complete';
  const verify=await t.verify(u);
  assert.equal(verify.status,409);
  assert.match(verify.data.error,/deposit was paid.*appointment is not booked/i);
  const row=t.sql.prepare('SELECT status,paid_at,booked_slot_id FROM requests WHERE id=?').get(u.id);
  assert.equal(row.status,'approved');assert.equal(row.paid_at,null);assert.equal(row.booked_slot_id,null);
  const attempt=t.sql.prepare('SELECT status,provider_paid_at FROM deposit_payments WHERE request_id=?').get(u.id);
  assert.equal(attempt.status,'open');assert.ok(attempt.provider_paid_at);
  assert.equal(t.sql.prepare("SELECT count(*) AS n FROM slot_claims WHERE state='held'").get().n,1);
  assert.equal((await t.call(`requests/${u.id}`,'GET',null,u.token)).data.pending_deposit.payment_received,true);
  delete t.env.PUBLIC_ORIGIN;
  assert.equal((await t.pay(other,'call',slotId)).status,409);
  assert.equal((await t.verify(u)).data.status,'booked');
});

test('an unpaid held call can expire while the calendar is unavailable',async()=>{
  const t=setup(),u=await t.approved(),slotId=t.addSlot();
  assert.equal((await t.pay(u,'call',slotId)).status,200);
  t.env.PUBLIC_ORIGIN='https://vibecheck.rodeo';
  assert.equal((await reconcilePendingDeposits(t.env,Date.now()+3600000)).released,1);
  assert.equal(t.sql.prepare('SELECT count(*) AS n FROM slot_claims').get().n,0);
});

test('deposit reconciliation reaches a later attempt after a hundred uncertain creations',async()=>{
  const t=setup(),old=Date.now()-24*3600000;
  const request=t.sql.prepare("INSERT INTO requests(id,token_hash,name,email,created_at,updated_at,ip_hash) VALUES(?,'fixture','Example','example@example.com',?,?,'fixture')");
  const creating=t.sql.prepare("INSERT INTO deposit_payments(id,request_id,review_mode,status,claims_ready,checkout_expires_at,stripe_payload,created_at) VALUES(?,?,'answer','creating',1,?,'{}',?)");
  for(let i=0;i<100;i++){
    const id=`old-${i}`;request.run(id,old+i,old+i);creating.run(`old-deposit-${i}`,id,Date.now()+3600000,old+i);
  }
  request.run('later',Date.now(),Date.now());
  t.sql.prepare("INSERT INTO deposit_payments(id,request_id,review_mode,status,claims_ready,session_id,checkout_expires_at,stripe_payload,created_at) VALUES('later-deposit','later','answer','open',1,'cs_later',?,'{}',?)").run(Date.now()+3600000,Date.now());
  t.env.FETCH=async()=>Response.json({id:'cs_later',metadata:{request_id:'later',deposit_payment_id:'later-deposit',review_mode:'answer'},amount_total:2500,currency:'usd',mode:'payment',status:'expired',payment_status:'unpaid'});
  const result=await reconcilePendingDeposits(t.env,900000);
  assert.equal(result.released,1);
  assert.equal(t.sql.prepare("SELECT status FROM deposit_payments WHERE id='later-deposit'").get().status,'expired');
});
