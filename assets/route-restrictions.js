/* Owner vehicle restriction, not a public road closure.
 * Bertrand Road bridge: OSM maxwidth=2, maxweight=4.
 * NPDC confirms vehicle-limiting bollards:
 * https://www.npdc.govt.nz/council/news/2022/august/big-rigs-steer-a-dangerous-and-costly-route-through-npdc-roads-and-bridges/
 * Geometry checked against OSM on 18 October 2026. Never accept an unverified
 * route or silently substitute a straight line for this restriction.
 */
(function(root){
  'use strict';
  const bridge={lat:-39.04735,lng:174.25492};
  const approaches=[{lat:-39.04734,lng:174.2535},{lat:-39.04736,lng:174.2564}];
  // SH3 Main North Road west of the river, then Ngatimaru Road on the east.
  // The east-bank anchor is essential: a waypoint on SH3 alone can still send
  // the return leg back across Bertrand Road. Validate the entire detour.
  const bypass=[{lat:-39.0080251,lng:174.2407313},{lat:-39.024908,lng:174.270303}];
  const failure='Could not verify a route avoiding Bertrand Road Bridge. No driving route is available; please retry when connected.';
  const cache=new Map();
  function xy(p){return [(p[0]-bridge.lng)*86400,(p[1]-bridge.lat)*111200];}
  function blocked(geometry){
    if(!geometry||geometry.type!=='LineString'||!Array.isArray(geometry.coordinates)||geometry.coordinates.length<2)throw Error(failure);
    const coords=geometry.coordinates;
    for(let i=1;i<coords.length;i++){
      if(![...coords[i-1],...coords[i]].every(Number.isFinite))throw Error(failure);
      const a=xy(coords[i-1]),b=xy(coords[i]),dx=b[0]-a[0],dy=b[1]-a[1];
      const t=Math.max(0,Math.min(1,-(a[0]*dx+a[1]*dy)/(dx*dx+dy*dy||1)));
      if(Math.hypot(a[0]+t*dx,a[1]+t*dy)<100)return true;
    }
    return false;
  }
  async function request(service,points,query){
    if(!points.every(p=>Number.isFinite(p.lat)&&Number.isFinite(p.lng)))throw Error(failure);
    const url=`https://router.project-osrm.org/${service}/v1/driving/${points.map(p=>`${p.lng},${p.lat}`).join(';')}?${query}`;
    const old=cache.get(url);if(old&&Date.now()-old.at<15*60000)return old.data;
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
    try{
      const response=await fetch(url,{signal:controller.signal});
      if(!response.ok)throw Error(failure);
      const data=await response.json();if(data.code!=='Ok')throw Error(failure);
      if(cache.size>100)cache.delete(cache.keys().next().value);
      cache.set(url,{at:Date.now(),data});return data;
    }finally{clearTimeout(timer);}
  }
  async function route(points){
    const data=await request('route',points,'overview=full&geometries=geojson&steps=true&continue_straight=false');
    const r=data.routes?.[0];
    if(!r||r.legs?.length!==points.length-1||!Number.isFinite(r.duration)||!Number.isFinite(r.distance))throw Error(failure);
    blocked(r.geometry); // Also validates the geometry on the unrestricted path.
    return r;
  }
  function legGeometry(leg){
    const coordinates=leg.steps?.flatMap(step=>step.geometry?.coordinates||[])||[];
    return {type:'LineString',coordinates};
  }
  async function safeRoute(points){
    const original=await route(points);
    if(!blocked(original.geometry))return {...original,detours:[]};
    const legs=[],coordinates=[],detours=[];
    for(let i=0;i<original.legs.length;i++){
      let leg=original.legs[i],geometry=legGeometry(leg);
      if(blocked(geometry)){
        const candidates=[];
        for(const via of [bypass,[...bypass].reverse()]){
          try{
            const r=await route([points[i],...via,points[i+1]]);
            if(!blocked(r.geometry))candidates.push({...r,via});
          }catch(e){/* A candidate never permits an unsafe fallback. */}
        }
        const best=candidates.sort((a,b)=>a.duration-b.duration)[0];
        if(!best)throw Error(failure);
        leg={duration:best.duration,distance:best.distance,steps:best.legs.flatMap(l=>l.steps)};
        geometry=best.geometry;detours.push({leg:i,via:best.via});
      }
      legs.push(leg);coordinates.push(...geometry.coordinates);
    }
    const result={geometry:{type:'LineString',coordinates},legs,detours,
      duration:legs.reduce((n,l)=>n+l.duration,0),distance:legs.reduce((n,l)=>n+l.distance,0)};
    if(blocked(result.geometry))throw Error(failure);
    return result;
  }
  async function matrix(points){
    if(points.length>50)throw Error('Too many stops for one road-time table');
    const n=points.length,all=[...points,...approaches,...bypass];
    const data=await request('table',all,'annotations=duration');
    const d=data.durations;
    if(d?.length!==all.length||!d.every(row=>row.length===all.length&&row.every(Number.isFinite)))throw Error(failure);
    // A shortest path using the forbidden bridge decomposes through its two
    // approaches. A conservative tolerance includes turn/snap rounding costs.
    // Remove those edges, then permit detours through the safe bypass anchors.
    const usesBridge=(i,j)=>i!==j&&[ [n,n+1],[n+1,n] ].some(([a,b])=>
      d[a][b]<120&&Math.abs(d[i][j]-(d[i][a]+d[a][b]+d[b][j]))<=30);
    const safe=d.map((row,i)=>row.map((v,j)=>usesBridge(i,j)?Infinity:v));
    for(const k of [n+2,n+3])for(let i=0;i<all.length;i++)for(let j=0;j<all.length;j++)
      safe[i][j]=Math.min(safe[i][j],safe[i][k]+safe[k][j]);
    const result=safe.slice(0,n).map(row=>row.slice(0,n));
    if(!result.every(row=>row.every(Number.isFinite)))throw Error(failure);
    return result;
  }
  const api={bridge,bypass,blocked,safeRoute,matrix,failure};
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.NakiRouting=api;
})(typeof window==='object'?window:globalThis);
