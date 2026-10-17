const assert=require('node:assert/strict'),plan=require('../assets/load-plan.js');
const stop=(appliances,extra={})=>({id:'a',appliances,...extra});
assert.deepEqual(plan.parse('Fridge x3'),{name:'Fridge',quantity:3});
assert.deepEqual(plan.parse('2 × Dryer'),{name:'Dryer',quantity:2});
for(const name of ['French-door fridge','Double door fridge','Large or French-door fridge','side-by-side refrigerator'])assert.equal(plan.classify(name).half,3);
for(const name of ['Fridge or upright freezer','Fridge/freezer','Upright freezer'])assert.equal(plan.classify(name).half,2);
for(const name of ['Washing machine','Dryer','Dishwasher'])assert.equal(plan.classify(name).group,'box');
for(const name of ['TV','Bicycle','Exercise bike','Elliptical trainer','Lawn mower','Microwave'])assert.equal(plan.classify(name).group,'gap');
for(const name of ['Freezer','Chest freezer','Oven','Other'])assert.equal(plan.classify(name).group,'check');
let p=plan.build([stop(Array(18).fill('Fridge'))])[0];assert.equal(p.units,18);assert.equal(p.placements.length,18);assert.equal(p.overflow.length,0);
p=plan.build([stop(['Large or French-door fridge x2','Fridge x3'])])[0];
assert.equal(p.units,6);assert.equal(p.placements.filter(i=>i.group==='big'&&i.row===2&&i.level===0).length,2);
assert.equal(p.placements.filter(i=>i.group==='tall'&&i.row===2&&i.level===1).length,3,'Three standard fridges sit above two wide fridge spaces');
p=plan.build([stop(['Washing machine x19'])])[0];assert.equal(p.overflow.length,1);assert.equal(p.placements.length,18);assert.equal(p.units,19);
const mixed=[stop(['Fridge','Microwave','TV','Unknown thing']),stop(['Dryer x2'],{id:'b'}),stop(['Dishwasher'],{id:'done',status:'DONE'}),stop(['Fridge'],{id:'cancelled',status:'CANCELLED'})];
const before=JSON.stringify(mixed);p=plan.build(mixed)[0];assert.equal(p.units,3);assert.equal(p.gaps.length,2);assert.equal(p.check.length,1);assert.equal(JSON.stringify(mixed),before);
const key=p.placements[0].key,move=plan.build(mixed,{[key]:true})[0];assert.equal(move.ute.length,1);assert.equal(move.units,2);
assert.equal(plan.build(JSON.parse(before),JSON.parse(JSON.stringify({[key]:true})))[0].ute.length,1,'Stable identity survives reload');
const split=plan.build([stop(['Fridge x18']),{id:'yard',kind:'unload'},stop(['Washing machine x18'],{id:'b'})]);assert.equal(split.length,2);assert(split.every(l=>l.overflow.length===0));
assert.equal(plan.build([stop([])])[0].check[0].missing,true,'Missing appliance details must remain visible');
const unsafe=plan.render([stop(['<img src=x onerror=alert(1)>'])]);assert(!unsafe.includes('<img'));assert(unsafe.includes('&lt;img'));
const simple=plan.summary([stop(['Fridge x3','Large fridge x2','Dryer','TV x2','Chest freezer'])]);
assert(simple.includes('About 11 spaces left'));assert(simple.includes('Trailer appliances'));assert(simple.includes('For the gaps'));assert(simple.includes('Check separately'));
assert(!simple.includes('data-load-key'),'Default summary has no placement controls to interpret');
// Many mixes: every item remains accounted for, each row stays within three
// standard spaces, the two wide fridges never overlap, and no top block floats.
for(let big=0;big<=8;big++)for(let standard=0;standard<=20;standard++){
  const raw=[...Array(big).fill('Large fridge'),...Array(standard).fill('Washing machine')];
  const load=plan.build([stop(raw)])[0];
  assert.equal(load.placements.length+load.overflow.length,big+standard);
  const used=new Set();for(const item of load.placements){
    assert(item.col+item.half<=6);for(let col=item.col;col<item.col+item.half;col++){
      const key=`${item.level}:${item.row}:${col}`;assert(!used.has(key));used.add(key);
      if(item.level===1)assert(load.cells[0][item.row][col]);
    }
  }
}
console.log('PASS: 18 spaces, 1.5-width big fridges, preferred rows, gap candidates, overflow, ute moves, unloads, quantities, missing details, escaping and 189 packing mixes');
