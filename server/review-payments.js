import {calendarBusy,overlapsBusy} from './calendar.js';
const BLOCK=900000, LEAD=35*60000;
const TOTALS={15:2500,30:4500,60:8000};
// A password change does not make a room a different meeting. Pending holds
// reserve its identity too; the guarded claim repeats this predicate atomically.
export const privateRoom=`NOT EXISTS(SELECT 1 FROM slots room LEFT JOIN slot_claims held ON held.slot_id=room.id
  WHERE substr(room.zoom_url,1,instr(room.zoom_url||'#','#')-1)=substr(s.zoom_url,1,instr(s.zoom_url||'#','#')-1)
  AND (coalesce(room.request_id!=?,0) OR coalesce(held.request_id!=?,0)))`;
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const load=(env,id)=>env.DB.prepare('SELECT * FROM requests WHERE id=?').bind(id).first();
const pending=(env,id)=>env.DB.prepare("SELECT * FROM review_payments WHERE request_id=? AND status IN ('creating','open')").bind(id).first();
export const validReviewMinutes=minutes=>Number.isInteger(minutes)&&Object.hasOwn(TOTALS,minutes);
export async function reviewBilling(env,row){
  const extra=await env.DB.prepare("SELECT coalesce(sum(amount_cents),0) AS amount FROM review_payments WHERE request_id=? AND status='paid'").bind(row.id).first();
  const paid=(row.paid_at?2500:0)+extra.amount,minutes=row.review_minutes||15;
  const attempt=await pending(env,row.id);
  return {billing:{minutes,paid_cents:paid,options:[15,30,60].filter(value=>value>=minutes).map(value=>({minutes:value,total_cents:TOTALS[value],due_cents:Math.max(0,TOTALS[value]-paid)}))},pending_upgrade:attempt?{minutes:attempt.minutes,slot_id:attempt.slot_id,status:attempt.status,expires_at:attempt.checkout_expires_at}:null};
}
async function stripe(env,path,values,key){
  if(!env.STRIPE_SECRET_KEY)fail(503,'Payments are not connected. Your current review is unchanged.');
  const response=await (env.FETCH||fetch)(`https://api.stripe.com/v1/${path}`,{method:values?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:`Bearer ${env.STRIPE_SECRET_KEY}`,...(values?{'Content-Type':'application/x-www-form-urlencoded'}:{}),...(key?{'Idempotency-Key':key}:{})},body:values?new URLSearchParams(values):undefined});
  if(!response.ok)fail(502,'Stripe could not confirm the payment. Your reserved time is being held while we check.');
  return response.json();
}
// Every booking path shares these claims. A query can show availability, but
// only the single guarded INSERT below reserves it against concurrent buyers.
async function range(env,slotId,minutes){
  const start=await env.DB.prepare('SELECT * FROM slots WHERE id=?').bind(slotId).first();
  if(!start)return [];
  return (await env.DB.prepare('SELECT * FROM slots WHERE starts_at>=? AND starts_at<? AND zoom_url=? AND ends_at=starts_at+? ORDER BY starts_at').bind(start.starts_at,start.starts_at+minutes*60000,start.zoom_url,BLOCK).all()).results;
}
export async function availableReviewSlots(env,row,minutes=15,now=Date.now()){
  if(row.finished_at||row.purged_at||row.review_mode==='answer'||!validReviewMinutes(minutes)||minutes<(row.review_minutes||15))return [];
  const limit=minutes>15?now+LEAD:now;
  const all=(await env.DB.prepare(`SELECT s.*,c.request_id AS claimed_by FROM slots s LEFT JOIN slot_claims c ON c.slot_id=s.id WHERE s.starts_at>? AND s.starts_at<=? AND ${privateRoom} ORDER BY s.starts_at`).bind(limit,now+7*86400000,row.id,row.id).all()).results;
  if(!all.length)return [];
  const busy=await calendarBusy(env,all[0].starts_at,all.at(-1).starts_at+60*60000);
  const byStart=new Map(all.map(slot=>[slot.starts_at,slot]));
  const result=[];
  for(const start of all){
    if(row.booked_slot_id&&start.id!==row.booked_slot_id)continue;
    const blocks=Array.from({length:minutes/15},(_,i)=>byStart.get(start.starts_at+i*BLOCK));
    const end=start.starts_at+minutes*60000;
    const checkedFrom=row.booked_slot_id===start.id?start.starts_at+(row.review_minutes||15)*60000:start.starts_at;
    if(!overlapsBusy(busy,checkedFrom,end)&&blocks.every(slot=>slot&&slot.ends_at===slot.starts_at+BLOCK&&slot.zoom_url===start.zoom_url&&(!slot.request_id||slot.request_id===row.id)&&(!slot.claimed_by||slot.claimed_by===row.id)))result.push({id:start.id,starts_at:start.starts_at,ends_at:end});
  }
  return result;
}
export async function adminReviewSlots(env,now=Date.now()){
  return (await env.DB.prepare(`SELECT s.*,(SELECT state FROM slot_claims WHERE slot_id=s.id) AS claim_state,
    NOT(${privateRoom}) AS room_reserved FROM slots s WHERE starts_at>? ORDER BY starts_at LIMIT 100`).bind('','',now).all()).results;
}
async function claim(env,row,slotId,minutes,paymentId){
  const blocks=await range(env,slotId,minutes),count=minutes/15;
  if(blocks.length!==count||blocks.some((slot,i)=>slot.starts_at!==blocks[0].starts_at+i*BLOCK))fail(409,'That continuous review time is no longer available.');
  const start=blocks[0],end=start.starts_at+minutes*60000;
  const checkedFrom=row.booked_slot_id===slotId?start.starts_at+(row.review_minutes||15)*60000:start.starts_at;
  if(checkedFrom<end&&overlapsBusy(await calendarBusy(env,checkedFrom,end),checkedFrom,end))fail(409,'Ashley’s calendar now has a conflict at that time. Choose another.');
  // The availability predicate applies to the WHOLE range before any INSERT.
  await env.DB.prepare(`INSERT OR IGNORE INTO slot_claims(slot_id,request_id,payment_id,state)
    SELECT s.id,?,?,? FROM slots s WHERE s.starts_at>=? AND s.starts_at<? AND s.zoom_url=? AND s.ends_at=s.starts_at+?
    AND ${privateRoom}
    AND EXISTS(SELECT 1 FROM requests r WHERE r.id=? AND r.paid_at IS NOT NULL AND r.finished_at IS NULL AND r.purged_at IS NULL AND r.review_minutes=? AND (r.booked_slot_id IS NULL OR r.booked_slot_id=?)
      AND (? IS NOT NULL OR (r.booked_slot_id IS NULL AND NOT EXISTS(SELECT 1 FROM review_payments p WHERE p.request_id=r.id AND p.status IN ('creating','open'))))
      AND (? IS NULL OR EXISTS(SELECT 1 FROM review_payments active WHERE active.id=? AND active.request_id=r.id AND active.status IN ('creating','open')))
      AND NOT EXISTS(SELECT 1 FROM slot_claims own JOIN slots os ON os.id=own.slot_id WHERE own.request_id=r.id AND NOT(r.booked_slot_id IS NOT NULL AND own.state='booked' AND os.starts_at>=(SELECT starts_at FROM slots WHERE id=r.booked_slot_id) AND os.starts_at<(SELECT starts_at FROM slots WHERE id=r.booked_slot_id)+r.review_minutes*60000 OR coalesce(own.payment_id=? AND own.state='held',0))))
    AND (SELECT count(*) FROM slots t WHERE t.starts_at>=? AND t.starts_at<? AND t.zoom_url=? AND t.ends_at=t.starts_at+?
      AND (t.request_id IS NULL OR t.request_id=?) AND NOT EXISTS(SELECT 1 FROM slot_claims c WHERE c.slot_id=t.id AND c.request_id!=?))=?`).bind(row.id,paymentId,paymentId?'held':'booked',start.starts_at,end,start.zoom_url,BLOCK,row.id,row.id,row.id,row.review_minutes||15,slotId,paymentId,paymentId,paymentId,paymentId,start.starts_at,end,start.zoom_url,BLOCK,row.id,row.id,count).run();
  const held=await env.DB.prepare('SELECT count(*) AS n FROM slot_claims WHERE request_id=? AND slot_id IN (SELECT id FROM slots WHERE starts_at>=? AND starts_at<?)').bind(row.id,start.starts_at,end).first();
  if(held.n!==count)fail(409,'That time was just taken. Choose another.');
  return start;
}
async function finalize(env,attempt){
  const row=await load(env,attempt.request_id),start=await env.DB.prepare('SELECT * FROM slots WHERE id=?').bind(attempt.slot_id).first();
  if(!start)fail(409,'Payment was received, but the reserved time needs Ashley’s attention.');
  const end=start.starts_at+attempt.minutes*60000;
  const checkedFrom=row.booked_slot_id===start.id?start.starts_at+(row.review_minutes||15)*60000:start.starts_at;
  if(checkedFrom<end&&overlapsBusy(await calendarBusy(env,checkedFrom,end),checkedFrom,end))fail(409,'Payment was received, but Ashley’s calendar now has a conflict. The time needs her attention before it can be booked.');
  const held=await env.DB.prepare('SELECT count(*) AS n FROM slot_claims WHERE request_id=? AND slot_id IN (SELECT id FROM slots WHERE starts_at>=? AND starts_at<?)').bind(row.id,start.starts_at,start.starts_at+attempt.minutes*60000).first();
  if(held.n!==attempt.minutes/15)fail(409,'Payment was received but the time needs Ashley’s attention.');
  await env.DB.batch([
    env.DB.prepare('UPDATE slots SET request_id=? WHERE id=? AND (request_id IS NULL OR request_id=?)').bind(row.id,attempt.slot_id,row.id),
    env.DB.prepare("UPDATE requests SET review_minutes=max(review_minutes,?),booked_slot_id=?,status='booked',updated_at=? WHERE id=? AND paid_at IS NOT NULL AND (booked_slot_id IS NULL OR booked_slot_id=?)").bind(attempt.minutes,attempt.slot_id,Date.now(),row.id,attempt.slot_id),
    env.DB.prepare("UPDATE slot_claims SET state='booked' WHERE request_id=? AND payment_id=?").bind(row.id,attempt.id),
    env.DB.prepare("INSERT INTO audit(request_id,event,created_at) SELECT ?,'review_upgrade_verified',? WHERE EXISTS(SELECT 1 FROM review_payments WHERE id=? AND status!='paid')").bind(row.id,Date.now(),attempt.id),
    env.DB.prepare("UPDATE review_payments SET status='paid',paid_at=coalesce(paid_at,?) WHERE id=?").bind(Date.now(),attempt.id)
  ]);
}
function verifySession(attempt,session){
  if(session.id!==attempt.session_id||session.metadata?.request_id!==attempt.request_id||session.metadata?.review_payment_id!==attempt.id||session.amount_total!==attempt.amount_cents||session.currency!=='usd'||session.mode!=='payment')fail(409,'Payment details do not match this review.');
}
async function getSession(env,attempt){
  if(!attempt.claims_ready){
    const row=await load(env,attempt.request_id);
    try{
      const start=await env.DB.prepare('SELECT starts_at FROM slots WHERE id=?').bind(attempt.slot_id).first();
      if(!row?.paid_at||row.review_minutes!==attempt.from_minutes||!start||start.starts_at<=Date.now()+LEAD||attempt.checkout_expires_at<=Date.now()+30*60000)fail(409,'The unfinished payment reservation expired before checkout.');
      await claim(env,row,attempt.slot_id,attempt.minutes,attempt.id);
      const ready=await env.DB.prepare("UPDATE review_payments SET claims_ready=1 WHERE id=? AND status='creating'").bind(attempt.id).run();
      if(!ready.meta.changes)fail(409,'The payment reservation changed. Refresh before continuing.');
      attempt={...attempt,claims_ready:1};
    }catch(error){
      // No provider call can start while claims_ready is zero. Only that state
      // is safe to abandon without a provider result; never release open holds.
      await env.DB.batch([
        env.DB.prepare("UPDATE review_payments SET status='expired' WHERE id=? AND claims_ready=0 AND session_id IS NULL").bind(attempt.id),
        env.DB.prepare("DELETE FROM slot_claims WHERE payment_id=? AND state='held' AND EXISTS(SELECT 1 FROM review_payments p WHERE p.id=? AND p.status='expired')").bind(attempt.id,attempt.id)
      ]);
      throw error;
    }
  }
  if(!attempt.session_id){
    // Persisted payload and idempotency key recover a lost creation response.
    // After Stripe's >=24h idempotency retention window, do not blindly retry.
    if(Date.now()-attempt.created_at>=23*3600000)fail(409,'An uncertain payment needs Ashley’s attention before releasing the time.');
    const session=await stripe(env,'checkout/sessions',JSON.parse(attempt.stripe_payload),`review-${attempt.id}`);
    if(typeof session.id!=='string'||!session.id.startsWith('cs_'))fail(502,'Stripe did not return a valid payment session.');
    await env.DB.prepare("UPDATE review_payments SET session_id=?,checkout_url=?,status='open' WHERE id=? AND status='creating'").bind(session.id,session.url||null,attempt.id).run();
    attempt={...attempt,session_id:session.id};verifySession(attempt,session);return {attempt,session};
  }
  const session=await stripe(env,`checkout/sessions/${encodeURIComponent(attempt.session_id)}`);verifySession(attempt,session);return {attempt,session};
}
async function reconcile(env,attempt,cancel=false,now=Date.now()){
  let result=await getSession(env,attempt);attempt=result.attempt;let session=result.session;
  if(session.payment_status==='paid'){await finalize(env,attempt);return {paid:true};}
  if(session.status==='open'&&(cancel||attempt.checkout_expires_at<=now)){
    await stripe(env,`checkout/sessions/${encodeURIComponent(attempt.session_id)}/expire`,{});
    session=await stripe(env,`checkout/sessions/${encodeURIComponent(attempt.session_id)}`);verifySession(attempt,session);
    if(session.payment_status==='paid'){await finalize(env,attempt);return {paid:true};}
  }
  if(session.status==='expired'&&session.payment_status==='unpaid'){
    await env.DB.batch([
      env.DB.prepare("DELETE FROM slot_claims WHERE payment_id=? AND state='held'").bind(attempt.id),
      env.DB.prepare("UPDATE review_payments SET status='expired',checkout_url=NULL WHERE id=? AND status IN ('creating','open')").bind(attempt.id)
    ]);return {expired:true};
  }
  if(session.status!=='open')fail(409,'Payment is still being confirmed. Your reserved time remains held.');
  return {url:session.url};
}
export async function confirmReviewPayment(env,row){
  const attempt=await pending(env,row.id);if(attempt)await reconcile(env,attempt);
  return load(env,row.id);
}
export async function reconcilePendingReviews(env,now=Date.now()){
  const total=(await env.DB.prepare("SELECT count(*) AS n FROM review_payments WHERE status IN ('creating','open')").first()).n;
  const limit=Math.min(100,total),offset=total?(Math.floor(now/900000)*100)%total:0;
  const attempts=limit?(await env.DB.prepare("SELECT * FROM review_payments WHERE status IN ('creating','open') ORDER BY created_at,id LIMIT ? OFFSET ?").bind(limit,offset).all()).results:[];
  if(attempts.length<limit){
    const wrap=(await env.DB.prepare("SELECT * FROM review_payments WHERE status IN ('creating','open') ORDER BY created_at,id LIMIT ?").bind(limit-attempts.length).all()).results;
    const seen=new Set(attempts.map(row=>row.id));
    attempts.push(...wrap.filter(row=>!seen.has(row.id)));
  }
  let confirmed=0,released=0,deferred=0;
  for(const attempt of attempts){try{const result=await reconcile(env,attempt,false,now);if(result.paid)confirmed++;if(result.expired)released++;}catch{deferred++;}}
  return {confirmed,released,deferred};
}
export async function cancelReviewUpgrade(env,row){
  const attempt=await pending(env,row.id);if(attempt)await reconcile(env,attempt,true);
  return load(env,row.id);
}
export async function reviewWebhook(env,event){
  const id=event.data?.object?.metadata?.review_payment_id;
  if(!id)return false;
  const attempt=await env.DB.prepare('SELECT * FROM review_payments WHERE id=?').bind(id).first();
  if(attempt&&attempt.session_id===event.data.object.id&&attempt.status!=='paid')await reconcile(env,attempt);
  return true;
}
export async function bookReview(env,row,slotId,now=Date.now()){
  if(row.finished_at||row.purged_at||row.review_mode==='answer')fail(409,'This review cannot be booked.');
  if(row.booked_slot_id)return row;
  if(await pending(env,row.id))fail(409,'Finish or cancel the pending upgrade before booking another time.');
  const available=await availableReviewSlots(env,row,15,now);
  if(!available.some(slot=>slot.id===slotId))fail(409,'That time is no longer available. Choose another.');
  // Claim direct bookings with a request-scoped durable lock too.
  const claimed=await claim(env,row,slotId,15,null);
  let result;try{result=await env.DB.batch([
    env.DB.prepare("UPDATE slots SET request_id=? WHERE id=? AND request_id IS NULL AND EXISTS(SELECT 1 FROM requests WHERE id=? AND paid_at IS NOT NULL AND finished_at IS NULL AND purged_at IS NULL AND booked_slot_id IS NULL AND NOT EXISTS(SELECT 1 FROM review_payments p WHERE p.request_id=requests.id AND p.status IN ('creating','open')))").bind(row.id,slotId,row.id),
    env.DB.prepare("UPDATE requests SET booked_slot_id=?,review_minutes=15,status='booked',updated_at=? WHERE id=? AND finished_at IS NULL AND purged_at IS NULL AND booked_slot_id IS NULL AND EXISTS(SELECT 1 FROM slots WHERE id=? AND request_id=?)").bind(slotId,now,row.id,slotId,row.id)
  ]);}catch(error){await env.DB.prepare("DELETE FROM slot_claims WHERE slot_id=? AND request_id=? AND payment_id IS NULL AND NOT EXISTS(SELECT 1 FROM slots WHERE id=? AND request_id=?)").bind(claimed.id,row.id,slotId,row.id).run();throw error;}
  if(!result[0].meta.changes){await env.DB.prepare("DELETE FROM slot_claims WHERE slot_id=? AND request_id=? AND payment_id IS NULL AND NOT EXISTS(SELECT 1 FROM slots WHERE id=? AND request_id=?)").bind(claimed.id,row.id,slotId,row.id).run();fail(409,'That time was just taken. Choose another.');}
  await env.DB.prepare("INSERT INTO audit(request_id,event,created_at) VALUES(?,'booked',?)").bind(row.id,now).run();return load(env,row.id);
}
export async function createReviewCheckout(env,row,slotId,minutes,origin,now=Date.now()){
  if(row.finished_at||row.purged_at||row.review_mode==='answer')fail(409,'This review cannot be extended.');
  if(!row.paid_at||!['paid','booked'].includes(row.status))fail(403,'Your first $25 payment must be verified before reserving a longer review.');
  if(!validReviewMinutes(minutes)||minutes<=Number(row.review_minutes||15))fail(400,'Choose a longer review of 30 or 60 minutes.');
  const existing=await pending(env,row.id);
  if(existing){if(existing.minutes!==minutes||existing.slot_id!==slotId)fail(409,'Finish or cancel the pending upgrade before choosing another.');const result=await reconcile(env,existing);if(result.url&&!env.STRIPE_WEBHOOK_SECRET)fail(503,'Review payments are not fully connected yet.');return result;}
  if(!env.STRIPE_SECRET_KEY||!env.STRIPE_WEBHOOK_SECRET)fail(503,'Review payments are not connected yet.');
  if(row.booked_slot_id&&row.booked_slot_id!==slotId)fail(409,'Extend your existing appointment time. Contact Ashley to reschedule.');
  const available=await availableReviewSlots(env,row,minutes,now);
  if(!available.some(slot=>slot.id===slotId))fail(409,'That continuous review time is no longer available.');
  const {billing}=await reviewBilling(env,row),amount=TOTALS[minutes]-billing.paid_cents;
  if(amount<=0)fail(409,'Your review payment needs attention before another charge.');
  const id=crypto.randomUUID(),expires=Math.floor((now+31*60000)/1000);
  // A human project review is not eligible for Stripe Managed Payments.
  const payload={mode:'payment','managed_payments[enabled]':'false',customer_email:row.email,
    success_url:`${origin}/?request=${row.id}&payment=returned#request`,cancel_url:`${origin}/?request=${row.id}#request`,
    'metadata[request_id]':row.id,'metadata[review_payment_id]':id,'metadata[minutes]':String(minutes),client_reference_id:id,
    'line_items[0][quantity]':'1','line_items[0][price_data][currency]':'usd','line_items[0][price_data][unit_amount]':String(amount),
    'line_items[0][price_data][product_data][name]':`Vibe Check — ${minutes}-minute review upgrade`,
    'line_items[0][price_data][product_data][description]':`$${amount/100} remaining; $${TOTALS[minutes]/100} total, including payments already received. Prepaid reserved time is non-refundable.`,expires_at:String(expires)};
  try{await env.DB.prepare("INSERT INTO review_payments(id,request_id,minutes,from_minutes,amount_cents,total_cents,slot_id,status,checkout_expires_at,stripe_payload,created_at) VALUES(?,?,?,?,?,?,?,'creating',?,?,?)").bind(id,row.id,minutes,row.review_minutes||15,amount,TOTALS[minutes],slotId,expires*1000,JSON.stringify(payload),now).run();}catch{fail(409,'Another payment is being prepared. Refresh before continuing.');}
  try{await claim(env,row,slotId,minutes,id);}catch(error){await env.DB.batch([env.DB.prepare("UPDATE review_payments SET status='expired' WHERE id=? AND claims_ready=0 AND session_id IS NULL").bind(id),env.DB.prepare("DELETE FROM slot_claims WHERE payment_id=? AND state='held' AND EXISTS(SELECT 1 FROM review_payments p WHERE p.id=? AND p.status='expired')").bind(id,id)]);throw error;}
  const ready=await env.DB.prepare("UPDATE review_payments SET claims_ready=1 WHERE id=? AND status='creating'").bind(id).run();
  if(!ready.meta.changes)fail(409,'The payment reservation changed. Refresh before continuing.');
  // No release after this point without authenticated Stripe reconciliation.
  return reconcile(env,await pending(env,row.id));
}
