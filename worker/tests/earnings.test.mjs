import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {bookingRows,documentRows,stopRows,buildEntries,summarise,nzDay,moneyCents} from '../../assets/earnings-model.js';
import {earningsReport} from '../src/earnings.js';
import worker from '../src/index.js';

const time=Date.parse('2026-09-30T12:30:00Z'); // 1 October in NZDT
const book=(id,extra={})=>({id,status:'COMPLETED',total_cents:2000,quote_required:0,quote_cents:0,quoted_at:null,
  updated_at:time,completed_at:time,pickup_date:'',source:'WEBSITE',...extra});
const doc=(id,booking_id,amount_cents,kind='RECEIPT',created_at=time)=>({id,booking_id,amount_cents,kind,created_at});
const runStore=stops=>({runs:[{data:{stops}}],shared:{unpaid:[]}});

test('NZ days cross UTC midnight correctly, including summer and winter',()=>{
  assert.equal(nzDay(time),'2026-10-01');
  assert.equal(nzDay('2026-06-30T12:30:00Z'),'2026-07-01');
  assert.equal(nzDay(1),'');assert.equal(nzDay('nonsense'),'');
});
test('money keeps exact cents and rejects absent/invalid prices',()=>{
  assert.equal(moneyCents('12.35'),1235);assert.equal(moneyCents(null),null);
  assert.equal(moneyCents(''),null);assert.equal(moneyCents(-1),null);assert.equal(moneyCents(Infinity),null);
});
test('Done without a receipt counts its price; a zero quote is a real price',()=>{
  const entries=buildEntries(bookingRows([book('WEB-1'),book('WEB-2',{total_cents:9000,quoted_at:time,quote_cents:0})]));
  const summary=summarise(entries,'2026-10-01');
  assert.equal(summary.allTimeCents,2000);assert.equal(summary.jobs,2);assert.equal(summary.receiptedCents,0);
});
test('latest receipt corrects the amount and a resend cannot count twice',()=>{
  const entries=buildEntries([...bookingRows([book('WEB-1')]),...documentRows([
    doc('old','WEB-1',2000,'RECEIPT',time-1000),doc('new','WEB-1',2500),doc('copy','WEB-1',2500)])]);
  assert.equal(entries.length,1);assert.equal(entries[0].cents,2500);assert.equal(entries[0].receiptedCents,2500);
});
test('booking, imported run copy, external record and unpaid twin join by stable IDs',()=>{
  const b=bookingRows([book('JOTFORM-123',{source:'JOTFORM',submission_id:'123'}),book('PICKUP-1',{source:'PICKUP_RUN',external_key:'pickup:123'})]);
  const stops=stopRows(runStore([{id:'s1',submission_id:'123',historyBookingKey:'pickup:123',status:'DONE',amount:20,collectedAt:time}]));
  const entries=buildEntries([...b,...stops,...documentRows([doc('r','PICKUP-1',2000)])]);
  assert.equal(entries.length,1);assert.equal(summarise(entries,'2026-10-01').allTimeCents,2000);
});
test('two jobs at the same address stay separate; unlinked documents never attach to every job',()=>{
  const entries=buildEntries([...bookingRows([book('WEB-1'),book('WEB-2')]),...documentRows([doc('orphan','',3000)])]);
  assert.equal(entries.length,3);assert.equal(summarise(entries,'2026-10-01').allTimeCents,7000);
});
test('cancelled/declined jobs, prepared receipts, unloads and future pickups are excluded',()=>{
  const entries=buildEntries([...bookingRows([book('WEB-cancel',{status:'CANCELLED'}),book('WEB-decline',{status:'DECLINED'}),book('WEB-new',{status:'NEW'})]),
    ...documentRows([doc('r','WEB-cancel',2000)]),...stopRows(runStore([
      {id:'prepared',status:'NEW',receiptAmount:25,amount:25},
      {id:'unload',kind:'unload',status:'DONE',amount:100},
      {id:'early-invoice',status:'DONE',invoiceStage:'before',amount:20,invoiceSent:true}]))]);
  assert.equal(summarise(entries,'2026-10-01').allTimeCents,0);
});
test('unknown dates remain in all-time, unknown prices are flagged; charts use completion day',()=>{
  const entries=buildEntries(bookingRows([book('WEB-undated',{completed_at:null}),book('WEB-unpriced',{quote_required:1}),
    book('WEB-old',{completed_at:Date.parse('2026-09-10T00:00:00Z'),pickup_date:'2026-10-01'})]));
  const s=summarise(entries,'2026-10-01');assert.equal(s.allTimeCents,4000);assert.equal(s.todayCents,0);
  assert.equal(s.missingPrices,1);assert.equal(s.undatedJobs,1);
});
test('owing invoices are separate, and later receipt settles only the same job',()=>{
  const records=[...bookingRows([book('WEB-1'),book('WEB-2')]),...documentRows([
    doc('i1','WEB-1',2000,'INVOICE',time-5000),doc('r','WEB-1',2000),doc('i2','WEB-2',2000,'INVOICE',time-5000)])];
  const s=summarise(buildEntries(records),'2026-10-01');assert.equal(s.allTimeCents,4000);assert.equal(s.owingCents,2000);
});

async function fixture() {
  const db=new DatabaseSync(':memory:');
  const columns='id TEXT,status TEXT,total_cents INTEGER,quote_required INTEGER,quote_cents INTEGER,quoted_at INTEGER,updated_at INTEGER,pickup_date TEXT,completed_at INTEGER';
  db.exec(`CREATE TABLE bookings(${columns});CREATE TABLE jotform_bookings(${columns},submission_id TEXT);CREATE TABLE external_bookings(${columns},external_key TEXT);
    CREATE TABLE booking_events(booking_id TEXT,event_type TEXT,detail TEXT,created_at INTEGER);
    CREATE TABLE booking_documents(id TEXT,booking_id TEXT,kind TEXT,amount_cents INTEGER,created_at INTEGER);
    CREATE TABLE run_backups(owner_key TEXT,record_json TEXT,previous_json TEXT,saved_at INTEGER);
    CREATE TABLE sessions(token_hash TEXT,customer_id TEXT,role TEXT,email TEXT,expires_at INTEGER,last_seen_at INTEGER);`);
  db.exec(`INSERT INTO bookings VALUES('WEB-a','COMPLETED',2000,0,0,NULL,${time},'',NULL);
    INSERT INTO booking_events VALUES('WEB-a','STATUS','COMPLETED',${time});
    INSERT INTO booking_documents VALUES('receipt','WEB-a','RECEIPT',2500,${time});`);
  for(const [token,role]of [['owner-test','owner'],['customer-test','customer'],['expired-test','owner']]){
    const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))).toString('base64url');
    db.prepare('INSERT INTO sessions VALUES(?,NULL,?,?,?,0)').run(hash,role,'private@example.test',token==='expired-test'?1:Date.now()+30*86400000);
  }
  const wrap={prepare(sql){const statement=db.prepare(sql);return {bind(...params){return {first:async()=>statement.get(...params)||null,all:async()=>({results:statement.all(...params)}),run:async()=>({meta:{changes:Number(statement.run(...params).changes)}})};},all:async()=>({results:statement.all()})};}};
  return {db,env:{CUSTOMER_DB:wrap,REMINDERS:{get:async()=>null}}};
}
test('private report reads complete history without customer identity or credentials',async()=>{
  const {db,env}=await fixture();try{
    for(let i=0;i<350;i++)db.prepare('INSERT INTO bookings VALUES(?,?,?,?,?,?,?,?,?)').run('WEB-'+i,'COMPLETED',100,0,0,null,time,'',null);
    const report=await earningsReport(env,null,time);assert.equal(report.summary.allTimeCents,37500);assert.equal(report.summary.jobs,351);
    assert.doesNotMatch(JSON.stringify(report),/private@example|email|pdfBase64|street_address|syncToken|token_hash/);
  }finally{db.close();}
});
test('Undo then Done uses the new completion day, while repeated Done syncs preserve it',async()=>{
  const {db,env}=await fixture();try{
    const first=Date.parse('2026-09-10T00:00:00Z'),undo=Date.parse('2026-09-20T00:00:00Z'),redo=Date.parse('2026-09-30T00:00:00Z');
    db.prepare('INSERT INTO bookings VALUES(?,?,?,?,?,?,?,?,?)').run('WEB-redo','COMPLETED',1000,0,0,null,time,'',null);
    for(const [status,at]of [['COMPLETED',first],['COMPLETED',first+1000],['ADDED_TO_RUN',undo],['COMPLETED',redo],['COMPLETED',time]]){
      db.prepare('INSERT INTO booking_events VALUES(?,?,?,?)').run('WEB-redo','STATUS',status,at);
    }
    const report=await earningsReport(env,null,time),entry=buildEntries(report.records).find(e=>e.key==='WEB-redo');
    assert.equal(entry.day,'2026-09-30');assert.equal(entry.cents,1000);
  }finally{db.close();}
});
test('anonymous, customers, expired sessions and external origins cannot read financial data',async()=>{
  const {db,env}=await fixture();try{
    for(const [token,origin,status]of [['','https://naki-pickup-run.pages.dev',401],['customer-test','https://naki-pickup-run.pages.dev',401],['expired-test','https://naki-pickup-run.pages.dev',401],['owner-test','https://untrusted.example',403]]){
      const res=await worker.fetch(new Request('https://test.invalid/v2/owner/earnings',{headers:{Origin:origin,...(token?{Authorization:'Bearer '+token}:{})}}),env);
      assert.equal(res.status,status);assert.doesNotMatch(await res.text(),/allTimeCents|records|2500/);
    }
  }finally{db.close();}
});
test('owner can read no-store totals and logout revokes the server token',async()=>{
  const {db,env}=await fixture();try{
    const request=(path,method='GET')=>new Request('https://test.invalid/v2'+path,{method,headers:{Origin:'https://naki-pickup-run.pages.dev',Authorization:'Bearer owner-test'}});
    const res=await worker.fetch(request('/owner/earnings'),env);assert.equal(res.status,200);
    assert.match(res.headers.get('Cache-Control'),/private.*no-store/);assert.equal(res.headers.get('X-Content-Type-Options'),'nosniff');
    assert.equal((await res.json()).summary.allTimeCents,2500);
    assert.equal((await worker.fetch(request('/owner/logout','POST'),env)).status,200);
    assert.equal((await worker.fetch(request('/owner/earnings'),env)).status,401);
  }finally{db.close();}
});
