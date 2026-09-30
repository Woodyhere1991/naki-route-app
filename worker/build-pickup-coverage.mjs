// Rebuild public coverage data from official boundaries and the mapped routes.
// Run from the business root after downloading the public inputs to tmp/.
import fs from 'node:fs';
import {inGeometry,nearestLine,intersection,metres} from './src/pickup-geometry.js';
const root=new URL('../../',import.meta.url);
const read=name=>JSON.parse(fs.readFileSync(new URL('tmp/'+name,root)));
const main=new Set(['New Plymouth','Waitara','Inglewood','Stratford','Eltham','Hawera']);
const towns=read('pickup-urban-2026.json').features.map(f=>({name:f.properties.UR2026_V1_00_NAME_ASCII,kind:main.has(f.properties.UR2026_V1_00_NAME_ASCII)?'main':'outlying',geometry:f.geometry}));
for(const town of towns){const p=town.geometry.coordinates.flat(town.geometry.type==='Polygon'?1:2);town.bounds=[Math.min(...p.map(x=>x[0])),Math.min(...p.map(x=>x[1])),Math.max(...p.map(x=>x[0])),Math.max(...p.map(x=>x[1]))];}
const osm=read('pickup-osm-roads.json'),nodes=new Map(osm.elements.filter(e=>e.type==='node').map(e=>[e.id,[e.lon,e.lat]]));
const ways=osm.elements.filter(e=>e.type==='way'&&!['no','private'].includes(e.tags?.access)&&!['no','private'].includes(e.tags?.motor_vehicle)&&!['no','private'].includes(e.tags?.motorcar)&&e.tags?.highway!=='service');
function roadPath(select,start,end){
  const graph=new Map();
  const add=(a,b)=>{if(!graph.has(a))graph.set(a,[]);graph.get(a).push([b,metres(nodes.get(a),nodes.get(b))]);};
  for(const w of ways.filter(select))for(let i=1;i<w.nodes.length;i++){const a=w.nodes[i-1],b=w.nodes[i];if(nodes.has(a)&&nodes.has(b)){add(a,b);add(b,a);}}
  const nearest=p=>[...graph.keys()].sort((a,b)=>metres(p,nodes.get(a))-metres(p,nodes.get(b)))[0];
  const source=nearest(start),target=nearest(end),dist=new Map([[source,0]]),prev=new Map(),open=new Set([source]);
  while(open.size){let at;for(const id of open)if(at===undefined||dist.get(id)<dist.get(at))at=id;open.delete(at);if(at===target)break;for(const [next,length] of graph.get(at)){const d=dist.get(at)+length;if(d<(dist.get(next)??Infinity)){dist.set(next,d);prev.set(next,at);open.add(next);}}}
  if(!dist.has(target))throw new Error('Covered road graph is disconnected');
  const ids=[target];while(ids[0]!==source)ids.unshift(prev.get(ids[0]));return ids.map(id=>nodes.get(id));
}
// Follow the actual named highways. A fastest-route shortcut is not automatically
// a covered main road (e.g. Wiremu Road bypassing the coastal highway).
const ref=n=>w=>String(w.tags.ref||'').split(';').includes('SH '+n);
const corridors=[
  {name:'SH 3: Hāwera–New Plymouth–Waitara',kind:'main',line:roadPath(ref('3'),[174.284,-39.591],[174.238,-39.001])},
  {name:'SH 3A: Inglewood–Waitara',kind:'main',line:roadPath(ref('3A'),[174.207,-39.161],[174.238,-39.001])},
  {name:'SH 45: Ōakura–Manaia coast',kind:'outlying',line:roadPath(ref('45'),[174.075,-39.056],[174.125,-39.551])},
  {name:'Eltham Road: Ōpunake–Kaponga',kind:'outlying',line:read('pickup-route-inland.json').routes[0].geometry.coordinates}
];
const pointKey=p=>p.map(n=>n.toFixed(6)).join(',');
for(const road of corridors){
  const points=new Set(road.line.map(pointKey));road.namedSegments=[];
  for(const w of ways){if(!w.tags.name)continue;const pairs=[];for(let i=1;i<w.nodes.length;i++){const a=nodes.get(w.nodes[i-1]),b=nodes.get(w.nodes[i]);if(a&&b&&points.has(pointKey(a))&&points.has(pointKey(b)))pairs.push([a,b]);}if(pairs.length)road.namedSegments.push({name:w.tags.name,ref:w.tags.ref||'',segments:pairs});}
}
const use=new Map();for(const w of ways)for(const id of w.nodes)use.set(id,(use.get(id)||0)+1);
const gates=[];
for(const town of towns){
  const polygons=town.geometry.type==='Polygon'?[town.geometry.coordinates]:town.geometry.coordinates;
  const edges=polygons.flatMap(rings=>rings.flatMap(ring=>ring.slice(1).map((p,i)=>[ring[i],p])));
  const xs=edges.flat().map(p=>p[0]),ys=edges.flat().map(p=>p[1]),box=[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)];
  for(const way of ways){
    const points=way.nodes.map(id=>nodes.get(id)).filter(Boolean);
    for(let i=1;i<points.length;i++){
      const a=points[i-1],b=points[i];
      if(Math.max(a[0],b[0])<box[0]||Math.min(a[0],b[0])>box[2]||Math.max(a[1],b[1])<box[1]||Math.min(a[1],b[1])>box[3])continue;
      for(const [c,d] of edges){
        if(Math.max(a[0],b[0])<Math.min(c[0],d[0])||Math.min(a[0],b[0])>Math.max(c[0],d[0])||Math.max(a[1],b[1])<Math.min(c[1],d[1])||Math.min(a[1],b[1])>Math.max(c[1],d[1]))continue;
        const hit=intersection(a,b,c,d);if(hit)gates.push({point:hit,kind:town.kind,name:town.name});
      }
    }
  }
}
for(const corridor of corridors){
  // Every mapped junction is a legal place to join a covered road. Also retain
  // route endpoints. Runtime adds a nearest projection for unmapped driveways.
  for(const [id,count] of use){if(count<2)continue;const p=nodes.get(id);if(towns.some(t=>t.kind===corridor.kind&&inGeometry(p,t.geometry)))continue;if(nearestLine(p,corridor.line).distance<=8)gates.push({point:p,kind:corridor.kind,name:corridor.name});}
  for(const p of [corridor.line[0],corridor.line.at(-1)])gates.push({point:p,kind:corridor.kind,name:corridor.name});
}
const unique=[];for(const gate of gates)if(!unique.some(g=>g.kind===gate.kind&&metres(g.point,gate.point)<15))unique.push(gate);
const data={version:'20260930-v1',builtAt:new Date().toISOString(),sources:{towns:'Stats NZ Urban Rural Areas 2026, high definition, CC BY 4.0',townUrl:'https://services2.arcgis.com/vKb0s8tBIA3bdocZ/ArcGIS/rest/services/Urban_Rural_Areas_2026/FeatureServer/0',roads:'© OpenStreetMap contributors, ODbL; OSRM road routes and public junctions',roadUrl:'https://www.openstreetmap.org/copyright'},towns,corridors,gates:unique};
const rounded=JSON.stringify(data,(_k,v)=>typeof v==='number'?Math.round(v*1e6)/1e6:v);
fs.writeFileSync(new URL('./src/pickup-coverage.json',import.meta.url),rounded+'\n');
console.log({towns:towns.length,corridors:corridors.length,gates:unique.length,bytes:rounded.length});
