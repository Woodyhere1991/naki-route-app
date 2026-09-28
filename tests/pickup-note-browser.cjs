const {chromium}=require('playwright'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
 for(const width of [390,1280]){
  let saved='';const page=await browser.newPage({viewport:{width,height:900},serviceWorkers:'block'});
  await page.route('**/*',route=>{
   const url=new URL(route.request().url());
   if(url.hostname==='pickup.test'){
    const rel=url.pathname==='/'?'index.html':url.pathname.slice(1),root=path.resolve(__dirname,'..'),target=path.resolve(root,rel);
    if(!target.startsWith(root+path.sep)||!fs.existsSync(target))return route.fulfill({status:404,body:''});
    return route.fulfill({status:200,contentType:target.endsWith('.js')?'text/javascript':target.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(target)});
   }
   if(/unpkg.com|cdnjs.cloudflare.com/.test(url.hostname))return route.continue();
   if(url.pathname.endsWith('/owner-note')){saved=JSON.parse(route.request().postData()).note;return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,note:saved})});}
   return route.fulfill({status:200,contentType:'application/json',body:'{"bookings":[],"customers":[],"documents":[]}'});
  });
  await page.goto('http://pickup.test/',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>typeof window.delStop==='function');
  await page.evaluate(()=>{
   ownerToken='synthetic-test';directBookingRows=[{id:'WEB-note-test',status:'NEW',firstName:'Test',lastName:'Customer',streetAddress:'12 Example Street',town:'Waitara',items:['Fridge'],total:20,ownerNote:'',createdAt:new Date().toISOString(),documents:[]}];
   state.stops=[{id:'stop-test',submission_id:'WEB-note-test',first_name:'Test',last_name:'Customer',street:'12 Example Street',town:'Waitara',appliances:['Fridge'],note:'After 10 October',status:'NEW',src:'direct'}];
   window.confirm=()=>true;
  });
  await page.evaluate(()=>window.delStop('stop-test'));assert.equal(saved,'After 10 October');
  assert.equal(await page.evaluate(()=>state.stops.length),0);
  await page.evaluate(()=>{document.body.dataset.view='bookings';renderDirectBookings();});
  await page.evaluate(()=>document.querySelectorAll('#directBookingList details').forEach(el=>el.open=true));
  assert.match(await page.locator('#directBookingList').innerText(),/After 10 October/);
  await page.evaluate(()=>{const details=document.querySelector('#directBookingList details');if(details)details.open=true;});
  assert.equal(await page.locator('[data-note-direct="WEB-note-test"]').count(),1);
  await page.close();
 }
 console.log('PASS: mobile/desktop Scheduled removal retains the note in the actual Bookings UI.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
