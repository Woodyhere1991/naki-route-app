const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),origin='https://pickup.test';
(async()=>{
 const model=await import(pathToFileURL(path.join(root,'assets/run-suggestions-model.mjs')));
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{for(const width of [320,390,1280]){
  const context=await browser.newContext({viewport:{width,height:950},serviceWorkers:'block'}),page=await context.newPage(),errors=[],requests=[];let snapshot,preview,approvals=0,failApprove=false;
  page.on('pageerror',e=>errors.push(e.message));
  const day=n=>new Date(Date.parse(model.nzDay())+n*86400000).toISOString().slice(0,10);
  const bookings=[{id:'WEB-A',firstName:'Synthetic pickup A',status:'NEW',streetAddress:'20 Example Street',town:'Waitara',items:['Fridge'],revision:{booking:100,note:0},...model.CENTRES.waitara},{id:'WEB-B',firstName:'Synthetic pickup B',status:'NEW',streetAddress:'10 Example Street',town:'Bell Block',items:['Dryer'],revision:{booking:100,note:0},...model.CENTRES.bellblock},{id:'WEB-C',firstName:'Synthetic pickup C',status:'NEW',streetAddress:'Example rural address',town:'Waitara',items:['Washing machine'],revision:{booking:100,note:0}}];
  await page.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());
   if(url.origin===origin){const target=path.resolve(root,url.pathname==='/'?'index.html':url.pathname.slice(1));if(!target.startsWith(root+path.sep)||!fs.existsSync(target))return route.fulfill({status:404,body:''});return route.fulfill({body:fs.readFileSync(target),contentType:/\.(m?js)$/.test(target)?'text/javascript':target.endsWith('.css')?'text/css':target.endsWith('.png')?'image/png':'text/html'});}
   requests.push({path:url.pathname,method:req.method()});let data={bookings:[],customers:[],towns:[],hasMore:false},status=200;
   if(url.pathname.endsWith('/run-suggestions/preview')){const body=req.postDataJSON();snapshot={...snapshot,runs:JSON.parse(body.runStamp)};preview={...model.buildGroups({store:snapshot,bookings,options:body.options}),id:'synthetic-preview-123',createdAt:Date.now(),baseSavedAt:100,runStamp:model.runStamp(snapshot),bookings};data=preview;}
   if(url.pathname.endsWith('/run-suggestions/approve')){approvals++;if(failApprove){status=409;data={error:'A booking changed after this preview. Generate fresh suggestions.'};}else{const body=req.postDataJSON(),s=structuredClone(snapshot),rows=body.group.bookingIds.map(id=>bookings.find(b=>b.id===id));assert.ok(body.options.availabilityConfirmed);model.validateGroup({store:s,bookings,options:body.options,group:body.group});s.runs.push({id:'new-synthetic',name:'Synthetic approved group',data:{stops:rows.filter(model.coords).map(b=>({id:b.id,submission_id:b.id,src:'direct',town:b.town,lat:b.lat,lng:b.lng,appliances:b.items,status:'NEW'})),bad:rows.filter(b=>!model.coords(b)).map(b=>({id:b.id,submission_id:b.id,src:'direct',town:b.town,appliances:b.items,status:'NEW'}))}});data={record:{savedAt:200,runCount:s.runs.length,data:{naki_pickup_runs_v1:JSON.stringify(s)}}};}}
   if(url.pathname.endsWith('/owner/backup/info'))data={latest:{savedAt:100}};
   return route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
  });
  await page.goto(origin+'/',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.nakiRunSuggestions);
  snapshot=await page.evaluate(()=>{ownerToken='synthetic-session';cloudBackupBusy=true;clearTimeout(cloudBackupTimer);state.stops=[];state.bad=[];state.unpaid=[];runStore.runs=[{id:'empty',name:'Synthetic empty run',data:runDataSnapshot()}];runStore.activeRunId='empty';localStorage.setItem(RUNS_LS,JSON.stringify(runStore));return JSON.parse(JSON.stringify(runStore));});
  await page.evaluate(()=>setAppView('bookings'));await page.locator('#suggestRuns').click();
  await page.locator('#suggestionsStart').selectOption('inglewood');await page.locator('#suggestionsDays').fill([day(1),day(2)].join('\n'));
  for(const [id,value] of [['suggestionsStartTime','08:00'],['suggestionsEndTime','16:00'],['suggestionsPickups','5'],['suggestionsItems','8'],['suggestionsMinutes','480'],['suggestionsService','10'],['suggestionsCorridor','20']])await page.locator('#'+id).fill(value);
  const before=await page.evaluate(()=>JSON.stringify(runStore));await page.locator('#suggestionsGenerate').click();await page.waitForFunction(()=>document.querySelector('.suggestion-group'));
  assert.equal(await page.evaluate(()=>JSON.stringify(runStore)),before,'preview does not mutate runs');
  assert.equal(await page.locator('[data-booking]').count(),3);assert.match(await page.locator('#suggestionsPreview').innerText(),/Weather unavailable/);
  await page.locator('[data-approve]').first().click();assert.match(await page.locator('#suggestionsStatus').innerText(),/availability/);assert.equal(approvals,0);
  await page.locator('#suggestionsAvailable').check();assert.equal(await page.locator('[data-approve]').count(),0,'changed constraints invalidate preview');
  await page.locator('#suggestionsGenerate').click();await page.waitForFunction(()=>document.querySelector('.suggestion-group'));
  await page.locator('[data-down]').first().click();await page.locator('[data-booking="WEB-C"] [data-include]').uncheck();
  assert.match(await page.locator('[data-approve]').first().innerText(),/edited/);
  assert.equal(await page.evaluate(()=>document.querySelector('#runSuggestionsDialog').scrollWidth>document.querySelector('#runSuggestionsDialog').clientWidth+1),false,width+'px dialog overflow');
  await page.screenshot({path:path.join(root,'output','suggestions-preview-'+width+'.png')});
  await page.evaluate(()=>cloudBackupBusy=false);failApprove=true;await page.locator('[data-approve]').first().click();await page.waitForFunction(()=>document.querySelector('#suggestionsStatus').textContent.includes('changed'));assert.equal(await page.evaluate(()=>JSON.stringify(runStore)),before,'failed approval leaves local runs unchanged');
  failApprove=false;await page.evaluate(()=>{const button=document.querySelector('[data-approve]');button.click();button.click();});await page.waitForFunction(()=>document.querySelector('#suggestionsStatus').textContent.includes('Group saved:'));
  const saved=await page.evaluate(()=>({runs:runStore.runs.length,events:JSON.parse(localStorage.getItem('naki_run_suggestion_audit_v1'))}));assert.equal(saved.runs,2);assert.ok(saved.events.some(e=>e.type==='edited'));assert.ok(saved.events.some(e=>e.type==='accepted'));assert.equal(approvals,2);assert.equal(requests.some(r=>/send-|bulk-confirm|\/bookings\/.*$/.test(r.path)&&r.method!=='GET'),false,'no customer actions');assert.deepEqual(errors,[]);await context.close();
 }
 // The self-contained synthetic demo must never invoke the suggestion API.
 const context=await browser.newContext({viewport:{width:390,height:950},serviceWorkers:'block'}),page=await context.newPage();let planningCalls=0;
 await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin){const file=path.resolve(root,url.pathname==='/'?'index.html':url.pathname.slice(1));return route.fulfill({body:fs.existsSync(file)?fs.readFileSync(file):'',contentType:/\.(m?js)$/.test(file)?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});}if(url.pathname.includes('run-suggestions'))planningCalls++;return route.fulfill({contentType:'application/json',body:'{}'});});
 await page.goto(origin+'/?suggestions-demo=1');await page.waitForFunction(()=>window.nakiRunSuggestions);assert.match(await page.locator('#runSuggestionsDialog').innerText(),/Demo — synthetic bookings/);assert.equal(planningCalls,0);await context.close();
 console.log('PASS: group preview, editable settings/order/membership, availability gate, failed/successful approval, private audit, no customer writes and synthetic demo at 320/390/1280px.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
