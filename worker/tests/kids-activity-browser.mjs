// Browser -> real Worker handler -> local SQLite -> private report UI.
// Synthetic counts stay in memory. No production database or email is touched.
import {createRequire} from 'node:module';
const {chromium}=createRequire(new URL('../../../customer-site/tests/kids-learning-browser.mjs',import.meta.url))('playwright');
import assert from 'node:assert/strict';
import {readFileSync,existsSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {activityHarness} from './kids-activity.test.mjs';
import worker from '../src/index.js';
import {nzDay} from '../src/kids-activity.js';
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
  // The report now sits at the top of the public Naki Kids page, so the child
  // opening that page must see nothing of it at all.
  await p.goto('https://nakiwhitewareremoval.vip/kids');
  assert.ok(!(await p.locator('#ownerActivity').isVisible()));
  assert.equal(await p.locator('#ownerActivity').evaluate(el=>el.childElementCount),0);

  // A stale or forged token earns a 401, and the child still sees nothing.
  // This has to run before the synthetic session is seeded below, because that
  // seeding happens on every navigation.
  await p.evaluate(()=>localStorage.setItem('naki_owner_token','not-a-real-session'));
  await p.goto('https://nakiwhitewareremoval.vip/kids');
  await p.waitForFunction(()=>!localStorage.getItem('naki_owner_token'));
  assert.ok(!(await p.locator('#ownerActivity').isVisible()));

  // The plays above went to the test bucket; the report reads the live one, so
  // give it a live row of its own to find.
  h.db.prepare("INSERT INTO kids_activity_daily VALUES(?,'share','live',4,3)").run(nzDay(Date.now()));
  await context.addInitScript(()=>{try{localStorage.setItem('naki_owner_token','owner-test');}catch{/* blocked storage is handled by the page */}});
  await p.goto('https://nakiwhitewareremoval.vip/kids');
  await p.getByText('4 plays started · 3 rounds completed',{exact:true}).waitFor();
  assert.ok((await p.locator('.owner-table').textContent()).includes('Fair Share Picnic'));
  await p.screenshot({path:fileURLToPath(new URL('owner-panel-390.png',out)),fullPage:true});
  await p.selectOption('#ownerRange','30');await p.getByRole('button',{name:'Refresh'}).and(p.locator(':enabled')).waitFor();
  await p.setViewportSize({width:1280,height:900});await p.screenshot({path:fileURLToPath(new URL('owner-panel-1280.png',out)),fullPage:true});

  // Signing out has to put the page back to what a child would see.
  await p.getByRole('button',{name:'Sign out'}).click();
  assert.ok(!(await p.locator('#ownerActivity').isVisible()));
  assert.equal(await p.evaluate(()=>localStorage.getItem('naki_owner_token')),null);
  assert.deepEqual(errors,[]);console.log('PASS: real game start/finish reach SQLite once; opt-out works; the kids page hides the report from everyone but a signed-in owner, shows the counts at phone/desktop widths, and clears on logout or a dead session.');
}finally{await browser.close();h.db.close();}
