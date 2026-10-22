// Phone-width check of the scrap receipt scanner on the Earnings page:
// totals include scrap, a photo is read and pre-fills the form, the owner's
// checked amount is what gets saved, and a failed read still lets them type it.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.NAKI_PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..');
(async()=>{
 const {nzDay}=await import('../assets/earnings-model.js');const today=nzDay();
 const now=Date.now();
 let scrap=[{id:'SCRAP-1-aaaa',cents:4000,day:today,yard:'GMS',weightKg:200,photo:true,createdAt:now}];
 const report=()=>({asOf:new Date().toISOString(),summary:{},scrap,records:[{kind:'booking',key:'WEB-1',aliases:['WEB-1'],rank:30,status:'COMPLETED',completedAt:now,at:now,cents:2500}],stats:null});
 let readFails=false,saved=null;
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const context=await browser.newContext({viewport:{width:375,height:812},serviceWorkers:'block'}),page=await context.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.hostname==='pickup.test'){
    const rel=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1)),target=path.resolve(root,rel);
    if(!target.startsWith(root+path.sep)||!fs.existsSync(target))return route.fulfill({status:404,body:''});
    return route.fulfill({status:200,contentType:/\.m?js$/.test(target)?'text/javascript':target.endsWith('.css')?'text/css':target.endsWith('.png')?'image/png':'text/html',body:fs.readFileSync(target)});
   }
   const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
   if(url.pathname.endsWith('/owner/earnings'))return json(report());
   if(url.pathname.endsWith('/owner/scrap/read'))return readFails?json({error:'That does not look like a scrap receipt. Type the amount in instead.'},422):json({read:{amount:87.25,day:today,yard:'GMS New Plymouth',weightKg:410}});
   if(url.pathname.endsWith('/owner/scrap')&&route.request().method()==='POST'){
    saved=JSON.parse(route.request().postData());
    const payment={id:'SCRAP-2-bbbb',cents:Math.round(saved.amount*100),day:saved.day,yard:saved.yard,weightKg:Number(saved.weightKg)||null,photo:!!saved.image,createdAt:Date.now()};
    scrap=[...scrap,payment];return json({payment});
   }
   if(/\/owner\/scrap\/SCRAP-1-aaaa$/.test(url.pathname)&&route.request().method()==='DELETE'){scrap=scrap.filter(p=>p.id!=='SCRAP-1-aaaa');return json({ok:true});}
   return json({bookings:[],customers:[],documents:[],ok:true});
  });
  await page.goto('https://pickup.test/',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>!!window.nakiEarnings);
  await page.evaluate(()=>{ownerToken='synthetic-owner';state.stops=[];state.bad=[];state.unpaid=[];runStore.runs=[{id:'t',name:'T',data:state}];runStore.activeRunId='t';setAppView('earnings');window.nakiEarnings.load();});
  await page.waitForSelector('#scrapScan');
  const todayCard=page.locator('.earnings-number').first();
  assert.match(await todayCard.innerText(),/\$65\.00/);assert.match(await todayCard.innerText(),/Pickups \$25\.00 · Scrap \$40\.00/);
  // Scan: the file input gets a photo, the read pre-fills the form.
  const [chooser]=await Promise.all([page.waitForEvent('filechooser'),page.click('#scrapScan')]);
  await chooser.setFiles(path.join(root,'assets/icon-192.png'));
  await page.waitForFunction(()=>document.getElementById('scrapAmount').value==='87.25');
  assert.equal(await page.inputValue('#scrapYard'),'GMS New Plymouth');
  assert.match(await page.textContent('#scrapStatus'),/Check the amount/);
  await page.fill('#scrapAmount','88.10'); // Woody corrects it before saving
  await page.click('#scrapSave');
  await page.waitForFunction(()=>!document.getElementById('scrapDialog').open);
  assert.equal(saved.amount,88.1);assert.ok(saved.image.startsWith('data:image/jpeg'));
  await page.waitForFunction(()=>/\$153\.10/.test(document.querySelector('.earnings-number').innerText));
  // A failed read still opens the form to type in.
  readFails=true;
  const [again]=await Promise.all([page.waitForEvent('filechooser'),page.click('#scrapScan')]);
  await again.setFiles(path.join(root,'assets/icon-192.png'));
  await page.waitForFunction(()=>/type the amount in/i.test(document.getElementById('scrapStatus').textContent));
  assert.equal(await page.inputValue('#scrapAmount'),'');
  await page.click('#scrapCancel');
  // Remove takes it off the totals.
  await page.click('[data-scrap-remove="SCRAP-1-aaaa"]');
  await page.waitForFunction(()=>/\$113\.10/.test(document.querySelector('.earnings-number').innerText));
  const width=await page.evaluate(()=>document.documentElement.scrollWidth);assert.ok(width<=375,'no sideways scroll at 375px');
  await page.screenshot({path:path.join(root,'output','scrap-scan-375.png'),fullPage:false});
  assert.deepEqual(errors,[]);
  console.log('PASS: scrap scan at 375px: totals include scrap, photo read pre-fills, corrected amount saved, failed read falls back to typing, remove lowers totals.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
