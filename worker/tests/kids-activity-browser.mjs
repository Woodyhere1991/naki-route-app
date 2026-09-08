// Browser -> real Worker handler -> local SQLite -> private report UI.
// Synthetic counts stay in memory. No production database or email is touched.
import {createRequire} from 'node:module';
const {chromium}=createRequire(new URL('../../../customer-site/tests/kids-learning-browser.mjs',import.meta.url))('playwright');
import assert from 'node:assert/strict';
import {readFileSync,existsSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {activityHarness} from './kids-activity.test.mjs';
import worker from '../src/index.js';
const publicRoot=new URL('../../../customer-site/',import.meta.url);
const root=new URL('../../',import.meta.url);
const out=new URL('output/kids-activity/',root);mkdirSync(out,{recursive:true});
const h=activityHarness(),browser=await chromium.launch({channel:'msedge',headless:true}),events=[],errors=[];
try{
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block',reducedMotion:'reduce'});
  await context.route('https://nakiwhitewareremoval.vip/**',async route=>{
    const pathname=new URL(route.request().url()).pathname,path=pathname==='/kids'||pathname==='/kids.html'?'kids.html':pathname.slice(1);
    const file=new URL(path,publicRoot);if(!existsSync(file)){await route.fulfill({status:404,body:'Missing fixture'});return;}
    const type=path.endsWith('.js')?'application/javascript':path.endsWith('.css')?'text/css':path.endsWith('.html')?'text/html':path.endsWith('.png')?'image/png':'image/webp';
    await route.fulfill({status:200,contentType:type,body:readFileSync(file)});
  });
  await context.route('https://naki-route-api.nakiwreckremoval.workers.dev/**',async route=>{
    const r=route.request();if(r.method()==='POST')events.push(JSON.parse(r.postData()));
    const response=await worker.fetch(new Request(r.url(),{method:r.method(),headers:r.headers(),...(r.method()==='POST'?{body:r.postData()}: {})}),h.env);
    await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});
  });
  const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto('https://nakiwhitewareremoval.vip/kids?kids-test=1');
  assert.equal(await p.locator('[data-kid="feelings"]').count(),0);await p.locator('[data-kid="share"]').click();
  await Promise.all([p.waitForResponse(r=>r.url().includes('/kids/activity')&&r.request().method()==='POST'),p.locator('#workStart').click()]);
  for(let at=0;at<6;at++){
    const[total,friends]=(await p.locator('#workAsk').textContent()).match(/\d+/g).map(Number);
    for(let i=1;i<=friends;i++)for(let j=0;j<total/friends;j++)await p.getByRole('button',{name:'Give an apple to Friend '+i,exact:true}).click();
    await p.getByRole('button',{name:'Check our picnic',exact:true}).click();
    if(at===5)await Promise.all([p.waitForResponse(r=>r.url().includes('/kids/activity')&&r.request().method()==='POST'),p.locator('#workNext').click()]);else await p.locator('#workNext').click();
  }
  assert.deepEqual(events.map(e=>e.kind),['start','finish']);assert.deepEqual({...h.db.prepare('SELECT starts,finishes FROM kids_activity_daily').get()},{starts:1,finishes:1});
  await p.locator('#kidBack').click();await p.locator('.grownups summary').click();await p.locator('#kidCounting').uncheck();await p.locator('[data-kid="share"]').click();await p.locator('#workStart').click();assert.equal(events.length,2);
  // Use the actual shipped panel and Worker owner route; counts above are test-only.
  const app=readFileSync(new URL('index.html',root),'utf8'),card=app.match(/<details class="card" id="kidsActivityCard"[\s\S]*?<\/details>/)[0],css=app.match(/<style>([\s\S]*?)<\/style>/)[1];
  await p.setContent(`<style>${css}</style><main style="padding:12px">${card}</main>`);
  await p.addScriptTag({content:readFileSync(new URL('assets/kids-activity-panel.js',root),'utf8')});
  await p.evaluate(()=>{
    window.testOwnerToken='owner-test';
    window.testPanel=window.KidsActivityPanel.mount({token:()=>window.testOwnerToken,api:async path=>{
      const r=await fetch('https://naki-route-api.nakiwreckremoval.workers.dev/v2'+path+'&test=1',{headers:{Authorization:'Bearer '+window.testOwnerToken}});
      if(!r.ok)throw Error('Rejected');return r.json();
    }});
  });
  await p.locator('#kidsActivityCard summary').click();await p.getByText('1 play started · 1 round completed',{exact:true}).waitFor();
  assert.ok((await p.locator('.kids-activity-table').textContent()).includes('Fair Share Picnic'));
  await p.screenshot({path:fileURLToPath(new URL('owner-panel-390.png',out)),fullPage:true});
  await p.selectOption('#kidsActivityRange','30');await p.locator('#kidsActivityRefresh:enabled').waitFor();
  await p.setViewportSize({width:1280,height:900});await p.screenshot({path:fileURLToPath(new URL('owner-panel-1280.png',out)),fullPage:true});
  await p.evaluate(()=>{window.testOwnerToken='';window.testPanel.visibility();});assert.ok(!(await p.locator('#kidsActivityCard').isVisible()));assert.equal(await p.locator('#kidsActivityBody').textContent(),'');
  assert.deepEqual(errors,[]);console.log('PASS: real game start/finish reach SQLite once; opt-out works; owner report shows the counts at phone/desktop widths and clears on logout.');
}finally{await browser.close();h.db.close();}
