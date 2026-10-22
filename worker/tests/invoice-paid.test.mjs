import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {handlePortalRequest} from '../src/customer.js';
import {paidDocuments,INVOICE_PAYMENTS_KEY} from '../src/invoice-payments.js';
import {bookingRows,documentRows,buildEntries} from '../../assets/earnings-model.js';

// Woody, 20 Oct 2026: marking paid must not finish the booking. Paid is money
// only; the receipt after pickup is what marks it done.
const json=(_r,data,status=200)=>Response.json(data,{status});
// Minimal R2 stand-in that honours onlyIf.etagMatches like the real bucket.
function fakeR2(){
  const store=new Map();let version=0;
  return {store,
    async get(key){const item=store.get(key);if(!item)return null;
      return {etag:item.etag,json:async()=>JSON.parse(item.body)};},
    async put(key,value,options={}){
      const current=store.get(key);
      if(options.onlyIf?.etagMatches&&current?.etag!==options.onlyIf.etagMatches)return null;
      store.set(key,{body:value,etag:'e'+(++version)});return {etag:'e'+version};
    }};
}
async function setup(){
  const db=new DatabaseSync(':memory:');
  for(const file of fs.readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort()){
    db.exec(fs.readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  }
  const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('owner-paid-test'))).toString('base64url');
  db.prepare("INSERT INTO sessions(token_hash,role,email,created_at,last_seen_at,expires_at) VALUES(?,'owner','owner@example.test',0,0,?)").run(hash,Date.now()+600000);
  db.prepare(`INSERT INTO bookings(id,status,first_name,last_name,phone,email,street_address,town,area,rural_option,items_json,total_cents,created_at,updated_at)
    VALUES('WEB-shawn','CONFIRMED','Shawn','Redpath','021','shawn@example.test','131 York Road','New Plymouth','New Plymouth','','["Fridge"]',3500,1000,1000)`).run();
  db.prepare(`INSERT INTO booking_documents(id,booking_id,email,kind,amount_cents,reference,created_at,items_json,address,filename)
    VALUES('INV-1','WEB-shawn','shawn@example.test','INVOICE',3500,'Shawn Redpath',2000,'["Fridge"]','131 York Road','Invoice.pdf')`).run();
  const wrap={prepare(sql){const s=db.prepare(sql);return {
    bind(...args){return {first:async()=>s.get(...args)||null,all:async()=>({results:s.all(...args)}),run:async()=>({meta:{changes:Number(s.run(...args).changes)}})};},
    all:async()=>({results:s.all()})};}};
  const env={CUSTOMER_DB:wrap,REMINDERS:{get:async()=>null,put:async()=>{}},DOCUMENTS:fakeR2()};
  const call=(path,{method='GET',body,token='owner-paid-test',integration=null}={})=>handlePortalRequest({
    request:new Request('https://test.invalid'+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body&&JSON.stringify(body)}),
    env,path,json,sendMail:async()=>true,integrationSession:integration});
  const booking=async()=>(await (await call('/owner/bookings')).json()).bookings.find(b=>b.id==='WEB-shawn');
  return {db,env,call,booking};
}

test('marking an invoice paid clears the owing but leaves the booking Confirmed, not Completed',async()=>{
  const {db,env,call,booking}=await setup();
  try{
    assert.equal((await booking()).invoiceOwing,true);
    const res=await call('/owner/payments',{method:'POST',body:{invoiceId:'INV-1',method:'bank',bankDate:'2026-10-20T08:17:48.000Z',pending:true}});
    assert.equal(res.status,200);
    const {payment}=await res.json();
    assert.equal(payment.cents,3500);assert.equal(payment.method,'bank');assert.equal(payment.bankPending,true);
    const after=await booking();
    assert.equal(after.invoiceOwing,false);
    assert.equal(after.status,'CONFIRMED','Paid is not done');
    assert.equal(after.invoicePaid.amount,35);assert.ok(after.invoicePaid.at>0);
    assert.equal(db.prepare("SELECT status FROM bookings WHERE id='WEB-shawn'").get().status,'CONFIRMED');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM booking_documents WHERE kind='RECEIPT'").get().n,0,'No receipt is made');
    // A second tap keeps the first record.
    await call('/owner/payments',{method:'POST',body:{invoiceId:'INV-1',amount:99}});
    const ledger=JSON.parse(env.DOCUMENTS.store.get(INVOICE_PAYMENTS_KEY).body);
    assert.equal(ledger.payments.length,1);assert.equal(ledger.payments[0].cents,3500);
  }finally{db.close();}
});
test('a new invoice after the payment is owing again; a receipt still settles it the old way',async()=>{
  const {db,call,booking}=await setup();
  try{
    await call('/owner/payments',{method:'POST',body:{invoiceId:'INV-1'}});
    db.prepare(`INSERT INTO booking_documents(id,booking_id,email,kind,amount_cents,reference,created_at,items_json,address,filename)
      VALUES('INV-2','WEB-shawn','shawn@example.test','INVOICE',2000,'Shawn Redpath',5000,'[]','131 York Road','Invoice 2.pdf')`).run();
    const again=await booking();
    assert.equal(again.invoiceOwing,true);assert.equal(again.invoicePaid,null);
    db.prepare(`INSERT INTO booking_documents(id,booking_id,email,kind,amount_cents,reference,created_at,items_json,address,filename)
      VALUES('REC-1','WEB-shawn','shawn@example.test','RECEIPT',2000,'Shawn Redpath',6000,'[]','131 York Road','Receipt.pdf')`).run();
    const receipted=await booking();
    assert.equal(receipted.invoiceOwing,false);assert.equal(receipted.invoicePaid,null);
  }finally{db.close();}
});
test('payments need the owner sign-in and a real invoice',async()=>{
  const {db,call}=await setup();
  try{
    assert.equal((await call('/owner/payments',{method:'POST',body:{invoiceId:'INV-1'},token:'nobody'})).status,401);
    assert.equal((await call('/owner/payments',{method:'POST',body:{invoiceId:'INV-1'},integration:{scope:'write'}})).status,403,'Bot keys cannot mark paid');
    assert.equal((await call('/owner/payments',{method:'POST',body:{invoiceId:'nope'}})).status,404);
    assert.equal((await call('/owner/payments',{method:'POST',body:{invoiceId:'INV-1',amount:-5}})).status,400);
  }finally{db.close();}
});
test('Earnings: a paid invoice is no longer owing, and an unpicked-up paid job is not counted as done',()=>{
  const jobs=bookingRows([{id:'WEB-shawn',status:'CONFIRMED',total_cents:3500,quote_required:0,quote_cents:null,quoted_at:null,updated_at:1000,pickup_date:'',submission_id:'',external_key:'',source:'WEBSITE',completed_at:null}]);
  const docs=[{id:'INV-1',booking_id:'WEB-shawn',kind:'INVOICE',amount_cents:3500,created_at:2000}];
  const before=buildEntries([...jobs,...documentRows(docs)]);
  assert.equal(before.reduce((s,e)=>s+e.owingCents,0),3500);
  const after=buildEntries([...jobs,...documentRows(paidDocuments(docs,[{invoiceId:'INV-1',cents:3500,paidAt:3000,method:'bank'}]))]);
  assert.equal(after.reduce((s,e)=>s+e.owingCents,0),0);
  assert.equal(after.length,0,'Not owing and not picked up: nothing to count yet');
});
