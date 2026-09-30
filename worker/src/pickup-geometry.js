// Coordinates throughout this module are [longitude, latitude]. Distances are metres.
export function metres(a, b) {
  const rad=Math.PI/180, x=(b[0]-a[0])*rad*Math.cos((a[1]+b[1])*rad/2), y=(b[1]-a[1])*rad;
  return Math.hypot(x,y)*6371008.8;
}
export function project(p,a,b) {
  const scale=Math.cos(p[1]*Math.PI/180), dx=(b[0]-a[0])*scale, dy=b[1]-a[1];
  const t=Math.max(0,Math.min(1,((p[0]-a[0])*scale*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy||1)));
  return [a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])];
}
export function nearestLine(p,line) {
  let best={distance:Infinity,point:null};
  for(let i=1;i<line.length;i++){const q=project(p,line[i-1],line[i]),distance=metres(p,q);if(distance<best.distance)best={distance,point:q};}
  return best;
}
export function inRing(p, ring) {
  let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const a=ring[i],b=ring[j];
    if(((a[1]>p[1])!==(b[1]>p[1])) && p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;
  }
  return inside;
}
export function inGeometry(p,geometry) {
  const polygons=geometry.type==='Polygon'?[geometry.coordinates]:geometry.coordinates;
  return polygons.some(rings=>inRing(p,rings[0])&&!rings.slice(1).some(r=>inRing(p,r)));
}
export function geometryDistance(p,geometry) {
  if(inGeometry(p,geometry))return 0;
  const polygons=geometry.type==='Polygon'?[geometry.coordinates]:geometry.coordinates;
  return Math.min(...polygons.flatMap(rings=>rings.map(r=>nearestLine(p,r).distance)));
}
export function intersection(a,b,c,d) {
  const x=b[0]-a[0],y=b[1]-a[1],u=d[0]-c[0],v=d[1]-c[1],den=x*v-y*u;
  if(Math.abs(den)<1e-15)return null;
  const t=((c[0]-a[0])*v-(c[1]-a[1])*u)/den, s=((c[0]-a[0])*y-(c[1]-a[1])*x)/den;
  return t>=0&&t<=1&&s>=0&&s<=1?[a[0]+t*x,a[1]+t*y]:null;
}
