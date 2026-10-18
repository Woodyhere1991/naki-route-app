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
      state.stops=[{id:'test-load',status:'NEW',street:'Example Street',town:'Waitara',appliances:['Fridge x14','Washing machine x8','Other x3','TV x2','Microwave']}];
      // Previous versions' manual ute choices no longer alter automatic filling.
      state.loadPlanUte=Object.fromEntries(NakiLoadPlan.items(state.stops).map(i=>[i.key,true]));
      applyAppView('today');save();render();
    });
    assert.equal(await page.locator('#stApp').innerText(),'28');
    await page.locator('.load-shortcut').click();
    assert(await page.locator('#loadPlanDialog').evaluate(d=>d.open));
    assert((await page.locator('.ls-capacity').innerText()).includes('18 / 18'));
    assert((await page.locator('.ls-trailer').innerText()).includes('18 appliances'));
    assert((await page.locator('.ls-leftover').innerText()).includes('left over · 4'));
    assert((await page.locator('.ls-small').innerText()).includes('gaps · 6'));
    assert.equal(await page.locator('#loadPlanDialog img,#loadPlanDialog svg,#loadPlanDialog canvas,.lp-block,#loadPictureDetails').count(),0,'Loading pictures completely removed');
    assert.equal(await page.locator('#loadPlanDialog').evaluate(d=>d.scrollWidth>d.clientWidth+1),false);
    if(width===390&&!process.env.NAKI_PUBLIC_ORIGIN)await page.screenshot({path:path.join(root,'output','load-plan-phone.png')});
    await page.locator('#loadPlanDialog .load-dialog-head button').click();
    await page.waitForFunction(()=>document.querySelector('#stAppBtn').getAttribute('aria-expanded')==='false');
    await page.reload();await page.waitForFunction(()=>typeof state==='object');await page.locator('#stAppBtn').click();
    assert((await page.locator('.ls-trailer').innerText()).includes('18 appliances'));
    await page.evaluate(()=>{state.stops=[{id:'cold',status:'NEW',appliances:['Fridge x9','Large chest freezer (over 1.5 m) x2','Dryer x6','Other']}];render();});
    assert((await page.locator('.ls-capacity').innerText()).includes('18 / 18'));
    assert((await page.locator('.ls-trailer').innerText()).includes('17 appliances'));
    assert((await page.locator('.ls-trailer').innerText()).includes('Large chest freezers'));
    assert((await page.locator('.ls-small').innerText()).includes('gaps · 1'));
    assert.deepEqual(errors,[]);await page.close();
  }}finally{await browser.close();}
  console.log('PASS: count-only trailer allocation, leftovers, Other/small totals, no pictures, reload, large chest freezers and no horizontal overflow at 320/390/1280px');
})().catch(e=>{console.error(e);process.exitCode=1;});
