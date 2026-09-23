import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

function setup(){
  const elements=new Map();
  const element=()=>({value:'',textContent:'',children:[],handlers:{},disabled:false,hidden:false,append(child){this.children.push(child);},replaceChildren(){this.children=[];},addEventListener(name,fn){this.handlers[name]=fn;},setAttribute(){},querySelectorAll(){return this.children;}});
  const get=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);};
  const pending=[];
  const context=vm.createContext({URLSearchParams,Intl,Date,console,localStorage:{getItem:()=>null},location:{search:'',hash:''},document:{getElementById:get,createElement:element},fetch:path=>path==='/api/health'?Promise.resolve({ok:true,json:async()=>({payments:false,email:{transactional:false,marketing:false}})}):new Promise((resolve,reject)=>pending.push({resolve:body=>resolve({ok:true,json:async()=>body}),reject}))});
  vm.runInContext(readFileSync('site/intake.js','utf8'),context);
  vm.runInContext("id='synthetic';current={billing:{paid_cents:2500},payment_ready:true};",context);
  return{get,pending,context,load:minutes=>{get('review-minutes').value=String(minutes);return vm.runInContext('loadSlots()',context);}};
}
test('registration records the displayed theme and only recognized launch labels',()=>{
 const t=setup();
 t.context.document.documentElement={dataset:{theme:'geometric'}};
 t.context.location.search='?utm_source=linkedin&utm_medium=paid_social&utm_campaign=launch_theme_01&utm_content=ribbon&theme=butter&extra=private';
 const capture=()=>JSON.parse(JSON.stringify(vm.runInContext('registrationAttribution()',t.context)));
 assert.deepEqual(capture(),{theme:'geometric',source:'linkedin',medium:'paid_social',campaign:'launch_theme_01',content:'ribbon'});
 t.context.location.hash='#access=private';assert.deepEqual(capture(),{theme:'geometric'});
 t.context.location.hash='';t.context.location.search+='&request=private';assert.deepEqual(capture(),{theme:'geometric'});
 t.context.location.search='?utm_source=private@example.com&theme=ribbon';assert.deepEqual(capture(),{theme:'geometric'});
});
test('changing duration ignores a late availability response for the previous duration',async()=>{
  const t=setup(),old=t.load(15),latest=t.load(60);
  t.pending[1].resolve({slots:[]});await latest;
  t.pending[0].resolve({slots:[{id:'old-slot',starts_at:Date.now()}]});await old;
  assert.equal(t.get('slots').children.length,1);
  assert.match(t.get('slots').children[0].textContent,/no available times/);
  assert.equal(t.get('book-slot').disabled,true);
  assert.equal(t.get('book-slot').textContent,'Reserve time and pay $55');
});
test('a superseded availability failure does not replace the current selection',async()=>{
  const t=setup(),old=t.load(15),latest=t.load(30);
  t.pending[1].resolve({slots:[{id:'current-slot',starts_at:Date.now()}]});await latest;
  t.pending[0].reject(new Error('old request failed'));await old;
  assert.equal(t.get('slots').children.length,1);
  assert.match(t.get('slots').children[0].textContent,/30 minutes/);
});
