const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
const root=path.resolve(__dirname,'..'),origin=process.env.NAKI_PUBLIC_ORIGIN||'https://pickup.test';
(async()=>{
  const browser=process.env.NAKI_BROWSER==='webkit'?await webkit.launch({headless:true}):await chromium.launch({channel:'msedge',headless:true});
  try{for(const width of [390,1280]){
    const page=await browser.newPage({viewport:{width,height:950},serviceWorkers:'block',userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'}),errors=[],alerts=[];
    page.on('pageerror',e=>errors.push(e.message));page.on('dialog',async d=>{alerts.push(d.message());await d.accept();});
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
    await page.goto(origin);await page.waitForFunction(()=>typeof NakiMaps==='object');
    await page.evaluate(()=>{
      ownerToken='synthetic';cloudBackupBusy=true;clearTimeout(cloudBackupTimer);bookingCompact=false;
      directBookingRows=[{id:'WEB-nav',firstName:'Navigation',streetAddress:'2A Example Street',town:'Waitara',area:'Taranaki',status:'NEW',items:['Fridge'],total:20,createdAt:new Date().toISOString(),documents:[]}];
      state.stops=[{id:'scheduled-nav',first_name:'Scheduled',street:'3 Example Street',town:'Tikorangi',lat:-39.04736,lng:174.2564,geoLabel:'3 Example Street, Tikorangi, New Zealand',status:'NEW',appliances:['Fridge']}];
      window.navLaunches=[];window.navChecks=0;window.navFail=false;
      NakiMaps.open=url=>{navLaunches.push(NakiMaps.links(url,navigator));return true;};
      Object.defineProperty(navigator,'geolocation',{configurable:true,value:{getCurrentPosition:ok=>ok({coords:{latitude:-39.04734,longitude:174.2535}})}});
      geocode=async()=>({lat:-39.04736,lng:174.2564});
      NakiRouting.safeRoute=async()=>{navChecks++;if(navFail)throw Error('Synthetic routing failed');return {detours:[{via:NakiRouting.bypass}]};};
      document.body.dataset.view='bookings';renderDirectBookings();
    });
    const bookingButton=page.locator('[data-navigate-booking="WEB-nav"]');assert.equal(await bookingButton.count(),1);
    assert.equal(await bookingButton.getAttribute('target'),null);
    await bookingButton.click();await page.waitForFunction(()=>navLaunches.length===1);
    let captured=await page.evaluate(()=>navLaunches[0]);
    assert(captured.app.startsWith('comgooglemapsurl://'));
    let url=new URL(captured.web);assert.equal(url.searchParams.get('dir_action'),'navigate');assert.equal(url.searchParams.has('origin'),false);
    assert.equal(url.searchParams.get('destination'),'-39.04736,174.2564');assert(url.searchParams.get('waypoints').includes('|'));
    await page.evaluate(()=>{applyAppView('today');render();});
    await page.locator('.nav-action[onclick*="scheduled-nav"]').first().click();await page.waitForFunction(()=>navLaunches.length===2);
    captured=await page.evaluate(()=>navLaunches[1]);assert(captured.app.startsWith('comgooglemapsurl://'));assert(new URL(captured.web).searchParams.has('waypoints'));
    const failed=await page.evaluate(async()=>{navFail=true;await navStop('scheduled-nav');return {launches:navLaunches.length,busy:navRouteBusy,disabled:document.querySelector('.nav-action').disabled};});
    assert.equal(failed.launches,2);assert.equal(failed.busy,false);assert.equal(failed.disabled,false);assert(alerts.some(s=>s.includes('routing failed')));
    assert.deepEqual(errors,[]);await page.close();
  }}finally{await browser.close();}
  console.log('PASS: booking and scheduled Navigate use app handoff, live-position navigation and bridge waypoints; routing failures stay in app with controls restored');
})().catch(e=>{console.error(e);process.exitCode=1;});
