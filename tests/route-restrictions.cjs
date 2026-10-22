const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('assets/route-restrictions.js','utf8');
const west={lat:-39.04734,lng:174.2535},east={lat:-39.04736,lng:174.2564};
const geom=points=>({type:'LineString',coordinates:points.map(p=>[p.lng,p.lat])});
const coord=p=>`${p.lng},${p.lat}`;
function environment(handler){
  const context={module:{exports:{}},setTimeout,clearTimeout,AbortController,URL,fetch:handler};
  vm.runInNewContext(source,context);return context.module.exports;
}
function response(route){return {ok:true,json:async()=>({code:'Ok',routes:[route]})};}
function route(points,duration=100){
  const legs=points.slice(1).map((p,i)=>({duration,distance:1000,steps:[{geometry:geom([points[i],p])}]}));
  return {geometry:geom(points),legs,duration:legs.length*duration,distance:legs.length*1000};
}
function urlPoints(url){return new URL(url).pathname.split('/').pop().split(';').map(p=>{const [lng,lat]=p.split(',').map(Number);return {lng,lat};});}
(async()=>{
  let r=environment(async()=>{throw Error('offline');});
  assert(r.blocked(geom([west,east])),'A sparse segment crossing the bridge is blocked');
  assert(r.blocked(geom([east,west])),'Both directions are blocked');
  assert(!r.blocked(geom(r.bypass)),'The bypass is outside the blocked area');
  assert.throws(()=>r.blocked({type:'LineString',coordinates:[]}),/Could not verify/);
  assert.throws(()=>r.blocked(geom([{lat:NaN,lng:174},east])),/Could not verify/);
  await assert.rejects(()=>r.safeRoute([west,east]),/offline/);
  for(const points of [[west,east],[east,west]]){
    const calls=[];
    r=environment(async url=>{
      calls.push(url);const p=urlPoints(url);
      // One candidate still crosses the blocked bridge after its waypoint.
      if(p.length===4&&coord(p[1])===coord(points[0]===west?r.bypass[0]:r.bypass[1]))return response(route(p));
      return response(route([points[0],points[1]]));
    });
    const safe=await r.safeRoute(points);
    assert(!r.blocked(safe.geometry));assert.equal(safe.legs.length,1,'Bypass legs are folded into the original pickup leg');
    assert.equal(safe.duration,300);assert.equal(safe.detours.length,1);
    assert.equal(calls.length,5,'Try each single waypoint, then both bypass directions');
  }
  // When one waypoint is enough, Maps gets one extra stop, not two.
  r=environment(async url=>{const p=urlPoints(url);return response(p.length===3&&coord(p[1])===coord(r.bypass[0])?route(p):route([p[0],p[p.length-1]]));});
  const single=await r.safeRoute([west,east]);assert(!r.blocked(single.geometry));assert.equal(single.detours[0].via.length,1);
  r=environment(async()=>response(route([west,east])));
  await assert.rejects(()=>r.safeRoute([west,east]),/Could not verify/,'An unsafe candidate is never returned');
  const far=[{lat:-39.2,lng:174.1},{lat:-39.3,lng:174.1}];let count=0;
  r=environment(async()=>{count++;return response(route(far));});
  const normal=await r.safeRoute(far);assert.equal(normal.detours.length,0);assert.equal(count,1);
  // Shortest paths through probes 2/3 take 30s. Bypass 4/5 takes 1600s.
  const d=Array.from({length:6},(_,i)=>Array.from({length:6},(_,j)=>i===j?0:Infinity));
  for(const [i,j,cost] of [[0,2,10],[2,3,10],[3,1,10],[0,4,600],[4,5,400],[5,1,600]])d[i][j]=d[j][i]=cost;
  for(let k=0;k<6;k++)for(let i=0;i<6;i++)for(let j=0;j<6;j++)d[i][j]=Math.min(d[i][j],d[i][k]+d[k][j]);
  r=environment(async()=>({ok:true,json:async()=>({code:'Ok',durations:d})}));
  const matrix=await r.matrix([west,east]);
  assert.equal(matrix[0][1],1600);assert.equal(matrix[1][0],1600,'Optimiser costs include the detour in both directions');
  // Trips nowhere near the bridge skip the route server; trips that could use it don't.
  const P={westown:{lat:-39.07,lng:174.06},bellBlock:{lat:-39.032,lng:174.148},oakura:{lat:-39.117,lng:173.953},
    np:{lat:-39.056,lng:174.075},hawera:{lat:-39.591,lng:174.284},normanby:{lat:-39.541,lng:174.287},
    tataraimaka:{lat:-39.1563,lng:173.9156},inglewood:{lat:-39.161,lng:174.207},urenui:{lat:-38.998,lng:174.39},
    tikorangi:{lat:-39.03,lng:174.29},lepperton:{lat:-39.08,lng:174.2},stratford:{lat:-39.337,lng:174.284},mokau:{lat:-38.70,lng:174.62}};
  for(const [a,b] of [['westown','bellBlock'],['oakura','np'],['hawera','normanby'],['tataraimaka','np']])
    assert(!r.mightCross(P[a],P[b]),`${a} to ${b} needs no bridge check`);
  for(const [a,b] of [['np','tikorangi'],['inglewood','urenui'],['lepperton','tikorangi'],['stratford','mokau'],['np','urenui'],['tikorangi','westown']])
    assert(r.mightCross(P[a],P[b]),`${a} to ${b} is still checked`);
  assert(r.mightCross({lat:NaN,lng:1},P.np),'Unknown points are always checked');
  // Same bank of the Waitara River: the trip never crosses it, so no bridge check.
  Object.assign(P,{waitaraWest:{lat:-39.0,lng:174.21},motunui:{lat:-38.985,lng:174.33},
    eastBank:{lat:-39.0583,lng:174.3057},patea:{lat:-39.5965,lng:174.282}});
  assert.equal(r.riverBank(P.np),'south');assert.equal(r.riverBank(P.urenui),'north');assert.equal(r.riverBank(P.tikorangi),'north');
  assert.equal(r.riverBank(r.bridge),null,'At the river the bank is not decided');
  assert.equal(r.riverBank(P.mokau),null,'Beyond the upper river the bank is not decided');
  for(const [a,b] of [['np','waitaraWest'],['np','inglewood'],['lepperton','bellBlock'],['inglewood','waitaraWest'],['urenui','tikorangi'],['motunui','tikorangi']])
    assert(!r.mightCross(P[a],P[b]),`${a} to ${b} stays on one bank - no bridge check`);
  // A real route that used the bridge (found 21 Oct 2026), and trips at the river, are still checked.
  assert(r.mightCross(P.eastBank,P.patea),'East bank to Patea crossed the bridge - still checked');
  assert(r.mightCross(r.bridge,P.waitaraWest),'Starting at the river is still checked');
  const html=fs.readFileSync('index.html','utf8');
  assert(html.indexOf('await NakiRouting.safeRoute([start,...best')<html.indexOf('state.stops = best.concat(rest)'),'Verify geometry before saving the new order');
  assert(!html.includes('matrix=routeMatrixFallback(points)'),'No unrestricted optimisation fallback');
  assert(html.includes('const r = await NakiRouting.safeRoute(seq)'),'Map uses the same restriction');
  assert(fs.readFileSync('sw.js','utf8').includes("FILES.push('/assets/route-restrictions.js')"));
  // The bridge only shapes the planned run. Navigate hands Maps the stop alone:
  // no GPS wait, no route check, no extra stops.
  const navSource=html.slice(html.indexOf('function navigatePickup(s){'),html.indexOf('function contactNavStop('));
  let checks=0;const stop={id:'one',...east};
  const context={window:{},findStop:()=>stop,alert(){},autoCheckPaymentFor(){},stopMoneyState(){},bookingsWithInvoiceState(){return [];},directBookingRows:[],
    mapsDirUrl:()=> 'https://www.google.com/maps/dir/?api=1&destination=Exact%20Address',
    NakiRouting:{safeRoute:async()=>{checks++;return {detours:[{via:r.bypass}]};}},location:{href:''}};
  context.NakiMaps={open:url=>{context.location.href=url;return true;}};
  vm.createContext(context);vm.runInContext(navSource,context);
  assert.equal(context.window.navStop('one'),true,'Opens Maps straight away');
  const navUrl=new URL(context.location.href);
  assert.equal(navUrl.searchParams.has('waypoints'),false,'No bridge stops added to Google Maps');
  assert.equal(navUrl.searchParams.get('destination'),'Exact Address');
  assert.equal(checks,0,'No route check when navigating');
  console.log('PASS: bridge geometry, both detours, unsafe/offline rejection, leg timings, matrix and app wiring');
})().catch(e=>{console.error(e);process.exitCode=1;});
