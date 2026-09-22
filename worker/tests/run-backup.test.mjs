import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {DatabaseSync} from 'node:sqlite';
import {readRunBackup,writeRunBackup} from '../src/run-backup.js';
function setup(t,initial=true){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(fs.readFileSync(new URL('../migrations/0030_run_backup_revision.sql',import.meta.url),'utf8'));
 const key='backup:owner';const old={savedAt:100,runCount:3,data:{runs:'Hawera,New Plymouth,Coastal'}};const kv=new Map(initial?[[key,JSON.stringify(old)]]:[]);
 const env={CUSTOMER_DB:{prepare(sql){const s=db.prepare(sql);return {bind(...args){return {first:async()=>s.get(...args)||null,run:async()=>({meta:{changes:Number(s.run(...args).changes)}})}}}}},REMINDERS:{get:async k=>kv.get(k)||null,put:async(k,v)=>kv.set(k,v)}};
 return {env,key,old,kv};
}
test('legacy and stale writers cannot remove Hawera; all copies survive',async t=>{
 const {env,key,old}=setup(t);assert.equal((await writeRunBackup(env,key,{data:{runs:'old'}})).status,428);
 assert.equal((await writeRunBackup(env,key,{baseSavedAt:90,data:{runs:'old'}})).status,409);
 assert.deepEqual(await readRunBackup(env,key),old);
 const next={baseSavedAt:100,runCount:3,data:{runs:'current revised'}};const saved=await writeRunBackup(env,key,next);assert.ok(saved.savedAt>100);
 assert.equal((await writeRunBackup(env,key,next)).savedAt,saved.savedAt);
 assert.deepEqual(await readRunBackup(env,key,true),old);
 assert.equal((await writeRunBackup(env,key,{...next,data:{runs:'stale overwrite'}})).status,409);
});
test('two concurrent phones from the same version: exactly one wins',async t=>{
 const {env,key}=setup(t);await readRunBackup(env,key);
 const results=await Promise.all(['A','B'].map(runs=>writeRunBackup(env,key,{baseSavedAt:100,data:{runs}})));
 assert.equal(results.filter(r=>r.status===409).length,1);assert.equal(results.filter(r=>r.savedAt).length,1);
});
test('first-save race cannot lose a run',async t=>{
 const {env,key}=setup(t,false);const results=await Promise.all(['A','B'].map(runs=>writeRunBackup(env,key,{baseSavedAt:0,data:{runs}})));
 assert.equal(results.filter(r=>r.status===409).length,1);
});
test('KV mirror failure or stale KV does not replace authoritative runs',async t=>{
 const {env,key,kv}=setup(t);env.REMINDERS.put=async()=>{throw Error('offline')};
 const result=await writeRunBackup(env,key,{baseSavedAt:100,data:{runs:'safe'}});assert.ok(result.savedAt);
 assert.equal((await readRunBackup(env,key)).data.runs,'safe');assert.equal(JSON.parse(kv.get(key)).savedAt,100);
});
const html=fs.readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const section=(a,b)=>html.slice(html.indexOf(a),html.indexOf(b,html.indexOf(a)));
test('a browser with local edits never pushes over a newer account copy',async()=>{
 let writes=0,pulls=0;const context={ownerToken:'yes',cloudBackupBusy:false,cloudPullAt:0,ownerApi:async()=>({latest:{savedAt:200}}),syncMark:()=>({serverAt:100,payload:'old'}),backupPayload:()=>({changed:true}),localHasWork:()=>true,pushCloudBackup:()=>writes++,applyCloudBackup:()=>pulls++,paintCloudState(){},backupStatus(){}};
 vm.runInNewContext(section('async function syncFromCloud(','// A fresh or wiped phone'),context);await context.syncFromCloud(true);assert.equal(writes,0);assert.equal(pulls,0);
});
test('restore retains the local undo copy instead of importing another devices undo',async()=>{
 const entries=new Map();const context={snapshotBeforePull:()=>entries.set('undo','local'),PRE_PULL_KEY:'undo',SYNC_KEY:'sync',OWNER_TOKEN_KEY:'auth',localStorage:{setItem:(k,v)=>entries.set(k,v)},setSyncMark(){},backupPayload:()=>({}),backupStatus(){},setTimeout(){}};
 vm.runInNewContext(section('async function applyCloudBackup(','let cloudPullAt='),context);await context.applyCloudBackup({savedAt:200,data:{undo:'foreign',runs:'new',auth:'secret'}});assert.equal(entries.get('undo'),'local');assert.equal(entries.get('runs'),'new');assert.equal(entries.has('auth'),false);
});
test('browser sends the version it actually read with its save',async()=>{
 let sent;const payload={runCount:3,data:{runs:'safe'}};const context={ownerToken:'yes',cloudBackupBusy:false,lastCloudPush:'',backupPayload:()=>payload,syncMark:()=>({serverAt:123}),ownerApi:async(_p,o)=>{sent=JSON.parse(o.body);return {savedAt:124}},setSyncMark(){},paintCloudState(){},backupStatus(){}};
 vm.runInNewContext(section('async function pushCloudBackup(','// Called from save();'),context);await context.pushCloudBackup(false);assert.equal(sent.baseSavedAt,123);assert.equal(sent.data.runs,'safe');
});
