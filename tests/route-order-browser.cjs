const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
const root=path.resolve(__dirname,'..'),origin=process.env.NAKI_PUBLIC_ORIGIN||'https://pickup.test';
const wanted='10,13,14,GMS,16,15,18,17,11';
(async()=>{
  const browser=process.env.NAKI_BROWSER==='webkit'?await webkit.launch({headless:true}):await chromium.launch({channel:'msedge',headless:true});
  try{for(const width of [320,390,1280]){
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
      return route.fulfill({contentType:'application/json',body:JSON.stringify({bookings:[],customers:[],documents:[],hasMore:false,runs:[]})});
    });
    await page.goto(origin);await page.waitForFunction(()=>typeof NakiRouteOrder==='object');
    await page.evaluate(()=>{
      window.seedArrange=(yard=true)=>{
        state.stops=Array.from({length:18},(_,i)=>({id:'s'+(i+1),kind:yard&&i===11?'unload':undefined,src:'manual',status:'NEW',first_name:'Pickup '+(i+1),street:(i+1)+' Example Street',town:'Bell Block',lat:-39.05+i/10000,lng:174.15,appliances:yard&&i===11?[]:['Fridge']}));
        state.stops.push({id:'completed',status:'DONE',street:'Completed Street',appliances:['Dryer']});
        state.end={...GMS_YARD};state.roundTrip=true;state.manual=false;save();render();applyAppView('today');
      };
      drawRoute=()=>{};seedArrange();
    });
    await page.locator('#arrangeStops').click();
    assert.equal(await page.locator('#routeOrderFinish').isChecked(),true,'Move the GMS endpoint into the run by default');
    await page.locator('#routeOrderInput').fill(wanted);await page.locator('#routeOrderPreview').click();
    assert((await page.locator('#routeOrderPreviewList').innerText()).includes('Stops 1–9 stay'));
    assert.equal(await page.locator('#routeOrderSave').isDisabled(),false);
    assert.equal(await page.locator('#routeOrderDialog').evaluate(d=>d.scrollWidth>d.clientWidth+1),false);
    assert.equal(await page.evaluate(()=>state.stops[10].id),'s11','Preview does not reorder the live run');
    if(width===390&&!process.env.NAKI_PUBLIC_ORIGIN)await page.screenshot({path:path.join(root,'output','arrange-stops-phone.png')});
    await page.locator('#routeOrderSave').click();
    const saved=await page.evaluate(()=>({ids:state.stops.map(s=>s.id),manual:state.manual,end:state.end,roundTrip:state.roundTrip,yards:state.stops.filter(isUnload).length}));
    assert.deepEqual(saved.ids,[1,2,3,4,5,6,7,8,9,10,13,14,12,16,15,18,17,11].map(n=>'s'+n).concat('completed'));
    assert.equal(saved.manual,true);assert.equal(saved.end,null);assert.equal(saved.roundTrip,false);assert.equal(saved.yards,1);
    await page.reload();await page.waitForFunction(()=>typeof state==='object');
    assert.deepEqual(await page.evaluate(()=>state.stops.map(s=>s.id)),saved.ids,'Chosen order survives reload');
    await page.evaluate(()=>{
      drawRoute=()=>{};state.stops=Array.from({length:18},(_,i)=>({id:'s'+(i+1),status:'NEW',street:'Example '+i,town:'Bell Block',lat:-39.05,lng:174.15,appliances:['Fridge']}));state.end={...GMS_YARD};save();render();applyAppView('today');
    });
    await page.locator('#arrangeStops').click();await page.locator('#routeOrderInput').fill(wanted);await page.locator('#routeOrderPreview').click();
    assert((await page.locator('#routeOrderError').innerText()).includes('stop 12'));assert.equal(await page.locator('#routeOrderSave').isDisabled(),true);
    const complete='10,13,14,GMS,12,16,15,18,17,11';
    await page.locator('#routeOrderInput').fill(complete);await page.locator('#routeOrderPreview').click();
    await page.evaluate(()=>{window.storageSet=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key===RUNS_LS)throw Error('Synthetic storage full');return storageSet.call(this,key,value);};});
    await page.locator('#routeOrderSave').click();
    assert((await page.locator('#routeOrderError').innerText()).includes('previous order is kept'));
    assert.equal(await page.evaluate(()=>state.stops.filter(isUnload).length),0,'Failed saving does not insert an unload');
    assert.equal(await page.locator('#routeOrderInput').inputValue(),complete,'Keep the entered order for retry');
    await page.evaluate(()=>{Storage.prototype.setItem=storageSet;});await page.locator('#routeOrderSave').click();
    assert.equal(await page.evaluate(()=>state.stops.filter(isUnload).length),1,'Retry adds the unload exactly once');
    // A cloud/address change between preview and save must not apply old numbers.
    await page.locator('#arrangeStops').click();await page.locator('#routeOrderCurrent').click();await page.locator('#routeOrderPreview').click();
    await page.evaluate(()=>{state.stops[0].street='Changed address';});await page.locator('#routeOrderSave').click();
    assert((await page.locator('#routeOrderError').innerText()).includes('run changed'));
    assert.deepEqual(errors,[]);await page.close();
  }}finally{await browser.close();}
  console.log('PASS: exact requested order, GMS endpoint conversion, existing/new unloads, preview, omissions, saving/reload, failed-save rollback/retry and stale-run protection at 320/390/1280px');
})().catch(e=>{console.error(e);process.exitCode=1;});
