import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarBusy, calendarConfiguration, overlapsBusy } from '../server/calendar.js';

const start=Date.parse('2026-09-24T17:00:00Z'),end=start+3600000;
const configured=()=>({GOOGLE_CALENDAR_REQUIRED:'true',GOOGLE_CALENDAR_CLIENT_ID:'client',GOOGLE_CALENDAR_CLIENT_SECRET:'secret',GOOGLE_CALENDAR_REFRESH_TOKEN:'refresh',GOOGLE_CALENDAR_IDS:'primary@example.com,secondary@example.com'});

test('freebusy reads only requested calendar ranges and merges both calendars',async()=>{
  const env=configured(),calls=[];
  env.CALENDAR_FETCH=async(url,options)=>{
    calls.push({url,options});
    if(url.endsWith('/token'))return Response.json({access_token:'access'});
    return Response.json({calendars:{'primary@example.com':{busy:[{start:'2026-09-24T17:15:00Z',end:'2026-09-24T17:30:00Z'}]},'secondary@example.com':{busy:[{start:'2026-09-24T17:45:00Z',end:'2026-09-24T18:00:00Z'}]}}});
  };
  const busy=await calendarBusy(env,start,end);
  assert.equal(calendarConfiguration(env).configured,true);
  assert.equal(busy.length,2);
  assert.equal(overlapsBusy(busy,start,start+900000),false);
  assert.equal(overlapsBusy(busy,start+900000,start+1800000),true);
  const request=JSON.parse(calls[1].options.body);
  assert.deepEqual(request.items,[{id:'primary@example.com'},{id:'secondary@example.com'}]);
  assert.deepEqual(Object.keys(request).sort(),['items','timeMax','timeMin']);
});

test('required calendar fails closed for missing credentials, provider errors, and missing calendar data',async()=>{
  await assert.rejects(calendarBusy({GOOGLE_CALENDAR_REQUIRED:'true'},start,end),{status:503});
  const env=configured();env.CALENDAR_FETCH=async(url)=>url.endsWith('/token')?Response.json({access_token:'access'}):Response.json({calendars:{'primary@example.com':{busy:[]}}});
  await assert.rejects(calendarBusy(env,start,end),{status:503});
  env.CALENDAR_FETCH=async()=>new Response('unavailable',{status:503});
  await assert.rejects(calendarBusy(env,start,end),{status:503});
});
