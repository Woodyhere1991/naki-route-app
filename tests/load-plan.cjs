const assert=require('node:assert/strict'),fs=require('node:fs'),plan=require('../assets/load-plan.js');
const stop=(appliances,extra={})=>({id:'a',appliances,...extra});
const load=appliances=>plan.build([stop(appliances)])[0];
assert.deepEqual(plan.parse('Fridge x3'),{name:'Fridge',quantity:3});
assert.deepEqual(plan.parse('2 × Dryer'),{name:'Dryer',quantity:2});
for(const name of ['French-door fridge','Double door fridge','Large or French-door fridge','side-by-side refrigerator','Large chest freezer (over 1.5 m)','Chest freezer 1.8m','Chest freezer 160cm','Chest freezer over 150 cm','Chest freezer 1600mm'])assert.equal(plan.classify(name).half,3,name);
for(const name of ['Fridge or upright freezer','Upright freezer','Chest freezer (small or medium)','Chest freezer 1.5m','Chest freezer 150cm','Freezer','Oven or stove'])assert.equal(plan.classify(name).half,2,name);
for(const name of ['TV','Bicycle','Exercise bike','Lawn mower','Microwave','Other','Other - small bits'])assert.equal(plan.classify(name).group,'small',name);
let p=load(['Fridge x14','Washing machine x8','Other x3']);
assert.equal(p.units,18);assert.equal(p.trailer.length,18);assert.equal(p.trailer.filter(i=>i.fridge).length,12);assert.equal(p.leftover.length,4);assert.equal(p.small.length,3);
p=load(['Washing machine x19']);assert.equal(p.units,18);assert.equal(p.trailer.length,18);assert.equal(p.leftover.length,1);
p=load(['Fridge x18']);assert.equal(p.units,12);assert.equal(p.trailer.length,12);assert.equal(p.leftover.length,6,'Keep the owner-specified 12-fridge limit');
p=load(['Fridge x10','Large fridge x2','Dryer x6']);
assert.equal(p.units,18);assert.equal(p.trailer.filter(i=>i.fridge).length,11);assert.equal(p.trailer.filter(i=>i.half===3).length,2,'Choose an equally fridge-rich combination that fills 18, instead of leaving 0.5 unused');
p=load(['Fridge x9','Large chest freezer (over 1.5 m) x2','Dryer x6']);assert.equal(p.units,18);assert.equal(p.trailer.length,17);assert.equal(p.coldUnits,12);
p=load(['Fridge x10','Large fridge','Washing machine x7','Other']);assert.equal(p.units,17.5);assert.equal(p.leftover.length,1);assert.equal(p.small.length,1);
assert(plan.summary([stop(['Fridge x10','Large fridge','Washing machine x7'])]).includes('½ space spare'));
// Chest freezers must not displace fridges just because they appear first.
p=load(['Chest freezer x12','Fridge x12','Dryer x6']);assert.equal(p.trailer.filter(i=>i.fridge).length,12);assert.equal(p.units,18);
const stops=[stop(['Fridge','Microwave','Other','Unspecified furniture']),stop(['Dryer x2'],{id:'b'}),stop(['Dishwasher'],{id:'done',status:'DONE'}),stop(['Fridge'],{id:'cancelled',status:'CANCELLED'})];
const before=JSON.stringify(stops);p=plan.build(stops)[0];assert.equal(p.units,3);assert.equal(p.small.length,2);assert.equal(p.check.length,1);assert.equal(JSON.stringify(stops),before);
const split=plan.build([stop(['Fridge x12','Dryer x6']),{id:'yard',kind:'unload'},stop(['Washing machine x18'],{id:'b'})]);assert.equal(split.length,2);assert(split.every(l=>l.units===18&&l.leftover.length===0));
assert.equal(plan.build([stop([])])[0].check[0].missing,true);
const unsafe=plan.summary([stop(['<img src=x onerror=alert(1)>'])]);assert(!unsafe.includes('<img'));assert(unsafe.includes('&lt;img'));
const html=fs.readFileSync('index.html','utf8'),css=fs.readFileSync('assets/load-plan.css','utf8');
for(const removed of ['loadPlanPicture','loadPictureDetails','loadPlanUte','lp-block','lp-layer'])assert(!html.includes(removed)&&!css.includes(removed),removed+' fully removed');
assert.equal(plan.render,undefined,'No picture renderer remains');
// Independent exhaustive count search proves the intended priority order:
// most fridges, then fullest trailer, then most whole appliances.
let cases=0;
for(let regular=0;regular<=14;regular++)for(let big=0;big<=6;big++)for(let standard=0;standard<=20;standard++){
  const p=load([...Array(regular).fill('Fridge'),...Array(big).fill('Large fridge'),...Array(standard).fill('Dryer')]);
  let best=[-1,-1,0,0];
  for(let a=0;a<=regular;a++)for(let b=0;b<=big;b++)if(a*2+b*3<=24)for(let c=0;c<=standard;c++)if(a*2+b*3+c*2<=36){
    // Big fridges first, then fridge count, then space used, then item count.
    const score=[b,a+b,a*2+b*3+c*2,a+b+c];
    if(String(score.map(n=>String(n).padStart(3,'0')))>String(best.map(n=>String(Math.max(n,0)).padStart(3,'0')))||best[0]<0)best=score;
  }
  assert.deepEqual([p.trailer.filter(i=>i.large).length,p.trailer.filter(i=>i.fridge).length,p.units*2,p.trailer.length],best);
  assert.equal(p.trailer.length+p.leftover.length,regular+big+standard);assert(p.units<=18&&p.coldUnits<=12);
  assert.equal(new Set(p.trailer.map(i=>i.key)).size,p.trailer.length);cases++;
}
{const p=load(['Fridge x12','Large or French-door fridge x2','Large chest freezer (over 1.5 m) x2','big chest freezer']);
  assert.equal(p.leftover.filter(i=>i.large).length,0,'Big fridges and large chest freezers load first');assert.equal(p.trailer.filter(i=>i.large).length,5);}
console.log(`PASS: no pictures, big items first, fridge priority, 18-space fill, 12-fridge space limit, 1.5m chest boundary, leftovers, small Other, unloads and ${cases} exhaustive packing cases`);
