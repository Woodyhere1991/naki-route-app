import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.js';
import {handleIntegrationApi, purgeApiRequests} from '../src/integration-api.js';
import {apiDigest} from '../src/api-keys.js';
import {handlePortalRequest, dumpDatabase} from '../src/customer.js';

const origin = 'https://naki-pickup-run.pages.dev';
const sample = {firstName:'API Test',lastName:'Example',phone:'0212345678',email:'api-test@example.test',
  streetAddress:'80 Hume Street',town:'Waitara',ruralOption:'Main town or main road - no travel fee',items:['Microwave'],additionalInfo:'Keep this note'};

async function setup(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON');
  for (const file of fs.readdirSync(new URL('../migrations/', import.meta.url)).filter(n=>n.endsWith('.sql')).sort()) db.exec(fs.readFileSync(new URL('../migrations/'+file, import.meta.url),'utf8'));
  const wrapper = {
    prepare(sql) {
      const s = db.prepare(sql);
      const bind = (...args) => ({first:async()=>s.get(...args)||null,all:async()=>({results:s.all(...args)}),run:async()=>({meta:{changes:Number(s.run(...args).changes)}})});
      return {...bind(),bind};
    },
    async batch(statements) {
      db.exec('BEGIN');
      try {const out=[]; for (const s of statements) out.push(await s.run()); db.exec('COMMIT'); return out;}
      catch(e){db.exec('ROLLBACK');throw e;}
    }
  };
  const state = {mails:0, botMails:[], allow:true, saved:null};
  const env = {CUSTOMER_DB:wrapper, BOT_RATE_LIMIT:{limit:async()=>({success:state.allow})}, REMINDERS:{get:async()=>state.saved}};
  const ownerHash = Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('test-owner'))).toString('base64url');
  db.prepare("INSERT INTO sessions(token_hash,role,email,created_at,last_seen_at,expires_at) VALUES(?,'owner','owner@example.test',0,0,?)").run(ownerHash,Date.now()+86400000);
  const owner = (path,method='GET',body,token='test-owner') => handlePortalRequest({
    request:new Request('https://test.invalid'+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),
    env,path,json:(_r,data,status=200)=>Response.json(data,{status}),sendMail:async()=>{state.mails++;return true;}
  });
  const makeKey = async(permission='write') => {
    const r = await owner('/owner/api-keys','POST',{name:'Grok test',permission,expiresInDays:90});
    assert.equal(r.status,201); return r.json();
  };
  const key = await makeKey();
  const api = (path,method='GET',body,headers={},secret=key.secret) => handleIntegrationApi(new Request('https://test.invalid/api/v1'+path,{
    method,headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})
  }),env,{sendMail:async(_env,message)=>{state.botMails.push(message);return true;}});
  const create = async() => {const r=await api('/bookings','POST',sample,{'Idempotency-Key':crypto.randomUUID()});assert.equal(r.status,201,await r.clone().text());return (await r.json()).booking;};
  return {db,env,state,key,owner,api,makeKey,create};
}

test('only owner sessions manage keys; secret is returned once and stored only as a hash',async t=>{
  const {db,key,owner,api}=await setup(t);
  assert.match(key.secret,/^naki_bot_[a-f0-9]{64}$/);
  assert.equal(db.prepare('SELECT token_hash FROM bot_api_keys').get().token_hash,await apiDigest(key.secret));
  const list=await(await owner('/owner/api-keys')).text(); assert.ok(!list.includes(key.secret)); assert.ok(!list.includes('token_hash'));
  assert.equal((await owner('/owner/api-keys','GET',undefined,key.secret)).status,401);
  assert.equal((await owner('/owner/api-keys','POST',{name:'bad',permission:'write'},'invalid')).status,401);
  for(const path of ['/owner/api-keys','/api-keys','/backup','/export','/send-bulk']) assert.equal((await api(path)).status,404);
  const dump=await dumpDatabase({CUSTOMER_DB:{prepare:sql=>({all:async()=>({results:sql.includes('sqlite_master')?[{name:'bot_api_keys'},{name:'bot_api_requests'}]:[]})})}});
  assert.deepEqual(dump.tables,{});
});

test('invalid, expired and revoked keys fail, including previously successful retries',async t=>{
  const {db,key,api,owner}=await setup(t);
  assert.equal((await api('/me','GET',undefined,{},'wrong')).status,401);
  assert.equal((await api('/me')).status,200);
  db.prepare('UPDATE bot_api_keys SET expires_at=0').run();assert.equal((await api('/me')).status,401);
  db.prepare('UPDATE bot_api_keys SET expires_at=?').run(Date.now()+86400000);
  assert.equal((await api('/bookings','POST',sample,{'Idempotency-Key':'revoke-retry'})).status,201);
  assert.equal((await owner('/owner/api-keys/'+key.key.id,'DELETE')).status,200);
  assert.equal((await api('/me')).status,401);
  assert.equal((await api('/bookings','POST',sample,{'Idempotency-Key':'revoke-retry'})).status,401);
});

test('read-only keys can read but cannot create, update or delete',async t=>{
  const {makeKey,api,db}=await setup(t);const key=await makeKey('read');
  assert.equal((await api('/bookings','GET',undefined,{},key.secret)).status,200);
  for(const method of ['POST','PATCH','DELETE']) assert.equal((await api('/bookings',method,{}, {},key.secret)).status,403);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n,0);
});

test('idempotent booking creation writes once and sends the customer one booking confirmation',async t=>{
  const {db,api,state,owner}=await setup(t);
  const first=await api('/bookings','POST',sample,{'Idempotency-Key':'same-create-1'});assert.equal(first.status,201);
  const body=await first.json();assert.equal(body.customerEmailed,true);
  // Woody, 25 Sept: everyone who books gets the what-happens-next email, phone bookings included.
  assert.equal(state.botMails.length,1);assert.equal(state.botMails[0].to,sample.email);assert.equal(state.botMails[0].subject,'Whiteware Collection');
  assert.match(state.botMails[0].text,/can't take any packaging, boxes etc/);
  const retry=await api('/bookings','POST',sample,{'Idempotency-Key':'same-create-1'});
  assert.equal(retry.status,201);assert.equal(retry.headers.get('Idempotency-Replayed'),'true');assert.deepEqual(await retry.json(),body);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n,1);
  assert.equal(state.mails,0);assert.equal(state.botMails.length,1,'a replayed create must not email again');
  assert.equal((await api('/bookings','POST',{...sample,firstName:'Different'},{'Idempotency-Key':'same-create-1'})).status,409);
  const activity=await(await owner('/owner/api-keys/activity')).json();assert.equal(activity.activity[0].status,201);
});

test('booking PATCH keeps omitted values, requires a fresh ETag and safely replays',async t=>{
  const {api,create,state,db}=await setup(t);const booking=await create();
  const path='/bookings/'+booking.id;const tag=(await api(path)).headers.get('ETag');
  assert.equal((await api(path,'PATCH',{status:'CONFIRMED',pickupDate:'2026-10-01'},{'Idempotency-Key':'no-etag-1'})).status,428);
  const headers={'Idempotency-Key':'update-day-1','If-Match':tag};
  const changed=await api(path,'PATCH',{status:'CONFIRMED',pickupDate:'2026-10-01'},headers);
  assert.equal(changed.status,200,await changed.clone().text());
  const data=await changed.json();assert.equal(data.booking.additionalInfo,sample.additionalInfo);assert.equal(data.booking.pickupDate,'2026-10-01');assert.equal(data.confirmationEmailed,null);
  assert.equal((await api(path,'PATCH',{status:'CONFIRMED',pickupDate:'2026-10-01'},headers)).status,200);
  assert.equal((await api(path,'PATCH',{customerNote:'stale'},{...headers,'Idempotency-Key':'new-but-stale'})).status,412);
  assert.notEqual((await api(path)).headers.get('ETag'),tag);assert.equal(state.mails,0);
  assert.equal(state.botMails.length,1,'bot edits never email the customer; only the creation confirmation was sent');
  assert.equal(db.prepare('SELECT customer_note FROM bookings WHERE id=?').get(booking.id).customer_note,'');
});

test('customer PATCH preserves omitted details and rejects unsupported email changes',async t=>{
  const {create,api}=await setup(t);await create();
  const customer=(await(await api('/customers')).json()).customers[0];const path='/customers/'+customer.id;
  const tag=(await api(path)).headers.get('ETag');
  const r=await api(path,'PATCH',{phone:'0219876543'},{'If-Match':tag,'Idempotency-Key':'customer-phone'});
  assert.equal(r.status,200,await r.clone().text());const updated=(await r.json()).customer;
  assert.equal(updated.firstName,sample.firstName);assert.equal(updated.streetAddress,sample.streetAddress);assert.equal(updated.phone,'0219876543');
  assert.equal((await api(path,'PATCH',{email:'other@example.test'},{'If-Match':tag,'Idempotency-Key':'customer-email'})).status,400);
});

test('a CDN-weakened ETag still identifies the same revision and rejects stale writes',async t=>{
  const {api,create}=await setup(t);const booking=await create();const path='/bookings/'+booking.id;
  const read=await api(path);assert.match(read.headers.get('Cache-Control'),/no-transform/);
  const tag='W/'+read.headers.get('ETag');
  assert.equal((await api(path,'PATCH',{customerNote:'Saved through compressed response'},{'If-Match':tag,'Idempotency-Key':'weak-etag-first'})).status,200);
  assert.equal((await api(path,'PATCH',{customerNote:'Stale overwrite'},{'If-Match':tag,'Idempotency-Key':'weak-etag-stale'})).status,412);
});

test('Jotform and imported pickups can both be read and changed',async t=>{
  const {db,api}=await setup(t);
  db.prepare("INSERT INTO jotform_bookings(id,submission_id,form_id,email,created_at,updated_at) VALUES('JOTFORM-test','test','form','j@example.test',1,1)").run();
  db.prepare("INSERT INTO external_bookings(id,external_key,sync_token_hash,email,created_at,updated_at) VALUES('PICKUP-test','sheet-test','hidden','p@example.test',1,1)").run();
  const rows=(await(await api('/bookings')).json()).bookings;assert.equal(rows.length,2);
  for(const id of ['JOTFORM-test','PICKUP-test']){
    const r=await api('/bookings/'+id);assert.equal(r.status,200);
    const changed=await api('/bookings/'+id,'PATCH',{status:'COMPLETED'},{'If-Match':r.headers.get('ETag'),'Idempotency-Key':'finish-'+id});
    assert.equal(changed.status,200,await changed.clone().text());assert.equal((await changed.json()).booking.status,'COMPLETED');
  }
});

test('validation refuses arbitrary fields, invalid dates, oversized bodies, messaging and deletes',async t=>{
  const {api,create}=await setup(t);const booking=await create();const path='/bookings/'+booking.id;
  for(const body of [{notifyCustomer:true},{status:'BOGUS'},{pickupDate:'2026-02-30'},{items:['made up']},{phone:123},{quoteAmount:'twenty'},{quoteAmount:null},{additionalInfo:'a'.repeat(33000)}]) {
    const r=await api(path,'PATCH',body,{'Idempotency-Key':crypto.randomUUID()}); assert.ok([400,413].includes(r.status),await r.clone().text());
  }
  assert.equal((await api(path,'DELETE')).status,405);
  assert.equal((await api('/bookings','POST',sample)).status,400);
  assert.equal((await api('/bookings','POST',sample,{'Content-Type':'text/plain'})).status,415);
});

test('atomic version predicate stops a change made between read and update',async t=>{
  const {db,env,api,create}=await setup(t);const booking=await create();const path='/bookings/'+booking.id;
  const tag=(await api(path)).headers.get('ETag');
  const prepare=env.CUSTOMER_DB.prepare.bind(env.CUSTOMER_DB);
  let raced=false;
  env.CUSTOMER_DB.prepare=sql=>{
    if(!raced && sql.startsWith('UPDATE bookings SET status=')) {raced=true;db.prepare('UPDATE bookings SET additional_info=?,updated_at=updated_at+1 WHERE id=?').run('Saved on phone',booking.id);}
    return prepare(sql);
  };
  assert.equal((await api(path,'PATCH',{additionalInfo:'Overwrite'},{'If-Match':tag,'Idempotency-Key':'atomic-race'})).status,412);
  assert.equal(db.prepare('SELECT additional_info FROM bookings WHERE id=?').get(booking.id).additional_info,'Saved on phone');
});

test('runs expose only run data, and expired replay bodies never allow duplicate execution',async t=>{
  const {state,api,env,db}=await setup(t);
  state.saved={savedAt:123,data:{naki_owner_token_v1:'never-return',naki_pickup_runs_v1:JSON.stringify({runs:[{id:'run-1',name:'Tuesday',state:{stops:[{name:'Example',historySyncToken:'never-return',profileInviteUrl:'never-return'}]}}],shared:{secret:'excluded'}})}};
  const runs=await(await api('/runs')).json();assert.equal(runs.savedAt,123);assert.deepEqual(runs.runs,[{id:'run-1',name:'Tuesday',state:{stops:[{name:'Example'}]}}]);assert.ok(!JSON.stringify(runs).includes('never-return'));
  await api('/bookings','POST',sample,{'Idempotency-Key':'old-response'});
  db.prepare('UPDATE bot_api_requests SET created_at=0').run();await purgeApiRequests(env);
  assert.equal((await api('/bookings','POST',sample,{'Idempotency-Key':'old-response'})).status,409);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n,1);
});

test('worker accepts server-to-server API calls without Origin; keeps owner routes protected',async t=>{
  const {key,env}=await setup(t);
  const request=path=>new Request('https://test.invalid'+path,{headers:{Authorization:'Bearer '+key.secret}});
  assert.equal((await worker.fetch(request('/api/v1/me'),env)).status,200);
  assert.equal((await worker.fetch(request('/v2/owner/bookings'),env)).status,403);
  const ownerRoute=new Request('https://test.invalid/v2/owner/api-keys',{headers:{Origin:origin,Authorization:'Bearer '+key.secret}});
  assert.equal((await worker.fetch(ownerRoute,env)).status,401);
  const publicSchema=await worker.fetch(new Request('https://test.invalid/api/v1/openapi.json'),env);assert.equal(publicSchema.status,200);
  assert.equal((await publicSchema.json()).openapi,'3.0.3');
});

test('rate limiting blocks work and key creation rejects invalid permissions and expiry',async t=>{
  const {state,api,owner}=await setup(t);state.allow=false;
  const r=await api('/me');assert.equal(r.status,429);assert.equal(r.headers.get('Retry-After'),'60');
  for(const body of [{name:'key',permission:'admin',expiresInDays:90},{name:'key',permission:'write',expiresInDays:0}]) assert.equal((await owner('/owner/api-keys','POST',body)).status,400);
});
test('caller price guard refuses mismatched creation without creating a booking',async t=>{
 const f=await setup(t);const catalog=await(await f.api('/catalog')).json();assert.equal(catalog.itemPrices.Dryer[0],2000);assert.equal(catalog.ruralPrices[sample.ruralOption],0);
 const before=f.db.prepare('SELECT count(*) AS n FROM bookings').get().n;
 const wrong=await f.api('/bookings','POST',{...sample,expectedTotalCents:9999,expectedQuoteRequired:false},{'Idempotency-Key':crypto.randomUUID()});assert.equal(wrong.status,422);assert.equal(f.db.prepare('SELECT count(*) AS n FROM bookings').get().n,before);
 const right=await f.api('/bookings','POST',{...sample,expectedTotalCents:1000,expectedQuoteRequired:false},{'Idempotency-Key':crypto.randomUUID()});assert.equal(right.status,201);assert.equal((await right.json()).booking.total,10);
});
