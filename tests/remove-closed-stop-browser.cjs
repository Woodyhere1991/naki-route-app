const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),origin=process.env.NAKI_PUBLIC_ORIGIN||'https://pickup.test';
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{for(const width of [390,1280]){
 const page=await browser.newPage({viewport:{width,height:950},serviceWorkers:'block'}),errors=[];let kind='missing',offline=false,requests=0;
 page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.origin===origin){
   if(process.env.NAKI_PUBLIC_ORIGIN)return route.continue();
   const target=path.resolve(root,url.pathname==='/'?'index.html':url.pathname.slice(1));if(!target.startsWith(root+path.sep)||!fs.existsSync(target))return route.fulfill({status:404,body:''});
   return route.fulfill({body:fs.readFileSync(target),contentType:/\.m?js$/.test(target)?'text/javascript':target.endsWith('.png')?'image/png':target.endsWith('.css')?'text/css':'text/html'});
  }
  let status=200,body={bookings:[],customers:[],documents:[]};
  if(url.pathname.endsWith('/owner-note')){status=kind==='missing'?404:200;body=status===404?{error:'Booking not found'}:{note:'Keep this cancellation note'};}
  if(url.pathname.endsWith('/unschedule')){requests++;status=offline?503:200;body=offline?{error:'Offline test'}:kind==='missing'?{ok:true,removedFromRun:true,missing:true}:{ok:true,removedFromRun:true,booking:{id:'WEB-cancelled',status:'CANCELLED',pickupDate:'2026-09-08'}};}
  return route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.goto(origin+'/',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>typeof window.delStop==='function');
 const setup=()=>page.evaluate(()=>{ownerToken='synthetic';cloudBackupBusy=true;directBookingRows=[];document.body.dataset.view='today';state.stops=[{id:'stale',src:'direct',submission_id:'WEB-cancelled',first_name:'Cancelled pickup',street:'12 Example Street',town:'Waitara',lat:-39.055,lng:174.075,appliances:['Fridge'],status:'NEW',note:'Keep this cancellation note',confirmedPickupDate:'2026-09-08'}];state.bad=[];render();});
 const remove=async()=>{if(!await page.locator('#pendingList .stop-more').evaluate(el=>el.open))await page.locator('#pendingList .stop-more > summary').click();await page.locator('#pendingList [title="Remove this stop"]').click();};
 await setup();offline=true;await remove();await page.waitForFunction(()=>removingStops.size===0);assert.equal(await page.locator('#pendingList .stop').count(),1,'Network failure retains the pickup');
 offline=false;await remove();await page.waitForFunction(()=>state.stops.length===0);assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('naki_booking_note_drafts_v1'))['WEB-cancelled']),'Keep this cancellation note');
 kind='cancelled';await setup();await remove();await page.waitForFunction(()=>state.stops.length===0);assert.equal(requests,3);assert.deepEqual(errors,[]);await page.close();
 }console.log('PASS: actual X button removes orphan and cancelled pickups at mobile/desktop widths, retains missing-booking notes, and keeps the card on offline failure until retry');}finally{await browser.close();}})().catch(error=>{console.error(error);process.exitCode=1});
