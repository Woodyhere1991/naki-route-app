import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';
import { metForecast, weatherNotices } from '../src/field-weather.js';
import { handlePortalRequest } from '../src/customer.js';

const html=fs.readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const helpers=fs.readFileSync(new URL('../../assets/field-tools.js',import.meta.url),'utf8');
const section=(source,a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
const json=(_r,data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
function database() {
  const db=new DatabaseSync(':memory:');
  db.exec('CREATE TABLE sessions(token_hash TEXT,customer_id TEXT,role TEXT,email TEXT,expires_at INTEGER);');
  db.exec(fs.readFileSync(new URL('../migrations/0023_owner_action_receipts.sql',import.meta.url),'utf8'));
  const wrap={prepare(sql){
    const statement=db.prepare(sql);
    return {bind(...params){return {
      first:async()=>statement.get(...params)||null,
      all:async()=>({results:statement.all(...params)}),
      run:async()=>({meta:{changes:Number(statement.run(...params).changes)}})
    };}};
  }};
  return {db,wrap};
}
async function signedEnv() {
  const {db,wrap}=database();
  const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('field-test-token'))).toString('base64url');
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(hash,'owner','owner','owner@example.test',Date.now()+600000);
  return {db,env:{CUSTOMER_DB:wrap,BREVO_API_KEY:'fake-only',REMINDERS:{delete:async()=>{throw Error('Unexpected reminder mutation');}}}};
}
function request(path,body={},token=true,key='test-request-0001') {
  return new Request('https://local.invalid/v2'+path,{method:'POST',headers:{Origin:'https://naki-pickup-run.pages.dev','Content-Type':'application/json','Idempotency-Key':key,...(token?{Authorization:'Bearer field-test-token'}:{})},body:JSON.stringify(body)});
}
test('every sending/reminder path rejects unsigned callers before effects',async()=>{
  for(const path of ['/send-bulk','/send-receipt','/send-invoice','/set-reminder','/cancel-reminder','/owner/bookings/bulk-confirm']) {
    const res=await worker.fetch(request(path,{},false),{});assert.equal(res.status,401,path);
  }
  const res=await worker.fetch(new Request('https://local.invalid/v2/run-reminders',{headers:{Origin:'https://naki-pickup-run.pages.dev'}}),{});
  assert.equal(res.status,404);
});
test('oversized email batches fail explicitly before any delivery',async()=>{
  const {env,db}=await signedEnv();
  try {const res=await worker.fetch(request('/send-bulk',{messages:Array.from({length:41},(_,i)=>({to:`test${i}@example.test`,body:'test'}))}),env);assert.equal(res.status,400);assert.match((await res.json()).error,/none were sent/);}finally{db.close();}
});
test('successful mail is replayed on an uncertain retry, never delivered twice',async()=>{
  const {env,db}=await signedEnv();const original=globalThis.fetch;let deliveries=0;
  globalThis.fetch=async()=>{deliveries++;return json(null,{messageId:'fake'});};
  try {
    const body={messages:[{to:'one@example.test',body:'hello'}]};
    const a=await worker.fetch(request('/send-bulk',body),env);assert.equal(a.status,200);assert.deepEqual((await a.json()).sentTo,['one@example.test']);
    const b=await worker.fetch(request('/send-bulk',body),env);assert.equal(b.status,200);assert.equal(deliveries,1);
    const changed=await worker.fetch(request('/send-bulk',{messages:[{to:'other@example.test',body:'changed'}]}),env);assert.equal(changed.status,409);assert.equal(deliveries,1);
  }finally{globalThis.fetch=original;db.close();}
});
test('simultaneous requests with one reference claim only one delivery',async()=>{
  const {env,db}=await signedEnv();const original=globalThis.fetch;let unlock,entered;const started=new Promise(r=>entered=r);let calls=0;
  globalThis.fetch=async()=>{calls++;entered();await new Promise(r=>unlock=r);return json(null,{messageId:'fake'});};
  try {const body={messages:[{to:'one@example.test',body:'hello'}]};const first=worker.fetch(request('/send-bulk',body),env);await started;const second=await worker.fetch(request('/send-bulk',body),env);assert.equal(second.status,409);unlock();assert.equal((await first).status,200);assert.equal(calls,1);}finally{globalThis.fetch=original;db.close();}
});
test('high rain chance alone never generates a heavy-rain notice',()=>{
  assert.deepEqual(weatherNotices(0.8,84,25),['Rain likely']);
  assert.deepEqual(weatherNotices(null,null,null),[]);
  assert.match(weatherNotices(20,10,75).join(' '),/Wet day.*70 km/);
});
test('forecast keeps unavailable probability and gusts unknown, and preserves coarse intervals',()=>{
  const timeseries=[0,6,12,18].map(h=>({time:`2026-09-05T${String(h).padStart(2,'0')}:00:00Z`,data:{instant:{details:{air_temperature:10,wind_speed:5}},next_6_hours:{summary:{symbol_code:'rain'},details:{precipitation_amount:2}}}}));
  const out=metForecast({properties:{meta:{updated_at:'2026-09-05T00:00:00Z'},timeseries}},{name:'Test'});
  assert.equal(out.hours[0].interval_hours,6);assert.equal(out.hours[0].gust,null);assert.equal(out.hours[0].rain_chance,null);assert.equal(out.hours[0].wind,18);
  assert.equal(out.days.reduce((sum,d)=>sum+d.rain_mm,0),8);
});
test('automatic backup failures visibly remain pending',async()=>{
  const updates=[];const context={ownerToken:'test',cloudBackupBusy:false,lastCloudPush:'',backupPayload:()=>({runCount:1,data:{}}),ownerApi:async()=>{throw Error('offline')},paintCloudState:(...x)=>updates.push(x),backupStatus(){}};
  vm.runInNewContext(section(html,'async function pushCloudBackup(','// Called from save();'),context);
  await context.pushCloudBackup(true);assert.match(updates[0][0],/waiting to sync/);assert.equal(updates[0][1],true);assert.equal(context.cloudBackupBusy,false);
});
test('a 41-person frontend batch splits 40 + 1 and retries only failed recipients',async()=>{
  const marks=new Map(),chunks=[];let failLast=true;
  const context={goodEmail:()=>true,markFor:s=>marks.get(s.id)||{},fullName:s=>s.first_name,dedupeBy:(values,key)=>[...new Map(values.map(x=>[key(x),x])).values()],messageMode:()=> 'reminder',API:'https://fake.invalid',recordMessageDelivery:(rows,change)=>rows.forEach(s=>marks.set(s.id,{...marks.get(s.id),...change})),ownerActionFetch:async(_url,options)=>{const rows=JSON.parse(options.body).messages;chunks.push(rows.length);const failed=failLast?rows.filter(r=>r.to==='test40@example.test').map(r=>r.to):[];const sentTo=rows.filter(r=>!failed.includes(r.to)).map(r=>r.to);return json(null,{ok:true,sent:sentTo.length,sentTo,failed});}};
  vm.runInNewContext(section(html,'async function sendReminderEmailBatch(','let pendingTextBatches='),context);
  const batch={message:'Hey Woody here',recipients:Array.from({length:41},(_,id)=>({id,email:`test${id}@example.test`,first_name:'Test'}))};
  const first=await context.sendReminderEmailBatch(batch);assert.deepEqual(chunks,[40,1]);assert.equal(first.sent,40);assert.match(first.problem,/1 email/);
  failLast=false;chunks.length=0;const second=await context.sendReminderEmailBatch(batch);assert.deepEqual(chunks,[1]);assert.equal(second.sent,1);assert.equal(second.problem,'');
});
test('prepared SMS is not called sent and JS strings cannot escape their argument',()=>{
  const context={markFor:s=>s.mark};
  vm.runInNewContext(section(helpers,'function messageDeliveryLabel(','function recordMessageDelivery('),context);
  assert.equal(context.messageDeliveryLabel({mark:{textPrepared:true}}),'Text ready');
  assert.equal(context.messageDeliveryLabel({mark:{textPrepared:true,email:true}}),'Email sent · text ready');
  vm.runInNewContext(section(html,'function jsString(','function esc('),context);
  const input="O'Neil'); hacked=true; //";context.accept=x=>context.accepted=x;context.hacked=false;
  vm.runInNewContext(`accept('${context.jsString(input)}')`,context);assert.equal(context.hacked,false);assert.equal(context.accepted,input);
});
test('pickup route timing still works with the map library absent',async()=>{
  const context={map:null,markerLayer:null,routeLayer:null,routeDrawVersion:0,routeStops:()=>[{id:'test',lat:-39,lng:174}],startPoint:()=>({lat:-39,lng:174}),endPoint:()=>null,state:{},setBanner(){},updateStats(){},fetchRouteData:async()=>({routes:[{distance:1000,duration:60,legs:[{duration:60}]}]}),setRouteTiming:(pts,legs)=>context.timing=legs,onTimingChanged(){}};
  vm.runInNewContext(section(html,'async function drawRoute(){','/* ---------- Rough time schedule'),context);await context.drawRoute();assert.equal(context.timing[0].duration,60);
});

test('server search finds an old booking and its paperwork beyond the old list limits',async()=>{
  const {env,db}=await signedEnv();
  const columns=['id','customer_id','status','first_name','last_name','phone','email','street_address','town','area','rural_option','items_json','additional_info','referral_source','referral_details','total_cents','quote_required','quote_cents','quote_note','quoted_at','photo_count','sheet_sync_status','pickup_date','pickup_window','customer_note','cancellation_reason','cancelled_at','created_at','updated_at','external_key'];
  for(const table of ['bookings','jotform_bookings','external_bookings']) db.exec(`CREATE TABLE ${table} (${columns.map(c=>c==='created_at'?c+' INTEGER':c+' TEXT').join(',')})`);
  db.exec('CREATE TABLE booking_events(id TEXT,booking_id TEXT,event_type TEXT); CREATE TABLE booking_documents(id TEXT,booking_id TEXT,email TEXT,kind TEXT,amount_cents INTEGER,reference TEXT,created_at INTEGER,items_json TEXT,address TEXT,filename TEXT,r2_key TEXT);');
  const insert=db.prepare('INSERT INTO bookings(id,status,first_name,last_name,email,street_address,town,items_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)');
  for(let i=0;i<350;i++) insert.run('b'+i,'COMPLETED',i===0?'ArchiveOnly':'Recent','Test',`test${i}@example.test`,'Test Lane','Test Town','[]',Date.now()+i*1000);
  db.prepare('INSERT INTO booking_documents VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('old-doc','b0','test0@example.test','INVOICE',2000,'test',1,'[]','Test Lane','test.pdf','key');
  try{
    const req=new Request('https://local.invalid/owner/bookings?q=archiveonly',{headers:{Authorization:'Bearer field-test-token'}});
    const res=await handlePortalRequest({request:req,env,path:'/owner/bookings',json,sendMail:()=>{throw Error('No sends allowed');}});
    assert.equal(res.status,200);const data=await res.json();assert.equal(data.bookings.length,1);assert.equal(data.bookings[0].id,'b0');assert.equal(data.bookings[0].documents[0].id,'old-doc');assert.equal(data.hasMore,false);
    const page=await handlePortalRequest({request:new Request('https://local.invalid/owner/bookings?offset=300',{headers:{Authorization:'Bearer field-test-token'}}),env,path:'/owner/bookings',json});
    const more=await page.json();assert.equal(more.bookings.length,50);assert.equal(more.nextOffset,350);assert.equal(more.hasMore,false);
  }finally{db.close();}
});


test('refresh replaces removed rows without losing older loaded pages',async()=>{
  let reply={bookings:[{id:'a'},{id:'b'}],pageSize:2,nextOffset:2,hasMore:true};
  const button={};const context={document:{getElementById:()=>button},setTimeout,clearTimeout,ownerApi:async()=>reply};
  vm.runInNewContext(helpers.slice(helpers.indexOf('const ownerPages=')),context);
  assert.deepEqual(Array.from((await context.loadOwnerCollection('bookings','')).bookings,r=>r.id),['a','b']);
  reply={bookings:[{id:'c'}],pageSize:2,nextOffset:3,hasMore:false};
  assert.deepEqual(Array.from((await context.loadOwnerCollection('bookings','',true)).bookings,r=>r.id),['a','b','c']);
  reply={bookings:[{id:'b'}],pageSize:2,nextOffset:1,hasMore:false};
  assert.deepEqual(Array.from((await context.loadOwnerCollection('bookings','')).bookings,r=>r.id),['b','c']);
});

test('large confirmations save successful chunks before a later connection failure',async()=>{
  const marks=new Map(),chunks=[];
  const context={state:{confirmationDate:'2026-09-06'},ownerToken:'test',markFor:s=>marks.get(s.id)||{},bulkBookingRecipient:s=>({bookingId:s.id,email:s.email}),save(){},syncExternalBooking(){},recordMessageDelivery:(rows,change)=>rows.forEach(s=>marks.set(s.id,{...marks.get(s.id),...change})),ownerApi:async(_p,options)=>{const body=JSON.parse(options.body);chunks.push(body.recipients.length);if(chunks.length===2)throw Error('connection lost');return {updated:40,emailed:40,emailedTo:body.recipients.map(r=>r.email)};}};
  vm.runInNewContext(section(html,'async function publishBulkPickupDate(','// pickupDate is only'),context);
  const rows=Array.from({length:81},(_,id)=>({id:String(id),email:`test${id}@example.test`}));
  await assert.rejects(()=>context.publishBulkPickupDate(rows,'2026-09-06',true,'test'),/connection lost/);
  assert.deepEqual(chunks,[40,40]);assert.equal(marks.size,40);assert.equal(rows[0].confirmedPickupDate,'2026-09-06');assert.equal(rows[40].confirmedPickupDate,undefined);
});
