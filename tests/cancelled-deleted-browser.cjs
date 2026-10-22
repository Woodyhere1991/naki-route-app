// Bookings at phone and desktop width: Cancelled has its own tab (and no longer
// pads Done), Restore calls the server's restore step, Delete goes to the bin,
// and the Deleted bookings panel restores a booking.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.NAKI_PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..');
const row=(id,status,first)=>({id,status,firstName:first,lastName:'Test',email:first.toLowerCase()+'@example.test',phone:'021',streetAddress:'1 Test St',town:'New Plymouth',items:['Dryer'],total:20,createdAt:'2026-10-20T00:00:00Z',documents:[],source:'WEBSITE'});
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{for(const width of [320,390,1280]){
  const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'}),page=await context.newPage();
  const errors=[],calls=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  let live=[row('WEB-c','CANCELLED','Cancelly'),row('WEB-d','DECLINED','Declino'),row('WEB-done','COMPLETED','Donna'),row('WEB-n','NEW','Newbie')];
  let bin=[{id:'WEB-gone',status:'CONFIRMED',firstName:'Gone',lastName:'Test',streetAddress:'9 Bin Rd',town:'Waitara',items:['Fridge'],deletedAt:'2026-10-20T01:00:00Z',emptiesAt:'2026-11-19T01:00:00Z'}];
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url()),method=route.request().method();
   if(url.hostname==='pickup.test'){
    const rel=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1)),target=path.resolve(root,rel);
    if(!target.startsWith(root+path.sep)||!fs.existsSync(target))return route.fulfill({status:404,body:''});
    return route.fulfill({status:200,contentType:/\.m?js$/.test(target)?'text/javascript':target.endsWith('.css')?'text/css':target.endsWith('.png')?'image/png':'text/html',body:fs.readFileSync(target)});
   }
   const reply=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
   if(/\/owner\/bookings\/WEB-c\/restore$/.test(url.pathname)){calls.push(method+' restore');live=live.map(r=>r.id==='WEB-c'?row('WEB-c','NEW','Cancelly'):r);return reply({ok:true,booking:{...row('WEB-c','NEW','Cancelly')}});}
   if(/\/owner\/bookings\/WEB-n$/.test(url.pathname)&&method==='DELETE'){calls.push('DELETE');live=live.filter(r=>r.id!=='WEB-n');bin=[{...bin[0],id:'WEB-n',firstName:'Newbie'},...bin];return reply({ok:true,binDays:30});}
   if(url.pathname.endsWith('/owner/deleted-bookings'))return reply({bookings:bin,days:30});
   if(url.pathname.endsWith('/owner/bookings')&&method==='GET')return reply({bookings:live,hasMore:false,nextOffset:live.length});
   if(/\/owner\/deleted-bookings\/WEB-gone\/restore$/.test(url.pathname)){calls.push('bin restore');live=[row('WEB-gone','CONFIRMED','Gone'),...live];bin=bin.filter(b=>b.id!=='WEB-gone');return reply({ok:true,booking:row('WEB-gone','CONFIRMED','Gone')});}
   return reply({bookings:[],customers:[],documents:[],hasMore:false,ok:true});
  });
  await page.goto('https://pickup.test/',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>typeof renderDirectBookings==='function');
  await page.evaluate(()=>{ownerToken='synthetic';cloudBackupBusy=true;bookingStage='all';setAppView('bookings');});
  await page.waitForFunction(()=>directBookingRows.length===4&&document.querySelector('#bookingStageTabs [data-stage="cancelled"]'));
  const tabs=await page.evaluate(()=>Object.fromEntries([...document.querySelectorAll('#bookingStageTabs [data-stage]')].map(b=>[b.dataset.stage,Number(b.querySelector('.n').textContent)])));
  assert.deepEqual(tabs,{all:4,new:1,scheduled:0,owing:0,done:1,cancelled:2},'cancelled and declined counted under Cancelled, not Done');
  await page.click('#bookingStageTabs [data-stage="cancelled"]');
  const shown=await page.evaluate(()=>[...document.querySelectorAll('#directBookingList [data-booking-id]')].map(e=>e.dataset.bookingId).sort());
  assert.deepEqual(shown,['WEB-c','WEB-d']);
  assert.match(await page.textContent('#directBookingList'),/Cancelled \(2\)/);assert.doesNotMatch(await page.textContent('#directBookingList'),/Done \(/);
  // On a phone the six tabs sit in two rows and no label is broken mid-word.
  const tabRows=await page.evaluate(()=>new Set([...document.querySelectorAll('#bookingStageTabs button')].map(b=>Math.round(b.getBoundingClientRect().top))).size);
  assert.equal(tabRows,width<=560?2:1);
  assert.equal(await page.evaluate(()=>[...document.querySelectorAll('#bookingStageTabs button')].every(b=>b.scrollWidth<=b.clientWidth+1)),true,'tab labels fit');
  // Restore uses the dedicated server step.
  await page.evaluate(()=>restoreDirectBooking('WEB-c'));
  assert.deepEqual(calls.slice(-1),['POST restore']);
  assert.equal(await page.evaluate(()=>directBookingRows.find(r=>r.id==='WEB-c').status),'NEW');
  // Delete goes to the bin and says so.
  await page.evaluate(()=>deleteDirectBooking('WEB-n'));
  assert(calls.includes('DELETE'));
  assert.equal(await page.evaluate(()=>directBookingRows.some(r=>r.id==='WEB-n')),false);
  // The Deleted bookings panel lists and restores.
  assert.equal(await page.isVisible('#deletedBinOpen'),true);
  await page.click('#deletedBinOpen');
  await page.waitForSelector('[data-bin-restore="WEB-gone"]');
  assert.match(await page.textContent('#deletedBin'),/Kept for 30 days/);
  await page.click('[data-bin-restore="WEB-gone"]');
  await page.waitForFunction(()=>directBookingRows.some(r=>r.id==='WEB-gone'));
  await page.waitForFunction(()=>!document.querySelector('[data-bin-restore="WEB-gone"]'));
  assert(calls.includes('bin restore'));
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
  assert.ok(overflow<=0,`no sideways scroll at ${width}px`);
  if(width===320)await page.screenshot({path:path.join(root,'output','cancelled-deleted-320.png')});
  // Signed out: no bin button.
  await page.evaluate(()=>{ownerToken='';renderDirectBookings();});
  assert.equal(await page.isVisible('#deletedBinOpen'),false);assert.equal(await page.isVisible('#deletedBin'),false);
  assert.deepEqual(errors,[]);await context.close();
 }}finally{await browser.close();}
 console.log('PASS: Cancelled tab (not padding Done), restore via server, delete to bin, Deleted bookings panel restore, signed-out hiding, no overflow at 320/390/1280px');
})().catch(e=>{console.error(e);process.exit(1);});
