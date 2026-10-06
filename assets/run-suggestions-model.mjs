// Shared, deterministic planning rules. No network, customer messages or learning model.
export const VERSION=1;
export const CENTRES={inglewood:{lat:-39.161,lng:174.207},hawera:{lat:-39.591,lng:174.284},patea:{lat:-39.757,lng:174.476},oakura:{lat:-39.117,lng:173.953},newplymouth:{lat:-39.056,lng:174.075},waitara:{lat:-39.001,lng:174.238},stratford:{lat:-39.337,lng:174.284},eltham:{lat:-39.429,lng:174.299},bellblock:{lat:-39.032,lng:174.148},okato:{lat:-39.195,lng:173.880}};
export const townKey=s=>String(s||'').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase().replace(/[^a-z]/g,'');
export const validDay=d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(d))&&new Date(d).toISOString().slice(0,10)===d;
export const nzDay=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Pacific/Auckland'}).format(new Date());
export function canonical(value){if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';return JSON.stringify(value);}
export const runStamp=store=>canonical((store.runs||[]).map(r=>({id:r.id,name:r.name,data:r.data})));
export const coords=p=>p&&p.lat!==null&&p.lng!==null&&p.lat!==''&&p.lng!==''&&Number.isFinite(Number(p.lat))&&Number.isFinite(Number(p.lng))&&Number(p.lat)>-40.3&&Number(p.lat)<-38.4&&Number(p.lng)>173.4&&Number(p.lng)<175.3;
export function km(a,b){if(!coords(a)||!coords(b))return Infinity;const r=Math.PI/180,x=Math.sin((b.lat-a.lat)*r/2)**2+Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin((b.lng-a.lng)*r/2)**2;return 6371*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));}
const point=s=>coords(s)?{lat:Number(s.lat),lng:Number(s.lng)}:CENTRES[townKey(s?.town)]||null;
const active=s=>s.kind==='unload'||!['DONE','COMPLETED','CANCELLED','DECLINED'].includes(s.status)&&!s.collectedAt&&s.historyStatus!=='COMPLETED';
const existingDateConflict=(run,day)=>(run?.data?.stops||[]).filter(s=>active(s)&&s.kind!=='unload').some(s=>s.confirmedPickupDate&&s.confirmedPickupDate!==day);
export function settings(input,today=nzDay()){
 const days=[...new Set(input.days||[])].sort();
 if(!days.length||days.length>14||days.some(d=>!validDay(d)||d<today||d>new Date(Date.parse(today)+30*86400000).toISOString().slice(0,10)))throw Error('Enter 1–14 available days within the next 30 days.');
 const out={days,targetRunId:String(input.targetRunId||''),startTown:townKey(input.startTown),maxPickups:Number(input.maxPickups),maxItems:Number(input.maxItems),maxMinutes:Number(input.maxMinutes),serviceMinutes:Number(input.serviceMinutes),corridorKm:Number(input.corridorKm),startTime:String(input.startTime||''),endTime:String(input.endTime||''),availabilityConfirmed:input.availabilityConfirmed===true};
 if(!CENTRES[out.startTown])throw Error('Choose your planning start / return town.');
 for(const [k,min,max] of [['maxPickups',1,50],['maxItems',1,200],['maxMinutes',15,720],['serviceMinutes',1,120],['corridorKm',1,100]])if(!Number.isFinite(out[k])||out[k]<min||out[k]>max)throw Error('Enter valid pickup, item, time and area limits.');
 if(!Number.isInteger(out.maxPickups)||!Number.isInteger(out.maxItems))throw Error('Pickup and item limits must be whole numbers.');
 if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(out.startTime)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(out.endTime)||out.endTime<=out.startTime)throw Error('Enter working start and finish times for these days.');
 const mins=s=>Number(s.slice(0,2))*60+Number(s.slice(3));out.maxMinutes=Math.min(out.maxMinutes,mins(out.endTime)-mins(out.startTime));
 return out;
}
export function itemCount(items){return (items||[]).reduce((n,item)=>{const q=String(item).match(/^\s*(\d+)\s*(?:x|×)\s*/i);return n+(q?Number(q[1]):1);},0);}
export function assigned(store,b){return (store.runs||[]).some(r=>[...(r.data?.stops||[]),...(r.data?.bad||[])].some(s=>s.submission_id===b.id||b.externalKey&&(s.historyBookingKey===b.externalKey||s.src!=='direct'&&`pickup:${s.submission_id||s.unpaidSourceId||s.id}`===b.externalKey)));}
export function eligibility(b,store,day){
 if(store.shared?.pendingDirectStatuses?.[b.id]==='COMPLETED')return 'Completion is waiting to sync';
 if(!['NEW','CONTACTED','CONFIRMED','ADDED_TO_RUN'].includes(b.status))return 'Booking is completed, cancelled or unavailable';
 if(assigned(store,b))return 'Already assigned to a run';
 if(!b.items?.length)return 'Item list needs checking';
 if(!b.streetAddress?.trim()||!CENTRES[townKey(b.town)]&&!coords(b))return 'Address or town needs checking';
 if(b.quoteRequired&&b.quotedPrice==null)return 'Quote needs approval';
 if(b.pickupWindow||b.requestedWindow)return 'Customer time window needs a manual plan';
 if((b.pickupDate&&!validDay(b.pickupDate))||(b.requestedDate&&!validDay(b.requestedDate)))return 'Customer date needs checking';
 if(day&&((b.pickupDate&&b.pickupDate!==day)||(b.requestedDate&&b.requestedDate!==day)))return 'Customer date does not fit';
 return '';
}
export function weatherFor(weather,towns,day,now=Date.now()){
 const required=[...new Set(towns.map(townKey))],rows=required.map(k=>weather?.towns?.find(t=>townKey(t.name)===k));
 const times=rows.map(t=>Date.parse(t?.updated_at||weather?.updated_at||''));
 const days=rows.map(t=>t?.days?.find(d=>d.date===day));
 const good=required.length&&times.every(t=>Number.isFinite(t)&&now-t<12*3600000&&t<=now+300000)&&days.every(d=>d&&!d.partial&&Number.isFinite(d.rain_mm)&&Number.isFinite(d.gust??d.wind));
 const range=(weather?.towns||[]).flatMap(t=>(t.days||[]).map(d=>d.date)).sort();
 if(!good)return {available:false,penalty:null,label:'Weather unavailable or partial for this day',horizon:range.length?[range[0],range.at(-1)]:null,updatedAt:weather?.updated_at||null};
 const rain=Math.max(...days.map(d=>d.rain_mm)),wind=Math.max(...days.map(d=>Number(d.gust??d.wind)||0));
 return {available:true,penalty:rain+Math.max(0,wind-30)/5,label:`Forecast: up to ${rain} mm rain; ${wind} km/h ${days.some(d=>d.gust!=null)?'gust/wind':'wind'}`,horizon:[range[0],range.at(-1)],updatedAt:new Date(Math.min(...times)).toISOString(),source:[...new Set(rows.map(t=>t.source||'MET Norway'))].join(' / ')};
}
function routeEstimate(base,insertions,opt){
 // Preserve all existing pending stops and unload boundaries; insertions go on the final leg.
 const seq=base.filter(active),start=point(base.start)||CENTRES[opt.startTown],end=point(base.end)||start;
 let prev=start,total=0,unknown=false;
 for(const s of [...seq,...insertions]){const p=point(s);if(!p){unknown=true;continue;}total+=km(prev,p)*1.4;prev=p;}
 total+=km(prev,end)*1.4;
 return {km:Math.round(total),minutes:Math.ceil(total/45*60+seq.filter(s=>s.kind!=='unload').length*opt.serviceMinutes+insertions.length*opt.serviceMinutes+seq.filter(s=>s.kind==='unload').length*opt.serviceMinutes),unknown};
}
export function routePlan(run,bookings,opt){
 const data=run?.data||{},base=(data.stops||[]).filter(active),parked=(data.bad||[]).filter(active),remaining=[...bookings],ordered=[];
 let prev=point(base.at(-1))||point(data.start)||CENTRES[opt.startTown];
 while(remaining.length){remaining.sort((a,b)=>km(prev,point(a))-km(prev,point(b))||a.id.localeCompare(b.id));const next=remaining.shift();ordered.push(next);prev=point(next);}
 const withEnds=Object.assign([...base],{start:data.start,end:data.end});
 const estimate=routeEstimate(withEnds,ordered,opt),existingItems=[...base,...parked].filter(s=>s.kind!=='unload').reduce((n,s)=>n+itemCount(s.appliances||s.items),0);
 return {ordered,estimate,pickups:[...base,...parked].filter(s=>s.kind!=='unload').length+bookings.length,items:existingItems+bookings.reduce((n,b)=>n+itemCount(b.items),0),hasParked:parked.length>0};
}
export function buildGroups({store,bookings,options,weather,today=nzDay(),now=Date.now()}){
 const opt=settings(options,today),target=opt.targetRunId?store.runs.find(r=>r.id===opt.targetRunId):null;
 if(opt.targetRunId&&!target)throw Error('The selected run is missing. Refresh your runs.');
 const fixedDay=target?.data?.confirmationDate||target?.data?.planningDay;
 const occupied=(store.runs||[]).filter(r=>r.id!==target?.id&&[...(r.data?.stops||[]),...(r.data?.bad||[])].some(active)).map(r=>r.data?.confirmationDate||r.data?.planningDay).filter(Boolean);
 const days=(fixedDay?opt.days.filter(d=>d===fixedDay):opt.days).filter(d=>!occupied.includes(d)),usedDays=new Set();
 if(!days.length)throw Error('No free planning day fits. Check the existing run day and other scheduled runs.');
 const held=[],candidates=[];
 for(const b of bookings){const reason=eligibility(b,store);if(reason)held.push({id:b.id,reason});else if(!days.some(d=>!eligibility(b,store,d)))held.push({id:b.id,reason:'Customer date does not fit available days'});else candidates.push(b);}
 const pool=new Map(candidates.map(b=>[b.id,b])),groups=[];
 while(pool.size&&groups.length<8){
  const trials=[];
  for(const day of days.filter(d=>!usedDays.has(d))){
   if(existingDateConflict(target,day))continue;
   const anchors=target?[target]:[...new Map([...pool.values()].map(b=>[townKey(b.town)||`${Math.round(b.lat*10)},${Math.round(b.lng*10)}`,b])).values()].slice(0,24);
   for(const anchor of anchors){
    const near=target?[...(target.data.stops||[]),...(target.data.bad||[])].filter(active).map(point).filter(Boolean):[point(anchor)];if(target&&!near.length)near.push(point(target.data.start)||CENTRES[opt.startTown]);
    const choices=[...pool.values()].filter(b=>!eligibility(b,store,day)&&(!near.length||Math.min(...near.map(p=>km(point(b),p)))<=opt.corridorKm)).sort((a,b)=>Number(!!b.pickupDate||!!b.requestedDate)-Number(!!a.pickupDate||!!a.requestedDate)||a.id.localeCompare(b.id));
    const selected=[];
    for(const b of choices){const plan=routePlan(target,[...selected,b],opt);if(plan.pickups<=opt.maxPickups&&plan.items<=opt.maxItems&&plan.estimate.minutes<=opt.maxMinutes&&!plan.estimate.unknown&&!plan.hasParked)selected.push(b);}
    if(!selected.length)continue;
    const plan=routePlan(target,selected,opt),wx=weatherFor(weather,[...selected.map(b=>b.town),...(target?.data?.stops||[]).filter(active).map(s=>s.town).filter(Boolean)],day,now);
    trials.push({day,bookingIds:plan.ordered.map(b=>b.id),runId:target?.id||'',runName:target?.name||[...new Set(selected.map(b=>b.town))].slice(0,2).join(' / '),plan,weather:wx});
   }
  }
  // Weather breaks ties only when every alternative has comparable forecast coverage.
  const count=Math.max(0,...trials.map(t=>t.bookingIds.length)),top=trials.filter(t=>t.bookingIds.length===count),weatherComparable=top.length>0&&top.every(t=>t.weather.available);
  top.sort((a,b)=>(weatherComparable?a.weather.penalty-b.weather.penalty:0)||a.plan.estimate.minutes-b.plan.estimate.minutes||a.day.localeCompare(b.day));
  if(!top.length)break;
  const chosen=top[0];groups.push({...chosen,weatherRanked:weatherComparable,confidence:chosen.plan.ordered.every(b=>coords(b))&&opt.availabilityConfirmed?'medium':'provisional',reasons:['Customer dates fit',target?'Fits the selected run area; existing order kept':'Nearby towns grouped',`Within entered limits: ${chosen.plan.pickups} pickups / ${chosen.plan.items} items`,weatherComparable?'Weather compared across suitable days':'Days chosen without weather ranking']});
  chosen.bookingIds.forEach(id=>pool.delete(id));usedDays.add(chosen.day);if(target)break;
 }
 for(const b of pool.values())held.push({id:b.id,reason:'No space, time or nearby run within entered limits'});
 return {version:VERSION,options:opt,groups:groups.map(({plan,...g})=>({...g,estimate:plan.estimate,pickups:plan.pickups,items:plan.items})),held};
}
export function validateGroup({store,bookings,options,group,today=nzDay()}){
 const opt=settings(options,today);if(!opt.availabilityConfirmed)throw Error('Confirm your availability and load limits first.');
 if(!opt.days.includes(group.day))throw Error('Choose one of your entered available days.');
 const target=group.runId?store.runs.find(r=>r.id===group.runId):null;if(group.runId&&!target)throw Error('Run missing.');
 if(opt.targetRunId!==group.runId)throw Error('Use the selected run or generate fresh suggestions for new runs.');
 if((store.runs||[]).some(r=>r.id!==group.runId&&(r.data?.confirmationDate||r.data?.planningDay)===group.day&&[...(r.data?.stops||[]),...(r.data?.bad||[])].some(active)))throw Error('Another active run already uses this day. Choose it as the target or choose another day.');
 const fixed=target?.data?.confirmationDate||target?.data?.planningDay;if(fixed&&fixed!==group.day)throw Error('The existing run day cannot change here.');
 if(existingDateConflict(target,group.day))throw Error('An existing pickup has a different confirmed day. Resolve that before adding this group.');
 if(!group.bookingIds?.length||group.bookingIds.length>50||new Set(group.bookingIds).size!==group.bookingIds.length)throw Error('Select a unique group of bookings.');
 const rows=group.bookingIds.map(id=>bookings.find(b=>b.id===id));if(rows.some(b=>!b))throw Error('A booking is missing.');
 for(const b of rows){const reason=eligibility(b,store,group.day);if(reason)throw Error(reason);if((b.additionalInfo||b.customerNote||b.ownerNote)&&!group.reviewedIds?.includes(b.id))throw Error('Review the customer and owner notes for each selected booking.');}
 const near=target?[...(target.data.stops||[]),...(target.data.bad||[])].filter(active).map(point).filter(Boolean):[point(rows[0])];
 if(rows.some(b=>near.length&&Math.min(...near.map(p=>km(point(b),p)))>opt.corridorKm))throw Error('A booking is outside the entered area limit.');
 const plan=routePlan(target,rows,opt);
 // Validate the edited order too, not just the generated nearest-neighbour order.
 const edited=routeEstimate(Object.assign([...(target?.data?.stops||[])],{start:target?.data?.start,end:target?.data?.end}),rows,opt);
 if(plan.pickups>opt.maxPickups||plan.items>opt.maxItems||edited.minutes>opt.maxMinutes||edited.unknown||plan.hasParked)throw Error('This group exceeds the entered limits or the run has unresolved addresses.');
 if(rows.some(b=>!coords(b))&&group.townOnlyConfirmed!==true)throw Error('Confirm that town-only stops need address pins before driving.');
 return {rows,target,opt,estimate:edited};
}
export function editedMetrics(store,bookings,opt,group){const run=store.runs.find(r=>r.id===group.runId),rows=group.bookingIds.map(id=>bookings.find(b=>b.id===id)).filter(Boolean),plan=routePlan(run,rows,opt);return {...plan,estimate:routeEstimate(Object.assign([...(run?.data?.stops||[])],{start:run?.data?.start,end:run?.data?.end}),rows,opt)};}
