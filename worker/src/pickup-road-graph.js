import {metres,project} from './pickup-geometry.js';
export const roadKey=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/^state highway /,'sh ').replace(/^sh\s*(\d)/,'sh $1');

// Build-time multi-source Dijkstra on REVERSED directed edges: each distance
// describes driving FROM that node TO the covered town/road, respecting one-way.
export function reverseDistances(count,segments,points,seeds){
  const reverse=Array.from({length:count},()=>[]);
  for(const [a,b,dir] of segments){const length=metres(points[a],points[b]);if(dir&1)reverse[b].push([a,length]);if(dir&2)reverse[a].push([b,length]);}
  const distances=Array(count).fill(Infinity),places=Array(count).fill(-1),heap=[];
  const push=item=>{heap.push(item);let at=heap.length-1;while(at){const up=(at-1)>>1;if(heap[up][0]<=item[0])break;heap[at]=heap[up];at=up;}heap[at]=item;};
  const pop=()=>{const top=heap[0],last=heap.pop();if(heap.length){let at=0;while(at*2+1<heap.length){let child=at*2+1;if(child+1<heap.length&&heap[child+1][0]<heap[child][0])child++;if(heap[child][0]>=last[0])break;heap[at]=heap[child];at=child;}heap[at]=last;}return top;};
  for(const {at,cost=0,place} of seeds)if(cost<distances[at]){distances[at]=cost;places[at]=place;push([cost,at]);}
  while(heap.length){const [distance,at]=pop();if(distance!==distances[at])continue;for(const [next,length] of reverse[at]){const d=distance+length;if(d<distances[next]){distances[next]=d;places[next]=places[at];push([d,next]);}}}
  return {distances,places};
}

export function localRoadDistances(point,street,graph){
  if(!graph)return null;
  const x=Math.floor(point[0]*100),y=Math.floor(point[1]*100),indexes=new Set();
  for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const i of graph.cells[(x+dx)+','+(y+dy)]||[])indexes.add(i);
  const requested=roadKey(street);let best;
  for(const index of indexes){const segment=graph.segments[index],[a,b,_dir,name,ref]=segment;
    if(roadKey(graph.names[name])!==requested&&!String(graph.names[ref]||'').split(';').some(r=>r&&roadKey(r)===requested))continue;
    const q=project(point,graph.nodes[a],graph.nodes[b]),snap=metres(point,q);
    if(!best||snap<best.snap)best={segment,point:q,snap};
  }
  if(!best||best.snap>150)return null;
  const [a,b,dir,, ,mainGates=[],outlyingGates=[],covered=0]=best.segment;
  const length=metres(graph.nodes[a],graph.nodes[b]),t=length?metres(graph.nodes[a],best.point)/length:0;
  const answer={snap:best.snap};
  for(const [kind,column,gates,bit] of [['main',2,mainGates,1],['outlying',3,outlyingGates,2]]){
    let distance=Infinity,place=-1;
    const consider=(d,p)=>{if(d<distance){distance=d;place=p;}};
    if(dir&2&&graph.nodes[a][column]!==null)consider(graph.nodes[a][column]+length*t,graph.nodes[a][column+2]);
    if(dir&1&&graph.nodes[b][column]!==null)consider(graph.nodes[b][column]+length*(1-t),graph.nodes[b][column+2]);
    for(const [gateT,gatePlace] of gates)if((gateT>=t&&dir&1)||(gateT<=t&&dir&2))consider(Math.abs(gateT-t)*length,gatePlace);
    if(covered&bit)consider(0,gates[0]?.[1]??graph.corridorPlaces[kind]);
    if(Number.isFinite(distance))answer[kind]={distance,name:graph.places[place]||'a covered '+(kind==='main'?'main town or road':'outlying town or route'),kind};
  }
  return answer;
}
