const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium,webkit}=require(process.env.NAKI_PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),origin=process.env.NAKI_PUBLIC_ORIGIN||'https://pickup.test';
const makeBooking=(id,status='NEW',extra={})=>({id,status,firstName:'Receipt',lastName:'Example',email:'example@example.test',phone:'0212345678',streetAddress:'20 Example Street',town:'Waitara',items:['Fridge','Microwave'],total:20,createdAt:new Date().toISOString(),documents:[],...extra});
(async()=>{
 const browser=process.env.NAKI_BROWSER==='webkit'?await webkit.launch({headless:true}):await chromium.launch({channel:'msedge',headless:true});
 try{for(const width of [320,390,1280]){
  const context=await browser.newContext({viewport:{width,height:950},serviceWorkers:'block'}),page=await context.newPage();
  const bookings=[makeBooking('WEB-receipt-test'),makeBooking('JOTFORM-receipt-test','COMPLETED'),makeBooking('PICKUP-receipt-test','ADDED_TO_RUN'),makeBooking('WEB-no-email','NEW',{email:''}),makeBooking('WEB-quote','NEW',{quoteRequired:true,total:0})];
  const errors=[],sent=[],cancelled=[],patches=[];let failSend=false;
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',dialog=>dialog.dismiss());
  await page.route('**/*',async route=>{
   const u=new URL(route.request().url());
   if(u.origin===origin){
    if(process.env.NAKI_PUBLIC_ORIGIN)return route.continue();
    const target=path.resolve(root,u.pathname==='/'?'index.html':u.pathname.slice(1));
    if(!target.startsWith(root+path.sep)||!fs.existsSync(target))return route.fulfill({status:404,body:''});
    return route.fulfill({body:fs.readFileSync(target),contentType:/\.m?js$/.test(target)?'text/javascript':target.endsWith('.png')?'image/png':target.endsWith('.css')?'text/css':'text/html'});
   }
   const body=route.request().postDataJSON();
   if(u.pathname.endsWith('/send-receipt')){
    sent.push({body,headers:route.request().headers()});
    if(failSend)return route.fulfill({status:502,contentType:'application/json',body:'{"error":"Email could not be sent"}'});
    const b=bookings.find(b=>b.id===body.bookingId);assert.ok(b);
    b.documents.push({id:'doc-'+sent.length,kind:'RECEIPT',amount:body.amount,createdAt:new Date().toISOString(),hasPdf:true});
    await new Promise(resolve=>setTimeout(resolve,80));
    return route.fulfill({contentType:'application/json',body:'{"ok":true}'});
   }
   if(u.pathname.endsWith('/cancel-reminder'))cancelled.push(body.id);
   if(u.pathname.includes('/owner/bookings/')&&route.request().method()==='PATCH'){
    const id=decodeURIComponent(u.pathname.split('/').pop());patches.push(id);Object.assign(bookings.find(b=>b.id===id),body);
   }
   if(u.pathname.endsWith('/owner/bookings'))return route.fulfill({contentType:'application/json',body:JSON.stringify({bookings})});
   if(u.pathname.endsWith('/customer/profile-invite'))return route.fulfill({contentType:'application/json',body:'{"url":"https://nakiwhitewareremoval.vip/account.html","hasProfile":true}'});
   return route.fulfill({contentType:'application/json',body:'{"ok":true,"bookings":[],"customers":[],"documents":[]}'});
  });
  await page.goto(origin+'/',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.nakiEarnings);
  await page.evaluate(rows=>{
   ownerToken='synthetic-owner';bookingStage='all';state.stops=[];state.bad=[];state.unpaid=[];
   runStore.runs=[{id:'active',name:'Test run',data:state},{id:'other',name:'Other run',data:{stops:[{id:'linked-other-run',src:'direct',submission_id:'PICKUP-receipt-test',status:'NEW',amount:20,appliances:['Fridge','Microwave'],email:'example@example.test',street:'20 Example Street',town:'Waitara',reminderId:'other-reminder'}],bad:[]}}];
   runStore.activeRunId='active';runStore.shared={};directBookingRows=rows;
   runStore.runs[1].data.stops.push({...runStore.runs[1].data.stops[0],id:'another-pickup',submission_id:'PICKUP-different-booking',reminderId:'keep-this-reminder'});
   rememberBookingInvoice('WEB-receipt-test',{reminderId:'booking-reminder',reminderDate:'2026-10-08'});render();
  },bookings);
  await page.locator('.bottom-nav [data-view-button=bookings]').click();
  const openCards=()=>page.evaluate(()=>document.querySelectorAll('#directBookingList details').forEach(el=>el.open=true));
  const previewReady=()=>page.waitForFunction(()=>document.getElementById('receiptFrame').dataset.ready==='true'&&document.querySelector('#receiptFrame canvas'));
  await page.waitForTimeout(200);await openCards();
  assert.equal(await page.locator('[data-receipt-direct="WEB-receipt-test"]').innerText(),'🧾 Send receipt');
  await page.locator('[data-receipt-direct="WEB-receipt-test"]').click();await previewReady();
  assert.equal(sent.length,0,'Opening preview sends nothing');
  assert.equal(await page.evaluate(()=>state.stops.length),0,'Preview does not add a Scheduled stop');
  assert.equal(await page.evaluate(()=>directBookingRows[0].status),'NEW','Preview does not mark completed');
  assert.equal(await page.evaluate(()=>pendingBookingReceipts['WEB-receipt-test'].asStop.receiptAmount),20);
  await page.locator('#receiptIncludeReview').uncheck();await page.waitForFunction(()=>!document.getElementById('receiptIncludeReview').disabled);await previewReady();
  assert.equal(await page.evaluate(async()=>/g.page/.test(await pendingBookingReceipts['WEB-receipt-test'].file.text())),false);
  await page.locator('#receiptRedoBtn').click();await page.locator('#fm_amount').fill('25');await page.locator('#formModalSave').click();await previewReady();
  assert.equal(await page.locator('#receiptIncludeReview').isChecked(),false,'Changing the amount preserves review choice');
  await page.getByRole('button',{name:'Close',exact:true}).click();await openCards();
  assert.match(await page.locator('[data-receipt-direct="WEB-receipt-test"]').innerText(),/Receipt preview/);
  await page.locator('[data-receipt-direct="WEB-receipt-test"]').click();await previewReady();
  await page.evaluate(()=>Promise.all([sendReceipt('WEB-receipt-test'),sendReceipt('WEB-receipt-test')]));
  assert.equal(sent.length,1,'Duplicate taps send once');assert.equal(sent[0].body.amount,25);assert.equal(sent[0].body.includeReviewRequest,false);
  assert.equal(sent[0].body.bookingId,'WEB-receipt-test');assert.deepEqual(sent[0].body.items,['Fridge','Microwave']);assert.match(sent[0].body.address,/20 Example Street, Waitara/);
  assert.match(Buffer.from(sent[0].body.pdfBase64,'base64').toString(),/^%PDF/);assert.ok(sent[0].headers['idempotency-key']);
  assert.ok(patches.includes('WEB-receipt-test'));assert.ok(cancelled.includes('booking-reminder'));
  assert.equal(await page.evaluate(()=>state.stops.length),0,'Sending does not insert a Scheduled stop');
  await page.evaluate(()=>closeReceiptPreview());
  for(const id of ['JOTFORM-receipt-test','PICKUP-receipt-test']){
   await openCards();await page.locator(`[data-receipt-direct="${id}"]`).click();await previewReady();
   await page.locator('#receiptSendBtn').click();await page.waitForFunction(id=>!pendingBookingReceipts[id]&&!receiptSendBusy.has(id),id);
   assert.equal(sent.at(-1).body.bookingId,id);assert.ok(patches.includes(id));
  }
  assert.equal(await page.evaluate(()=>runStore.runs[1].data.stops[0].status),'DONE','Same booking in another run is completed');
  assert.equal(await page.evaluate(()=>runStore.runs[1].data.stops[0].receiptAmount),20);
  assert.ok(cancelled.includes('other-reminder'));
  assert.equal(await page.evaluate(()=>runStore.runs[1].data.stops[1].status),'NEW','Another job at the same address is untouched');
  assert.equal(cancelled.includes('keep-this-reminder'),false);
  await openCards();await page.locator('[data-receipt-direct="WEB-quote"]').click();await page.locator('#fm_amount').fill('30');await page.locator('#formModalSave').click();await previewReady();
  failSend=true;await page.locator('#receiptSendBtn').click();await page.waitForFunction(()=>!receiptSendBusy.has('WEB-quote'));
  assert.equal(await page.evaluate(()=>directBookingRows.find(b=>b.id==='WEB-quote').status),'NEW','Failed email leaves booking unfinished');
  assert.equal(await page.evaluate(()=>!!pendingBookingReceipts['WEB-quote']),true,'Failure keeps actual PDF for retry');
  const retryKey=sent.at(-1).headers['idempotency-key'];failSend=false;
  await page.evaluate(()=>openReceiptPreview('WEB-quote'));await previewReady();await page.locator('#receiptSendBtn').click();await page.waitForFunction(()=>!receiptSendBusy.has('WEB-quote'));
  assert.equal(sent.at(-1).headers['idempotency-key'],retryKey,'Ambiguous failures reuse the send reference');
  await openCards();await page.locator('[data-receipt-direct="WEB-no-email"]').click();await previewReady();assert.match(await page.locator('#receiptSendBtn').innerText(),/Send receipt/);
  await page.evaluate(()=>{Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>true});Object.defineProperty(navigator,'share',{configurable:true,value:async()=>{throw new DOMException('Cancelled','AbortError')}});});
  await page.locator('#receiptSendBtn').click();await page.waitForFunction(()=>!receiptSendBusy.has('WEB-no-email'));
  assert.equal(await page.evaluate(()=>directBookingRows.find(b=>b.id==='WEB-no-email').status),'NEW','Cancelled share does not mark paid');
  await page.evaluate(()=>openReceiptPreview('WEB-no-email'));await previewReady();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await page.evaluate(()=>document.getElementById('ownerLogout').click());
  assert.equal(await page.evaluate(()=>Object.keys(pendingBookingReceipts).length),0,'Sign-out clears private receipt drafts');
  assert.equal(await page.locator('#receiptFrame canvas').count(),0);assert.deepEqual(errors,[]);
  await context.close();
 }console.log('PASS: direct Bookings receipts at 320/390/1280px; actual PDF/review choice/amount; three booking sources; duplicate send guard; success, retry, reminders, linked runs, cancelled sharing and sign-out privacy.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
