const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
const root=path.resolve(__dirname,'..'),origin=process.env.NAKI_PUBLIC_ORIGIN||'https://pickup.test';
(async()=>{
  const safari=process.env.NAKI_BROWSER==='webkit';
  const browser=safari?await webkit.launch({headless:true}):await chromium.launch({channel:'msedge',headless:true});
  try{for(const width of [320,390,1280]){
    const page=await browser.newPage({viewport:{width,height:950},serviceWorkers:'block',hasTouch:true}),errors=[];
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
    await page.goto(origin);await page.waitForFunction(()=>typeof NakiRouteOrganizer==='object');
    await page.evaluate(()=>{
      state.stops=Array.from({length:18},(_,i)=>({id:'s'+(i+1),src:'manual',status:'NEW',first_name:'Pickup '+(i+1),street:(i+1)+' Example Street',town:'Bell Block',lat:-39.05+i*.001,lng:174.15+(i%3)*.002,geoLabel:(i+1)+' Example Street, Bell Block, New Zealand',pinFix:8,appliances:['Fridge']}));
      state.stops.push({id:'completed',status:'DONE',street:'1 Completed Street',geoLabel:'1 Completed Street, New Zealand',lat:-39.06,lng:174.16,pinFix:8,appliances:['Dryer']});
      state.end={...GMS_YARD};state.roundTrip=true;state.manual=false;
      window.draftRouteCalls=[];window.failDraftRoute=false;
      NakiRouting.safeRoute=async points=>{draftRouteCalls.push(points.map(p=>[p.lat,p.lng]));if(failDraftRoute)throw Error('offline');return {geometry:{type:'LineString',coordinates:points.map(p=>[p.lng,p.lat])},legs:points.slice(1).map(()=>({duration:60})),distance:18000,duration:1000,detours:[]};};
      drawRoute=()=>{};save();render();applyAppView('today');
    });
    await page.locator('#arrangeStops').click();
    await page.waitForFunction(()=>routeOrderEditor.getMap()&&document.querySelector('#routeOrderList')._sortable!==null);
    await page.waitForFunction(()=>document.querySelector('#routeOrderMapState').textContent.includes('matches'));
    assert.equal(await page.locator('#routeOrderList > .route-order-row').count(),18);
    assert.equal(await page.locator('#routeOrderInput').count(),0,'No number-typing form');
    assert.equal(await page.locator('#routeOrderFinish').isChecked(),false,'Opening matches the saved route including E');
    assert.equal(await page.locator('#routeOrderDialog').evaluate(d=>d.scrollWidth>d.clientWidth+1),false);
    const first=await page.locator('[data-order-key="s1"] .route-order-handle').boundingBox();
    const second=await page.locator('[data-order-key="s2"]').boundingBox();
    await page.mouse.move(first.x+first.width/2,first.y+first.height/2);await page.mouse.down();
    await page.mouse.move(first.x+first.width/2,second.y+second.height-3,{steps:14});await page.waitForTimeout(180);await page.mouse.up();
    await page.waitForFunction(()=>routeOrderDraft.order[0].id==='s2');
    assert.equal(await page.locator('[data-order-key="s1"] .route-order-number').innerText(),'2');
    const pin=await page.evaluate(()=>{let found;routeOrderEditor.getMap().eachLayer(layer=>{if(layer.options?.routeOrderKey==='s1')found=layer.options.icon.options.html;});return found;});
    assert(pin.includes('>2<'),'Map renumbers with the dragged list');
    assert.equal(await page.evaluate(()=>state.stops[0].id),'s1','Dragging only changes the preview');
    if(!safari&&width===390){
      await page.locator('#routeOrderReset').click();
      const a=await page.locator('[data-order-key="s1"] .route-order-handle').boundingBox(),b=await page.locator('[data-order-key="s2"]').boundingBox();
      const cdp=await page.context().newCDPSession(page),x=a.x+a.width/2,y=a.y+a.height/2;
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});await page.waitForTimeout(230);
      for(let i=1;i<=12;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y+(b.y+b.height-3-y)*i/12}]});
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForFunction(()=>routeOrderDraft.order[0].id==='s2');await cdp.detach();
    }
    await page.waitForFunction(()=>document.querySelector('#routeOrderMapState').textContent.includes('matches'));
    await page.evaluate(()=>{window.goodRoute=NakiRouting.safeRoute;window.heldRoutes=[];NakiRouting.safeRoute=points=>new Promise(resolve=>heldRoutes.push({points,resolve}));});
    await page.locator('[data-order-key="s1"] [data-order-step="-1"]').click();await page.waitForFunction(()=>heldRoutes.length===1);
    await page.locator('[data-order-key="s1"] [data-order-step="1"]').click();await page.waitForFunction(()=>heldRoutes.length===2);
    await page.evaluate(()=>{const held=heldRoutes[1];held.resolve({geometry:{type:'LineString',coordinates:held.points.map(p=>[p.lng,p.lat])}});});
    await page.waitForFunction(()=>document.querySelector('#routeOrderMapState').textContent.includes('matches'));
    await page.evaluate(()=>{const held=heldRoutes[0];held.resolve({geometry:{type:'LineString',coordinates:held.points.map(p=>[p.lng,p.lat])}});});
    await page.waitForTimeout(50);
    assert(await page.evaluate(()=>{let coordinates;routeOrderEditor.getMap().eachLayer(layer=>{if(layer.feature?.geometry.type==='LineString')coordinates=layer.feature.geometry.coordinates;});return JSON.stringify(coordinates)===JSON.stringify(heldRoutes[1].points.map(p=>[p.lng,p.lat]));}),'Old network result cannot overwrite the latest draft route');
    await page.evaluate(()=>{NakiRouting.safeRoute=goodRoute;});
    const mapY=await page.locator('#routeOrderMap').boundingBox();
    await page.evaluate(()=>{routeOrderEditor.getMap().eachLayer(layer=>{if(layer.options?.routeOrderKey==='s14')layer.fire('click');});});
    assert((await page.locator('[data-order-key="s14"]').getAttribute('class')).includes('is-selected'));
    assert.equal((await page.locator('#routeOrderMap').boundingBox()).y,mapY.y,'Map stays visible while list scrolls');
    await page.locator('#routeOrderAddGms').click();
    const gms=await page.evaluate(()=>routeOrderDraft.order.find(s=>s.newUnload).id);
    assert.equal(await page.evaluate(()=>routeOrderDraft.order.findIndex(s=>s.newUnload)),14,'GMS inserted after selected pickup 14');
    assert.equal(await page.locator('#routeOrderFinish').isChecked(),true,'Move final GMS into the draft route');
    // Move the yard with the same accessible controls, which also update the map.
    await page.locator(`[data-order-key="${gms}"] [data-order-step="1"]`).click();
    assert.equal(await page.evaluate(()=>routeOrderDraft.order.findIndex(s=>s.newUnload)),15);
    await page.waitForFunction(()=>document.querySelector('#routeOrderMapState').textContent.includes('matches'));
    assert(await page.evaluate(()=>draftRouteCalls.at(-1).length===routeOrderDraft.order.length+1),'Updated road line uses draft order and removes E');
    if(width===390&&!process.env.NAKI_PUBLIC_ORIGIN)await page.screenshot({path:path.join(root,'output','arrange-map-phone.png')});
    const original=await page.evaluate(()=>state.stops.map(s=>s.id));
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>state.stops.map(s=>s.id)),original,'Cancel discards all edits');
    await page.locator('#arrangeStops').click();await page.waitForFunction(()=>routeOrderEditor.getMap());
    await page.locator('[data-order-key="s1"] [data-order-step="1"]').click();await page.locator('#routeOrderAddGms').click();
    const draftIds=await page.evaluate(()=>routeOrderDraft.order.filter(s=>!s.newUnload).map(s=>s.id));
    await page.evaluate(()=>{window.storageSet=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key===RUNS_LS)throw Error('Synthetic storage full');return storageSet.call(this,key,value);};});
    await page.locator('#routeOrderSave').click();assert((await page.locator('#routeOrderError').innerText()).includes('previous order is kept'));
    assert.deepEqual(await page.evaluate(()=>state.stops.map(s=>s.id)),original);
    await page.evaluate(()=>{Storage.prototype.setItem=storageSet;});await page.locator('#routeOrderSave').click();
    assert.equal(await page.evaluate(()=>state.stops.filter(isUnload).length),1);
    assert.deepEqual(await page.evaluate(()=>routeStops().filter(s=>!isUnload(s)).map(s=>s.id)),draftIds);
    assert.equal(await page.evaluate(()=>state.manual),true);assert.equal(await page.evaluate(()=>state.end),null);
    await page.reload();await page.waitForFunction(()=>typeof state==='object');assert.equal(await page.evaluate(()=>state.stops.filter(isUnload).length),1);
    await page.evaluate(()=>{NakiRouting.safeRoute=async()=>{throw Error('offline');};});
    await page.locator('#arrangeStops').click();await page.waitForFunction(()=>document.querySelector('#routeOrderMapState').textContent.includes('unavailable'));
    assert.equal(await page.locator('#routeOrderMap .leaflet-overlay-pane path').count(),1,'Offline map contains only the blocked-bridge circle, no unverified road line');
    await page.evaluate(()=>{state.stops[0].street='Changed address';});await page.locator('#routeOrderSave').click();assert((await page.locator('#routeOrderError').innerText()).includes('run changed'));
    assert.deepEqual(errors,[]);await page.close();
  }}finally{await browser.close();}
  console.log('PASS: actual drag and touch hold, live numbered map, selected-pin scroll, GMS insertion/move, cancel, save/reload, storage retry, offline line rejection and stale-run guard at 320/390/1280px');
})().catch(e=>{console.error(e);process.exitCode=1;});
