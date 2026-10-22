const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium,webkit}=require(process.env.NAKI_PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),origin=process.env.NAKI_PUBLIC_ORIGIN||'https://pickup.test';
const invoiceAt=Date.parse('2026-10-18T09:00:00Z');
const makeBooking=(id,extra={})=>({id,status:'CONFIRMED',firstName:'Shawn',lastName:'Redpath',email:'example@example.test',phone:'0212345678',streetAddress:'131 York Road',town:'New Plymouth',items:['Fridge'],total:35,createdAt:new Date(invoiceAt-86400000).toISOString(),documents:[],...extra});
const found={ok:true,exact:[{date:'2026-10-20T08:17:48.000Z',amount:35,payer:'Redpath,Shawn Shawn 131 York Rd',pending:true,matchedOn:['name','address']}],combined:[],otherAmounts:[],checkedFrom:'2026-10-04T09:00:00.000Z',cleared:9,pending:5};
const none={ok:true,exact:[],combined:[],otherAmounts:[{date:'2026-10-19T08:00:00.000Z',amount:20,payer:'Redpath S',pending:false,matchedOn:['name']}],checkedFrom:'2026-10-04T09:00:00.000Z',cleared:9,pending:5};
(async()=>{
 const browser=process.env.NAKI_BROWSER==='webkit'?await webkit.launch({headless:true}):await chromium.launch({channel:'msedge',headless:true});
 try{for(const width of [320,1280]){
  const context=await browser.newContext({viewport:{width,height:950},serviceWorkers:'block'}),page=await context.newPage();
  const bookings=[makeBooking('WEB-owing',{invoiceOwing:true,documents:[{id:'inv-1',kind:'INVOICE',amount:35,createdAt:invoiceAt,hasPdf:true}]}),makeBooking('WEB-paid',{firstName:'Paid',email:'paid@example.test',streetAddress:'9 Other Street',documents:[]}),
   makeBooking('WEB-run',{firstName:'Rua',lastName:'Runner',email:'rua@example.test',streetAddress:'7 Run Road',invoiceOwing:true,documents:[{id:'inv-2',kind:'INVOICE',amount:35,createdAt:invoiceAt,hasPdf:true}]})];
  const errors=[],checks=[],sent=[],payments=[],patches=[];let reply=found,status=200;
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',dialog=>dialog.accept());
  await page.route('**/*',async route=>{
   const u=new URL(route.request().url());
   if(u.origin===origin){
    if(process.env.NAKI_PUBLIC_ORIGIN)return route.continue();
    const target=path.resolve(root,u.pathname==='/'?'index.html':u.pathname.slice(1));
    if(!target.startsWith(root+path.sep)||!fs.existsSync(target))return route.fulfill({status:404,body:''});
    return route.fulfill({body:fs.readFileSync(target),contentType:/\.m?js$/.test(target)?'text/javascript':target.endsWith('.png')?'image/png':target.endsWith('.css')?'text/css':'text/html'});
   }
   if(u.pathname.endsWith('/owner/payment-check')){
    checks.push({body:route.request().postDataJSON(),auth:route.request().headers().authorization});
    await new Promise(resolve=>setTimeout(resolve,60));
    return route.fulfill({status,contentType:'application/json',body:JSON.stringify(reply)});
   }
   if(u.pathname.endsWith('/owner/payments')){
    const body=route.request().postDataJSON();payments.push(body);
    const b=bookings.find(b=>b.documents.some(d=>d.id===body.invoiceId));
    b.invoiceOwing=false;b.invoicePaid={at:Date.parse('2026-10-20T09:00:00Z'),amount:35};b.documents[0].paidAt=b.invoicePaid.at;
    return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,payment:{invoiceId:body.invoiceId,cents:3500}})});
   }
   if(route.request().method()==='PATCH')patches.push(route.request().postDataJSON());
   if(u.pathname.endsWith('/send-receipt'))sent.push(1);
   if(u.pathname.endsWith('/owner/bookings'))return route.fulfill({contentType:'application/json',body:JSON.stringify({bookings})});
   if(u.pathname.endsWith('/customer/profile-invite'))return route.fulfill({contentType:'application/json',body:'{"url":"https://nakiwhitewareremoval.vip/account.html","hasProfile":true}'});
   return route.fulfill({contentType:'application/json',body:'{"ok":true,"bookings":[],"customers":[],"documents":[]}'});
  });
  await page.goto(origin+'/',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.nakiEarnings);
  await page.evaluate(rows=>{
   ownerToken='synthetic-owner';bookingStage='all';state.bad=[];
   state.stops=[{id:'stop-run',src:'direct',submission_id:'WEB-run',first_name:'Rua',last_name:'Runner',street:'7 Run Road',town:'New Plymouth',lat:-39.06,lng:174.08,geoLabel:'7 Run Road, New Plymouth',status:'NEW',appliances:['Fridge'],amount:35}];
   state.unpaid=[{id:'local-1',first_name:'Lee',last_name:'Local',street:'5 Side Road',town:'Inglewood',email:'lee@example.test',phone:'',appliances:['Washing machine'],invoiceSent:true,invoiceAmount:20,amount:20,status:'NEW',paid:false,src:'manual',invoiceAt:Date.parse('2026-10-18T09:00:00Z')}];
   runStore.runs=[{id:'active',name:'Test run',data:state}];runStore.activeRunId='active';runStore.shared={};directBookingRows=rows;render();
  },bookings);
  await page.locator('.bottom-nav [data-view-button=bookings]').click();
  const openCards=()=>page.evaluate(()=>document.querySelectorAll('#directBookingList details').forEach(el=>el.open=true));
  await page.waitForTimeout(200);await openCards();
  assert.equal(await page.locator('[data-payment-check="WEB-paid"]').count(),0,'No button when nothing is owing');
  await page.locator('[data-payment-check="WEB-owing"]').click();
  await page.waitForSelector('#directBookingList [data-booking-id="WEB-owing"] .pay-check.found');
  assert.equal(checks.length,1);
  assert.deepEqual({...checks[0].body},{amount:35,firstName:'Shawn',lastName:'Redpath',street:'131 York Road',since:invoiceAt},'Sends the invoice amount, name, street and invoice date');
  assert.equal(checks[0].auth,'Bearer synthetic-owner','Uses the owner sign-in');
  const text=await page.locator('#directBookingList [data-booking-id="WEB-owing"] .pay-check').innerText();
  assert.match(text,/Payment found/);assert.match(text,/\$35\.00/);assert.match(text,/pending/);assert.match(text,/Redpath,Shawn Shawn 131 York Rd/);
  assert.equal(await page.evaluate(()=>directBookingRows.find(b=>b.id==='WEB-owing').status),'CONFIRMED');
  assert.equal(await page.evaluate(()=>directBookingRows.find(b=>b.id==='WEB-owing').invoiceOwing),true,'Finding a payment marks nothing paid by itself');
  await page.locator('[data-payment-receipt="WEB-owing"]').click();
  await page.waitForSelector('#formModal',{state:'visible'});
  assert.match(await page.locator('#formModal').innerText(),/Only once it's picked up/);
  await page.locator('#formModalCancel').click();
  assert.equal(await page.evaluate(()=>Object.keys(pendingReceipts).length+Object.keys(pendingBookingReceipts).length),0,'Cancel makes nothing');
  await page.locator('[data-payment-receipt="WEB-owing"]').click();await page.locator('#formModalSave').click();
  await page.waitForFunction(()=>document.getElementById('receiptFrame').dataset.ready==='true'&&document.querySelector('#receiptFrame canvas'));
  assert.deepEqual(await page.evaluate(()=>{const b=bookingCardRow('WEB-owing');return b._unpaidStopId?[!!pendingReceipts[b._unpaidStopId],findStop(b._unpaidStopId).receiptAmount]:[!!pendingBookingReceipts['WEB-owing'],pendingBookingReceipts['WEB-owing'].asStop.receiptAmount];}),[true,35],'Opens the usual receipt for the invoice amount');
  assert.equal(sent.length,0,'Nothing is sent until Woody presses Send');
  await page.evaluate(()=>closeReceiptPreview());
  reply=none;await openCards();await page.locator('[data-payment-check="WEB-owing"]').click();
  await page.waitForFunction(()=>/No payment found under their name yet/.test(document.querySelector('#directBookingList [data-booking-id="WEB-owing"] .pay-check')?.innerText||''));
  const missing=await page.locator('#directBookingList [data-booking-id="WEB-owing"] .pay-check').innerText();
  assert.match(missing,/including pending/);assert.match(missing,/different amount/);assert.match(missing,/\$20\.00/);
  assert.equal(await page.locator('[data-payment-receipt="WEB-owing"]').count(),0,'No receipt shortcut when nothing matches');
  status=502;reply={error:'The bank connection needs re-linking in Akahu.'};await openCards();await page.locator('[data-payment-check="WEB-owing"]').click();
  await page.waitForFunction(()=>/re-linking/.test(document.querySelector('#directBookingList [data-booking-id="WEB-owing"] .pay-check')?.innerText||''));
  // Navigate to a stop with an invoice owing checks the bank on the way.
  status=200;reply=found;
  await page.evaluate(()=>{window.navTaps=0;navigatePickup=()=>{window.navTaps++;return true;};renderList();});
  const stopText=()=>page.evaluate(()=>document.querySelector('#listWrap [data-id="stop-run"]')?.textContent||'');
  assert.match(await stopText(),/Invoice owing/);
  const before=checks.length;
  await page.evaluate(()=>navStop('stop-run'));
  assert.equal(await page.evaluate(()=>window.navTaps),1,'Maps still opens straight away');
  await page.waitForFunction(()=>/Bank shows they've paid/.test(document.querySelector('#listWrap [data-id="stop-run"]')?.textContent||''));
  assert.equal(checks.length,before+1,'One bank check');
  assert.equal(checks.at(-1).body.lastName,'Runner');
  await page.evaluate(()=>navStop('stop-run'));
  assert.equal(checks.length,before+1,'Not checked again once a payment is found');
  const tapStopPaid=()=>page.evaluate(()=>document.querySelector('#listWrap [data-id="stop-run"] button.good[onclick^="markBookingPaid"]').click());
  await tapStopPaid();await page.waitForSelector('#formModal',{state:'visible'});
  assert.match(await page.locator('#formModal').innerText(),/Bank shows \$35\.00/);
  await page.locator('#formModalCancel').click();
  assert.equal(payments.length,0,'Cancel marks nothing paid');
  await tapStopPaid();await page.locator('#formModalSave').click();
  await page.waitForFunction(()=>/✅ PAID/.test(document.querySelector('#listWrap [data-id="stop-run"]')?.textContent||''));
  assert.match(await stopText(),/just collect it/);
  assert.equal(await page.evaluate(()=>findStop('stop-run').status),'NEW','The stop stays to do');
  assert.equal(payments.at(-1).invoiceId,'inv-2');
  await openCards();
  assert.match(await page.locator('[data-booking-id="WEB-run"]').innerText(),/✅ PAID/);
  // Woody: marking paid must not mark the booking done - the receipt does that.
  status=200;reply=found;await openCards();await page.locator('[data-payment-check="WEB-owing"]').click();
  await page.waitForSelector('[data-payment-paid="WEB-owing"]');await page.locator('[data-payment-paid="WEB-owing"]').click();
  await page.waitForSelector('#formModal',{state:'visible'});await page.locator('#formModalSave').click();
  await page.waitForFunction(()=>/Paid \$35\.00/.test(document.querySelector('[data-booking-id="WEB-owing"]')?.innerText||''));
  assert.equal(payments.length,2);assert.equal(payments[1].invoiceId,'inv-1');assert.equal(payments[1].pending,true);assert.equal(payments[1].method,'bank');
  assert.equal(await page.evaluate(()=>directBookingRows.find(b=>b.id==='WEB-owing').status),'CONFIRMED','Still confirmed, not done');
  assert.equal(patches.some(p=>p&&p.status==='COMPLETED'),false,'Nothing tells the server it is completed');
  assert.equal(sent.length,0,'No receipt sent');
  await openCards();
  const card=await page.locator('[data-booking-id="WEB-owing"]').innerText();
  assert.match(card,/New · paid|Scheduled · paid/);assert.match(card,/Not picked up yet/);
  assert.equal(await page.locator('[data-payment-check="WEB-owing"]').count(),0,'Nothing left to check');
  assert.equal(await page.locator('[data-booking-id="WEB-owing"] [data-booking-id], [data-booking-id="WEB-owing"] button',{hasText:'Send receipt'}).count()>0,true,'Send receipt is still the last step');
  assert.equal(await page.evaluate(()=>stagesOfBooking(bookingCardRow('WEB-owing')).includes('done')),false,'Not in Done');
  // The ledger's own Mark paid button behaves the same way.
  await page.locator(`button[onclick="markPaid('local-1')"]`).click();
  await page.waitForSelector('#formModal',{state:'visible'});await page.locator('#formModalSave').click();
  await page.waitForFunction(()=>state.unpaid.find(s=>s.id==='local-1')?.paid===true);
  const local=await page.evaluate(()=>({...state.unpaid.find(s=>s.id==='local-1')}));
  assert.equal(local.status,'NEW');assert.notEqual(local.historyStatus,'COMPLETED');assert.ok(!local.collectedAt,'Not marked picked up');
  await openCards();
  const localCard=await page.locator('[data-booking-id="LOCAL-INVOICE-local-1"]').innerText();
  assert.match(localCard,/· paid/);assert.match(localCard,/🧾 Send receipt/);assert.doesNotMatch(localCard,/Send receipt again/);
  // Sending the receipt is still what finishes it.
  await page.evaluate(()=>receiptStop('local-1'));
  await page.waitForFunction(()=>document.getElementById('receiptFrame').dataset.ready==='true'&&document.querySelector('#receiptFrame canvas'));
  await page.locator('#receiptSendBtn').click();
  await page.waitForFunction(()=>state.unpaid.concat(allRunStates().flatMap(d=>d.stops||[])).some(s=>s.id==='local-1'&&s.status==='DONE'&&s.receiptSent));
  assert.ok(sent.length>=1,'Receipt sent');
  await openCards();assert.equal(await page.locator('[data-booking-id="LOCAL-INVOICE-local-1"]').count(),0,'Receipted: off the to-do list');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'No sideways scroll');
  assert.deepEqual(errors,[]);
  await context.close();
 }console.log('PASS: Check payment at 320/1280px; button only on owing invoices; owner sign-in; found (pending) opens the usual receipt without sending; no-payment and bank-error messages; Mark as paid (bank match and ledger) keeps the booking New/Scheduled and sends nothing; Navigate checks the bank once; stop and card show PAID; confirm boxes on Mark as paid and receipt.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
