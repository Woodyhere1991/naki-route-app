const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),origin=process.env.NAKI_PUBLIC_ORIGIN||'https://pickup.test';
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{for(const width of [320,390,1280]){
  const page=await browser.newPage({viewport:{width,height:950},serviceWorkers:'block'}),errors=[],sends=[],reads=[],moves=[];
  let failPage=false,failMail=true,holdMove,failMove=false,review='';
  const rows=[
   {id:'WEB-waiting-123',firstName:'Waiting',phone:'0491 570 159',email:'waiting@example.test',streetAddress:'1 Example Street',town:'Waitara',status:'NEW'},
   {id:'JOTFORM-scheduled-123',firstName:'Scheduled',phone:'0212222222',email:'scheduled@example.test',streetAddress:'2 Example Street',town:'Waitara',status:'CONFIRMED',pickupDate:'2026-11-01'},
   {id:'WEB-finished-123',firstName:'Finished',email:'finished@example.test',status:'COMPLETED'},
   {id:'WEB-cancelled-123',firstName:'Cancelled',email:'cancelled@example.test',status:'CANCELLED'},
   {id:'PHONE-later-123',firstName:'Later page',email:'later@example.test',status:'NEW'},
   {id:'WEB-duplicate-123',firstName:'Second booking',phone:'+61 491 570 159',email:'WAITING@example.test',status:'NEW'}
  ];
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',async d=>{if(d.type()==='confirm')review=d.message();await d.accept();});
  await page.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());
   if(url.origin===origin){
    if(process.env.NAKI_PUBLIC_ORIGIN)return route.continue();
    const target=path.resolve(root,url.pathname==='/'?'index.html':url.pathname.slice(1));
    if(!target.startsWith(root+path.sep)||!fs.existsSync(target))return route.fulfill({status:404,body:''});
    return route.fulfill({body:fs.readFileSync(target),contentType:/\.m?js$/.test(target)?'text/javascript':target.endsWith('.css')?'text/css':target.endsWith('.png')?'image/png':'text/html'});
   }
   let data={bookings:[],customers:[],documents:[],hasMore:false},status=200;
   if(url.pathname.endsWith('/owner/bookings')){
    const offset=Number(url.searchParams.get('offset')||0);reads.push({offset,q:url.searchParams.get('q')});
    if(offset===300&&failPage){status=503;data={error:'Synthetic second page failed'};}
    else data={bookings:offset===300?rows.slice(4):rows.slice(0,4),hasMore:offset===0,nextOffset:offset===0?300:302};
   }
   if(url.pathname.endsWith('/send-bulk')){
    const body=req.postDataJSON();sends.push(body);
    await new Promise(r=>setTimeout(r,150));
    const accepted=body.messages.filter(m=>!(failMail&&m.to==='later@example.test')).map(m=>m.to.toLowerCase());
    data={ok:true,sent:accepted.length,sentTo:accepted};
   }
   if(url.pathname.endsWith('/unschedule')){
    moves.push(url.pathname);if(holdMove)await holdMove;
    status=failMove?503:200;data=failMove?{error:'Synthetic move failed'}:{ok:true,booking:{...rows[1],status:'NEW',pickupDate:'',pickupWindow:''}};
   }
   assert(!url.pathname.includes('bulk-confirm'),'Booking updates never confirm pickup dates');
   return route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
  });
  await page.goto(origin+'/',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>typeof window.bulkSend==='function');
  assert.equal(await page.locator('#suggestRuns, #suggestThisRun, #runSuggestionsDialog').count(),0,'Suggestion controls removed');
  assert.equal(await page.evaluate(()=>typeof window.nakiRunSuggestions),'undefined','Suggestion feature no longer loads');
  await page.evaluate(()=>{
   ownerToken='synthetic';cloudBackupBusy=true;clearTimeout(cloudBackupTimer);bookingSearchText='would hide unscheduled';
   state.stops=[];state.bad=[];state.unpaid=[];state.confirmationDate='2020-01-01';state.messageHistory={};
   runStore.shared={};runStore.runs=[{id:'active',name:'Active',data:state},{id:'other',name:'Other run',data:{stops:[{id:'sheet',first_name:'Sheet pickup',phone:'0213333333',email:'sheet@example.test',street:'3 Example Street',town:'Waitara',status:'NEW',appliances:['Fridge']}],bad:[]}}];runStore.activeRunId='active';
   document.body.dataset.view='messages';renderContacts();
  });
  assert.match(await page.locator('#contactsWrap').innerText(),/All bookings/,'Scope is available on an empty run');
  failPage=true;await page.getByRole('button',{name:'All bookings',exact:true}).click();
  await page.waitForFunction(()=>!bookingMessageLoading);assert.match(await page.locator('#contactsWrap').innerText(),/second page failed/);
  assert.equal(await page.locator('[data-recipient]').count(),0,'Failed paging never publishes a partial list');
  failPage=false;await page.getByRole('button',{name:'Refresh all bookings',exact:true}).click();await page.waitForFunction(()=>!bookingMessageLoading);
  assert.equal(await page.locator('[data-recipient]').count(),5,'All active bookings plus an unlinked pickup on another run');
  assert(reads.some(r=>r.offset===300&&r.q===null),'Loads all pages without inheriting the Bookings search');
  await page.getByLabel('Include completed, cancelled and declined bookings').check();assert.equal(await page.locator('[data-recipient]').count(),7);
  await page.getByLabel('Include completed, cancelled and declined bookings').uncheck();
  await page.getByRole('button',{name:'Select all',exact:true}).click();
  await page.locator('[data-recipient="booking:JOTFORM-scheduled-123"]').uncheck();
  await page.locator('#messagePreview').fill("Hey Woody here. I'm injured and pickups are delayed. Thanks for your patience.");
  assert.equal(await page.locator('#selectedCount').innerText(),'4 selected customers','Editing retains explicit deselections');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,width+'px overflow');
  await page.screenshot({path:path.join(root,'output','booking-messages-'+width+'.png')});
  await page.evaluate(()=>{const b=document.getElementById('bulkSendButton');b.click();b.click();});
  await page.waitForFunction(()=>!bulkSendBusy);assert.equal(sends.length,1,'Repeat taps send only once');
  assert.equal(sends[0].subject,'Whiteware collection update');assert.equal(sends[0].messages.length,3,'One email per address');
  assert(!sends[0].messages.some(m=>m.to==='scheduled@example.test'),'Unticked booking omitted');
  assert.match(review,/I'm injured/);assert.match(review,/waiting@example.test/,'Full draft and recipients shown before send');
  assert.equal(await page.evaluate(()=>state.confirmationDate),'2020-01-01','Old collection dates do not block or change the update');
  assert.equal(await page.evaluate(()=>batchPhoneNumbers({recipients:selectedRecipients()}).length),2,'One text per number');
  assert.match(await page.locator('#bulkSendStatus a').getAttribute('href'),/^sms:\+61491570159;0213333333\?body=/,'Australian mobile included once with +61 in the real text handoff');
  failMail=false;await page.locator('#bulkSendButton').click();await page.waitForFunction(()=>!bulkSendBusy);
  assert.equal(sends.length,2);assert.deepEqual(sends[1].messages.map(m=>m.to),['later@example.test'],'Retry skips successful emails');
  await page.getByRole('button',{name:'Select new only',exact:true}).click();assert.equal(await page.locator('#selectedCount').innerText(),'1 selected customer');
  await page.getByRole('button',{name:'Unselect all',exact:true}).click();assert.equal(await page.locator('#selectedCount').innerText(),'0 selected customers');
  await page.evaluate(()=>saveMessageDraft('A different update'));assert.equal(await page.evaluate(()=>selectedRecipients().length),0,'Changed wording preserves deselection');
  await page.getByRole('button',{name:'Select new only',exact:true}).click();assert.equal(await page.locator('#selectedCount').innerText(),'5 selected customers','New wording has separate delivery marks');
  // Check the existing confirmation mode still offers its collection date.
  await page.getByRole('button',{name:'Active run',exact:true}).click();
  await page.evaluate(()=>{state.stops=[{id:'scheduled',src:'direct',submission_id:'JOTFORM-scheduled-123',first_name:'Scheduled',street:'2 Example Street',town:'Waitara',phone:'0212222222',email:'scheduled@example.test',status:'NEW',confirmedPickupDate:'2026-11-01',appliances:['Fridge'],lat:-39.05,lng:174.07}];state.bad=[];directBookingRows=[{id:'JOTFORM-scheduled-123',status:'CONFIRMED',pickupDate:'2026-11-01'}];renderContacts();});
  assert.equal(await page.locator('#contactsWrap input[type=date]').count(),1,'Active-run confirmation retained');
  await page.evaluate(()=>{document.body.dataset.view='today';render();});
  let release;holdMove=new Promise(r=>release=r);
  await page.evaluate(()=>{sendAllBackToBookings();sendAllBackToBookings();});
  await page.waitForFunction(()=>document.querySelector('#returnBookingsStatus').textContent.includes('Moving 1 of 1'));
  assert.equal(await page.locator('#sendBackBookings').isDisabled(),true,'Move locks immediately');
  assert.equal(await page.locator('#sendBackBookings').getAttribute('aria-busy'),'true');
  await page.waitForFunction(()=>returnBookingsBusy);await new Promise(r=>setTimeout(r,200));assert.equal(moves.length,1,'Repeat move taps do not duplicate requests');
  failMove=true;release();await page.waitForFunction(()=>!returnBookingsBusy);assert.equal(await page.evaluate(()=>state.stops.length),1,'Failure keeps pickup for retry');
  assert.equal(await page.locator('#sendBackBookings').isDisabled(),false);
  failMove=false;holdMove=null;await page.evaluate(()=>{document.getElementById('runActions').hidden=false});await page.locator('#sendBackBookings').click();await page.waitForFunction(()=>!returnBookingsBusy);assert.equal(await page.evaluate(()=>state.stops.length),0,'Retry moves pickup');
  assert.deepEqual(errors,[]);await page.close();
 }
 console.log('PASS: complete unfiltered paging, failed-page recovery, all-run Sheet coverage, include past, selection/edit persistence, channel dedupe, full review, rapid-tap guard, email retry, date isolation, existing confirmation, immediate move progress and failure/retry at 320/390/1280px.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
