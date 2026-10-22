import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {findPayments,payerTerms,isOwnTransfer} from '../src/bank-payments.js';
import worker from '../src/index.js';

// Shapes copied from real Akahu rows (names and numbers made up).
const credit=(amount,description,meta={},extra={})=>({_id:'trans_'+Math.random(),date:'2026-10-19T10:06:37.000Z',amount,type:'PAYMENT',description,meta,...extra});
const shawn={amount:35,firstName:'Shawn',lastName:'Redpath',street:'131 York Road'};

test('a same-day payment only shows as pending, and is still found',()=>{
  const r=findPayments([credit(35,'Redpath,Shawn Shawn 131 York Rd',{particulars:'Shawn',reference:'131 York Rd'},{pending:true,date:'2026-10-20T08:17:48.000Z'})],shawn);
  assert.equal(r.exact.length,1);
  assert.equal(r.exact[0].pending,true);
  assert.deepEqual(r.exact[0].matchedOn,['name','address']);
});
test('fuzzy names and road spellings: Dan for Daniel, Rd for Road, 56C for 56',()=>{
  assert.deepEqual(findPayments([credit(20,'D Aldred')],{amount:20,firstName:'Daniel',lastName:'Aldred',street:''}).exact[0].matchedOn,['name']);
  assert.equal(findPayments([credit(20,'Dan A')],{amount:20,firstName:'Daniel',lastName:'Aldred'}).exact.length,1);
  assert.equal(findPayments([credit(20,'Aldrid pickup')],{amount:20,firstName:'',lastName:'Aldred'}).exact.length,1);
  assert.deepEqual(findPayments([credit(20,'Mr B 131 york road')],{amount:20,firstName:'Zed',lastName:'Q',street:'131 York Rd'}).exact[0].matchedOn,['address']);
  assert.deepEqual(findPayments([credit(20,'Fischer Mr B J 56C Frankley',{code:'56C Frankley'})],{amount:20,firstName:'',lastName:'',street:'56 Frankley Road'}).exact[0].matchedOn,['address']);
  // A street number alone, or someone else's name, is not a match.
  assert.equal(findPayments([credit(35,'Smith 131 Devon St')],shawn).exact.length,0);
  assert.equal(findPayments([credit(35,'Courtney Keech')],shawn).exact.length,0);
});
test('payments split into parts that add up are shown together',()=>{
  const r=findPayments([
    credit(20,'Paurini Mr J J 373 Tvsx2 Carrington',{},{pending:true,date:'2026-10-20T08:08:19.000Z'}),
    credit(20,'Paurini Mr J J 373 Paurini Carrington',{},{date:'2026-10-18T21:07:47.000Z'})
  ],{amount:40,firstName:'J',lastName:'Paurini',street:'373 Carrington Street'});
  assert.equal(r.exact.length,0);
  assert.deepEqual(r.combined.map(p=>p.amount),[20,20]);
  assert.equal(r.combined[0].pending,true,'newest first');
});
test('a payment from them for a different amount is shown, not counted as paid',()=>{
  const r=findPayments([credit(20,'Redpath S')],shawn);
  assert.equal(r.exact.length,0);assert.equal(r.combined.length,0);
  assert.equal(r.otherAmounts[0].amount,20);
});
test("Woody's own transfers and money going out are ignored",()=>{
  const own=new Set(['06-0709-0900575-01']);
  assert.equal(isOwnTransfer(credit(35,'W J Heremaia Shawn'),own),true);
  assert.equal(isOwnTransfer(credit(35,'From: 06-0709 Credit Transfer'),own),true);
  assert.equal(isOwnTransfer(credit(35,'Redpath Shawn',{other_account:'06-0709-0900575-01'}),own),true);
  const r=findPayments([credit(35,'W J Heremaia Redpath'),credit(-35,'Redpath Shawn 131 York Rd'),credit(35,'Shawn',{other_account:'06-0709-0900575-01'})],shawn,own);
  assert.deepEqual([r.exact.length,r.otherAmounts.length],[0,0]);
});
test('a pending payment that has since cleared is listed once',()=>{
  const r=findPayments([credit(35,'Redpath,Shawn 131 York Rd',{},{pending:true,date:'2026-10-19T08:00:00Z'}),credit(35,'Redpath,Shawn 131 York Rd',{},{date:'2026-10-20T01:00:00Z'})],shawn);
  assert.equal(r.exact.length,1);assert.equal(r.exact[0].pending,false);
});
test('street words: the road type and suburb are not used to match',()=>{
  assert.deepEqual(payerTerms({street:'131 York Road'}),{first:[],last:[],number:'131',streetName:['york']});
});

async function fixture(extra={}){
  const db=new DatabaseSync(':memory:');
  db.exec('CREATE TABLE sessions(token_hash TEXT,customer_id TEXT,role TEXT,email TEXT,expires_at INTEGER,last_seen_at INTEGER);');
  for(const [token,role]of [['owner-test','owner'],['customer-test','customer']]){
    const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))).toString('base64url');
    db.prepare('INSERT INTO sessions VALUES(?,NULL,?,?,?,0)').run(hash,role,'private@example.test',Date.now()+30*86400000);
  }
  const wrap={prepare(sql){const statement=db.prepare(sql);return {bind(...params){return {first:async()=>statement.get(...params)||null,all:async()=>({results:statement.all(...params)}),run:async()=>({meta:{changes:Number(statement.run(...params).changes)}})};},all:async()=>({results:statement.all()})};}};
  return {CUSTOMER_DB:wrap,REMINDERS:{get:async()=>null},AKAHU_APP_TOKEN:'app_token_test',AKAHU_USER_TOKEN:'user_token_test',...extra};
}
const call=(env,body,token='owner-test')=>worker.fetch(new Request('https://test.invalid/v2/owner/payment-check',{method:'POST',
  headers:{Origin:'https://naki-pickup-run.pages.dev',Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)}),env);
// Stand-in for Akahu: records what the Worker asked for.
function fakeAkahu(t){
  const seen=[],realFetch=globalThis.fetch;
  globalThis.fetch=async(url,options={})=>{
    const u=new URL(url);seen.push({path:u.pathname,search:u.search,headers:options.headers});
    const reply=body=>new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
    if(u.pathname==='/v1/accounts')return reply({items:[{_id:'acc_go',name:'Go',formatted_account:'06-0709-0900575-01'},{_id:'acc_biz',name:'Business Current Account',formatted_account:'01-0000-0000000-00'}]});
    if(u.pathname==='/v1/accounts/acc_biz/transactions'&&!u.searchParams.get('cursor'))return reply({items:[credit(20,'Someone else')],cursor:{next:'page2'}});
    if(u.pathname==='/v1/accounts/acc_biz/transactions')return reply({items:[credit(35,'W J Heremaia Shawn')],cursor:{next:null}});
    if(u.pathname==='/v1/accounts/acc_biz/transactions/pending')return reply({items:[{...credit(35,'Redpath,Shawn Shawn 131 York Rd'),_id:undefined}]});
    return new Response('{}',{status:404});
  };
  t.after(()=>{globalThis.fetch=realFetch;});
  return seen;
}

test('the check reads only the business account, cleared pages and pending, with the secret tokens',async t=>{
  const seen=fakeAkahu(t),env=await fixture();
  const response=await call(env,{...shawn,since:Date.parse('2026-10-19T00:00:00Z')});
  assert.equal(response.status,200);
  const data=await response.json();
  assert.equal(data.exact.length,1);assert.equal(data.exact[0].pending,true);
  assert.equal(data.pending,1);assert.equal(data.cleared,2);
  assert.ok(seen.some(s=>s.search.includes('cursor=page2')),'follows the next page');
  assert.ok(seen.every(s=>!s.path.includes('acc_go')),'never reads other accounts');
  assert.ok(seen.every(s=>s.headers['X-Akahu-Id']==='app_token_test'&&s.headers.Authorization==='Bearer user_token_test'));
  const start=new URL('https://x'+seen.find(s=>s.search.includes('start=')).search).searchParams.get('start');
  assert.equal(start,'2026-10-05T00:00:00.000Z','starts two weeks before the invoice');
  assert.equal(JSON.stringify(data).includes('token_test'),false,'tokens never reach the phone');
});
test('needs the owner sign-in; customers and no-login are refused before the bank is touched',async t=>{
  const seen=fakeAkahu(t),env=await fixture();
  assert.equal((await call(env,shawn,'customer-test')).status,401);
  assert.equal((await call(env,shawn,'nobody')).status,401);
  assert.equal(seen.length,0);
});
test('plain messages when the bank link is missing, refused or the invoice has nothing to look for',async t=>{
  fakeAkahu(t);
  const noKeys=await call(await fixture({AKAHU_APP_TOKEN:''}),shawn);
  assert.equal(noKeys.status,503);assert.match((await noKeys.json()).error,/bank link isn't set up/);
  assert.equal((await call(await fixture(),{...shawn,amount:0})).status,400);
  assert.equal((await call(await fixture(),{amount:20})).status,400);
  globalThis.fetch=async()=>new Response('{}',{status:401});
  const refused=await call(await fixture(),shawn);
  assert.equal(refused.status,502);assert.match((await refused.json()).error,/re-linking/);
});

test('same amount from another name since the invoice is offered to check, never as found',()=>{
  const nyssa={amount:30,firstName:'Nyssa',lastName:'Comrie',street:'790 Otaraoa Road',invoicedAt:Date.parse('2026-10-20T20:53:36Z')};
  const r=findPayments([
    credit(30,'J Smith whiteware',{},{date:'2026-10-21T01:00:00Z',pending:true}),
    credit(30,'Old payment',{},{date:'2026-10-10T01:00:00Z'}),
    credit(25,'K Brown',{},{date:'2026-10-21T02:00:00Z'})],nyssa);
  assert.equal(r.exact.length,0);
  assert.deepEqual(r.sameAmount.map(p=>p.payer),['J Smith whiteware']);
  const named=findPayments([credit(30,'Comrie N'),credit(30,'J Smith',{},{date:'2026-10-21T01:00:00Z'})],nyssa);
  assert.equal(named.exact.length,1);assert.equal(named.sameAmount.length,0);
});

test('bank data refresh is asked for hourly from 9am to 10pm NZ time only',async()=>{
  const {bankRefreshDue,scheduledBankRefresh}=await import('../src/bank-payments.js');
  // 21 Oct 2026 is NZDT (UTC+13).
  const nz=(h,m)=>Date.parse(`2026-10-21T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00+13:00`);
  assert.equal(bankRefreshDue(nz(9,0)),true);assert.equal(bankRefreshDue(nz(22,0)),true);assert.equal(bankRefreshDue(nz(12,14)),true);
  assert.equal(bankRefreshDue(nz(12,15)),false,'once an hour, not every 15 minutes');
  assert.equal(bankRefreshDue(nz(8,0)),false);assert.equal(bankRefreshDue(nz(23,0)),false);assert.equal(bankRefreshDue(nz(2,0)),false);
  const realFetch=globalThis.fetch,calls=[];
  try{
    globalThis.fetch=async(url,init={})=>{calls.push([init.method||'GET',String(url)]);return Response.json(String(url).endsWith('/accounts')?{items:[{_id:'acc_1',name:'Business Current Account'}]}:{success:true});};
    const env={AKAHU_APP_TOKEN:'a',AKAHU_USER_TOKEN:'u'};
    assert.equal(await scheduledBankRefresh(env,nz(9,0)),true);
    assert.deepEqual(calls.at(-1),['POST','https://api.akahu.io/v1/refresh/acc_1']);
    calls.length=0;assert.equal(await scheduledBankRefresh(env,nz(23,0)),false);assert.equal(calls.length,0);
    assert.equal(await scheduledBankRefresh({},nz(9,0)),false,'no keys, no call');
  }finally{globalThis.fetch=realFetch;}
});
