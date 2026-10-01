import {createHash} from 'node:crypto';
import {cleanItem,canonicalTown,isTestBooking} from '../assets/business-stats-model.js';
import {moneyCents,validDay} from '../assets/earnings-model.js';
import {repriceHistoricalItems} from './history-normalise.mjs';
import {townFromAddress} from './src/customer-details.js';
const text=value=>String(value??'').replace(/<[^>]*>/g,'').replace(/\s+/g,' ').trim();
const hash=value=>createHash('sha256').update(value).digest('hex');
const lower=value=>text(value).normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase();
const email=value=>/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(lower(value))?lower(value):'';
const phone=value=>{let s=text(value).replace(/\D/g,'');if(s.startsWith('64'))s='0'+s.slice(2);return s.length>=8&&s.length<=12?s:'';};
const identity=(e,p)=>email(e)?hash('email:'+email(e)):phone(p)?hash('phone:'+phone(p)):'';
const itemKey=items=>items.map(lower).sort().join('|');
const dayDiff=(a,b)=>validDay(a)&&validDay(b)?Math.round((Date.parse(a)-Date.parse(b))/86400000):Infinity;
export function streetKey(value){
 let s=lower(value).split(',')[0].replace(/[.'’]/g,'').replace(/\b(street|avenue|road|drive|place|crescent|terrace|lane|court|parade|highway)\b/g,m=>({street:'st',avenue:'ave',road:'rd',drive:'dr',place:'pl',crescent:'cres',terrace:'tce',lane:'ln',court:'ct',parade:'pde',highway:'hwy'}[m]));
 const end=s.match(/^(.*?\b(?:st|ave|rd|dr|pl|cres|tce|ln|ct|pde|hwy|way|close|grove)\b)/);if(end)s=end[1];
 return /\d/.test(s)?s.replace(/[^a-z0-9/]/g,''):'';
}
function sourceDetails(sub){
 let address='',e='',p='',name='';
 for(const a of Object.values(sub.answers||{})){
  const label=lower(a.text),v=a.answer;
  if(a.type==='control_address'&&v&&typeof v==='object')address=v.addr_line1||address;
  if(label==='street address'&&typeof v==='string')address=v;
  if(a.type==='control_email'&&!/confirm|again/.test(label))e=email(v)||e;
  if(/phone|mobile/.test(label)&&!/confirm|again/.test(label))p=phone(v&&typeof v==='object'?Object.values(v).join(''):v)||p;
  if(a.type==='control_fullname'&&v&&typeof v==='object')name=[v.first,v.middle,v.last].filter(Boolean).join(' ');
 }
 return {address:streetKey(address),email:e,phone:p,name:lower(name)};
}
export function zeoStop(stop){
 const v=stop.values||{},customs=Object.entries(v).filter(([k])=>/^Custom Field\d+$/.test(k)).map(([,x])=>text(x)).filter(Boolean);
 const items=customs.filter(x=>/^(?:refrigerator|fridge|freezer|washing machine|top.loading washing|front.loading washing|dryer|dishwasher|oven|stove|chest freezer|double\/french door|microwave|large .*fridge|hob|rangehood|tv|television|bbq|gas bottle|bike|bicycle|lawn mower|bar fridge|cooktop|small benchtop oven|metal wash tub|treadmill|exercise bike|elliptical|rowing machine|stair climber|home gym|pilates reformer|push bike|kids' bike|scooter|cast.iron bath|flat.screen tv|old box tv|small desktop printer|large scanner|very large standing scanner|heat pump)/i.test(x)).map(cleanItem);
 const amounts=customs.filter(x=>/^\$?\d+(?:\.\d{1,2})?$/.test(x)).map(x=>moneyCents(x.replace(/^\$/,''))).filter(x=>x!==null&&x<=50000&&(x===0||x>=1000));
 const unique=[...new Set(amounts)];let cents=unique.length===1?unique[0]:null,priceSource=cents!==null?'saved Zeo field':'missing';
 const notes=[v.Note,v['Delivery Notes']].map(text).join(' ');
 if(cents===null){
  const fees=[...notes.matchAll(/\b(?:total|price|paid|cash|amount)\s*[:=\-]?\s*\$\s*(\d+(?:\.\d{1,2})?)(?![\d.])/gi)].map(m=>moneyCents(m[1])).filter(n=>n!==null&&n<=50000);
  if(fees.length&&new Set(fees).size===1){cents=fees[0];priceSource='saved Zeo note';}
  else if(/(?:^|[\s\-:])free(?:\s+(?:pickup|collection))?[.! ]*$/i.test(text(v['Customer Name']))||/^(?:free|free pickup|free collection)[.! ]*$/i.test(notes.trim())){cents=0;priceSource='saved Zeo note';}
 }
 // Large IDs and phone numbers are never prices. Rebuild absent/corrupt values only from named appliances.
 if(cents===null&&items.length){cents=repriceHistoricalItems(items,customs.find(x=>/^(?:rural|outlying|more than 10|main town|main road)/i.test(x))||'');if(cents!==null)priceSource='appliance pricing';}
 const e=email(v['Customer Email']),p=phone(v['Customer Mobile']),name=text(v['Customer Name']),status=lower(v['Stop Progress']);
 const waypoint=!text(v['Stop Type'])&&!name&&!e&&!p&&!customs.length&&!text(v.Note)&&!text(v['Delivery Notes']);
 const test=isTestBooking(name,e)||/^chloe\s+heremaia$/i.test(name)||/^(?:test|testing|test booking)[.! ]*$/i.test(text(v.Note));
 const cancelled=['failed','undo','cancelled','canceled'].includes(status);
 const serial=text(v['Serial No']);
 return {key:`ZEO-${stop.routeId}-${serial||'row'+stop.row}`,aliases:[`ZEO-${stop.routeId}-${serial||'row'+stop.row}`],routeId:stop.routeId,
  requestedDay:stop.routeDay,completedDay:status==='done'?stop.routeDay:'',completed:status==='done',assumed:status!=='done',cancelled,test,waypoint,
  name,customerId:identity(e,p),town:canonicalTown(text(v.City)||townFromAddress(v.Address)||''),items,cents,priceSource,recalculatedPrice:priceSource==='appliance pricing',source:'Zeo',
  match:{address:streetKey(v.Address),email:e,phone:p,name:lower(name)},stableIds:customs.filter(x=>/^\d{18,22}$/.test(x)),
  fingerprint:hash(JSON.stringify([streetKey(v.Address),e||p||lower(name),itemKey(items),cents,customs]))};
}
export function distanceMetres(value){
 const s=lower(value).replace(/,/g,'');if(!s)return null;
 const km=s.match(/(\d+(?:\.\d+)?)\s*km\b/),m=s.match(/(\d+(?:\.\d+)?)\s*m\b/);
 return km||m?Math.round((Number(km?.[1])||0)*1000+(Number(m?.[1])||0)):null;
}
export function mergeZeoHistory(history,jotform,zeo){
 const jobs=structuredClone(history.jobs),byAlias=new Map();for(const job of jobs)for(const alias of job.aliases||[job.key])if(!byAlias.has(alias))byAlias.set(alias,job);
 const candidates=[];for(const sub of jotform.submissions||[]){const job=byAlias.get(String(sub.id));if(job)candidates.push({job,...sourceDetails(sub)});}
 const rows=zeo.stops.map(zeoStop),grouped=new Map(),summary={rawStopRows:zeo.stops.length,waypoints:0,sourceStops:0,sameDayCopies:0,rescheduledCopies:0,matchedExisting:0,newJobs:0,ambiguous:0,failedOrUndone:0,tests:0,missingPrices:0,savedPrices:0,estimatedPrices:0,datesRecovered:0,newValueCents:0};
 // A mostly identical plan moved within a week is evidence of rescheduling.
 // Two routes with completed stops never merge merely because the customer returned.
 const routeRows=zeo.routes.map(route=>({...route,rows:rows.filter(r=>r.routeId===route.id&&!r.waypoint)})),rescheduled=new Map();
 for(let i=0;i<routeRows.length;i++)for(let j=i+1;j<routeRows.length;j++){
  const a=routeRows[i],b=routeRows[j],gap=Math.abs(dayDiff(a.day,b.day));if(gap<1||gap>7||a.rows.length<3||b.rows.length<3||a.rows.some(r=>r.completed)&&b.rows.some(r=>r.completed))continue;
  const x=new Set(a.rows.map(r=>r.fingerprint)),y=new Set(b.rows.map(r=>r.fingerprint)),shared=[...x].filter(k=>y.has(k));
  if(shared.length<3||shared.length/Math.min(x.size,y.size)<.8)continue;
  for(const fingerprint of shared){const keys=[a.day+'|'+fingerprint,b.day+'|'+fingerprint],representative=rescheduled.get(keys[0])||keys[0],other=rescheduled.get(keys[1]);
   if(other&&other!==representative)for(const [key,value]of rescheduled)if(value===other)rescheduled.set(key,representative);
   for(const key of keys)rescheduled.set(key,representative);
  }
 }
 for(const row of rows){if(row.waypoint){summary.waypoints++;continue;}summary.sourceStops++;
  const dayKey=row.requestedDay+'|'+row.fingerprint,key=rescheduled.get(dayKey)||dayKey;
  const previous=grouped.get(key);
  if(previous){if(previous.requestedDay===row.requestedDay)summary.sameDayCopies++;else summary.rescheduledCopies++;previous.aliases.push(...row.aliases);if(row.completed){previous.completed=true;previous.completedDay=row.completedDay;previous.cancelled=false;}continue;}
  grouped.set(key,row);
 }
 const audit=[];const used=new Map();
 for(const row of grouped.values()){
  if(row.test){summary.tests++;audit.push({key:row.key,action:'test'});continue;}
  if(row.cancelled){summary.failedOrUndone++;audit.push({key:row.key,action:'failed or undone'});continue;}
  let match=row.stableIds.map(id=>byAlias.get(id)).find(Boolean),mode=match?'stable ID':'';
  if(!match){
   const found=candidates.filter(c=>{
    const diff=dayDiff(row.requestedDay,c.job.requestedDay);if(diff< -1||diff>35)return false;
    const contact=row.match.email&&row.match.email===c.email||row.match.phone&&row.match.phone===c.phone;
    const sameItems=row.items.length&&c.job.items?.length&&itemKey(row.items)===itemKey(c.job.items);
    const sameName=row.match.name&&row.match.name===c.name;
    return row.match.address&&row.match.address===c.address&&(contact||sameItems||sameName)||contact&&sameItems&&Math.abs(diff)<=14;
   });
   let unique=[...new Map(found.map(c=>[c.job.key,c.job])).values()];
   if(unique.length>1){
    const precise=unique.filter(job=>row.items.length&&itemKey(row.items)===itemKey(job.items||[])&&row.cents!==null&&row.cents===job.cents);
    if(precise.length)unique=precise;
    if(unique.length>1&&precise.length){
     const chronological=unique.map(job=>({job,gap:dayDiff(row.requestedDay,job.requestedDay)})).filter(x=>x.gap>=0).sort((a,b)=>a.gap-b.gap);
     if(chronological.length===1||chronological.length>1&&chronological[0].gap<chronological[1].gap)unique=[chronological[0].job];
    }
   }
   if(unique.length===1){match=unique[0];mode='address/contact and date';}
   else if(unique.length>1){summary.ambiguous++;audit.push({key:row.key,action:'ambiguous existing match',candidates:unique.map(j=>j.key)});continue;}
  }
  if(match){
   // Reused exports of the same source booking join its stable ID. Separate source bookings remain separate.
   summary.matchedExisting++;match.aliases=[...new Set([...(match.aliases||[match.key]),...row.aliases])];
   if(!match.items?.length&&row.items.length)match.items=row.items;
   if(!match.customerId&&row.customerId)match.customerId=row.customerId;if(!match.name&&row.name)match.name=row.name;
   if((!match.town||match.town==='Town not recorded')&&row.town!=='Town not recorded')match.town=row.town;
   if(match.cents===null&&row.cents!==null){match.cents=row.cents;match.priceSource=row.priceSource;match.recalculatedPrice=row.recalculatedPrice;}
   if(row.completed&&!match.completedDay){match.completed=true;match.completedDay=row.completedDay;summary.datesRecovered++;}
   used.set(match.key,(used.get(match.key)||0)+1);audit.push({key:row.key,action:'matched',to:match.key,mode});continue;
  }
  // Near matches remain visible in the private audit rather than adding a possible duplicate to earnings.
  const near=candidates.filter(c=>row.match.address&&row.match.address===c.address&&Math.abs(dayDiff(row.requestedDay,c.job.requestedDay))<=35);
  if(near.length){summary.ambiguous++;audit.push({key:row.key,action:'address needs review',candidates:near.map(c=>c.job.key)});continue;}
  const knownContacts=candidates.filter(c=>row.match.email&&row.match.email===c.email||row.match.phone&&row.match.phone===c.phone);
  const knownIdentities=[...new Set(knownContacts.map(c=>c.job.customerId).filter(Boolean))];
  if(knownIdentities.length===1)row.customerId=knownIdentities[0];
  if(row.town==='Town not recorded'){const knownTowns=[...new Set(knownContacts.map(c=>c.job.town).filter(t=>t&&t!=='Town not recorded'))];if(knownTowns.length===1)row.town=knownTowns[0];}
  const {match:privateMatch,stableIds,fingerprint,waypoint,...job}=row;jobs.push(job);summary.newJobs++;summary.newValueCents+=job.cents||0;
  if(job.cents===null)summary.missingPrices++;else if(job.priceSource.startsWith('saved Zeo'))summary.savedPrices++;else summary.estimatedPrices++;
  audit.push({key:row.key,action:'new',priceSource:job.priceSource,cents:job.cents});
 }
 summary.matchedSourceBookings=used.size;summary.repeatedSourceRoutes=[...used.values()].filter(n=>n>1).reduce((sum,n)=>sum+n-1,0);
 const routeSummaries=zeo.routes.map(route=>{const stops=zeo.stops.filter(s=>s.routeId===route.id),metres=stops.map(s=>distanceMetres(s.values['Distance ( From Start)'])).filter(n=>n!==null);const distance=metres.length?Math.max(...metres):null;return {id:route.id,day:route.day,stops:rows.filter(r=>r.routeId===route.id&&!r.waypoint).length,metres:distance!==null&&distance<=800000?distance:null,distanceOutlier:distance>800000};});
 const routeInfo={routes:routeSummaries.length,stops:summary.sourceStops,firstDay:routeSummaries.map(r=>r.day).sort()[0],lastDay:routeSummaries.map(r=>r.day).sort().at(-1),
  plannedMetres:routeSummaries.reduce((sum,r)=>sum+(r.metres||0),0),routesWithDistance:routeSummaries.filter(r=>r.metres!==null).length,distanceOutliers:routeSummaries.filter(r=>r.distanceOutlier).length,
  longestRoute:routeSummaries.filter(r=>r.metres!==null).sort((a,b)=>b.metres-a.metres)[0]||null,busiestRoute:routeSummaries.slice().sort((a,b)=>b.stops-a.stops)[0]||null,...summary};
 return {history:{...history,jobs,updatedAt:new Date().toISOString(),sources:{...history.sources,zeo:routeInfo},note:history.note+' Zeo route history is matched against existing source bookings. Failed stops, tests, route waypoints and unresolved possible duplicates do not add earnings. Prices reconstructed from appliances are estimates, not receipts.'},summary:routeInfo,audit};
}
