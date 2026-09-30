import test from 'node:test';
import assert from 'node:assert/strict';
import worker,{pickupAddressLookup} from '../src/index.js';
import coverage from '../src/pickup-coverage.json' with {type:'json'};
import {distanceBand,measurePickupArea} from '../src/pickup-distance.js';
import {inGeometry,intersection,metres} from '../src/pickup-geometry.js';
import {reverseDistances,localRoadDistances} from '../src/pickup-road-graph.js';
const address={street:'356 Ngatimaru Road',town:'Waitara',area:'Tikorangi'};
const lookup=async()=>({label:'356 Ngatimaru Road, Tikorangi, Waitara',lat:-39.03418755,lng:174.2788872833,exact:true});
const graphFixture=(distance=3900,dir=3)=>({
 nodes:[[174.278887,-39.034188,distance,distance,0,1],[174.279887,-39.034188,distance+86.37,distance+86.37,0,1]],
 segments:[[0,1,dir,0,1]],names:['Ngatimaru Road',''],places:['Waitara','Outlying route'],cells:{'17427,-3904':[0],'17428,-3904':[0]}
});
const fixtureData=distance=>({towns:[],corridors:[],graph:graphFixture(distance)});

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
 const r=await measurePickupArea(address,{lookup,});assert.equal(r.key,'under5km');assert.equal(r.distanceKm,3.9);assert.equal(r.cents,500);
});
test('outlying rural addresses receive one $10 fee even when distance is under 5 km',async()=>{
 const r=await measurePickupArea({...address,town:'Oakura'},{lookup,});assert.equal(r.key,'6to10km');assert.equal(r.cents,1000);
});
test('missing, ambiguous, imprecise, out-of-region and failed maps require confirmation',async()=>{
 for(const point of [null,{lat:0,lng:0,exact:true},{lat:-39.03,lng:174.28,exact:false}])assert.equal((await measurePickupArea(address,{lookup:async()=>point})).key,'');
 assert.equal((await measurePickupArea(address,{lookup:async()=>{throw Error('Offline');}})).key,'');
 assert.equal((await measurePickupArea(address,{lookup,data:{...coverage,graph:null}})).key,'');
 assert.equal((await measurePickupArea({street:'No street number',town:'Waitara'},{lookup})).key,'');
 assert.equal((await measurePickupArea(address,{lookup,data:fixtureData(5000)})).reason,'fee-boundary');
});
test('town boundary and polygon holes are handled conservatively',async()=>{
 const geometry={type:'Polygon',coordinates:[[[174,-39],[174.02,-39],[174.02,-39.02],[174,-39.02],[174,-39]],[[174.005,-39.005],[174.01,-39.005],[174.01,-39.01],[174.005,-39.01],[174.005,-39.005]]]};
 assert.equal(inGeometry([174.007,-39.007],geometry),false);
 const data={towns:[{name:'Test',kind:'main',geometry}],corridors:[],gates:[]};
 assert.equal((await measurePickupArea(address,{data,lookup:async()=>({lat:-39.00001,lng:174.01,exact:true})})).reason,'town-boundary');
 assert.deepEqual(intersection([0,0],[2,0],[1,-1],[1,1]),[1,0]);
});
test('the road graph computes the shortest connected drive and respects one-way roads',()=>{
 const points=[[174,-39],[174.01,-39],[174.01,-39.01],[174,-39.01],[174.04,-39]],segments=[[0,1,1],[1,2,3],[2,3,3],[3,0,3]];
 const measured=reverseDistances(5,segments,points,[{at:0,place:0}]);
 assert.equal(measured.distances[0],0);
 assert.equal(measured.distances[4],Infinity,'disconnected road is never a crow-flight route');
 assert.ok(measured.distances[1]>metres(points[0],points[1])*2,'one-way road requires the connected return drive');
 assert.ok(Math.abs(measured.distances[3]-metres(points[3],points[0]))<.01);
 const boundary=reverseDistances(2,[[0,1,1]],points.slice(0,2),[{at:0,cost:400,place:2}]);
 assert.equal(boundary.distances[0],400);assert.equal(boundary.distances[1],Infinity);
});
test('local road snapping requires the registered street and handles partial town boundary edges',()=>{
 const graph=graphFixture(3900),point=[174.278887,-39.034188];
 assert.equal(localRoadDistances(point,'Wrong Road',graph),null);
 assert.equal(localRoadDistances([174.278887,-39.04],'Ngatimaru Road',graph),null);
 assert.equal(localRoadDistances(point,'Ngatimaru Road',graph).main.distance,3900);
 graph.segments[0].push([[.5,0]],[],0);
 assert.ok(localRoadDistances(point,'Ngatimaru Road',graph).main.distance<44);
 graph.segments[0][2]=2;
 assert.equal(localRoadDistances(point,'Ngatimaru Road',graph).main.distance,3900,'cannot travel forward on a reverse one-way edge');
});
test('a short driveway on a matching covered main road stays free, a side road does not',async()=>{
 const point=[174.278887,-39.034188],data=fixtureData(10);
 data.graph.names[0]='Junction Road';data.corridors=[{line:[[174.278887,-39.05],[174.278887,-39.03]],kind:'main',name:'SH3',namedSegments:[{name:'Junction Road',segments:[[[174.278887,-39.05],[174.278887,-39.03]]]}]}];
 const r=await measurePickupArea({street:'1052 Junction Road',town:'Inglewood'},{data,lookup:async()=>({label:'1052 Junction Road',lat:point[1],lng:point[0],exact:true})});assert.equal(r.key,'town');
 data.graph.names[0]='Other Road';
 const side=await measurePickupArea({street:'1 Other Road',town:'Inglewood'},{data,lookup:async()=>({label:'1 Other Road',lat:point[1],lng:point[0],exact:true})});assert.equal(side.key,'under5km');
});
test('public rural landmarks match independently checked road distances and fee bands',async()=>{
 for(const [area,street,town,lat,lng,key,distance] of [
 ['Ratapiko','4 Ratapiko Road','Inglewood',-39.2003096333,174.3224364667,'6to10km',8.89],
 ['Kaimata','715 Tarata Road','Inglewood',-39.1619848333,174.2920634333,'6to10km',7.19],
 ['Egmont Village','1052 Junction Road','Inglewood',-39.14634735,174.1459820833,'town',0],
 ['Rotokare','365 Sangster Road','Eltham',-39.4511767833,174.39873425,'over10km',12.03],
 ['Makahu','835 Brewer Road','Stratford',-39.292985,174.6309950333,'over10km',null]]){
  const r=await measurePickupArea({street,town,area},{lookup:async()=>({lat,lng,label:street+', '+area+', '+town,exact:true})});
  assert.equal(r.key,key,area);if(distance!==null)assert.ok(Math.abs(r.distanceKm-distance)<=.1,area);else assert.equal(r.distanceKm,undefined);
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
 const r=await measurePickupArea({...address,lat:-39.161,lng:174.205,distanceKm:0,rural:'town'},{lookup,});assert.equal(r.key,'under5km');assert.equal(r.cents,500);
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
