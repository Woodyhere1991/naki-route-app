const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
const root=path.resolve(__dirname,'..'),origin=process.env.NAKI_PUBLIC_ORIGIN||'https://pickup.test';
(async()=>{
  const browser=process.env.NAKI_BROWSER==='webkit'?await webkit.launch({headless:true}):await chromium.launch({channel:'msedge',headless:true});
  try{for(const width of [320,390,1280]){
    const page=await browser.newPage({viewport:{width,height:950},serviceWorkers:'block'}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.origin===origin){
        if(process.env.NAKI_PUBLIC_ORIGIN)return route.continue();
        const file=path.resolve(root,url.pathname==='/'?'index.html':url.pathname.slice(1));
        if(!file.startsWith(root+path.sep)||!fs.existsSync(file))return route.fulfill({status:404,body:''});
        return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.png')?'image/png':'text/html'});
      }
      return route.fulfill({contentType:'application/json',body:JSON.stringify({bookings:[],customers:[],documents:[],hasMore:false,runs:[]})});
    });
    await page.goto(origin);await page.waitForFunction(()=>typeof NakiLoadPlan==='object'&&typeof state==='object');
    await page.evaluate(()=>{
      state.stops=[{id:'test-load',status:'NEW',street:'Example Street',town:'Waitara',appliances:['Large or French-door fridge x2','Fridge x3','Washing machine x2','Dryer x2','Dishwasher','TV x2','Microwave','Bicycle','Lawn mower']}];
      applyAppView('today');save();render();
    });
    assert.equal(await page.locator('#stApp').innerText(),'15');
    await page.locator('.load-shortcut').click();
    assert(await page.locator('#loadPlanDialog').evaluate(d=>d.open));
    assert.equal(await page.locator('.lp-block.big').count(),2);assert.equal(await page.locator('.lp-block').count(),10);
    assert((await page.locator('#loadPlanPicture').textContent()).includes('11 / 18'));
    assert((await page.locator('.lp-summary').textContent()).includes('Washer × 2'));
    const overflow=await page.locator('#loadPlanDialog').evaluate(d=>d.scrollWidth>d.clientWidth+1);assert.equal(overflow,false);
    assert.equal(await page.locator('#loadPictureDetails').getAttribute('open'),null,'Picture stays out of the way by default');
    assert((await page.locator('#loadPlanSummary').innerText()).includes('About 7 spaces left'));
    assert((await page.locator('#loadPlanSummary').innerText()).includes('For the gaps'));
    if(width===390&&!process.env.NAKI_PUBLIC_ORIGIN){await page.screenshot({path:path.join(root,'output','load-plan-phone.png')});}
    await page.locator('#loadPictureDetails > summary').click();
    await page.locator('.lp-block.box').first().click();
    assert.equal(await page.locator('.lp-ute .lp-chip').count(),1);
    assert((await page.locator('#loadPlanStatus').innerText()).includes('saved'));
    await page.locator('.load-dialog-head button').click();
    await page.waitForFunction(()=>document.querySelector('#stAppBtn').getAttribute('aria-expanded')==='false');
    assert.equal(await page.locator('#stAppBtn').getAttribute('aria-expanded'),'false');
    await page.reload();await page.waitForFunction(()=>typeof state==='object');
    await page.locator('#stAppBtn').click();
    assert.equal(await page.locator('.lp-ute .lp-chip').count(),1,'Ute choices survive reload');
    await page.locator('#loadPictureDetails > summary').click();
    await page.locator('.lp-ute .lp-chip').click();assert.equal(await page.locator('.lp-ute .lp-chip').count(),0);
    await page.locator('.lp-gap-list .lp-chip').first().click();assert.equal(await page.locator('.lp-ute .lp-chip').count(),1,'Gap candidates can move to ute gaps');
    // No items disappear when the standard-space count exceeds the trailer.
    await page.evaluate(()=>{state.stops=[{id:'full',status:'NEW',appliances:Array(19).fill('Fridge')}];render();});
    assert.equal(await page.locator('.lp-block').count(),18);assert((await page.locator('.lp-warning').innerText()).includes('1 appliance not placed'));
    assert.equal(await page.locator('.lp-warning .lp-chip').count(),1);
    assert.deepEqual(errors,[]);await page.close();
  }}finally{await browser.close();}
  console.log('PASS: load picture, grouped quantities, both fridge widths, phone overflow, moving items, saved/reloaded choices, returns, gap moves and overflow at 320/390/1280px');
})().catch(e=>{console.error(e);process.exitCode=1;});
