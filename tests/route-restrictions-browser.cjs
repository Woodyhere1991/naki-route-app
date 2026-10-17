const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),origin=process.env.NAKI_PUBLIC_ORIGIN||'https://pickup.test';
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try{for(const width of [390,1280]){
    const page=await browser.newPage({viewport:{width,height:950},serviceWorkers:'block'}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.origin===origin){
        if(process.env.NAKI_PUBLIC_ORIGIN)return route.continue();
        const file=path.resolve(root,url.pathname==='/'?'index.html':url.pathname.slice(1));
        if(!file.startsWith(root+path.sep)||!fs.existsSync(file))return route.fulfill({status:404,body:''});
        return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.png')?'image/png':'text/html'});
      }
      return route.fulfill({contentType:'application/json',body:JSON.stringify({bookings:[],customers:[],documents:[],runs:[],hasMore:false})});
    });
    await page.goto(origin);await page.waitForFunction(()=>typeof NakiRouting==='object'&&typeof optimise==='function');
    const result=await page.evaluate(async()=>{
      state.start={lat:-39.04734,lng:174.2535};state.end=null;state.roundTrip=false;
      state.stops=[{id:'bridge-east',lat:-39.04736,lng:174.2564,status:'NEW',first_name:'Test',street:'Test pickup',town:'Tikorangi',appliances:['Fridge']}];
      const seq=[state.start,...NakiRouting.bypass,state.stops[0]];
      const safe={geometry:{type:'LineString',coordinates:seq.map(p=>[p.lng,p.lat])},distance:16727,duration:1400,
        legs:[{distance:16727,duration:1400}],detours:[{leg:0,via:NakiRouting.bypass}]};
      NakiRouting.safeRoute=async()=>safe;
      await ensureMap();await drawRoute();
      const roadLayers=routeLayer.getLayers().length,km=document.querySelector('#stKm').textContent;
      const banner=document.querySelector('#bannerOsrm').textContent;
      const arrival=routeTiming['bridge-east'].driveSec;
      NakiRouting.matrix=async points=>points.map((_,i)=>points.map((_,j)=>i===j?0:1400));
      NakiRouting.safeRoute=async()=>{throw Error('offline test');};
      const before=JSON.stringify(state.stops),optimised=await optimise();
      await drawRoute();
      return {roadLayers,km,banner,arrival,optimised,kept:before===JSON.stringify(state.stops),
        afterFailure:routeLayer.getLayers().length,timingCleared:Object.keys(routeTiming).length===0,
        failedBanner:document.querySelector('#bannerOsrm').textContent,
        busy:document.querySelector('#optimise').disabled};
    });
    assert(result.roadLayers>0);assert.equal(result.km,'17');assert(result.banner.includes('SH3'));assert.equal(result.arrival,1400);
    assert.equal(result.optimised,false);assert(result.kept);assert.equal(result.afterFailure,0);assert(result.timingCleared);
    assert(result.failedBanner.includes('Could not verify'));assert.equal(result.busy,false);assert.deepEqual(errors,[]);
    await page.close();
  }}finally{await browser.close();}
  console.log('PASS: map detour, distance, timing, failed optimisation preserves pickups, no unsafe fallback and busy cleanup at 390/1280px');
})().catch(e=>{console.error(e);process.exitCode=1;});
