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
    assert.equal(calls.length,3,'Try and validate both bypass directions');
  }
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
  const html=fs.readFileSync('index.html','utf8');
  assert(html.indexOf('await NakiRouting.safeRoute([start,...best')<html.indexOf('state.stops = best.concat(rest)'),'Verify geometry before saving the new order');
  assert(!html.includes('matrix=routeMatrixFallback(points)'),'No unrestricted optimisation fallback');
  assert(html.includes('const r = await NakiRouting.safeRoute(seq)'),'Map uses the same restriction');
  assert(html.includes("target.searchParams.set('waypoints'"),'Navigation carries the bypass waypoints');
  assert(fs.readFileSync('sw.js','utf8').includes("FILES.push('/assets/route-restrictions.js')"));
  // Execute the actual Navigate handler: retain the address, force the detour,
  // block a second tap, and restore controls after GPS/network failures.
  const navSource=html.slice(html.indexOf('let navRouteBusy=false;'),html.indexOf('// Stops saved before this check existed'));
  const button={textContent:'Navigate',disabled:false},alerts=[];
  let resolveGps,checks=0;
  const stop={id:'one',...east};
  const context={URL,window:{},document:{querySelectorAll:()=>[button]},findStop:()=>stop,
    mapsDirUrl:()=> 'https://www.google.com/maps/dir/?api=1&destination=Exact%20Address',
    navigator:{geolocation:{getCurrentPosition:ok=>{resolveGps=ok;}}},
    NakiRouting:{failure:'No safe route',mightCross:r.mightCross,safeRoute:async()=>{checks++;return {detours:[{via:r.bypass}]};}},
    location:{href:''},busy(){},alert:message=>alerts.push(message)};
  context.NakiMaps={open:url=>{context.location.href=url;return true;}};
  vm.createContext(context);vm.runInContext(navSource,context);
  const navigating=context.window.navStop('one');
  assert(button.disabled);assert.equal(await context.window.navStop('one'),false);
  resolveGps({coords:{latitude:west.lat,longitude:west.lng}});assert.equal(await navigating,true);
  const navUrl=new URL(context.location.href);
  assert.equal(navUrl.searchParams.get('waypoints'),r.bypass.map(p=>`${p.lat},${p.lng}`).join('|'));
  assert.equal(navUrl.searchParams.get('destination'),`${east.lat},${east.lng}`);
  assert.equal(navUrl.searchParams.has('origin'),false,'Navigation starts from the live phone location');
  assert.equal(checks,1);assert(!button.disabled);assert.equal(button.textContent,'Navigate');
  context.location.href='';context.navigator.geolocation.getCurrentPosition=(ok,fail)=>fail();
  assert.equal(await context.window.navStop('one'),false);assert.equal(context.location.href,'');assert(!button.disabled);
  context.navigator.geolocation.getCurrentPosition=ok=>ok({coords:{latitude:west.lat,longitude:west.lng}});
  context.NakiRouting.safeRoute=async()=>{throw Error('Routing offline');};
  assert.equal(await context.window.navStop('one'),false);assert.equal(context.location.href,'');assert(!button.disabled);
  console.log('PASS: bridge geometry, both detours, unsafe/offline rejection, leg timings, matrix and app wiring');
})().catch(e=>{console.error(e);process.exitCode=1;});
