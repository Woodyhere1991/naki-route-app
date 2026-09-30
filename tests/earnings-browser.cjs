const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium,webkit}=require(process.env.NAKI_PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..');
const yesterday=Date.now()-86400000;
const fixture={asOf:new Date().toISOString(),summary:{allTimeCents:5500},records:[2000,3500,0].map((cents,i)=>({kind:'booking',key:'WEB-test-'+i,aliases:['WEB-test-'+i],rank:30,status:'COMPLETED',completedAt:yesterday,at:yesterday,cents})),
 stats:{rows:[2000,3500,0].map((cents,i)=>({key:'WEB-test-'+i,aliases:['WEB-test-'+i],completed:true,completedDay:'2026-09-30',requestedDay:'2026-09-28',cents,items:[i===0?'Fridge':'Dryer'],name:'Example '+i,customerId:'synthetic'+i,town:'Waitara'})).concat([{key:'old-request',aliases:['old-request'],completed:false,archived:true,requestedDay:'2024-02-11',items:['Dishwasher'],name:'Historical example',customerId:'old'}]),sources:{rawSubmissions:1,jotformForms:[],localWorkbooks:0,pastCustomerContacts:0},snapshotAt:'2026-09-30T00:00:00Z'}};
const baseline=process.env.NAKI_EARNINGS_FIXTURE?JSON.parse(fs.readFileSync(process.env.NAKI_EARNINGS_FIXTURE)):fixture;
let expectedJobs,expectedFridges;
(async()=>{
 const {buildEntries}=await import('../assets/earnings-model.js'),{aggregateStats,mergeStatsRows}=await import('../assets/business-stats-model.js');const stats=aggregateStats(mergeStatsRows(baseline.stats.rows,buildEntries(baseline.records)));expectedJobs=stats.jobs;expectedFridges=stats.fridges;
 const browser=process.env.NAKI_BROWSER==='webkit'?await webkit.launch({headless:true}):await chromium.launch({channel:'msedge',headless:true});
 try{
  for(const width of [375,390,1280]){
   const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'}),page=await context.newPage();
   const errors=[];page.on('pageerror',e=>errors.push(e.message));let fail=false;
   await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.hostname==='pickup.test'){
     const rel=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1)),target=path.resolve(root,rel);
     if(!target.startsWith(root+path.sep)||!fs.existsSync(target))return route.fulfill({status:404,body:''});
     return route.fulfill({status:200,contentType:/\.m?js$/.test(target)?'text/javascript':target.endsWith('.css')?'text/css':target.endsWith('.png')?'image/png':'text/html',body:fs.readFileSync(target)});
    }
    if(url.pathname.endsWith('/owner/earnings'))return route.fulfill({status:fail?503:200,contentType:'application/json',body:JSON.stringify(fail?{error:'Reconnect to load earnings'}:baseline)});
    return route.fulfill({status:200,contentType:'application/json',body:'{"bookings":[],"customers":[],"documents":[],"ok":true}'});
   });
   await page.goto('https://pickup.test/',{waitUntil:'domcontentloaded'});
   await page.waitForFunction(()=>!!window.nakiEarnings);
   await page.evaluate(()=>{ownerToken='synthetic-owner';state.stops=[];state.bad=[];state.unpaid=[];runStore.runs=[{id:'test-run',name:'Test run',data:state}];runStore.activeRunId='test-run';});
   await page.locator('.bottom-nav [data-view-button=customers]').click();await page.locator('[data-view-button=earnings]').click();
   await page.waitForFunction(()=>!document.getElementById('earningsContent').hidden);
   assert.ok((await page.locator('#earningsContent').innerText()).includes(new Intl.NumberFormat('en-NZ',{style:'currency',currency:'NZD'}).format(baseline.summary.allTimeCents/100)));
   await page.getByRole('button',{name:'12 months',exact:true}).click();
   assert.equal(await page.locator('.earnings-chart rect.bar').count(),12);
   await page.locator('[data-earnings-tab=stats]').click();
   assert.equal(await page.locator('.stats-numbers strong').first().innerText(),expectedJobs.toLocaleString('en-NZ'));
   assert.match(await page.locator('#earningsContent').innerText(),new RegExp('Fridges collected\\s+'+expectedFridges));
   await page.locator('#statsYear').selectOption('2024');
   assert.match(await page.locator('#earningsContent').innerText(),/Older bookings are counted as collected/);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'No horizontal page overflow');
   if(width===390&&process.env.NAKI_EARNINGS_FIXTURE){await page.locator('#statsYear').selectOption('all');await page.screenshot({path:path.join(root,'tmp','business-stats-phone-private.png'),fullPage:true});}
   await page.locator('[data-earnings-tab=earnings]').click();
   await page.locator('[data-view-button=today]').click();
   await page.evaluate(()=>{
    state.stops=[{id:'synthetic-final',first_name:'Test',last_name:'Only',submission_id:'WEB-synthetic-final',src:'direct',appliances:['Fridge'],status:'NEW',amount:23.45,street:'Test street',town:'Waitara'}];state.bad=[];state.unpaid=[];window.toggleDone('synthetic-final');
   });
   await page.waitForFunction(()=>document.getElementById('dayEarningsBody').innerText.includes('$23.45'));
   assert.equal(await page.locator('#dayEarningsDialog').evaluate(e=>e.open),true);
   await page.locator('#dayEarningsClose').click();
   await page.evaluate(()=>window.toggleDone('synthetic-final'));
   assert.equal(await page.locator('#dayEarningsDialog').evaluate(e=>e.open),false,'Undo does not celebrate completion');
   await page.evaluate(()=>{state.stops=[{id:'a',status:'NEW',amount:20},{id:'b',status:'NEW',amount:30}];window.toggleDone('a');});
   assert.equal(await page.locator('#dayEarningsDialog').evaluate(e=>e.open),false,'Earlier stops do not trigger the popup');
   if(width===390){
    await page.evaluate(async()=>{
      await ensurePdf();state.stops=[{id:'review-choice',first_name:'Preview',last_name:'Example',status:'NEW',amount:20,receiptAmount:20,street:'20 Example St',town:'Waitara',email:'example@example.test',appliances:['Fridge']}];
      const blob=await buildReceiptPdf(state.stops[0],20);pendingReceipts['review-choice']=new File([blob],'test.pdf',{type:'application/pdf'});openReceiptPreview('review-choice');
    });
    assert.equal(await page.locator('#receiptIncludeReview').isChecked(),true);
    const checkPreview=async()=>{
      await page.waitForFunction(()=>document.getElementById('receiptFrame').dataset.ready==='true');
      assert.ok(await page.locator('#receiptFrame canvas').count(),'Actual PDF is rendered');
      const darkPixels=await page.locator('#receiptFrame canvas').first().evaluate(canvas=>{
        const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let count=0;
        for(let i=0;i<pixels.length;i+=4)if(pixels[i+3]>0&&pixels[i]+pixels[i+1]+pixels[i+2]<500)count++;
        return count;
      });
      assert.ok(darkPixels>1000,'Preview contains printed PDF content rather than a blank white panel');
      assert.equal(await page.locator('#receiptSendBtn').isDisabled(),false);
      assert.equal(await page.locator('#receiptFrame').evaluate(el=>el.scrollWidth>el.clientWidth+1),false);
    };
    await checkPreview();
    await page.locator('#receiptIncludeReview').uncheck();await page.waitForFunction(()=>!document.getElementById('receiptIncludeReview').disabled);
    await checkPreview();
    assert.equal(await page.evaluate(async()=>/g.page|Leave a Google review|Happy with how it went/.test(await pendingReceipts['review-choice'].text())),false,'Review removed from actual PDF');
    assert.equal(await page.evaluate(()=>state.stops[0].receiptIncludeReview),false);
    await page.locator('#receiptIncludeReview').check();await page.waitForFunction(()=>!document.getElementById('receiptIncludeReview').disabled);
    await checkPreview();
    assert.equal(await page.evaluate(async()=>/g.page/.test(await pendingReceipts['review-choice'].text())),true,'Review restored in actual PDF');
    await page.evaluate(()=>{delete pendingReceipts['review-choice'];closeReceiptPreview();});
    assert.equal(await page.locator('#receiptFrame canvas').count(),0,'Private preview cleared on close');
    await page.evaluate(async()=>{
      const stop=state.stops[0],blob=await buildInvoicePdf(stop,20);
      pendingInvoices[stop.id]=new File([blob],'invoice.pdf',{type:'application/pdf'});openInvoicePreview(stop.id);
    });
    await checkPreview();
    assert.equal(await page.locator('#receiptReviewOption').isVisible(),false);
    await page.evaluate(()=>{closeReceiptPreview();pendingBookingInvoices['preview-booking']={file:pendingInvoices['review-choice'],amount:20};openBookingInvoicePreview('preview-booking');});
    await checkPreview();
    await page.evaluate(()=>{closeReceiptPreview();delete pendingInvoices['review-choice'];delete pendingBookingInvoices['preview-booking'];});
    await page.evaluate(async()=>{
     state.unpaid=[];state.stops=[{id:'receipt-final',src:'direct',submission_id:'WEB-receipt-final',first_name:'Receipt',last_name:'Example',email:'example@example.test',status:'NEW',amount:20,receiptAmount:25,appliances:['Fridge']}];
     pendingReceipts['receipt-final']=new File(['synthetic receipt'], 'test.pdf',{type:'application/pdf'});await window.sendReceipt('receipt-final');
    });
    try{await page.waitForFunction(()=>document.getElementById('dayEarningsBody').innerText.includes('$25.00'));}catch(error){console.log(await page.evaluate(()=>({dialog:document.getElementById('dayEarningsBody').innerText,open:document.getElementById('dayEarningsDialog').open,stops:state.stops.map(s=>({status:s.status,amount:s.amount,receiptAmount:s.receiptAmount,receiptSent:s.receiptSent})),errors:document.getElementById('earningsStatus').innerText})));throw error;}
    assert.match(await page.locator('#dayEarningsBody').innerText(),/1 job today/);await page.locator('#dayEarningsClose').click();
    await page.evaluate(async()=>{
     state.unpaid=[];state.stops=[{id:'invoice-final',src:'direct',submission_id:'WEB-invoice-final',first_name:'Invoice',last_name:'Example',email:'example@example.test',status:'NEW',amount:30,invoiceAmount:30,appliances:['Fridge']}];
     window.confirm=()=>false;pickReminder=async()=>({date:'',repeat:0});pendingInvoices['invoice-final']=new File(['synthetic invoice'],'test.pdf',{type:'application/pdf'});await window.sendInvoice('invoice-final');
    });
    assert.equal(await page.locator('#dayEarningsDialog').evaluate(e=>e.open),false,'An early invoice is not a completed pickup');
    await page.evaluate(async()=>{
     window.confirm=()=>true;pendingInvoices['invoice-final']=new File(['synthetic invoice'],'test.pdf',{type:'application/pdf'});await window.sendInvoice('invoice-final');
    });
    await page.waitForFunction(()=>document.getElementById('dayEarningsBody').innerText.includes('$30.00'));
    assert.match(await page.locator('#dayEarningsBody').innerText(),/1 job today/);await page.locator('#dayEarningsClose').click();
   }
   await page.evaluate(()=>{state.stops=[];});
   await page.locator('.bottom-nav [data-view-button=customers]').click();await page.locator('[data-view-button=earnings]').click();await page.waitForFunction(()=>!document.getElementById('earningsContent').hidden);
   fail=true;await page.locator('#earningsRefresh').click();
   await page.waitForFunction(()=>document.getElementById('earningsStatus').innerText.includes('Reconnect'));
   assert.equal(await page.locator('#earningsContent').innerText(),'','Failure does not show stale money');
   fail=false;await page.locator('#earningsRefresh').click();await page.waitForFunction(()=>!document.getElementById('earningsContent').hidden);
   await page.evaluate(()=>{ownerToken='';window.nakiEarnings.clear();});
   assert.equal(await page.locator('#earningsContent').innerText(),'');
   const privateCache=await page.evaluate(()=>Object.entries(localStorage).filter(([k,v])=>/naki_(earnings|business_stats)|allTimeCents|receiptedCents/.test(k+' '+v)));
   assert.equal(privateCache.length,0,'No financial report persisted to browser storage');
   assert.deepEqual(errors,[]);
   await context.close();
  }
  console.log('PASS: 375/390/1280px earnings, historical stats, filters, chart, final Done/receipt/invoice popup, early-invoice exclusion, undo, failures and sign-out privacy.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
