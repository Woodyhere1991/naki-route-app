import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import {buildGroups,validateGroup,runStamp,CENTRES,nzDay} from '../../assets/run-suggestions-model.mjs';
import {previewSuggestions,approveSuggestions,handleRunSuggestions} from '../src/run-suggestions.js';
const day=n=>new Date(Date.parse(nzDay())+n*86400000).toISOString().slice(0,10);
export const options={days:[day(1),day(2)],targetRunId:'',startTown:'inglewood',maxPickups:5,maxItems:7,maxMinutes:480,serviceMinutes:10,corridorKm:20,startTime:'08:00',endTime:'16:00',availabilityConfirmed:true};
const booking=(id,town='Waitara',more={})=>({id,status:'NEW',streetAddress:'20 Example Street',town,items:['Fridge'],firstName:'Synthetic '+id,...CENTRES[town.toLowerCase().replace(/ /g,'')],...more});
const store=()=>({activeRunId:'r1',runs:[{id:'r1',name:'Example empty run',data:{stops:[],bad:[]}}],shared:{}});
const wx=(days=options.days)=>({updated_at:new Date().toISOString(),towns:['Waitara','Bell Block','Hawera'].map(name=>({name,source:'Synthetic forecast',updated_at:new Date().toISOString(),days:days.map((date,i)=>({date,rain_mm:i?1:15,wind:20,partial:false}))}))});
test('multiple towns grouped; weather breaks feasible day ties, customer date wins',()=>{
 const result=buildGroups({store:store(),bookings:[booking('A'),booking('B','Bell Block')],options,weather:wx()});
 assert.equal(result.groups.length,1);assert.equal(result.groups[0].bookingIds.length,2);assert.equal(result.groups[0].day,day(2));assert.equal(result.groups[0].weatherRanked,true);
 const constrained=buildGroups({store:store(),bookings:[booking('C','Waitara',{requestedDate:day(1),pickupDate:day(1)})],options,weather:wx()});assert.equal(constrained.groups[0].day,day(1));
});
test('capacity counts existing stops; order/unloads survive; full or unresolved runs held',()=>{
 const s=store();s.runs[0].data.stops=[{id:'old',town:'Waitara',status:'NEW',appliances:['Fridge'],...CENTRES.waitara},{id:'yard',kind:'unload',...CENTRES.waitara}];
 const opt={...options,targetRunId:'r1',maxPickups:2};const r=buildGroups({store:s,bookings:[booking('A'),booking('B')],options:opt});assert.equal(r.groups[0].bookingIds.length,1);assert.equal(s.runs[0].data.stops[1].id,'yard');
 s.runs[0].data.bad=[{id:'bad',town:'Waitara',status:'NEW'}];assert.equal(buildGroups({store:s,bookings:[booking('A')],options:opt}).groups.length,0);
});
test('conflicting promises, time windows, no location, quotes and closed bookings held',()=>{
 const rows=[booking('date','Waitara',{pickupDate:day(3)}),booking('window','Waitara',{requestedWindow:'9–10am'}),booking('missing','Unknown',{lat:undefined,lng:undefined}),booking('quote','Waitara',{quoteRequired:true}),booking('cancel','Waitara',{status:'CANCELLED'}),booking('done','Waitara',{status:'COMPLETED'})];
 const r=buildGroups({store:store(),bookings:rows,options});assert.equal(r.groups.length,0);assert.equal(r.held.length,6);
});
test('no coordinates uses provisional town order, requires consent and never invents a street pin',()=>{
 const b=booking('town','Waitara',{lat:undefined,lng:undefined}),s=store(),r=buildGroups({store:s,bookings:[b],options});assert.equal(r.groups[0].confidence,'provisional');assert.equal(b.lat,undefined);
 assert.throws(()=>validateGroup({store:s,bookings:[b],options,group:r.groups[0]}),/pins/);
 assert.ok(validateGroup({store:s,bookings:[b],options,group:{...r.groups[0],townOnlyConfirmed:true}}));
});
test('missing, partial, stale or out-of-range weather is not fabricated or ranked',()=>{
 for(const weather of [undefined,wx([]),{...wx(),updated_at:'2020-01-01',towns:[]}, {...wx(),towns:wx().towns.map(t=>({...t,days:t.days.map(d=>({...d,partial:true}))}))}]){
  const r=buildGroups({store:store(),bookings:[booking('A')],options,weather});assert.equal(r.groups[0].weather.available,false);assert.equal(r.groups[0].weatherRanked,false);assert.equal(r.groups[0].day,day(1));
 }
});
test('one group per day; occupied run days excluded; confirmation day cannot change',()=>{
 const r=buildGroups({store:store(),bookings:[booking('A'),booking('B','Hawera'),booking('C','Patea')],options:{...options,maxPickups:1}});assert.equal(new Set(r.groups.map(g=>g.day)).size,r.groups.length);assert.equal(r.groups.length,2);
 const s=store();s.runs[0].data={confirmationDate:day(1),stops:[{id:'old',town:'Waitara',status:'NEW',appliances:['Fridge'],...CENTRES.waitara}],bad:[]};
 assert.equal(buildGroups({store:s,bookings:[booking('A')],options}).groups[0].day,day(2));
 assert.throws(()=>validateGroup({store:s,bookings:[booking('A')],options:{...options,targetRunId:'r1'},group:{runId:'r1',day:day(2),bookingIds:['A']}}),/cannot change/);
});
test('manual edits recheck availability, item limits, dates, notes, duplicates and target',()=>{
 const s=store(),b=booking('A','Waitara',{additionalInfo:'Customer access constraint'}),g={runId:'',day:day(1),bookingIds:['A']};
 assert.throws(()=>validateGroup({store:s,bookings:[b],options,group:g}),/notes/);assert.ok(validateGroup({store:s,bookings:[b],options,group:{...g,reviewedIds:['A']}}));
 assert.throws(()=>validateGroup({store:s,bookings:[b],options:{...options,availabilityConfirmed:false},group:g}),/availability/);
 assert.throws(()=>validateGroup({store:s,bookings:[b],options,group:{...g,bookingIds:['A','A']}}),/unique/);
 assert.throws(()=>validateGroup({store:s,bookings:[b],options,group:{...g,runId:'r1'}}),/selected run/);
 assert.throws(()=>validateGroup({store:s,bookings:[booking('A','Waitara',{items:['2 x Fridge']})],options:{...options,maxItems:1},group:g}),/limits/);
});
export function fixture(t){
 const db=new DatabaseSync(':memory:');t?.after(()=>db.close());
 db.exec(`CREATE TABLE run_backups(owner_key TEXT PRIMARY KEY,saved_at INTEGER,record_json TEXT,previous_json TEXT);CREATE TABLE owner_booking_notes(booking_id TEXT PRIMARY KEY,note TEXT,updated_at INTEGER);`);
 const cols=`id TEXT PRIMARY KEY,status TEXT,updated_at INTEGER,first_name TEXT,last_name TEXT,street_address TEXT,town TEXT,area TEXT,items_json TEXT,pickup_date TEXT,pickup_window TEXT,requested_date TEXT,requested_window TEXT,additional_info TEXT,customer_note TEXT,quote_required INTEGER,quoted_at INTEGER,quote_cents INTEGER,external_key TEXT,phone TEXT,email TEXT,total_cents INTEGER`;
 for(const name of ['bookings','jotform_bookings','external_bookings'])db.exec(`CREATE TABLE ${name}(${cols});`);
 const s=store(),cache={'20 example street, waitara':{...CENTRES.waitara,label:'20 Example Street, Waitara'}};
 const record={savedAt:100,runCount:1,data:{naki_pickup_runs_v1:JSON.stringify(s),naki_geocache_v10:JSON.stringify(cache)}};
 db.prepare('INSERT INTO run_backups VALUES(?,?,?,NULL)').run('backup:test',100,JSON.stringify(record));
 for(const id of ['WEB-A','WEB-B'])db.prepare(`INSERT INTO bookings(id,status,updated_at,first_name,street_address,town,items_json,total_cents) VALUES(?,'NEW',100,'Synthetic booking','20 Example Street','Waitara','["Fridge"]',2000)`).run(id);
 let hook=null,failWrite=false,maxBindings=0;
 const env={CUSTOMER_DB:{prepare(sql){const q=db.prepare(sql);return {bind(...args){maxBindings=Math.max(maxBindings,args.length);return {first:async()=>q.get(...args)||null,all:async()=>({results:q.all(...args)}),run:async()=>{if(sql.startsWith('UPDATE run_backups')){if(hook)hook();if(failWrite)throw Error('Synthetic database outage');}return {meta:{changes:Number(q.run(...args).changes)}}}}},all:async()=>({results:q.all()})};}},REMINDERS:{put:async()=>{}}};
 return {db,env,record,store:s,key:'backup:test',hook:fn=>hook=fn,failWrite:value=>failWrite=value,maxBindings:()=>maxBindings};
}
async function proposal(f){const p=await previewSuggestions(f.env,f.key,{runStamp:runStamp(f.store),options},{weather:async loc=>({...loc,...wx().towns[0],name:loc.name})});const group=p.groups[0];return {preview:p,body:{id:p.id+'-0',createdAt:p.createdAt,baseSavedAt:p.baseSavedAt,runStamp:p.runStamp,group:{...group,townOnlyConfirmed:true},options:p.options,revisions:Object.fromEntries(p.bookings.map(b=>[b.id,b.revision]))}};}
test('preview queries real SQL without writes; weather receives only public town centres',async t=>{
 const f=fixture(t),sent=[];await previewSuggestions(f.env,f.key,{runStamp:runStamp(f.store),options},{weather:async loc=>{sent.push(loc);throw Error('Synthetic unavailable');}});
 assert.equal(f.db.prepare('SELECT saved_at FROM run_backups').get().saved_at,100);assert.equal(f.db.prepare('SELECT count(*) n FROM run_backups').get().n,1);assert.equal(f.db.prepare('SELECT count(*) n FROM owner_booking_notes').get().n,0);
 assert.deepEqual(Object.keys(sent[0]).sort(),['lat','lng','name']);assert.equal(sent[0].lat,CENTRES.waitara.lat);
});
test('approval all-or-nothing; promises and booking statuses unchanged; audit and previous snapshot retained',async t=>{
 const f=fixture(t),{body}=await proposal(f),before=f.db.prepare('SELECT * FROM bookings').all();
 const out=await approveSuggestions(f.env,f.key,body),s=JSON.parse(out.record.data.naki_pickup_runs_v1);assert.equal(s.runs.length,2);assert.equal(s.runs[1].data.stops.length,2);assert.equal(s.shared.runSuggestionAudit[0].type,'accepted');assert.deepEqual(f.db.prepare('SELECT * FROM bookings').all(),before);assert.equal(JSON.parse(f.db.prepare('SELECT previous_json FROM run_backups').get().previous_json).savedAt,100);
});
test('duplicate click and lost-response retry replay one group, mismatched retry refused',async t=>{
 const f=fixture(t),{body}=await proposal(f);await approveSuggestions(f.env,f.key,body);const repeat=await approveSuggestions(f.env,f.key,body);assert.equal(repeat.replayed,true);assert.equal(JSON.parse(repeat.record.data.naki_pickup_runs_v1).runs.length,2);
 await assert.rejects(approveSuggestions(f.env,f.key,{...body,group:{...body.group,day:day(1)}}),/different approval/);
});
test('stale run, changed/cancelled/completed booking and changed owner notes refuse the group',async t=>{
 for(const change of [f=>f.db.exec('UPDATE run_backups SET saved_at=200'),f=>f.db.exec("UPDATE bookings SET status='CANCELLED',updated_at=200"),f=>f.db.exec("UPDATE bookings SET status='COMPLETED',updated_at=200"),f=>f.db.exec("INSERT INTO owner_booking_notes VALUES('WEB-A','Changed access',200)")]){
  const f=fixture(t),{body}=await proposal(f);change(f);await assert.rejects(approveSuggestions(f.env,f.key,body),/changed/);const s=JSON.parse(JSON.parse(f.db.prepare('SELECT record_json FROM run_backups').get().record_json).data.naki_pickup_runs_v1);assert.equal(s.runs.length,1);
 }
});
test('last-moment booking and note races checked inside atomic write',async t=>{
 for(const change of [f=>f.db.exec("UPDATE bookings SET status='CANCELLED',updated_at=200 WHERE id='WEB-A'"),f=>f.db.exec("INSERT INTO owner_booking_notes VALUES('WEB-A','Changed',200)")]){
 const f=fixture(t),{body}=await proposal(f);f.hook(()=>change(f));await assert.rejects(approveSuggestions(f.env,f.key,body),/changed while approving/);assert.equal(f.db.prepare('SELECT saved_at FROM run_backups').get().saved_at,100);
 }
});
test('database partial failure changes nothing; KV mirror failure does not undo accepted D1 group',async t=>{
 const f=fixture(t),{body}=await proposal(f);f.failWrite(true);await assert.rejects(approveSuggestions(f.env,f.key,body),/outage/);assert.equal(f.db.prepare('SELECT saved_at FROM run_backups').get().saved_at,100);f.failWrite(false);f.env.REMINDERS.put=async()=>{throw Error('Mirror outage')};const out=await approveSuggestions(f.env,f.key,body);assert.ok(out.record.savedAt>100);
});
test('expired preview and local/account mismatch require fresh suggestions',async t=>{
 const f=fixture(t),{body}=await proposal(f);await assert.rejects(approveSuggestions(f.env,f.key,{...body,createdAt:Date.now()-31*60000}),/expired/);await assert.rejects(previewSuggestions(f.env,f.key,{runStamp:'different',options}),/different runs/);
});
test('endpoint returns error rather than partial success and does not expose internals',async t=>{
 const f=fixture(t),res=await handleRunSuggestions(new Request('https://example.test/owner/run-suggestions/approve',{method:'POST',body:'{'}),f.env,f.key,'/owner/run-suggestions/approve',(_r,data,status=200)=>Response.json(data,{status}));assert.equal(res.status,503);assert.equal((await res.json()).error,'Suggestions could not be saved or loaded. Refresh and retry.');
});
test('50-booking group stays within D1 parameter limits and is applied once',async t=>{
 const f=fixture(t);for(let i=0;i<48;i++)f.db.prepare(`INSERT INTO bookings(id,status,updated_at,street_address,town,items_json) VALUES(?,'NEW',100,'20 Example Street','Waitara','["Fridge"]')`).run('WEB-'+i);
 const opt={...options,maxPickups:50,maxItems:60,serviceMinutes:1};const p=await previewSuggestions(f.env,f.key,{runStamp:runStamp(f.store),options:opt},{weather:async()=>{throw Error('Unavailable')}});assert.equal(p.groups[0].bookingIds.length,50);
 const out=await approveSuggestions(f.env,f.key,{id:p.id+'-0',createdAt:p.createdAt,baseSavedAt:p.baseSavedAt,runStamp:p.runStamp,group:p.groups[0],options:p.options,revisions:Object.fromEntries(p.bookings.map(b=>[b.id,b.revision]))});assert.equal(JSON.parse(out.record.data.naki_pickup_runs_v1).runs[1].data.stops.length,50);assert.ok(f.maxBindings()<=100);
});
test('local cached pins are accepted only for the current address; audit contains no address',async t=>{
 const f=fixture(t),{body}=await proposal(f);body.pins={'WEB-A':{...CENTRES.waitara,label:'20 Example Street, Waitara',addressKey:'Wrong address|Waitara'}};await assert.rejects(approveSuggestions(f.env,f.key,body),/pin no longer matches/);
 body.pins['WEB-A'].addressKey='20 Example Street|Waitara';const out=await approveSuggestions(f.env,f.key,body);const audit=JSON.parse(out.record.data.naki_pickup_runs_v1).shared.runSuggestionAudit;assert.equal(JSON.stringify(audit).includes('Example Street'),false);assert.equal(audit[0].requestStamp.length,64);
});
test('pending completion and legacy external alias cannot be assigned twice',()=>{
 const s=store();s.shared.pendingDirectStatuses={'A':'COMPLETED'};s.runs[0].data.stops=[{id:'legacy',src:'sheet',submission_id:'legacy-booking',historyBookingKey:'pickup:legacy-booking',status:'DONE',...CENTRES.waitara}];const r=buildGroups({store:s,bookings:[booking('A'),booking('PICKUP-B','Waitara',{externalKey:'pickup:legacy-booking'})],options});assert.equal(r.groups.length,0);assert.equal(r.held.length,2);
});
test('real migration chain supports preview/approval; owner login required and integration keys refused',async t=>{
 const f=fixture(t);f.db.exec('DROP TABLE bookings;DROP TABLE jotform_bookings;DROP TABLE external_bookings;DROP TABLE owner_booking_notes;DROP TABLE run_backups;');
 for(const file of fs.readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort())f.db.exec(fs.readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 f.db.prepare('INSERT INTO run_backups(owner_key,saved_at,record_json) VALUES(?,?,?)').run(f.key,100,JSON.stringify(f.record));
 const data={id:'WEB-A',status:'NEW',updated_at:100,created_at:100,first_name:'Synthetic',last_name:'Example',phone:'',email:'sample@example.test',street_address:'20 Example Street',town:'Waitara',rural_option:'',items_json:'["Fridge"]'};
 const cols=Object.keys(data);f.db.prepare(`INSERT INTO bookings(${cols.join(',')}) VALUES(${cols.map(()=>'?').join(',')})`).run(...Object.values(data));
 const {body}=await proposal(f);assert.ok((await approveSuggestions(f.env,f.key,body)).record);
 const {handlePortalRequest}=await import('../src/customer.js'),path='/owner/run-suggestions/approve',json=(_r,data,status=200)=>Response.json(data,{status});
 const request=()=>new Request('https://example.test'+path,{method:'POST',body:JSON.stringify(body)});
 const unauth=await handlePortalRequest({request:request(),path,env:f.env,json});assert.equal(unauth.status,401);
 const bot=await handlePortalRequest({request:request(),path,env:f.env,json,integrationSession:{role:'owner'}});assert.equal(bot.status,403);
});
test('existing stop promise must fit the selected run day',()=>{
 const s=store();s.runs[0].data.stops=[{id:'promised',town:'Waitara',status:'NEW',appliances:['Fridge'],confirmedPickupDate:day(3),...CENTRES.waitara}];
 const opt={...options,targetRunId:'r1'};assert.equal(buildGroups({store:s,bookings:[booking('A')],options:opt}).groups.length,0);
 assert.throws(()=>validateGroup({store:s,bookings:[booking('A')],options:opt,group:{runId:'r1',day:day(1),bookingIds:['A']}}),/different confirmed day/);
});
