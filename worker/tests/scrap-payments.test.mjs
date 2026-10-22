import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {scrapSummary} from '../../assets/earnings-model.js';
import {cleanScrapPayment,SCRAP_LEDGER_KEY} from '../src/scrap-payments.js';
import worker from '../src/index.js';

// Minimal R2 stand-in that honours onlyIf.etagMatches like the real bucket.
function fakeR2(){
  const store=new Map();let version=0;
  return {store,
    async get(key){const item=store.get(key);if(!item)return null;
      return {etag:item.etag,body:item.body,json:async()=>JSON.parse(new TextDecoder().decode(item.body))};},
    async put(key,value,options={}){
      const current=store.get(key);
      if(options.onlyIf?.etagMatches&&current?.etag!==options.onlyIf.etagMatches)return null;
      const body=typeof value==='string'?new TextEncoder().encode(value):value;
      store.set(key,{body,etag:'e'+(++version)});return {etag:'e'+version};
    }};
}
async function fixture(){
  const db=new DatabaseSync(':memory:');
  const columns='id TEXT,status TEXT,total_cents INTEGER,quote_required INTEGER,quote_cents INTEGER,quoted_at INTEGER,updated_at INTEGER,pickup_date TEXT,completed_at INTEGER';
  db.exec(`CREATE TABLE bookings(${columns});CREATE TABLE jotform_bookings(${columns},submission_id TEXT);CREATE TABLE external_bookings(${columns},external_key TEXT);
    CREATE TABLE booking_events(booking_id TEXT,event_type TEXT,detail TEXT,created_at INTEGER);
    CREATE TABLE booking_documents(id TEXT,booking_id TEXT,kind TEXT,amount_cents INTEGER,created_at INTEGER);
    CREATE TABLE run_backups(owner_key TEXT,record_json TEXT,previous_json TEXT,saved_at INTEGER);
    CREATE TABLE sessions(token_hash TEXT,customer_id TEXT,role TEXT,email TEXT,expires_at INTEGER,last_seen_at INTEGER);`);
  for(const [token,role]of [['owner-test','owner'],['customer-test','customer']]){
    const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))).toString('base64url');
    db.prepare('INSERT INTO sessions VALUES(?,NULL,?,?,?,0)').run(hash,role,'private@example.test',Date.now()+30*86400000);
  }
  const wrap={prepare(sql){const statement=db.prepare(sql);return {bind(...params){return {first:async()=>statement.get(...params)||null,all:async()=>({results:statement.all(...params)}),run:async()=>({meta:{changes:Number(statement.run(...params).changes)}})};},all:async()=>({results:statement.all()})};}};
  return {db,env:{CUSTOMER_DB:wrap,REMINDERS:{get:async()=>null},DOCUMENTS:fakeR2(),OPENAI_API_KEY:'test-key'}};
}
const call=(env,path,{method='GET',body,token='owner-test',headers={}}={})=>worker.fetch(new Request('https://test.invalid/v2'+path,{method,
  headers:{Origin:'https://naki-pickup-run.pages.dev',Authorization:'Bearer '+token,'Content-Type':'application/json',...headers},body:body&&JSON.stringify(body)}),env);
const photo='data:image/jpeg;base64,'+Buffer.from('fake jpeg bytes').toString('base64');

test('scrap totals: today, week, month and all-time; bad rows ignored',()=>{
  const s=scrapSummary([{cents:4550,day:'2026-10-20'},{cents:1000,day:'2026-10-19'},{cents:2000,day:'2026-09-30'},{cents:-5,day:'2026-10-20'},{cents:900,day:'nope'}],'2026-10-20');
  assert.deepEqual([s.todayCents,s.weekCents,s.monthCents,s.allTimeCents,s.count],[4550,5550,5550,7550,3]);
});
test('payment cleaning keeps exact cents and refuses missing or future amounts',()=>{
  const now=Date.parse('2026-10-20T03:00:00Z');
  assert.equal(cleanScrapPayment({amount:'45.55',day:'2026-10-20'},now).payment.cents,4555);
  assert.match(cleanScrapPayment({amount:0},now).error,/amount/);
  assert.match(cleanScrapPayment({amount:10,day:'2026-10-25'},now).error,/future/);
  assert.equal(cleanScrapPayment({amount:10},now).payment.day,'2026-10-20');
});
test('a saved scrap payment adds to earnings, keeps its photo, and a retry cannot add it twice',async()=>{
  const {db,env}=await fixture();try{
    const body={amount:62.4,day:'2026-10-20',yard:'GMS New Plymouth',weightKg:'312',image:photo};
    const first=await call(env,'/owner/scrap',{method:'POST',body,headers:{'Idempotency-Key':'k1'}});
    assert.equal(first.status,200);const saved=(await first.json()).payment;
    assert.equal(saved.cents,6240);assert.equal(saved.photo,true);
    const retry=await call(env,'/owner/scrap',{method:'POST',body,headers:{'Idempotency-Key':'k1'}});
    assert.equal((await retry.json()).payment.id,saved.id);
    const list=await (await call(env,'/owner/scrap')).json();
    assert.equal(list.payments.length,1);assert.equal(list.payments[0].cents,6240);
    const pic=await call(env,`/owner/scrap/${saved.id}/photo`);assert.equal(pic.status,200);assert.equal(pic.headers.get('Content-Type'),'image/jpeg');
    assert.equal((await call(env,`/owner/scrap/${saved.id}`,{method:'DELETE'})).status,200);
    assert.equal((await (await call(env,'/owner/scrap')).json()).payments.length,0);
    assert.ok(env.DOCUMENTS.store.has(`scrap-receipts/${saved.id}.jpg`),'photo is kept after removal');
  }finally{db.close();}
});
test('two saves racing on the ledger both survive',async()=>{
  const {db,env}=await fixture();try{
    await Promise.all([call(env,'/owner/scrap',{method:'POST',body:{amount:10}}),call(env,'/owner/scrap',{method:'POST',body:{amount:20}})]);
    const ledger=JSON.parse(new TextDecoder().decode(env.DOCUMENTS.store.get(SCRAP_LEDGER_KEY).body));
    assert.deepEqual(ledger.payments.map(p=>p.cents).sort(),[1000,2000]);
  }finally{db.close();}
});
test('customers cannot read or add scrap money',async()=>{
  const {db,env}=await fixture();try{
    assert.equal((await call(env,'/owner/scrap',{method:'POST',body:{amount:10},token:'customer-test'})).status,401);
    assert.equal((await call(env,'/owner/scrap',{token:'customer-test'})).status,401);
  }finally{db.close();}
});
test('reading a docket returns the amount for checking, and never saves it',async()=>{
  const {db,env}=await fixture();const realFetch=globalThis.fetch;try{
    let sent;
    globalThis.fetch=async(url,init)=>{sent=JSON.parse(init.body);return new Response(JSON.stringify({output:[{content:[{type:'output_text',text:JSON.stringify({readable:true,amount:87.25,date:'2026-10-20',yard:'GMS',weightKg:410})}]}]}),{status:200});};
    const res=await call(env,'/owner/scrap/read',{method:'POST',body:{image:photo}});
    assert.equal(res.status,200);assert.deepEqual((await res.json()).read,{amount:87.25,day:'2026-10-20',yard:'GMS',weightKg:410});
    assert.equal(sent.input[0].content[1].type,'input_image');
    assert.equal(env.DOCUMENTS.store.size,0);
    globalThis.fetch=async()=>new Response(JSON.stringify({output_text:JSON.stringify({readable:false,amount:null,date:null,yard:null,weightKg:null})}),{status:200});
    const bad=await call(env,'/owner/scrap/read',{method:'POST',body:{image:photo}});
    assert.equal(bad.status,422);assert.match((await bad.json()).error,/Type the amount/);
  }finally{globalThis.fetch=realFetch;db.close();}
});
