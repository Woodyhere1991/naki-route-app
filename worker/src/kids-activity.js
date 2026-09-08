const GAMES = ['numbers','patterns','bridge','pack','robot','share','round','sorter'];
const ORIGINS = new Set(['https://nakiwhitewareremoval.vip','https://www.nakiwhitewareremoval.vip','https://naki-collection.pages.dev']);
const DAY = 86400000;
export function nzDay(stamp = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA',{timeZone:'Pacific/Auckland',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(stamp));
  return ['year','month','day'].map(k=>parts.find(p=>p.type===k).value).join('-');
}
export async function recordKidsActivity(request, env, json, stamp = Date.now()) {
  if (request.method !== 'POST') return json(request,{error:'Method not allowed'},405);
  if (!ORIGINS.has(request.headers.get('Origin'))) return json(request,{error:'Unsupported origin'},403);
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) return json(request,{error:'JSON required'},415);
  // Bound the stream, including requests without a Content-Length header.
  const reader=request.body?.getReader(); if(!reader) return json(request,{error:'Event required'},400);
  let size=0,raw=''; const decoder=new TextDecoder();
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>256){await reader.cancel();return json(request,{error:'Event too large'},413);}raw+=decoder.decode(value,{stream:true});}
  raw+=decoder.decode(); let event;try{event=JSON.parse(raw);}catch{return json(request,{error:'Invalid event'},400);}
  if(!event || Array.isArray(event) || Object.keys(event).sort().join(',')!=='game,id,kind' || !GAMES.includes(event.game) || !['start','finish'].includes(event.kind) || typeof event.id!=='string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(event.id)) return json(request,{error:'Invalid event'},400);
  // A rotating key is used only in Cloudflare's short-lived limiter, never in D1.
  if (env.KIDS_RATE_LIMIT) {
    const keyBytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`${env.AUTH_PEPPER}|kids|${Math.floor(stamp/600000)}|${request.headers.get('CF-Connecting-IP')||'unknown'}`));
    const key=Array.from(new Uint8Array(keyBytes),x=>x.toString(16).padStart(2,'0')).join('');
    if(!(await env.KIDS_RATE_LIMIT.limit({key})).success) return json(request,{error:'Please wait'},429);
  }
  const channel=new URL(request.url).searchParams.get('test')==='1'?'test':'live';
  if(event.kind==='start'){
    await env.CUSTOMER_DB.prepare('INSERT OR IGNORE INTO kids_activity_rounds(id,game,day,channel,expires_at) VALUES(?1,?2,?3,?4,?5)').bind(event.id,event.game,nzDay(stamp),channel,stamp+DAY).run();
  }else{
    await env.CUSTOMER_DB.prepare('UPDATE kids_activity_rounds SET finished=1 WHERE id=?1 AND game=?2 AND channel=?3 AND finished=0 AND expires_at>?4').bind(event.id,event.game,channel,stamp).run();
  }
  return json(request,{ok:true});
}
export async function kidsActivityReport(request,env,json,stamp=Date.now()) {
  const url=new URL(request.url),days=Number(url.searchParams.get('days')||7);
  if(![1,7,30].includes(days))return json(request,{error:'Choose 1, 7 or 30 days'},400);
  const today=nzDay(stamp);
  // Subtract calendar days from the NZ date, so DST cannot shift the date boundary.
  const from=new Date(Date.parse(today+'T12:00:00Z')-(days-1)*DAY).toISOString().slice(0,10);
  const channel=url.searchParams.get('test')==='1'?'test':'live';
  const result=await env.CUSTOMER_DB.prepare('SELECT day,game,starts,finishes FROM kids_activity_daily WHERE day>=?1 AND day<=?2 AND channel=?3 ORDER BY day,game').bind(from,today,channel).all();
  const rows=result.results||[];
  const games=GAMES.map(game=>({game,starts:rows.filter(r=>r.game===game).reduce((s,r)=>s+Number(r.starts),0),finishes:rows.filter(r=>r.game===game).reduce((s,r)=>s+Number(r.finishes),0)}));
  const daily=Array.from({length:days},(_,i)=>{const day=new Date(Date.parse(from+'T12:00:00Z')+i*DAY).toISOString().slice(0,10);return {day,starts:rows.filter(r=>r.day===day).reduce((s,r)=>s+Number(r.starts),0),finishes:rows.filter(r=>r.day===day).reduce((s,r)=>s+Number(r.finishes),0)};});
  return json(request,{days,from,to:today,timeZone:'Pacific/Auckland',channel,totals:{starts:games.reduce((s,g)=>s+g.starts,0),finishes:games.reduce((s,g)=>s+g.finishes,0)},games,daily,updatedAt:new Date(stamp).toISOString()});
}
export async function purgeKidsActivity(env,stamp=Date.now()) {
  await env.CUSTOMER_DB.batch([
    env.CUSTOMER_DB.prepare('DELETE FROM kids_activity_rounds WHERE expires_at<?1').bind(stamp),
    env.CUSTOMER_DB.prepare('DELETE FROM kids_activity_daily WHERE day<?1').bind(nzDay(stamp-365*DAY))
  ]);
}
