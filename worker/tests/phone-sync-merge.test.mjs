import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

// Phone sync: bot edits in the account backup must reach the phone without
// wiping anything the phone did. Runs the real index.html code in a sandbox.
const html=fs.readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const section=(a,b)=>html.slice(html.indexOf(a),html.indexOf(b,html.indexOf(a)));
const RUNS='naki_pickup_runs_v1';
const run=(id,stops=[])=>({id,name:'Run '+id,data:{stops:stops.map(s=>({id:s,status:'PENDING'})),bad:[]}});
const store=runs=>JSON.stringify({activeRunId:runs[0].id,runs});

function phone({base,local,server,screenTap=false}){
  const ls=new Map(),ss=new Map(),calls=[];
  const localStorage={getItem:k=>ls.has(k)?ls.get(k):null,setItem:(k,v)=>ls.set(k,String(v)),removeItem:k=>ls.delete(k),key:i=>[...ls.keys()][i],get length(){return ls.size}};
  const ctx={localStorage,sessionStorage:{getItem:k=>ss.get(k)??null,setItem:(k,v)=>ss.set(k,v),removeItem:k=>ss.delete(k)},
    Object:{...Object,keys:o=>o===localStorage?[...ls.keys()]:Object.keys(o),entries:Object.entries},
    RUNS_LS:RUNS,GEO:'naki_geocache_v10',OWNER_TOKEN_KEY:'naki_owner_token_v1',CLOUD_ATTEMPTS_KEY:'naki_cloud_attempts_v1',
    window:{},fieldLocalSaveFailed:false,runStore:null,ownerToken:'t',cloudBackupBusy:false,
    loadJSON:(k,d)=>{try{return ls.has(k)?JSON.parse(ls.get(k)):d}catch{return d}},saveJSON:(k,v)=>{ls.set(k,JSON.stringify(v));return true},
    paintCloudState:()=>{},backupStatus:()=>{},whenText:()=>'',scheduleCloudBackup:()=>{},adoptLostCloudSave:async()=>false,
    location:{reload:()=>calls.push('reload')},setTimeout:f=>f(),JSON,Date,Set,Map};
  ctx.pushCloudBackup=async()=>calls.push('push:'+ctx.syncMark().serverAt);
  ctx.ownerApi=async path=>path.endsWith('/info')?{latest:{savedAt:200,runCount:1}}:{savedAt:200,runCount:1,data:{[RUNS]:server}};
  vm.createContext(ctx);
  vm.runInContext(section('const SYNC_KEY=','$("#backupSave")')+section('function backupPayload(','function whenText(')+section('function syncMark(','// A fresh or wiped phone')
    .replace('let cloudPullAt=0;','var cloudPullAt=0;')+';this.syncMark=syncMark;this.syncFromCloud=syncFromCloud;this.mergeRunStores=mergeRunStores;',ctx);
  ls.set(RUNS,base);ls.set('naki_booking_group_open_v1','{}');
  ctx.saveJSON('naki_cloud_sync_v1',{serverAt:100,payload:JSON.stringify(vm.runInContext('backupPayload()',ctx))});
  ls.set(RUNS,local);
  if(screenTap) ls.set('naki_booking_group_open_v1','{"Hawera":true}');
  return {ctx,ls,ss,calls,runs:()=>JSON.parse(ls.get(RUNS)).runs};
}

test("Bob's case: an account-only stop edit plus a screen-setting tap pulls automatically",async()=>{
  const base=store([run('hawera')]);
  const p=phone({base,local:base,server:store([run('hawera',['a','b','c','d'])]),screenTap:true});
  assert.equal(await p.ctx.syncFromCloud(true),true);
  assert.equal(p.runs()[0].data.stops.length,4);
  assert.equal(p.ls.get('naki_booking_group_open_v1'),'{"Hawera":true}','screen settings stay on the phone');
  assert.equal(p.ctx.syncMark().serverAt,200);
});
test('a phone-only edit is kept and the account copy is not pulled over it',async()=>{
  const base=store([run('one',['x'])]);
  const p=phone({base,local:store([run('one',['x','y'])]),server:base});
  await p.ctx.syncFromCloud(true);
  assert.deepEqual(p.runs()[0].data.stops.map(s=>s.id),['x','y']);
});
test('both sides editing different runs keeps both edits and saves on top of the account',async()=>{
  const base=store([run('one'),run('two')]);
  const p=phone({base,local:store([run('one',['phone']),run('two')]),server:store([run('one'),run('two',['bot']),run('new',['n'])])});
  assert.equal(await p.ctx.syncFromCloud(true),true);
  const runs=p.runs();
  assert.deepEqual(runs.map(r=>r.id),['one','two','new']);
  assert.deepEqual(runs[0].data.stops.map(s=>s.id),['phone']);
  assert.deepEqual(runs[1].data.stops.map(s=>s.id),['bot']);
  assert.ok(p.calls.includes('push:200'),'pushes with the account savedAt as its base');
  assert.equal(p.ss.get('naki_sync_notice'),undefined,'no notice when nothing clashed');
});
test('both sides editing the same run keeps the phone version and the account one as a copy',async()=>{
  const base=store([run('one',['x'])]);
  const p=phone({base,local:store([run('one',['x','phone'])]),server:store([run('one',['x','bot'])])});
  await p.ctx.syncFromCloud(true);
  const runs=p.runs();
  assert.equal(runs.length,2);
  assert.deepEqual(runs[0].data.stops.map(s=>s.id),['x','phone']);
  assert.equal(runs[1].id,'one-account-200');assert.match(runs[1].name,/account copy/);
  assert.deepEqual(runs[1].data.stops.map(s=>s.id),['x','bot']);
  assert.match(p.ss.get('naki_sync_notice'),/Kept both/);
});
test('screen settings and drafts are left out of the sync payload',()=>{
  const p=phone({base:store([run('one')]),local:store([run('one')]),server:store([run('one')])});
  p.ls.set('naki_booking_note_drafts_v1','{}');
  const keys=Object.keys(vm.runInContext('backupPayload()',p.ctx).data);
  assert.deepEqual(keys,[RUNS]);
});
