import test from 'node:test';
import assert from 'node:assert/strict';
import worker,{pickupAddressLookup} from '../src/index.js';
import coverage from '../src/pickup-coverage.json' with {type:'json'};
import {distanceBand,measurePickupArea,roadDistances,candidatesFor} from '../src/pickup-distance.js';
import {inGeometry,intersection,metres} from '../src/pickup-geometry.js';
const address={street:'356 Ngatimaru Road',town:'Waitara',area:'Tikorangi'};
const lookup=async()=>({label:'356 Ngatimaru Road, Tikorangi, Waitara',lat:-39.03418755,lng:174.2788872833,exact:true});
const fakeTable=(distance=3900)=>async url=>{
 const u=new URL(url),coords=u.pathname.split('/').at(-1).split(';').map(s=>s.split(',').map(Number));
 const indexes=u.searchParams.get('destinations').split(';').map(Number);
 return Response.json({code:'Ok',sources:[{distance:1,location:coords[0]}],destinations:indexes.map(i=>({distance:1,location:coords[i]})),distances:[indexes.map(()=>distance)]});
};

test('distance bands preserve the fees and ask around 5/10 km',()=>{
 for(const [m,key] of [[0,'town'],[3900,'under5km'],[4899,'under5km'],[4900,''],[5000,''],[5100,''],[5101,'6to10km'],[9899,'6to10km'],[10000,''],[10101,'over10km']])assert.equal(distanceBand(m),key,String(m));
 assert.equal(distanceBand(100,'outlying'),'6to10km');assert.equal(distanceBand(5000,'outlying'),'6to10km');assert.equal(distanceBand(10000,'outlying'),'');
});
test('official town boundaries include Bell Block and distinguish Oakura',async()=>{
 for(const [lat,lng,key,name] of [[-39.1610253667,174.2059458833,'town','Inglewood'],[-39.0323484,174.1650931333,'town','Bell Block'],[-39.1187690833,173.9576302833,'6to10km','Oakura']]){
  const r=await measurePickupArea({street:'16 Test Street',town:name},{lookup:async()=>({label:'16 Test Street, '+name,lat,lng,exact:true}),fetcher:()=>{throw Error('Urban address must not need routing');}});assert.equal(r.key,key);assert.equal(r.method,'mapped-town');
 }
});
test('road data follows SH3/SH3A and SH45 instead of treating inland shortcuts as coastal coverage',()=>{
 assert.equal(coverage.corridors.length,4);assert.ok(coverage.gates.length>100);
 const coast=coverage.corridors.find(c=>c.name.startsWith('SH 45'));
 assert.ok(coast.namedSegments.some(s=>s.name==='South Road'));assert.ok(!coast.namedSegments.some(s=>s.name==='Wiremu Road'));
 assert.ok(coverage.corridors.find(c=>c.name.startsWith('SH 3:')).namedSegments.some(s=>s.name==='Junction Road'));
 assert.ok(coverage.towns.find(t=>t.name==='New Plymouth'));
});
test('postal main town does not turn a rural street into a free pickup',async()=>{
 const r=await measurePickupArea(address,{lookup,fetcher:fakeTable()});assert.equal(r.key,'under5km');assert.equal(r.distanceKm,3.9);assert.equal(r.cents,500);
});
test('outlying rural addresses receive one $10 fee even when distance is under 5 km',async()=>{
 const r=await measurePickupArea({...address,town:'Oakura'},{lookup,fetcher:fakeTable()});assert.equal(r.key,'6to10km');assert.equal(r.cents,1000);
});
test('missing, ambiguous, imprecise, out-of-region and failed maps require confirmation',async()=>{
 for(const point of [null,{lat:0,lng:0,exact:true},{lat:-39.03,lng:174.28,exact:false}])assert.equal((await measurePickupArea(address,{lookup:async()=>point})).key,'');
 assert.equal((await measurePickupArea(address,{lookup,fetcher:async()=>{throw Error('Offline');}})).key,'');
 assert.equal((await measurePickupArea({street:'No street number',town:'Waitara'},{lookup})).key,'');
 assert.equal((await measurePickupArea(address,{lookup,fetcher:fakeTable(5000)})).reason,'fee-boundary');
});
test('town boundary and polygon holes are handled conservatively',async()=>{
 const geometry={type:'Polygon',coordinates:[[[174,-39],[174.02,-39],[174.02,-39.02],[174,-39.02],[174,-39]],[[174.005,-39.005],[174.01,-39.005],[174.01,-39.01],[174.005,-39.01],[174.005,-39.005]]]};
 assert.equal(inGeometry([174.007,-39.007],geometry),false);
 const data={towns:[{name:'Test',kind:'main',geometry}],corridors:[],gates:[]};
 assert.equal((await measurePickupArea(address,{data,lookup:async()=>({lat:-39.00001,lng:174.01,exact:true})})).reason,'town-boundary');
 assert.deepEqual(intersection([0,0],[2,0],[1,-1],[1,1]),[1,0]);
});
test('OSRM must return real distances, valid snapping and no crow-flight fallback',async()=>{
 const point=[174.27,-39.04],candidates=[{point:[174.28,-39.04],kind:'main'}];
 for(const change of [d=>d.sources[0].distance=81,d=>d.destinations[0].distance=61,d=>d.fallback_speed_cells=[[0,0]],d=>d.distances=[]]){
  await assert.rejects(roadDistances(point,candidates,async u=>{const d=await(await fakeTable()(u)).json();change(d);return Response.json(d);}));
 }
 const distances=await roadDistances(point,candidates,async u=>{const d=await(await fakeTable()(u)).json();d.distances[0][0]=null;return Response.json(d);});assert.equal(distances[0].distance,null);
});
test('branch and bound checks a farther-looking road access that gives a shorter drive',async()=>{
 const point=[174.27,-39.04],gates=Array.from({length:15},(_,i)=>({point:[174.27+(i+1)*.001,-39.04],kind:'main',name:'Access '+i}));
 const data={towns:[],corridors:[],gates};let checked=0;
 const r=await measurePickupArea(address,{data,lookup:async()=>({lat:point[1],lng:point[0],exact:true}),fetcher:async u=>{const d=await(await fakeTable()(u)).json();checked+=d.distances[0].length;d.distances[0]=d.destinations.map(p=>metres(p.location,gates[14].point)<2?600:6000);return Response.json(d);}});
 assert.equal(checked,15);assert.equal(r.distanceKm,.6);assert.equal(r.key,'under5km');
});
test('a short driveway on a matching covered main road stays free, a different road does not',async()=>{
 const point=[174.27,-39.04],data={towns:[],gates:[{point:[174.2701,-39.04],kind:'main',name:'Junction Road'}],corridors:[{line:[[174.27,-39.05],[174.27,-39.03]],kind:'main',name:'SH3',namedSegments:[{name:'Junction Road',segments:[[[174.27,-39.05],[174.27,-39.03]]]}]}]};
 for(const [road,key] of [['Junction Road','town'],['Other Road','under5km']]){
  const r=await measurePickupArea({street:'1052 '+road,town:'Inglewood'},{data,lookup:async()=>({label:'1052 '+road,lat:point[1],lng:point[0],exact:true}),fetcher:fakeTable(80)});assert.equal(r.key,key);
 }
});
test('known town disambiguation recognises Hāwera macrons and never accepts the other Tawa Street',async()=>{
 const old=globalThis.fetch;globalThis.fetch=async()=>Response.json({features:[{properties:{full_address_number:'10',full_address:'10 Tawa Street, Inglewood'},geometry:{coordinates:[174.2059458833,-39.1610253667]}},{properties:{full_address_number:'10',full_address:'10 Tawa Street, Hāwera'},geometry:{coordinates:[174.2737284667,-39.5738577333]}}]});
 try{const r=await pickupAddressLookup({LINZ_API_KEY:'test'},{street:'10 Tawa Street',town:'Inglewood'});assert.equal(r.label,'10 Tawa Street, Inglewood');}finally{globalThis.fetch=old;}
});
test('public measurement API validates requests and respects origin/rate limits',async()=>{
 const request=(body='{}',origin='https://nakiwhitewareremoval.vip',method='POST')=>new Request('https://api.test/v2/pickup-area',{method,headers:{Origin:origin},...(method==='POST'?{body}:{})});
 assert.equal((await worker.fetch(request('{}','https://evil.test'),{})).status,403);
 assert.equal((await worker.fetch(request('{}',undefined,'GET'),{})).status,405);
 assert.equal((await worker.fetch(request('not-json'),{BOT_RATE_LIMIT:{limit:async()=>({success:true})}})).status,400);
 assert.equal((await worker.fetch(request(),{BOT_RATE_LIMIT:{limit:async()=>({success:false})}})).status,429);
});
test('supplied coordinates, rural band and claimed distance cannot override the server measurement',async()=>{
 const r=await measurePickupArea({...address,lat:-39.161,lng:174.205,distanceKm:0,rural:'town'},{lookup,fetcher:fakeTable(3900)});assert.equal(r.key,'under5km');assert.equal(r.cents,500);
});
test('API caches successful checks only and keeps the browser response no-store',async()=>{
 const oldFetch=globalThis.fetch,oldCaches=globalThis.caches,stored=new Map();let calls=0;
 globalThis.caches={default:{match:async key=>stored.get(key.url)?.clone(),put:async(key,response)=>stored.set(key.url,response.clone())}};
 globalThis.fetch=async()=>{calls++;return Response.json({features:[{properties:{full_address_number:'10',full_address:'10 Tawa Street, Inglewood'},geometry:{coordinates:[174.2059458833,-39.1610253667]}}]});};
 const request=body=>new Request('https://api.test/v2/pickup-area',{method:'POST',headers:{Origin:'https://nakiwhitewareremoval.vip'},body:JSON.stringify(body)});
 try{
  const body={street:'10 Tawa Street',town:'Inglewood'};
  for(let i=0;i<2;i++){const r=await worker.fetch(request(body),{LINZ_API_KEY:'test'});assert.equal(r.status,200);assert.equal(r.headers.get('Cache-Control'),'no-store');assert.equal((await r.json()).key,'town');}
  assert.equal(calls,1);assert.equal(stored.size,1);
  const bad={street:'99 Missing Street',town:'Inglewood'};
  let before=calls;
  for(let i=0;i<2;i++){const r=await worker.fetch(request(bad),{LINZ_API_KEY:'test'});assert.equal((await r.json()).needsConfirmation,true);assert.ok(calls>before,'failed checks must retry the lookup');before=calls;}
  assert.equal(stored.size,1);
 }finally{globalThis.fetch=oldFetch;if(oldCaches===undefined)delete globalThis.caches;else globalThis.caches=oldCaches;}
});
test('exact road names and pasted Terrace/Court/Way localities are checked against the address register',async()=>{
 const old=globalThis.fetch;
 try{
  for(const suffix of ['Terrace','Court','Way']){
   globalThis.fetch=async()=>Response.json({features:[{properties:{full_address_number:'16',full_address:`16 Example ${suffix}, Ōakura`},geometry:{coordinates:[173.9576302833,-39.1187690833]}}]});
   const found=await pickupAddressLookup({LINZ_API_KEY:'test'},{street:`16 Example ${suffix} Oakura`,town:'New Plymouth'});assert.ok(found?.exact);
   const wrong=await pickupAddressLookup({LINZ_API_KEY:'test'},{street:`16 Example ${suffix} East`,town:'New Plymouth'});assert.equal(wrong,null);
  }
 }finally{globalThis.fetch=old;}
});
