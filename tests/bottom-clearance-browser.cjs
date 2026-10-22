// Every page scrolled to the bottom: the last thing on it must sit fully above
// the fixed bottom bar, including when the bar is taller (iPhone home-bar gap).
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.NAKI_PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{for(const [width,height] of [[320,568],[390,844],[430,932]]) for(const homeBar of [0,34]){
  const page=await browser.newPage({viewport:{width,height},serviceWorkers:'block'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{const url=new URL(route.request().url());
   if(url.hostname==='pickup.test'){const rel=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1)),target=path.resolve(root,rel);
    if(!target.startsWith(root+path.sep)||!fs.existsSync(target))return route.fulfill({status:404,body:''});
    return route.fulfill({status:200,contentType:/\.m?js$/.test(target)?'text/javascript':target.endsWith('.css')?'text/css':target.endsWith('.png')?'image/png':'text/html',body:fs.readFileSync(target)});}
   return route.fulfill({status:200,contentType:'application/json',body:'{"bookings":[],"customers":[],"documents":[],"ok":true}'});});
  await page.goto('https://pickup.test/',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>typeof setAppView==='function');
  // Stand in for the iPhone home-bar gap the real bar pads itself with.
  if(homeBar)await page.addStyleTag({content:`.bottom-nav{padding-bottom:${8+homeBar}px!important}`});
  for(const view of ['today','add','bookings','customers','messages']){
   await page.evaluate(v=>{applyAppView(v);},view);
   await page.waitForTimeout(150);
   const r=await page.evaluate(()=>{
    window.scrollTo(0,document.documentElement.scrollHeight);
    const nav=document.querySelector('.bottom-nav').getBoundingClientRect();
    const items=[...document.querySelectorAll('.view-panel button,.view-panel a,.view-panel input,.view-panel .card')].filter(e=>{const s=getComputedStyle(e);const b=e.getBoundingClientRect();const folded=e.closest('details:not([open])');return b.height>0&&s.visibility!=='hidden'&&!(folded&&!e.closest('summary'))&&e.closest('.view-panel')&&getComputedStyle(e.closest('.view-panel')).display!=='none';});
    const lowest=Math.max(...items.map(e=>e.getBoundingClientRect().bottom));
    return {navTop:nav.top,lowest,count:items.length};
   });
   assert.ok(r.count>0,`${view} has content`);
   assert.ok(r.lowest<=r.navTop-8,`${view} at ${width}x${height} home bar ${homeBar}: last item bottom ${r.lowest} must clear bar top ${r.navTop}`);
  }
  assert.deepEqual(errors,[]);await page.close();
 }}finally{await browser.close();}
 console.log('PASS: Scheduled, Add, Bookings, Customers and Messages scroll fully clear of the bottom bar at 320/390/430px, with and without an iPhone home-bar gap.');
})().catch(e=>{console.error(e);process.exit(1);});
