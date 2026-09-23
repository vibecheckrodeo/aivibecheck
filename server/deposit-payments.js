import {availableReviewSlots,privateRoom} from './review-payments.js';
import {calendarBusy,overlapsBusy} from './calendar.js';

const BLOCK=900000, CHECKOUT=31*60000, LEAD=60*60000, DAY=86400000;
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const load=(env,id)=>env.DB.prepare('SELECT * FROM requests WHERE id=?').bind(id).first();
const pending=(env,id)=>env.DB.prepare("SELECT * FROM deposit_payments WHERE request_id=? AND status IN ('creating','open')").bind(id).first();
export const latestDeposit=(env,id)=>env.DB.prepare('SELECT * FROM deposit_payments WHERE request_id=? ORDER BY created_at DESC LIMIT 1').bind(id).first();

async function stripe(env,path,values,key){
  if(!env.STRIPE_SECRET_KEY)fail(503,'Deposit payments are not connected yet.');
  const response=await (env.FETCH||fetch)(`https://api.stripe.com/v1/${path}`,{method:values?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:`Bearer ${env.STRIPE_SECRET_KEY}`,...(values?{'Content-Type':'application/x-www-form-urlencoded'}:{}),...(key?{'Idempotency-Key':key}:{})},body:values?new URLSearchParams(values):undefined});
  if(!response.ok)fail(502,'Stripe could not confirm the deposit. We are keeping this payment under review.');
  return response.json();
}
function verifySession(attempt,session){
  if(session.id!==attempt.session_id||session.metadata?.request_id!==attempt.request_id||session.metadata?.deposit_payment_id!==attempt.id||session.metadata?.review_mode!==attempt.review_mode||session.amount_total!==2500||session.currency!=='usd'||session.mode!=='payment')fail(409,'Payment details do not match this request.');
}
export async function depositSlots(env,row,now=Date.now()){
  if(row.status!=='approved'||row.paid_at||row.expires_at<=now+CHECKOUT+60000)return [];
  const slots=await availableReviewSlots(env,row,15,now);
  return slots.filter(slot=>slot.starts_at>now+LEAD);
}
export async function depositSummary(env,row){
  const attempt=await pending(env,row.id);
  if(!attempt)return null;
  const slot=attempt.slot_id?await env.DB.prepare('SELECT starts_at FROM slots WHERE id=?').bind(attempt.slot_id).first():null;
  return {mode:attempt.review_mode,slot_id:attempt.slot_id,starts_at:slot?.starts_at||null,status:attempt.status,expires_at:attempt.checkout_expires_at,payment_received:Boolean(attempt.provider_paid_at)};
}
async function reserve(env,row,attempt,now=Date.now()){
  if(attempt.review_mode==='answer')return;
  const selected=await env.DB.prepare('SELECT starts_at,ends_at FROM slots WHERE id=?').bind(attempt.slot_id).first();
  if(!selected)fail(409,'That time is no longer available. Choose another.');
  if(overlapsBusy(await calendarBusy(env,selected.starts_at,selected.ends_at),selected.starts_at,selected.ends_at))fail(409,'Ashley’s calendar now has a conflict at that time. Choose another.');
  await env.DB.prepare(`INSERT OR IGNORE INTO slot_claims(slot_id,request_id,deposit_payment_id,state)
    SELECT s.id,?,?,'held' FROM slots s WHERE s.id=? AND s.starts_at>? AND s.starts_at<=? AND s.ends_at=s.starts_at+?
    AND s.request_id IS NULL AND ${privateRoom}
    AND EXISTS(SELECT 1 FROM requests r WHERE r.id=? AND r.status='approved' AND r.paid_at IS NULL AND r.expires_at>?)
    AND EXISTS(SELECT 1 FROM deposit_payments p WHERE p.id=? AND p.request_id=? AND p.slot_id=s.id AND p.status='creating' AND p.claims_ready=0)`)
    .bind(row.id,attempt.id,attempt.slot_id,now+LEAD,now+7*DAY,BLOCK,row.id,row.id,row.id,now+CHECKOUT+60000,attempt.id,row.id).run();
  const held=await env.DB.prepare("SELECT 1 FROM slot_claims WHERE slot_id=? AND request_id=? AND deposit_payment_id=? AND state='held'").bind(attempt.slot_id,row.id,attempt.id).first();
  if(!held)fail(409,'That time was just taken. Choose another.');
}
async function getSession(env,attempt){
  if(!attempt.claims_ready){
    const row=await load(env,attempt.request_id);
    try{
      if(!row||row.status!=='approved'||row.paid_at||row.expires_at<=Date.now()+CHECKOUT+60000||attempt.checkout_expires_at<=Date.now()+30*60000)fail(409,'The unfinished deposit reservation has expired.');
      await reserve(env,row,attempt);
      const ready=await env.DB.prepare("UPDATE deposit_payments SET claims_ready=1 WHERE id=? AND status='creating'").bind(attempt.id).run();
      if(!ready.meta.changes)fail(409,'The deposit reservation changed. Refresh before continuing.');
      attempt={...attempt,claims_ready:1};
    }catch(error){
      await env.DB.batch([
        env.DB.prepare("UPDATE deposit_payments SET status='expired' WHERE id=? AND claims_ready=0 AND session_id IS NULL").bind(attempt.id),
        env.DB.prepare("DELETE FROM slot_claims WHERE deposit_payment_id=? AND state='held' AND EXISTS(SELECT 1 FROM deposit_payments p WHERE p.id=? AND p.status='expired')").bind(attempt.id,attempt.id)
      ]);
      throw error;
    }
  }
  if(!attempt.session_id){
    // A lost response can be retried with the same immutable payload and key.
    // Past Stripe's idempotency window, a human must reconcile the uncertain charge.
    if(Date.now()-attempt.created_at>=23*3600000)fail(409,'An uncertain deposit needs Ashley’s attention before releasing the time.');
    const session=await stripe(env,'checkout/sessions',JSON.parse(attempt.stripe_payload),`deposit-${attempt.id}`);
    if(typeof session.id!=='string'||!session.id.startsWith('cs_'))fail(502,'Stripe did not return a valid deposit session.');
    if(typeof session.url!=='string'||!session.url.startsWith('https://checkout.stripe.com/'))fail(502,'Stripe did not return a valid checkout link.');
    verifySession({...attempt,session_id:session.id},session);
    await env.DB.batch([
      env.DB.prepare("UPDATE deposit_payments SET session_id=?,checkout_url=?,status='open' WHERE id=?").bind(session.id,session.url||null,attempt.id),
      env.DB.prepare("UPDATE requests SET stripe_session_id=? WHERE id=? AND status='approved' AND paid_at IS NULL").bind(session.id,attempt.request_id)
    ]);
    attempt={...attempt,session_id:session.id,status:'open'};
    return {attempt,session};
  }
  const session=await stripe(env,`checkout/sessions/${encodeURIComponent(attempt.session_id)}`);
  verifySession(attempt,session);
  return {attempt,session};
}
async function finalize(env,attempt){
  const now=Date.now();
  if(attempt.review_mode==='answer'){
    await env.DB.batch([
      env.DB.prepare("UPDATE requests SET paid_at=?,review_mode='answer',status='paid',updated_at=? WHERE id=? AND status='approved' AND paid_at IS NULL AND booked_slot_id IS NULL").bind(now,now,attempt.request_id),
      env.DB.prepare("UPDATE deposit_payments SET status='paid',paid_at=coalesce(paid_at,?) WHERE id=?").bind(now,attempt.id),
      env.DB.prepare("INSERT INTO audit(request_id,event,created_at) VALUES(?,'deposit_verified',?)").bind(attempt.request_id,now)
    ]);
    return;
  }
  const selected=await env.DB.prepare('SELECT starts_at,ends_at FROM slots WHERE id=?').bind(attempt.slot_id).first();
  if(!selected||selected.starts_at<=Date.now()+5*60000)fail(409,'Your deposit was paid, but the selected time is no longer suitable. The appointment is not booked. Ashley will review the payment and arrange a new time or refund. Please do not pay again.');
  let busy;
  try{busy=await calendarBusy(env,selected.starts_at,selected.ends_at);}catch{fail(409,'Your deposit was paid, but I cannot check the calendar right now. The appointment is not booked. Ashley will review the payment and arrange a time or refund. Please do not pay again.');}
  if(overlapsBusy(busy,selected.starts_at,selected.ends_at))fail(409,'Your deposit was paid, but Ashley’s calendar now has a conflict. The appointment is not booked. Ashley will arrange a new time or refund. Please do not pay again.');
  const held=await env.DB.prepare("SELECT 1 FROM slot_claims WHERE slot_id=? AND request_id=? AND deposit_payment_id=? AND state='held'").bind(attempt.slot_id,attempt.request_id,attempt.id).first();
  if(!held)fail(409,'Payment was received but the reserved time needs Ashley’s attention.');
  await env.DB.batch([
    env.DB.prepare('UPDATE slots SET request_id=? WHERE id=? AND request_id IS NULL').bind(attempt.request_id,attempt.slot_id),
    env.DB.prepare("UPDATE requests SET paid_at=?,booked_slot_id=?,review_mode='call',review_minutes=15,status='booked',updated_at=? WHERE id=? AND status='approved' AND paid_at IS NULL AND booked_slot_id IS NULL AND EXISTS(SELECT 1 FROM slots WHERE id=? AND request_id=?)").bind(now,attempt.slot_id,now,attempt.request_id,attempt.slot_id,attempt.request_id),
    env.DB.prepare("UPDATE slot_claims SET state='booked' WHERE slot_id=? AND request_id=? AND deposit_payment_id=? AND state='held'").bind(attempt.slot_id,attempt.request_id,attempt.id),
    env.DB.prepare("UPDATE deposit_payments SET status='paid',paid_at=coalesce(paid_at,?) WHERE id=?").bind(now,attempt.id),
    env.DB.prepare("INSERT INTO audit(request_id,event,created_at) VALUES(?,'deposit_verified',?)").bind(attempt.request_id,now),
    env.DB.prepare("INSERT INTO audit(request_id,event,created_at) VALUES(?,'booked',?)").bind(attempt.request_id,now)
  ]);
}
async function reconcile(env,attempt,forceExpire=false,now=Date.now()){
  let result=await getSession(env,attempt);attempt=result.attempt;let session=result.session;
  if(session.payment_status==='paid'){
    await env.DB.prepare("UPDATE deposit_payments SET provider_paid_at=coalesce(provider_paid_at,?) WHERE id=? AND status IN ('creating','open')").bind(Date.now(),attempt.id).run();
    await finalize(env,attempt);return {paid:true};
  }
  if(session.status==='open'&&(forceExpire||attempt.checkout_expires_at<=now)){
    await stripe(env,`checkout/sessions/${encodeURIComponent(attempt.session_id)}/expire`,{});
    session=await stripe(env,`checkout/sessions/${encodeURIComponent(attempt.session_id)}`);verifySession(attempt,session);
    if(session.payment_status==='paid'){
      await env.DB.prepare("UPDATE deposit_payments SET provider_paid_at=coalesce(provider_paid_at,?) WHERE id=? AND status IN ('creating','open')").bind(Date.now(),attempt.id).run();
      await finalize(env,attempt);return {paid:true};
    }
  }
  if(session.status==='expired'&&session.payment_status==='unpaid'){
    await env.DB.batch([
      env.DB.prepare("DELETE FROM slot_claims WHERE deposit_payment_id=? AND state='held'").bind(attempt.id),
      env.DB.prepare("UPDATE deposit_payments SET status='expired',checkout_url=NULL WHERE id=? AND status IN ('creating','open')").bind(attempt.id)
    ]);
    return {expired:true};
  }
  if(session.status!=='open')fail(409,'Payment is still being confirmed. Your deposit remains under review.');
  return {url:session.url};
}
export async function createDepositCheckout(env,row,mode,slotId,origin,now=Date.now()){
  if(row.status!=='approved'||row.paid_at||row.expires_at<=now+CHECKOUT+60000)fail(409,'This request is not ready for a deposit payment.');
  if(!['answer','call'].includes(mode))fail(400,'Choose an answer or a call before paying.');
  if(mode==='answer'&&slotId)fail(400,'An answer does not need an appointment.');
  const existing=await pending(env,row.id);
  if(existing){if(existing.review_mode!==mode||existing.slot_id!==(mode==='call'?slotId:null))fail(409,'Finish or wait for your pending deposit before choosing another review option.');const result=await reconcile(env,existing);if(result.url&&!env.STRIPE_WEBHOOK_SECRET)fail(503,'Deposit payments are not fully connected yet.');return result;}
  if(!env.STRIPE_SECRET_KEY||!env.STRIPE_WEBHOOK_SECRET)fail(503,'Deposit payments are not fully connected yet. Your request is saved; there is nothing to pay now.');
  if(mode==='call'){
    const available=await depositSlots(env,row,now);
    if(!available.length)fail(409,'No review times are available in the next week. Please check back before paying.');
    if(!available.some(slot=>slot.id===slotId))fail(409,'Choose an available time before paying.');
  }
  const id=crypto.randomUUID(),expires=Math.floor((now+CHECKOUT)/1000);
  const payload={mode:'payment','managed_payments[enabled]':'false',customer_email:row.email,
    success_url:`${origin}/?request=${row.id}&payment=returned#request`,cancel_url:`${origin}/?request=${row.id}#request`,
    client_reference_id:id,'metadata[request_id]':row.id,'metadata[deposit_payment_id]':id,'metadata[review_mode]':mode,
    'line_items[0][quantity]':'1','line_items[0][price_data][currency]':'usd','line_items[0][price_data][unit_amount]':'2500',
    'line_items[0][price_data][product_data][name]':'Vibe check — review deposit',
    'line_items[0][price_data][product_data][description]':mode==='call'?'Confirms your selected 15-minute review. Extra time is agreed and paid for before extending.':'Pays for an answer to your project request.',
    expires_at:String(expires)};
  let inserted;
  try{inserted=await env.DB.prepare(`INSERT INTO deposit_payments(id,request_id,review_mode,slot_id,status,checkout_expires_at,stripe_payload,created_at)
    SELECT ?,r.id,?,?,'creating',?,?,? FROM requests r
    WHERE r.id=? AND r.status='approved' AND r.paid_at IS NULL AND r.finished_at IS NULL AND r.purged_at IS NULL AND r.expires_at>?`)
    .bind(id,mode,mode==='call'?slotId:null,expires*1000,JSON.stringify(payload),now,row.id,now+CHECKOUT+60000).run();}
  catch{fail(409,'Another deposit is being prepared. Refresh before continuing.');}
  if(!inserted.meta.changes)fail(409,'This request changed before checkout. Refresh before continuing.');
  const attempt=await pending(env,row.id);
  try{await reserve(env,row,attempt,now);}catch(error){await env.DB.batch([env.DB.prepare("UPDATE deposit_payments SET status='expired' WHERE id=? AND claims_ready=0 AND session_id IS NULL").bind(id),env.DB.prepare("DELETE FROM slot_claims WHERE deposit_payment_id=? AND state='held' AND EXISTS(SELECT 1 FROM deposit_payments p WHERE p.id=? AND p.status='expired')").bind(id,id)]);throw error;}
  const ready=await env.DB.prepare("UPDATE deposit_payments SET claims_ready=1 WHERE id=? AND status='creating'").bind(id).run();
  if(!ready.meta.changes)fail(409,'The deposit reservation changed. Refresh before continuing.');
  return reconcile(env,{...attempt,claims_ready:1});
}
export async function confirmDepositPayment(env,row){
  const attempt=await pending(env,row.id);
  if(attempt)await reconcile(env,attempt);
  return load(env,row.id);
}
export async function expireDepositForRequest(env,row,now=Date.now()){
  const attempt=await latestDeposit(env,row.id);
  if(!attempt)return false;
  if(['creating','open'].includes(attempt.status))await reconcile(env,attempt,true,now);
  return true;
}
export async function depositWebhook(env,event){
  const id=event.data?.object?.metadata?.deposit_payment_id;
  if(!id)return false;
  const attempt=await env.DB.prepare('SELECT * FROM deposit_payments WHERE id=?').bind(id).first();
  if(attempt&&attempt.session_id===event.data.object.id&&attempt.status!=='paid')await reconcile(env,attempt);
  return true;
}
export async function reconcilePendingDeposits(env,now=Date.now()){
  const total=(await env.DB.prepare("SELECT count(*) AS n FROM deposit_payments WHERE status IN ('creating','open')").first()).n;
  const limit=Math.min(100,total),offset=total?(Math.floor(now/900000)*100)%total:0;
  const attempts=limit?(await env.DB.prepare("SELECT * FROM deposit_payments WHERE status IN ('creating','open') ORDER BY created_at,id LIMIT ? OFFSET ?").bind(limit,offset).all()).results:[];
  if(attempts.length<limit){
    const wrap=(await env.DB.prepare("SELECT * FROM deposit_payments WHERE status IN ('creating','open') ORDER BY created_at,id LIMIT ?").bind(limit-attempts.length).all()).results;
    const seen=new Set(attempts.map(row=>row.id));
    attempts.push(...wrap.filter(row=>!seen.has(row.id)));
  }
  let confirmed=0,released=0,deferred=0;
  for(const attempt of attempts){try{const result=await reconcile(env,attempt,false,now);if(result.paid)confirmed++;if(result.expired)released++;}catch{deferred++;}}
  return {confirmed,released,deferred};
}
