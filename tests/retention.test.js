import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {handle,expireUnpaid,purgeFinishedReviews} from '../server/api.js';

const DAY=86400000;
const ROOM='https://meet.proton.me/join/id-TESTROOM01#pwd-TESTPASS0001';
function fixture(){
  const sql=new DatabaseSync(':memory:');
  for(const file of readdirSync('migrations').filter(name=>name.endsWith('.sql')).sort())sql.exec(readFileSync(`migrations/${file}`,'utf8'));
  sql.exec('PRAGMA foreign_keys=ON');
  const statement=(query,args=[])=>({bind(...values){return statement(query,values);},async first(){return sql.prepare(query).get(...args)||null;},async all(){return {results:sql.prepare(query).all(...args)};},async run(){return {meta:{changes:Number(sql.prepare(query).run(...args).changes)}};}});
  const env={ADMIN_TOKEN:'retention-admin',DB:{prepare:statement,async batch(items){sql.exec('BEGIN');try{const result=[];for(const item of items)result.push(await item.run());sql.exec('COMMIT');return result;}catch(error){sql.exec('ROLLBACK');throw error;}}}};
  const call=async(path,method='GET',data,credential)=>{
    const response=await handle(new Request(`https://vibecheck.test/api/${path}`,{method,headers:{...(data?{'Content-Type':'application/json'}:{}),...(credential?{Authorization:`Bearer ${credential}`}:{})},body:data?JSON.stringify(data):undefined}),env);
    return {status:response.status,data:await response.json()};
  };
  const register=async()=>{const result=await call('register','POST',{name:'Private Person',email:'private@example.com'});assert.equal(result.status,201);return result.data;};
  const answerMode=id=>{if(sql.prepare('PRAGMA table_info(requests)').all().some(c=>c.name==='review_mode'))sql.prepare("UPDATE requests SET review_mode='answer' WHERE id=?").run(id);};
  return {sql,env,call,register,answerMode};
}

function assertScrubbed(row){
  for(const key of ['token_hash','name','email','description','access_notes','scope','reply','answer_text','ip_hash'])assert.equal(row[key],'',key);
  assert.equal(row.links,'[]');assert.ok(row.purged_at);
}

test('a prepayment estimate cannot finish a paid answer; the distinct final answer is visible until scrubbed',async()=>{
  const t=fixture(),user=await t.register();t.answerMode(user.id);
  t.sql.prepare("UPDATE requests SET status='paid',paid_at=?,description='private source',links='[\"https://example.com/private\"]',access_notes='private note',reply='Prepayment estimate' WHERE id=?").run(Date.now(),user.id);
  const path=`admin/requests/${user.id}`;
  assert.equal((await t.call(path,'POST',{action:'finish'},'retention-admin')).status,400);
  assert.equal((await t.call(path,'POST',{action:'finish',confirmDelivered:true,answerText:'  '},'retention-admin')).status,400);
  assert.equal((await t.call(path,'POST',{action:'finish',answerText:'The paid answer.'},'retention-admin')).status,400);
  const done=await t.call(path,'POST',{action:'finish',answerText:'The paid answer.',confirmDelivered:true},'retention-admin');
  assert.equal(done.status,200);assert.equal(done.data.answer_text,'The paid answer.');
  const finished=t.sql.prepare('SELECT * FROM requests WHERE id=?').get(user.id);
  assert.equal(finished.reply,'Prepayment estimate');assert.equal(finished.answer_text,'The paid answer.');
  assert.equal(finished.purge_after-finished.finished_at,6*DAY);
  assert.equal((await t.call(`requests/${user.id}`,'GET',null,user.token)).data.answer_text,'The paid answer.');
  assert.equal((await t.call(`requests/${user.id}`,'PUT',{description:'changed',links:['https://example.com'],notes:'',complete:true},user.token)).status,409);
  assert.equal((await purgeFinishedReviews(t.env,finished.purge_after-1)).purged,0);
  assert.equal((await purgeFinishedReviews(t.env,finished.purge_after)).purged,1);
  const scrubbed=t.sql.prepare('SELECT * FROM requests WHERE id=?').get(user.id);assertScrubbed(scrubbed);
  assert.equal(scrubbed.status,'paid');assert.ok(scrubbed.paid_at);
  assert.equal(t.sql.prepare('SELECT count(*) AS n FROM email_outbox WHERE request_id=?').get(user.id).n,0);
  assert.equal((await t.call(`requests/${user.id}`,'GET',null,user.token)).status,401);
});

test('booked work ends at the purchased appointment end and removes private room fragments without deleting accounting',async()=>{
  const t=fixture(),user=await t.register(),start=Date.now()-3600000;
  t.sql.prepare('INSERT INTO slots(id,starts_at,ends_at,zoom_url,request_id,created_at) VALUES(?,?,?,?,?,?)').run('past-slot',start,start+900000,ROOM,user.id,start-DAY);
  t.sql.prepare('INSERT INTO slots(id,starts_at,ends_at,zoom_url,created_at) VALUES(?,?,?,?,?)').run('unused-same-room',start+DAY,start+DAY+900000,ROOM,start-DAY);
  t.sql.prepare("UPDATE requests SET status='booked',paid_at=?,booked_slot_id='past-slot',description='private project',reply='private estimate' WHERE id=?").run(start-DAY,user.id);
  t.sql.prepare("INSERT INTO slot_claims(slot_id,request_id,state) VALUES('past-slot',?,'booked')").run(user.id);
  t.sql.prepare("INSERT INTO connections(id,request_id,provider,external_id,resource,encrypted_credentials,created_at) VALUES('figma-1',?,'figma','person','{\"url\":\"https://figma.com/private\"}','secret',?)").run(user.id,start);
  t.sql.prepare("INSERT INTO email_outbox(id,request_id,category,kind,subject,message,created_at,due_at) VALUES('mail-1',?,'transactional','reply-1','Private subject','Private message',?,?)").run(user.id,start,start);
  const first=await purgeFinishedReviews(t.env,start+900001);assert.equal(first.finished,1);
  assert.equal(t.sql.prepare("SELECT encrypted_credentials FROM connections WHERE id='figma-1'").get().encrypted_credentials,'');
  const due=t.sql.prepare('SELECT purge_after FROM requests WHERE id=?').get(user.id).purge_after;
  assert.equal(due,start+900000+6*DAY);
  assert.equal((await purgeFinishedReviews(t.env,due)).purged,1);
  assertScrubbed(t.sql.prepare('SELECT * FROM requests WHERE id=?').get(user.id));
  assert.equal(t.sql.prepare('SELECT count(*) AS n FROM email_outbox WHERE request_id=?').get(user.id).n,0);
  assert.equal(t.sql.prepare('SELECT count(*) AS n FROM slot_claims WHERE request_id=?').get(user.id).n,1);
  assert.equal(t.sql.prepare("SELECT zoom_url FROM slots WHERE id='past-slot'").get().zoom_url,ROOM.split('#')[0]);
  assert.equal(t.sql.prepare("SELECT zoom_url FROM slots WHERE id='unused-same-room'").get().zoom_url,ROOM.split('#')[0]);
});

test('unverified outside invitation remains a retryable operator task while customer content is scrubbed',async()=>{
  const t=fixture(),user=await t.register(),now=Date.now();
  t.sql.prepare('INSERT INTO slots(id,starts_at,ends_at,zoom_url,request_id,created_at) VALUES(?,?,?,?,?,?)').run('private-room',now-DAY,now-DAY+900000,ROOM,user.id,now-2*DAY);
  t.sql.prepare("UPDATE requests SET status='booked',paid_at=?,booked_slot_id='private-room',finished_at=?,purge_after=?,description='private text',reply='private estimate',links='[\"https://example.com/private\"]' WHERE id=?").run(now-2*DAY,now-DAY,now-1,user.id);
  t.sql.prepare("INSERT INTO access_grants(id,request_id,provider,resource,created_at) VALUES('invite-1',?,'other','Private invitation',?)").run(user.id,now-DAY);
  const pending=await purgeFinishedReviews(t.env,now);assert.equal(pending.waitingForAccess,1);assert.equal(pending.purged,1);
  assertScrubbed(t.sql.prepare('SELECT * FROM requests WHERE id=?').get(user.id));
  assert.equal(t.sql.prepare("SELECT state FROM access_grants WHERE id='invite-1'").get().state,'cleanup_due');
  assert.equal((await t.call(`requests/${user.id}`,'GET',null,user.token)).status,401);
  assert.equal((await t.call('admin/grants/invite-1','POST',{confirmRemoved:true},'retention-admin')).status,200);
  assert.equal(t.sql.prepare("SELECT resource FROM access_grants WHERE id='invite-1'").get().resource,'');
  assert.equal(t.sql.prepare('SELECT * FROM requests WHERE id=?').get(user.id).status,'booked');
});

test('draft cutoff uses immutable registration time even after a recent edit',async()=>{
  const t=fixture(),user=await t.register(),now=Date.now();
  t.sql.prepare("UPDATE requests SET created_at=?,updated_at=?,description='private draft' WHERE id=?").run(now-7*DAY-1,now,user.id);
  assert.equal((await t.call(`requests/${user.id}`,'PUT',{description:'changed',links:['https://example.com'],notes:'',complete:false},user.token)).status,410);
  assert.equal((await purgeFinishedReviews(t.env,now)).purged,1);
  const row=t.sql.prepare('SELECT * FROM requests WHERE id=?').get(user.id);assertScrubbed(row);
  assert.equal(row.status,'expired');assert.equal(row.purge_after,row.created_at+7*DAY);
});

test('unpaid submitted request scrubs at its seven-day deadline after safe payment reconciliation',async()=>{
  const t=fixture(),user=await t.register(),now=Date.now();
  assert.equal((await t.call(`requests/${user.id}`,'PUT',{description:'Private project',links:['https://example.com/private'],notes:'private note',complete:true},user.token)).status,200);
  t.sql.prepare('UPDATE requests SET expires_at=?,status=? WHERE id=?').run(now-1,'approved',user.id);
  assert.equal((await expireUnpaid(t.env,now)).expired,1);
  assert.equal((await purgeFinishedReviews(t.env,now)).purged,1);
  const row=t.sql.prepare('SELECT * FROM requests WHERE id=?').get(user.id);assertScrubbed(row);
  assert.equal(row.status,'expired');assert.equal(row.purge_after,now-1);
});

test('uncertain extra-time payment blocks finish and delays content scrub until reconciliation',async()=>{
  const t=fixture(),user=await t.register(),now=Date.now();t.answerMode(user.id);
  t.sql.prepare('INSERT INTO slots(id,starts_at,ends_at,zoom_url,created_at) VALUES(?,?,?,?,?)').run('held-slot',now+DAY,now+DAY+900000,ROOM,now);
  t.sql.prepare("UPDATE requests SET status='paid',paid_at=?,description='private project',reply='Estimate' WHERE id=?").run(now-DAY,user.id);
  t.sql.prepare("INSERT INTO review_payments(id,request_id,minutes,from_minutes,amount_cents,total_cents,slot_id,status,checkout_expires_at,stripe_payload,created_at) VALUES('attempt-1',?,30,15,2000,4500,'held-slot','open',?,?,?)").run(user.id,now+DAY,'{"customer_email":"private@example.com"}',now);
  assert.equal((await t.call(`admin/requests/${user.id}`,'POST',{action:'finish',answerText:'Final answer',confirmDelivered:true},'retention-admin')).status,409);
  // Simulate an already finished row with a late payment state requiring reconciliation.
  t.sql.prepare('UPDATE requests SET finished_at=?,purge_after=? WHERE id=?').run(now-7*DAY,now-1,user.id);
  const pending=await purgeFinishedReviews(t.env,now);
  assert.equal(pending.waitingForPayments,1);assert.equal(pending.purged,0);
  assert.equal(t.sql.prepare('SELECT description FROM requests WHERE id=?').get(user.id).description,'private project');
  assert.equal(t.sql.prepare("SELECT status FROM review_payments WHERE id='attempt-1'").get().status,'open');
  t.sql.prepare("UPDATE review_payments SET status='expired' WHERE id='attempt-1'").run();
  assert.equal((await purgeFinishedReviews(t.env,now+1)).purged,1);
  assertScrubbed(t.sql.prepare('SELECT * FROM requests WHERE id=?').get(user.id));
  const settled=t.sql.prepare("SELECT status,amount_cents,stripe_payload FROM review_payments WHERE id='attempt-1'").get();
  assert.equal(settled.status,'expired');assert.equal(settled.amount_cents,2000);assert.equal(settled.stripe_payload,'{}');
});

test('an uncertain deposit preserves unpaid access and content until Stripe is reconciled',async()=>{
  const t=fixture(),user=await t.register(),now=Date.now();
  t.sql.prepare("UPDATE requests SET status='approved',expires_at=?,description='private project',links='[\"https://example.com/private\"]' WHERE id=?").run(now-1,user.id);
  t.sql.prepare("INSERT INTO deposit_payments(id,request_id,review_mode,status,claims_ready,checkout_expires_at,stripe_payload,created_at) VALUES('uncertain-deposit',?,'answer','creating',1,?,?,?)")
    .run(user.id,now+3600000,'{"customer_email":"private@example.com"}',now);
  t.sql.prepare("INSERT INTO connections(id,request_id,provider,external_id,resource,encrypted_credentials,created_at) VALUES('pending-figma',?,'figma','person','{}','sealed',?)").run(user.id,now);
  assert.equal((await expireUnpaid(t.env,now)).expired,0);
  assert.equal(t.sql.prepare('SELECT status,description FROM requests WHERE id=?').get(user.id).description,'private project');
  assert.equal(t.sql.prepare("SELECT state FROM connections WHERE id='pending-figma'").get().state,'active');
  t.sql.prepare("UPDATE deposit_payments SET status='expired' WHERE id='uncertain-deposit'").run();
  assert.equal((await expireUnpaid(t.env,now)).expired,1);
  assert.equal((await purgeFinishedReviews(t.env,now)).purged,1);
  assertScrubbed(t.sql.prepare('SELECT * FROM requests WHERE id=?').get(user.id));
  const payment=t.sql.prepare("SELECT status,stripe_payload,checkout_url FROM deposit_payments WHERE id='uncertain-deposit'").get();
  assert.equal(payment.status,'expired');assert.equal(payment.stripe_payload,'{}');assert.equal(payment.checkout_url,null);
});

test('a hundred uncertain legacy sessions cannot prevent a later unpaid request from expiring',async()=>{
  const t=fixture(),now=900000;
  const insert=t.sql.prepare("INSERT INTO requests(id,token_hash,name,email,status,created_at,updated_at,expires_at,stripe_session_id,ip_hash) VALUES(?,'old','Old','old@example.com','approved',?,?,?,'cs_uncertain','old')");
  for(let i=0;i<100;i++)insert.run(`legacy-${i}`,i,i,now-1);
  const user=await t.register();
  t.sql.prepare("UPDATE requests SET status='approved',expires_at=? WHERE id=?").run(now-1,user.id);
  assert.equal((await expireUnpaid(t.env,now)).expired,1);
  assert.equal(t.sql.prepare('SELECT status FROM requests WHERE id=?').get(user.id).status,'expired');
  assert.equal(t.sql.prepare("SELECT count(*) AS n FROM requests WHERE stripe_session_id='cs_uncertain' AND status='approved'").get().n,100);
});

test('more than 100 failed external grant removals cannot starve a later retry',async()=>{
  const t=fixture();
  const request=t.sql.prepare("INSERT INTO requests(id,token_hash,name,email,status,created_at,updated_at,ip_hash) VALUES(?,'fixture','Test','test@example.com','expired',0,0,'fixture')");
  const grant=t.sql.prepare("INSERT INTO access_grants(id,request_id,provider,resource,state,created_at) VALUES(?,?,?,?,'cleanup_due',0)");
  for(let i=0;i<=100;i++){
    const id=`retry-${String(i).padStart(3,'0')}`;
    request.run(id);grant.run(`grant-${i}`,id,i===100?'github':'other',i===100?'owner/project':'Manual removal needed');
  }
  t.env.GITHUB_ACCESS_TOKEN='fixture';t.env.GITHUB_USERNAME='owner';
  t.env.FETCH=async()=>new Response(null,{status:204});
  await expireUnpaid(t.env,0);
  assert.equal(t.sql.prepare("SELECT state FROM access_grants WHERE id='grant-100'").get().state,'cleanup_due');
  await expireUnpaid(t.env,900000);
  assert.equal(t.sql.prepare("SELECT state FROM access_grants WHERE id='grant-100'").get().state,'removed');
  assert.equal(t.sql.prepare("SELECT count(*) AS n FROM access_grants WHERE state='cleanup_due'").get().n,100);
});

test('a hundred pending payments cannot prevent a later due request from being scrubbed',async()=>{
  const t=fixture(),now=900000;
  const request=t.sql.prepare("INSERT INTO requests(id,token_hash,name,email,status,created_at,updated_at,finished_at,purge_after,ip_hash) VALUES(?,'old','Old','old@example.com','expired',?,?,?,?,'old')");
  const payment=t.sql.prepare("INSERT INTO deposit_payments(id,request_id,review_mode,status,claims_ready,checkout_expires_at,stripe_payload,created_at) VALUES(?,?,'answer','creating',1,?,'{}',?)");
  for(let i=0;i<100;i++){
    const id=`waiting-${i}`;request.run(id,i,i,i+1,i+1);payment.run(`deposit-${i}`,id,now+3600000,i);
  }
  const user=await t.register();
  t.sql.prepare("UPDATE requests SET status='expired',finished_at=?,purge_after=?,description='private project' WHERE id=?").run(200,200,user.id);
  const result=await purgeFinishedReviews(t.env,now);
  assert.equal(result.waitingForPayments,100);assert.equal(result.purged,1);
  assertScrubbed(t.sql.prepare('SELECT * FROM requests WHERE id=?').get(user.id));
});
