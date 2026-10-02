const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
const origin=process.env.NAKI_PUBLIC_ORIGIN||'https://pickup.test',root=path.resolve(__dirname,'..');
const booking=(id,status='COMPLETED')=>({id,status,firstName:'Finished',lastName:id,items:['Fridge'],total:20,pickupDate:'2026-09-23',createdAt:'2026-09-01T00:00:00Z',documents:[]});
(async()=>{
 const browser=process.env.NAKI_BROWSER==='webkit'?await webkit.launch({headless:true}):await chromium.launch({channel:'msedge',headless:true});
 try{for(const width of [320,390,1280]){
  const page=await browser.newPage({viewport:{width,height:950},serviceWorkers:'block'}),errors=[];let patches=0,failPatch=false,requests=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.origin===origin){
    if(process.env.NAKI_PUBLIC_ORIGIN)return route.continue();
    const target=path.resolve(root,url.pathname==='/'?'index.html':url.pathname.slice(1));
    if(!target.startsWith(root+path.sep)||!fs.existsSync(target))return route.fulfill({status:404,body:''});
    return route.fulfill({body:fs.readFileSync(target),contentType:/\.m?js$/.test(target)?'text/javascript':target.endsWith('.css')?'text/css':target.endsWith('.png')?'image/png':'text/html'});
   }
   let response={bookings:[],customers:[],documents:[]},status=200;
   if(url.pathname.endsWith('/owner/bookings')){
    requests.push(url.search);response=url.searchParams.get('offset')==='300'?{bookings:[booking('WEB-old')],hasMore:false}:{bookings:[booking('WEB-finished'),booking('WEB-waiting','NEW')],hasMore:!url.searchParams.has('q'),nextOffset:300};
   }else if(route.request().method()==='PATCH'){
    patches++;status=failPatch?503:200;response=failPatch?{error:'Offline test'}:{booking:booking('WEB-waiting')};
   }
   return route.fulfill({status,contentType:'application/json',body:JSON.stringify(response)});
  });
  await page.goto(origin+'/',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>typeof syncBookingChangesIntoRuns==='function');
  await page.evaluate(()=>{
   ownerToken='synthetic-test';cloudBackupBusy=true;document.body.dataset.view='today';
   const stops=[{id:'finished',src:'direct',submission_id:'WEB-finished',first_name:'Finished',street:'20 Example Street',town:'Waitara',appliances:['Fridge'],amount:25,note:'Keep this',status:'NEW',lat:-39.055,lng:174.075},{id:'old',src:'direct',submission_id:'WEB-old',first_name:'Older',street:'10 Example Street',town:'Waitara',appliances:['Fridge'],status:'NEW',lat:-39.055,lng:174.075}];
   state.stops=stops;state.bad=[];state.messageSelectedIds=['finished','old'];
   runStore.shared.pendingDirectCompletions=[];runStore.shared.pendingDirectStatuses={};
   runStore.runs=[{id:runStore.activeRunId,name:'First',data:state},{id:'other',name:'Other',data:{stops:[{...stops[0],id:'other-finished'}],bad:[],messageSelectedIds:[]}}];render();
  });
  await page.evaluate(()=>loadDirectBookings(true));
  assert.equal(await page.locator('#pendingList .stop').count(),0,'Finished stops disappear from pending Scheduled');
  assert.match(await page.locator('.completed-pickups > summary').innerText(),/Completed \(2\)/);
  await page.locator('.completed-pickups > summary').click();assert.equal(await page.locator('#doneList .stop').count(),2);
  assert.equal(await page.evaluate(()=>runStore.runs[1].data.stops[0].status),'DONE');
  assert.equal(await page.evaluate(()=>state.stops[0].amount),25);assert.equal(await page.evaluate(()=>state.stops[0].note),'Keep this');
  assert.ok(requests.some(search=>search.includes('offset=300')),'Old run bookings outside the first page are checked');
  await page.evaluate(()=>{state.stops[0].status='NEW';state.stops[0].historyStatus='CONFIRMED';});
  await page.evaluate(()=>loadDirectBookings(false));assert.equal(await page.evaluate(()=>state.stops[0].status),'DONE','Identical booking response repairs a restored run');
  await page.evaluate(()=>{document.body.dataset.view='bookings';bookingStage='done';renderDirectBookings();});
  assert.match(await page.locator('#directBookingList').innerText(),/Finished/);
  await page.evaluate(()=>{state.stops.push({id:'waiting',src:'direct',submission_id:'WEB-waiting',status:'NEW',street:'30 Example Street',town:'Waitara',appliances:['Fridge'],amount:20});});
  failPatch=true;await page.evaluate(()=>completeDirectBooking('WEB-waiting'));assert.equal(await page.evaluate(()=>state.stops.find(s=>s.id==='waiting').status),'NEW','Failed completion leaves the stop untouched');
  failPatch=false;await page.evaluate(()=>completeDirectBooking('WEB-waiting'));assert.equal(await page.evaluate(()=>state.stops.find(s=>s.id==='waiting').status),'DONE','Booking-card completion settles its run immediately');
  assert.equal(patches,2);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);assert.deepEqual(errors,[]);
  await page.close();
 }console.log('PASS: completed/restored/older-page pickups, all runs, actual Scheduled and Done UI, prices/notes, failed and successful completion, no runtime errors or overflow at 320/390/1280px');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
