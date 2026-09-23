import {recordEmailDelivery} from './communications.js';

const fail = (status, message) => { throw Object.assign(new Error(message), {status}); };
const bytes = value => Uint8Array.from(atob(value),char=>char.charCodeAt(0));

export async function verifyResendSignature(raw,headers,secret,now=Date.now()){
  if(!secret?.startsWith('whsec_'))fail(503,'Email webhook is not connected.');
  const id=headers.get('svix-id'),timestamp=headers.get('svix-timestamp'),header=headers.get('svix-signature')||'';
  if(!id||!/^[0-9]{10}$/.test(timestamp||'')||Math.abs(now/1000-Number(timestamp))>300)fail(400,'Invalid email webhook timestamp.');
  let key;
  try{key=await crypto.subtle.importKey('raw',bytes(secret.slice(6)),{name:'HMAC',hash:'SHA-256'},false,['verify']);}
  catch{fail(503,'Email webhook is not connected.');}
  const message=new TextEncoder().encode(`${id}.${timestamp}.${raw}`);
  let valid=false;
  for(const entry of header.split(/\s+/)){
    if(!entry.startsWith('v1,'))continue;
    try{if(await crypto.subtle.verify('HMAC',key,bytes(entry.slice(3)),message))valid=true;}catch{}
  }
  if(!valid)fail(400,'Invalid email webhook signature.');
}

export async function handleResendWebhook(request,env){
  const raw=await request.text();
  if(raw.length>100000)fail(413,'Payload too large.');
  await verifyResendSignature(raw,request.headers,env.RESEND_WEBHOOK_SECRET);
  let event;
  try{event=JSON.parse(raw);}catch{fail(400,'Invalid email webhook payload.');}
  const state={'email.delivered':'delivered','email.failed':'review','email.suppressed':'review','email.bounced':'bounced','email.complained':'complained'}[event.type];
  if(state){
    const sender=String(event.data?.from||'').match(/@([^>\s]+)/)?.[1]?.toLowerCase();
    const expected=String(env.EMAIL_FROM||'').match(/@([^>\s]+)/)?.[1]?.toLowerCase();
    if(sender&&sender===expected)await recordEmailDelivery(env,event.data?.email_id,state);
  }
  return new Response(JSON.stringify({received:true}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
}
