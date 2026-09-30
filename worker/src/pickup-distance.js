import coverage from './pickup-coverage.json' with { type: 'json' };
import {metres,nearestLine,inGeometry,geometryDistance} from './pickup-geometry.js';

export const AREA_LABELS=Object.freeze({town:'Main town or main road - no travel fee',under5km:'Rural: up to 5 km from a main town or road - add $5','6to10km':'Outlying route, or rural 6-10 km away - add $10',over10km:'More than 10 km from a covered town or route - contact us'});
const normal=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const OUTLYING=/\b(?:oakura|owakura|okato|warea|pungarehu|rahotu|oaonui|opunake|pihama|otakeho|manaia|kaponga)\b/;
const uncertain=reason=>({key:'',label:'',cents:0,needsConfirmation:true,reason,coverageVersion:coverage.version});
const result=(key,extra={})=>({key,label:AREA_LABELS[key],cents:key==='under5km'?500:key==='6to10km'?1000:0,needsConfirmation:key==='over10km',coverageVersion:coverage.version,...extra});
const nearBounds=(p,t,margin=0)=>!t.bounds||(p[0]>=t.bounds[0]-margin&&p[0]<=t.bounds[2]+margin&&p[1]>=t.bounds[1]-margin&&p[1]<=t.bounds[3]+margin);

export function distanceBand(distance,kind='main') {
  if(!Number.isFinite(distance)||distance<0)return '';
  // Mapped town edges and road snapping have metre-scale uncertainty. Ask near
  // a fee boundary instead of letting rounding decide which price is charged.
  if(Math.abs(distance-10000)<=100 || (kind==='main'&&Math.abs(distance-5000)<=100))return '';
  if(distance>10000)return 'over10km';
  if(kind==='outlying')return '6to10km';
  return distance<=20?'town':distance<=5000?'under5km':'6to10km';
}

export function candidatesFor(point,data=coverage) {
  const candidates=data.gates.map(g=>({...g,lower:metres(point,g.point)}));
  for(const road of data.corridors){const q=nearestLine(point,road.line);candidates.push({point:q.point,kind:road.kind,name:road.name,lower:q.distance,projection:true});}
  return candidates.filter(g=>g.lower<=10200).sort((a,b)=>a.lower-b.lower);
}

export async function roadDistances(point,candidates,fetcher=fetch,signal) {
  if(!candidates.length)return [];
  const coords=[point,...candidates.map(g=>g.point)].map(p=>p.map(n=>n.toFixed(6)).join(',')).join(';');
  const params=new URLSearchParams({sources:'0',destinations:candidates.map((_,i)=>i+1).join(';'),annotations:'distance'});
  const response=await fetcher('https://router.project-osrm.org/table/v1/driving/'+coords+'?'+params,{signal});
  if(!response.ok)throw new Error('Routing unavailable');
  const data=await response.json();
  if(data.code!=='Ok'||!Array.isArray(data.distances?.[0])||data.distances[0].length!==candidates.length||data.fallback_speed_cells?.length)throw new Error('Incomplete road distances');
  const source=data.sources?.[0];
  if(!source||!Number.isFinite(source.distance)||source.distance>80||!Array.isArray(source.location))throw new Error('Address too far from a mapped road');
  return candidates.map((gate,i)=>{
    const target=data.destinations?.[i],distance=data.distances[0][i];
    if(distance===null||!Number.isFinite(distance)||distance<0)return {...gate,distance:null};
    if(!target||!Number.isFinite(target.distance)||target.distance>60||!Array.isArray(target.location))throw new Error('Covered-road access could not be verified');
    // A projection must land on the covered road itself, not a parallel road.
    if(gate.projection && metres(target.location,gate.point)>20)throw new Error('Covered road could not be matched');
    return {...gate,distance,sourceSnap:source.distance,sourcePoint:source.location,targetSnap:target.distance};
  });
}

export async function measurePickupArea(address,{lookup,fetcher=fetch,data=coverage,signal=AbortSignal.timeout(22000)}={}) {
  const street=String(address?.street||'').trim(),town=String(address?.town||'').trim(),area=String(address?.area||'').trim();
  if(!street||!town||street.length>180||town.length>100||area.length>100||!/^\s*(?:(?:unit|flat|apt|apartment|u)\s*)?[#\d]/i.test(street)||!/[a-z]/i.test(street))return uncertain('incomplete-address');
  try{
    const found=await lookup({street,town,area},signal);
    if(!found||!Number.isFinite(found.lat)||!Number.isFinite(found.lng)||!found.exact)return uncertain('address-not-confirmed');
    const point=[found.lng,found.lat];
    // Same regional bounds as address-search. Routing uses the full road
    // network; the frozen data describes only the towns/roads we COVER.
    if(point[0]<173.45||point[0]>175.35||point[1]<-40.15||point[1]>-38.35)return uncertain('outside-mapped-area');
    const containing=data.towns.filter(t=>nearBounds(point,t)&&inGeometry(point,t.geometry));
    if(containing.length){
      const place=containing.find(t=>t.kind==='outlying')||containing[0];
      // Distance to the polygon EDGE, including its holes (not distance to area).
      const rings=place.geometry.type==='Polygon'?[place.geometry.coordinates]:place.geometry.coordinates;
      const edge=Math.min(...rings.flatMap(rs=>rs.map(r=>nearestLine(point,r).distance)));
      if(edge<=100)return uncertain('town-boundary');
      return result(place.kind==='main'?'town':'6to10km',{distanceKm:0,coveredPlace:place.name,matchedAddress:found.label,method:'mapped-town'});
    }
    // Also protect just-outside town edges where official boundary precision is
    // insufficient to distinguish a free urban address from a rural address.
    if(data.towns.some(t=>nearBounds(point,t,.002)&&geometryDistance(point,t.geometry)<=100))return uncertain('town-boundary');
    const all=candidatesFor(point,data),done=new Set(),measured=[];
    const streetRoad=normal(String(found.label).split(',')[0].replace(/^.*?\d+[a-z]?(?:\s*\/\s*\d+[a-z]?)?\s*/i,''));
    const namedOutlying=OUTLYING.test(normal([town,area,...String(found.label).split(',').slice(1)].join(' ')));
    const kinds=namedOutlying?['outlying','main']:['main','outlying'];
    // Branch and bound: evaluate nearest access points first, then EVERY gate
    // whose straight-line lower bound could improve the measured road distance.
    // Crow-flight distance is only used to prune requests, never to set a fee.
    for(const kind of kinds){
      const pool=all.filter(g=>g.kind===kind);let pending=pool.slice(0,12);
      while(pending.length){
        const batch=pending.slice(0,80);batch.forEach(g=>done.add(g));
        measured.push(...await roadDistances(point,batch,fetcher,signal));
        const best=Math.min(10200,...measured.filter(g=>g.kind===kind&&g.distance!==null).map(g=>g.distance+g.targetSnap));
        pending=pool.filter(g=>!done.has(g)&&g.lower<=best+80);
        if(done.size>400)return uncertain('too-many-route-options');
      }
    }
    const bestFor=kind=>measured.filter(g=>g.kind===kind&&g.distance!==null).sort((a,b)=>a.distance-b.distance)[0];
    const main=bestFor('main'),outlying=bestFor('outlying');
    let chosen;
    if(namedOutlying){chosen=[main,outlying].filter(Boolean).sort((a,b)=>a.distance-b.distance)[0];if(chosen)chosen={...chosen,kind:'outlying'};}
    else if(main && main.distance<=5100)chosen=main;
    else chosen=[main,outlying].filter(Boolean).sort((a,b)=>a.distance-b.distance)[0];
    if(!chosen){
      // With no gate within 10.2 km, the lower bound proves road travel exceeds
      // 10 km. If gates exist but are disconnected, we cannot establish that.
      return all.length?uncertain('no-driving-route'):result('over10km',{method:'outside-distance-limit',matchedAddress:found.label});
    }
    // The fee rule says addresses directly ON a covered main road are free.
    // A geocoder may place the pin inside the property/short driveway. Verify
    // both its street name and the local covered segment before treating that
    // short access distance as an address on the route.
    const roadAlias=name=>normal(name).replace(/^state highway /,'sh ');
    const onMainRoad=!namedOutlying&&chosen.kind==='main'&&chosen.distance<=200&&data.corridors.some(c=>c.kind==='main'&&(c.namedSegments||[]).some(r=>(normal(r.name)===streetRoad||String(r.ref||'').split(';').some(ref=>ref&&roadAlias(ref)===roadAlias(streetRoad)))&&r.segments.some(s=>nearestLine(point,s).distance<=150)));
    if(onMainRoad)chosen={...chosen,distance:0};
    else if(chosen.kind==='main'&&chosen.distance<=20)chosen={...chosen,distance:21};
    const key=distanceBand(chosen.distance,chosen.kind);
    if(!key)return uncertain('fee-boundary');
    return result(key,{distanceKm:Math.round(chosen.distance/10)/100,coveredPlace:chosen.name,matchedAddress:found.label,method:'driving-distance'});
  }catch{return uncertain('map-unavailable');}
}
