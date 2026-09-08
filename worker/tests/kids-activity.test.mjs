import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,readdirSync } from 'node:fs';
import { createHash,randomUUID } from 'node:crypto';
import worker from '../src/index.js';
import { recordKidsActivity,kidsActivityReport,purgeKidsActivity,nzDay } from '../src/kids-activity.js';
export function activityHarness(){
  const db=new DatabaseSync(':memory:'),dir=new URL('../migrations/',import.meta.url);
  for(const file of [readdirSync(dir).find(f=>f.startsWith('0001')),'0025_kids_activity.sql'])db.exec(readFileSync(new URL(file,dir),'utf8'));
  const env={AUTH_PEPPER:'test-only',KIDS_RATE_LIMIT:{limit:async()=>({success:true})},CUSTOMER_DB:{prepare(sql){const stmt=db.prepare(sql);const bind=(...a)=>({bind,first:async()=>stmt.get(...a)||null,all:async()=>({results:stmt.all(...a)}),run:async()=>({meta:{changes:Number(stmt.run(...a).changes)}})});return bind();},batch:async s=>Promise.all(s.map(q=>q.run()))}};
  for(const role of ['owner','customer'])db.prepare('INSERT INTO sessions(token_hash,role,email,expires_at,created_at,last_seen_at) VALUES(?,?,?,?,?,?)').run(createHash('sha256').update(role+'-test').digest('base64url'),role,'test@example.invalid',Date.now()+86400000,Date.now(),Date.now());
  return {db,env};
}
const json=(_req,data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
const request=(event,query='',headers={})=>new Request('https://test.invalid/v2/kids/activity'+query,{method:'POST',headers:{Origin:'https://nakiwhitewareremoval.vip','Content-Type':'application/json',...headers},body:JSON.stringify(event)});
test('duplicate starts and finishes are atomic and unknown finishes do not create plays',async()=>{
  const h=activityHarness();try{const id=randomUUID();
    await recordKidsActivity(request({game:'share',kind:'finish',id}),h.env,json);assert.equal(h.db.prepare('SELECT COUNT(*) n FROM kids_activity_daily').get().n,0);
    await Promise.all(Array.from({length:12},()=>recordKidsActivity(request({game:'share',kind:'start',id}),h.env,json)));
    await Promise.all(Array.from({length:12},()=>recordKidsActivity(request({game:'share',kind:'finish',id}),h.env,json)));
    assert.deepEqual({...h.db.prepare('SELECT starts,finishes FROM kids_activity_daily').get()},{starts:1,finishes:1});
    await recordKidsActivity(request({game:'robot',kind:'finish',id}),h.env,json);assert.equal(h.db.prepare('SELECT COUNT(*) n FROM kids_activity_daily').get().n,1);
  }finally{h.db.close();}
});
test('test events never enter live reports and the NZ calendar day handles midnight and DST',async()=>{
  const h=activityHarness();try{const stamp=Date.parse('2026-09-08T11:59:00Z'),id=randomUUID();
    await recordKidsActivity(request({game:'share',kind:'start',id},'?test=1'),h.env,json,stamp);
    await recordKidsActivity(request({game:'share',kind:'finish',id},'?test=1'),h.env,json,stamp+120000);
    assert.equal(h.db.prepare('SELECT day FROM kids_activity_daily').get().day,'2026-09-08');
    const report=async query=>(await kidsActivityReport(new Request('https://test.invalid/owner/kids-activity'+query),h.env,json,stamp+120000)).json();
    assert.equal((await report('?days=7')).totals.starts,0);assert.deepEqual((await report('?days=7&test=1')).totals,{starts:1,finishes:1});
    assert.equal((await report('?days=1&test=1')).totals.starts,0);
    assert.equal(nzDay(Date.parse('2026-09-27T11:30:00Z')),'2026-09-28');
    const dst=await kidsActivityReport(new Request('https://test.invalid/owner/kids-activity?days=7'),h.env,json,Date.parse('2026-09-27T11:30:00Z'));assert.equal((await dst.json()).from,'2026-09-22');
  }finally{h.db.close();}
});
test('public collection rejects extra data, bad origins, oversized events and rate-limited calls',async()=>{
  const h=activityHarness();try{const valid={game:'share',kind:'start',id:randomUUID()};
    for(const body of [{...valid,age:8},{...valid,name:'someone'},{...valid,game:'feelings'},{...valid,id:'not-a-round'},null])assert.equal((await recordKidsActivity(request(body),h.env,json)).status,400);
    assert.equal((await recordKidsActivity(request(valid,'',{Origin:'https://unknown.example'}),h.env,json)).status,403);
    assert.equal((await recordKidsActivity(request(valid,'',{'Content-Type':'text/plain'}),h.env,json)).status,415);
    assert.equal((await recordKidsActivity(request({...valid,padding:'x'.repeat(500)}),h.env,json)).status,413);
    h.env.KIDS_RATE_LIMIT.limit=async()=>({success:false});assert.equal((await recordKidsActivity(request(valid),h.env,json)).status,429);
    assert.equal(h.db.prepare('SELECT COUNT(*) n FROM kids_activity_rounds').get().n,0);
  }finally{h.db.close();}
});
test('owner report is private at the full Worker router; customers cannot read it',async()=>{
  const h=activityHarness();try{
    for(const token of ['', 'customer-test','owner-test']){
      const r=await worker.fetch(new Request('https://test.invalid/v2/owner/kids-activity?days=7',{headers:{Origin:'https://naki-pickup-run.pages.dev',Authorization:'Bearer '+token}}),h.env);
      assert.equal(r.status,token==='owner-test'?200:401);if(r.ok){const data=await r.json();assert.equal(data.games.length,8);assert.equal(data.daily.length,7);}
    }
    const invalid=await worker.fetch(new Request('https://test.invalid/v2/owner/kids-activity?days=100',{headers:{Origin:'https://naki-pickup-run.pages.dev',Authorization:'Bearer owner-test'}}),h.env);assert.equal(invalid.status,400);
  }finally{h.db.close();}
});
test('expired round receipts are removed while recent daily totals survive',async()=>{
  const h=activityHarness();try{const stamp=Date.now();await recordKidsActivity(request({game:'share',kind:'start',id:randomUUID()}),h.env,json,stamp-2*86400000);
    h.db.prepare("INSERT INTO kids_activity_daily VALUES('2020-01-01','share','live',1,0)").run();await purgeKidsActivity(h.env,stamp);
    assert.equal(h.db.prepare('SELECT COUNT(*) n FROM kids_activity_rounds').get().n,0);assert.equal(h.db.prepare('SELECT COUNT(*) n FROM kids_activity_daily').get().n,1);
  }finally{h.db.close();}
});
