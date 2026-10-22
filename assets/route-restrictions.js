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
        // Every waypoint shows in Google Maps as an extra stop, so try one
        // waypoint first and keep it when the verified route is just as good.
        for(const via of [[bypass[0]],[bypass[1]],bypass,[...bypass].reverse()]){
          try{
            const r=await route([points[i],...via,points[i+1]]);
            if(!blocked(r.geometry))candidates.push({...r,via});
          }catch(e){/* A candidate never permits an unsafe fallback. */}
        }
        const quickest=Math.min(...candidates.map(c=>c.duration));
        const best=candidates.filter(c=>c.duration<=quickest+120).sort((a,b)=>a.via.length-b.via.length||a.duration-b.duration)[0];
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
  // Most trips can't come anywhere near the bridge. A road route through it is
  // at least as long as the straight lines start->bridge->end, so when that
  // already beats any real road trip between the two points (1.8x the straight
  // distance plus 5 km - generous for Taranaki roads) the bridge can never be on
  // the way and there is nothing to check. Trips near the river, or across it,
  // still get the full route check.
  function km(a,b){
    const r=Math.PI/180,dLat=(b.lat-a.lat)*r,dLng=(b.lng-a.lng)*r;
    const x=Math.sin(dLat/2)**2+Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin(dLng/2)**2;
    return 12742*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
  }
  // Which bank of the Waitara River a point is on. A trip that starts and ends on
  // the same bank never has to cross the river, so it can't need this bridge.
  // River line: OpenStreetMap relation 12336327 (Waitara River), fetched 21 Oct
  // 2026, simplified to within 50 m. It runs from the hills in the north-east,
  // south, then back north past the bridge to the sea at Waitara - a U shape.
  // "north" is inside the U (Waitara east, Tikorangi, Motunui, Urenui and up the
  // coast); "south" is everything else (New Plymouth, Bell Block, Waitara west,
  // Inglewood, Stratford...). Within 500 m of the river, or east of the river's
  // upper reaches, the bank is not decided and the full check still runs.
  // Checked 21 Oct 2026 against 250 real same-bank routes, including the 150
  // lined up closest with the bridge: none used it. 4 of 80 opposite-bank
  // routes did, and so did the one bridge route found among 611 customer trips.
  const river=[
    174.65649,-38.96973,174.656,-38.9714,174.65278,-38.97237,174.65105,-38.9759,174.64938,-38.97632,174.64788,-38.97539,174.64527,-38.96965,174.64115,-38.96814,
    174.64018,-38.96909,174.64045,-38.97029,174.64349,-38.97247,174.64335,-38.97499,174.64153,-38.97667,174.63819,-38.9756,174.63643,-38.97833,174.63387,-38.97946,
    174.63408,-38.98206,174.62876,-38.98212,174.63144,-38.98439,174.63097,-38.9859,174.62579,-38.98812,174.62225,-38.9867,174.62123,-38.9894,174.62292,-38.99073,
    174.62614,-38.99168,174.62482,-38.99462,174.62684,-38.99701,174.63144,-38.99803,174.62974,-39.00027,174.62584,-39.00108,174.62547,-39.00199,174.62672,-39.00287,
    174.63174,-39.00284,174.63676,-39.00935,174.63629,-39.01091,174.63341,-39.01251,174.63663,-39.01449,174.63653,-39.01522,174.63259,-39.01655,174.63284,-39.01775,
    174.6367,-39.01721,174.63904,-39.01586,174.64063,-39.01664,174.63993,-39.018,174.63736,-39.01865,174.6395,-39.02431,174.63406,-39.02897,174.63694,-39.03033,
    174.63587,-39.03316,174.63831,-39.03522,174.63876,-39.03952,174.64188,-39.0413,174.63925,-39.04702,174.64137,-39.05148,174.6441,-39.05335,174.64178,-39.05555,
    174.64359,-39.05843,174.63457,-39.0635,174.63764,-39.06565,174.64186,-39.06701,174.64444,-39.07047,174.64356,-39.07131,174.63713,-39.0732,174.63586,-39.07618,
    174.63268,-39.07687,174.63213,-39.07798,174.63359,-39.07979,174.64034,-39.08132,174.63957,-39.08323,174.6349,-39.08526,174.63111,-39.08367,174.62855,-39.08341,
    174.62741,-39.08162,174.62545,-39.08099,174.62364,-39.07822,174.62008,-39.0763,174.6191,-39.07285,174.61408,-39.07175,174.61095,-39.06729,174.60693,-39.07103,
    174.60344,-39.07291,174.60369,-39.0743,174.60494,-39.07493,174.609,-39.0742,174.6114,-39.07526,174.61157,-39.07801,174.60621,-39.07991,174.60374,-39.0781,
    174.59813,-39.07791,174.59613,-39.07532,174.59524,-39.07533,174.59402,-39.07615,174.59244,-39.08,174.59902,-39.08243,174.59888,-39.0838,174.59651,-39.0844,
    174.59085,-39.08326,174.58496,-39.07624,174.58339,-39.07575,174.58174,-39.07659,174.57933,-39.07959,174.57783,-39.08486,174.57568,-39.08562,174.57201,-39.08266,
    174.57417,-39.07709,174.57121,-39.07494,174.56916,-39.07079,174.56785,-39.07046,174.5666,-39.07174,174.56731,-39.07505,174.56611,-39.07794,174.56065,-39.07919,
    174.557,-39.07799,174.55696,-39.07229,174.55603,-39.07131,174.55426,-39.07146,174.55245,-39.07467,174.55412,-39.07745,174.55713,-39.07949,174.55463,-39.083,
    174.55806,-39.08558,174.55803,-39.08673,174.55545,-39.08902,174.55795,-39.09267,174.55201,-39.09334,174.54868,-39.09189,174.54731,-39.09244,174.54837,-39.09481,
    174.55193,-39.09744,174.55689,-39.0981,174.55792,-39.10014,174.54563,-39.10231,174.54281,-39.10132,174.53976,-39.09889,174.53864,-39.09913,174.53731,-39.10521,
    174.54065,-39.10992,174.5455,-39.1087,174.54705,-39.10931,174.54665,-39.11142,174.5425,-39.1127,174.53932,-39.11271,174.53423,-39.11024,174.53386,-39.11324,
    174.53738,-39.12115,174.53743,-39.12382,174.53536,-39.12441,174.53264,-39.12377,174.52665,-39.12022,174.52307,-39.1224,174.52038,-39.12545,174.52078,-39.1269,
    174.52607,-39.12841,174.52881,-39.13277,174.52813,-39.13426,174.52028,-39.13762,174.52123,-39.13951,174.52559,-39.14038,174.5277,-39.14344,174.53071,-39.14201,
    174.53309,-39.13963,174.53665,-39.14024,174.54163,-39.14321,174.53947,-39.14448,174.52791,-39.14632,174.52665,-39.15176,174.52916,-39.15226,174.53102,-39.15422,
    174.52978,-39.15873,174.52894,-39.15902,174.52796,-39.15826,174.524,-39.15282,174.52229,-39.15257,174.52171,-39.15903,174.52228,-39.15966,174.52656,-39.16013,
    174.52707,-39.16082,174.52484,-39.16288,174.51941,-39.1631,174.51863,-39.16391,174.51932,-39.16497,174.52104,-39.16549,174.52683,-39.16465,174.53306,-39.16487,
    174.53444,-39.16654,174.52917,-39.16645,174.52777,-39.16921,174.52504,-39.17038,174.52747,-39.17182,174.53319,-39.17072,174.53317,-39.17271,174.53008,-39.17475,
    174.52777,-39.17409,174.51988,-39.17514,174.5206,-39.18578,174.52001,-39.18619,174.51781,-39.18552,174.51556,-39.18671,174.51439,-39.18887,174.51549,-39.19063,
    174.51528,-39.19321,174.5112,-39.19709,174.50973,-39.19697,174.50546,-39.19449,174.50326,-39.19441,174.49998,-39.1957,174.49577,-39.19145,174.49329,-39.19183,
    174.49355,-39.1954,174.49942,-39.20101,174.49542,-39.20287,174.49233,-39.20657,174.49042,-39.20955,174.4908,-39.21167,174.48931,-39.21162,174.48706,-39.20972,
    174.4849,-39.2096,174.48285,-39.20845,174.48149,-39.20138,174.47682,-39.19788,174.47365,-39.19205,174.4699,-39.19053,174.46636,-39.19204,174.46886,-39.19856,
    174.46678,-39.2005,174.4621,-39.20157,174.46428,-39.20892,174.45994,-39.21037,174.45942,-39.21194,174.45678,-39.21419,174.45457,-39.21352,174.45065,-39.20964,
    174.45195,-39.20377,174.44947,-39.20124,174.44814,-39.19597,174.44428,-39.1915,174.44125,-39.1907,174.43482,-39.19307,174.43278,-39.19157,174.43135,-39.18745,
    174.42942,-39.18659,174.42632,-39.18729,174.42335,-39.19004,174.42226,-39.18991,174.42098,-39.18835,174.41588,-39.18817,174.41306,-39.18624,174.41057,-39.18601,
    174.40821,-39.18743,174.40693,-39.187,174.40651,-39.18187,174.40411,-39.18078,174.4011,-39.18161,174.39864,-39.18018,174.39934,-39.17781,174.40247,-39.17659,
    174.40201,-39.17381,174.39992,-39.1731,174.39704,-39.17384,174.39476,-39.17261,174.39451,-39.17083,174.39644,-39.17037,174.39712,-39.16923,174.39678,-39.16666,
    174.39457,-39.16642,174.39175,-39.16967,174.38816,-39.16809,174.38144,-39.16684,174.37997,-39.16364,174.37727,-39.1629,174.37819,-39.15884,174.37632,-39.15742,
    174.37408,-39.15778,174.37231,-39.16115,174.37121,-39.16124,174.37009,-39.15826,174.36776,-39.15675,174.37011,-39.15526,174.36958,-39.1541,174.36876,-39.15355,
    174.36407,-39.1553,174.36262,-39.15384,174.361,-39.1495,174.36236,-39.14888,174.36391,-39.14987,174.36501,-39.14972,174.36816,-39.14479,174.36561,-39.14446,
    174.3655,-39.14609,174.36169,-39.14826,174.361,-39.14786,174.35907,-39.14538,174.36058,-39.14178,174.36295,-39.13892,174.36045,-39.13638,174.36036,-39.13508,
    174.36231,-39.13258,174.361,-39.13207,174.3571,-39.13415,174.35582,-39.1336,174.35581,-39.13261,174.36068,-39.12639,174.35696,-39.12515,174.35008,-39.12502,
    174.35123,-39.12244,174.35373,-39.12191,174.35271,-39.11773,174.35547,-39.11606,174.35595,-39.11428,174.35422,-39.11289,174.35256,-39.1127,174.34883,-39.11425,
    174.34739,-39.11744,174.34786,-39.11919,174.34639,-39.12138,174.3435,-39.12352,174.34197,-39.12354,174.34071,-39.1216,174.34112,-39.11999,174.34289,-39.11902,
    174.34369,-39.11321,174.34159,-39.10878,174.34027,-39.10856,174.3372,-39.11298,174.33539,-39.11386,174.33142,-39.10824,174.32891,-39.10699,174.32459,-39.10642,
    174.32369,-39.10359,174.3167,-39.09756,174.31748,-39.09556,174.31389,-39.08973,174.31442,-39.08847,174.32017,-39.08921,174.32049,-39.08847,174.31903,-39.08631,
    174.31947,-39.08455,174.31765,-39.08304,174.3138,-39.0852,174.31023,-39.08526,174.30892,-39.08126,174.30508,-39.07725,174.30407,-39.07703,174.29995,-39.0809,
    174.29902,-39.08095,174.29865,-39.07945,174.30036,-39.07828,174.3,-39.07566,174.29734,-39.07521,174.29402,-39.07597,174.29278,-39.07391,174.29297,-39.07173,
    174.28941,-39.06554,174.291,-39.06523,174.29373,-39.06662,174.29659,-39.0641,174.29315,-39.06276,174.28879,-39.06227,174.28536,-39.05969,174.28183,-39.06288,
    174.27812,-39.06396,174.27173,-39.05922,174.26792,-39.06393,174.26457,-39.06548,174.26346,-39.06429,174.26307,-39.05786,174.26888,-39.05016,174.26603,-39.04864,
    174.26386,-39.049,174.2605,-39.05124,174.26104,-39.05393,174.26054,-39.05482,174.25941,-39.0549,174.25736,-39.05296,174.25298,-39.05113,174.2551,-39.04568,
    174.2595,-39.04245,174.2539,-39.03946,174.25191,-39.03633,174.25405,-39.03076,174.25267,-39.02332,174.24513,-39.01701,174.24174,-39.01241,174.24144,-39.00797,
    174.23877,-39.00532,174.2415,-39.00249,174.24165,-39.0011,174.23327,-38.99467,174.22844,-38.98778
  ];
  const riverLine=[];for(let i=0;i<river.length;i+=2)riverLine.push([river[i],river[i+1]]);
  const northBank=[...riverLine,[174.20,-38.95],[174.20,-38.40],[174.656,-38.40]];
  const KM_LNG=111.32*Math.cos(-39.05*Math.PI/180),KM_LAT=110.57;
  function riverKm(p){
    let best=Infinity;
    for(let i=1;i<riverLine.length;i++){
      const ax=(riverLine[i-1][0]-p.lng)*KM_LNG,ay=(riverLine[i-1][1]-p.lat)*KM_LAT;
      const bx=(riverLine[i][0]-p.lng)*KM_LNG,by=(riverLine[i][1]-p.lat)*KM_LAT,dx=bx-ax,dy=by-ay;
      const t=Math.max(0,Math.min(1,-(ax*dx+ay*dy)/(dx*dx+dy*dy||1)));
      best=Math.min(best,Math.hypot(ax+t*dx,ay+t*dy));
    }
    return best;
  }
  function riverBank(p){
    if(![p?.lat,p?.lng].every(Number.isFinite)||p.lng>174.60||riverKm(p)<0.5)return null;
    let inside=false;
    for(let i=0,j=northBank.length-1;i<northBank.length;j=i++){
      const [xi,yi]=northBank[i],[xj,yj]=northBank[j];
      if((yi>p.lat)!==(yj>p.lat)&&p.lng<(xj-xi)*(p.lat-yi)/(yj-yi)+xi)inside=!inside;
    }
    return inside?'north':'south';
  }
  function mightCross(from,to){
    if(![from?.lat,from?.lng,to?.lat,to?.lng].every(Number.isFinite))return true;
    const bank=riverBank(from);
    if(bank&&bank===riverBank(to))return false;
    return km(from,bridge)+km(bridge,to)<=1.8*km(from,to)+5;
  }
  const api={bridge,bypass,blocked,safeRoute,matrix,mightCross,riverBank,failure};
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.NakiRouting=api;
})(typeof window==='object'?window:globalThis);
