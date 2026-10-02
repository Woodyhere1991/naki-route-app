const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const html=fs.readFileSync('index.html','utf8');
function extract(name){let start=html.indexOf('function '+name+'(');assert(start>=0,name);if(html.slice(start-6,start)==='async ')start-=6;return html.slice(start,html.indexOf('\n}',start)+2);}
for(const match of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)){if(match[2].trim()&&!/type=["']module/.test(match[1]))new vm.Script(match[2]);}
function setup(){
 const state={stops:[],bad:[],messageSelectedIds:[]};
 const context={state,runStore:{activeRunId:'active',runs:[{id:'active',name:'Active',data:state},{id:'other',name:'Other',data:{stops:[],bad:[]}}],shared:{}},ownerToken:'owner',saves:0,renders:0,
  save(){context.saves++},render(){context.renders++},drawRoute(){},historyBookingKey:s=>s.externalKey||'',isCollected:s=>Boolean(s.collectedAt||s.receiptSent||s.historyStatus==='COMPLETED')};
 vm.createContext(context);
 for(const name of ['bookingPriceFor','stopIsFinished','stopBelongsToBooking','syncBookingChangesIntoRuns','loadMissingRunBookings'])vm.runInContext(extract(name),context);
 return context;
}
const booking={id:'WEB-done',status:'COMPLETED',firstName:'Finished',items:['Fridge'],total:20,pickupDate:'2026-09-23'};
const stop={id:'stop',submission_id:booking.id,status:'NEW',historyStatus:'CONFIRMED',appliances:['Fridge'],amount:25,note:'Keep this',phone:'0212345678',lat:-39,lng:174};
(async()=>{
 const c=setup();c.state.stops=[structuredClone(stop)];c.state.messageSelectedIds=['stop','waiting'];
 c.runStore.runs[1].data.stops=[{...stop,id:'twin',paid:false,invoiceSent:true,invoiceStage:'before'}];
 c.runStore.runs[1].data.bad=[{...stop,id:'bad'}];
 c.state.stops.push({...stop,id:'other-booking',submission_id:'WEB-another'});
 const result=c.syncBookingChangesIntoRuns([booking]);assert.equal(result.completions.length,3);
 for(const run of c.runStore.runs){for(const s of run.data.stops.filter(s=>s.submission_id===booking.id)){
  assert.equal(s.status,'DONE');assert.equal(s.historyStatus,'COMPLETED');assert.equal(s.confirmedPickupDate,'2026-09-23');
  assert.equal(s.amount,25);assert.equal(s.note,'Keep this');assert.equal(s.lat,-39);assert.equal(s.phone,'0212345678');assert.equal(s.collectedAt,undefined,'No invented collection timestamp');
 }}
 assert.equal(c.runStore.runs[1].data.bad.length,0);assert.equal(c.runStore.runs[1].data.stops[0].paid,false,'Completion does not claim payment');
 assert.equal(c.state.stops[1].status,'NEW');assert.deepEqual(Array.from(c.state.messageSelectedIds),['waiting']);
 const saves=c.saves;assert.equal(c.syncBookingChangesIntoRuns([booking]).completions.length,0);assert.equal(c.saves,saves,'Repeated refresh is idempotent');
 const undo=setup();undo.state.stops=[structuredClone(stop)];undo.runStore.shared.pendingDirectStatuses={'WEB-done':'ADDED_TO_RUN'};
 undo.syncBookingChangesIntoRuns([booking]);assert.equal(undo.state.stops[0].status,'NEW','Queued Undo survives a stale completed response');
 const existing=setup();existing.state.stops=[{...stop,status:'NEW',receiptSent:true}];existing.syncBookingChangesIntoRuns([booking]);assert.equal(existing.state.stops[0].status,'DONE','Finished payment flags cannot leave a pickup pending');
 const paged=setup();paged.state.stops=[{...stop,invoiceSent:true,invoiceStage:'before'}];let requests=[];
 paged.ownerApi=async path=>{requests.push(path);return requests.length===1?{bookings:[],hasMore:true,nextOffset:300}:{bookings:[booking],hasMore:false}};
 assert.equal((await paged.loadMissingRunBookings([],'owner'))[0].id,booking.id);assert.deepEqual(requests,['/owner/bookings?offset=0','/owner/bookings?offset=300']);
 paged.syncBookingChangesIntoRuns([booking]);requests=[];await paged.loadMissingRunBookings([],'owner');assert.equal(requests.length,0,'Settled runs do not load older pages');
 const changed=setup();changed.state.stops=[structuredClone(stop)];changed.ownerApi=async()=>{changed.ownerToken='different';return {bookings:[booking]}};
 await assert.rejects(()=>changed.loadMissingRunBookings([],'owner'),/sign-in changed/);
 const failed=setup();failed.state.stops=[structuredClone(stop)];failed.ownerApi=async()=>{throw Error('offline')};
 await assert.rejects(()=>failed.loadMissingRunBookings([],'owner'),/offline/);assert.equal(failed.state.stops[0].status,'NEW');
 console.log('PASS: completion across all runs, restored stops, exact identity, notes/prices/payment preservation, needs-address, message selection, queued Undo, repeat refresh, older pages, sign-out and offline protection');
})().catch(error=>{console.error(error);process.exitCode=1});
