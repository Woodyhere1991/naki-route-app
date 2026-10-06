import {buildGroups,validateGroup,runStamp,coords,CENTRES,townKey,canonical,settings} from '../../assets/run-suggestions-model.mjs';
import {metWeather} from './field-weather.js';
const RUNS='naki_pickup_runs_v1';
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const parse=value=>typeof value==='string'?JSON.parse(value):value;
const table=id=>id.startsWith('JOTFORM-')?'jotform_bookings':id.startsWith('PICKUP-')?'external_bookings':'bookings';
function view(row,record){
 const b={id:row.id,status:row.status,revision:{booking:row.updated_at,note:row.note_updated_at||0},firstName:row.first_name,lastName:row.last_name,streetAddress:row.street_address,town:row.town,area:row.area,items:parse(row.items_json||'[]'),pickupDate:row.pickup_date||'',pickupWindow:row.pickup_window||'',requestedDate:row.requested_date||'',requestedWindow:row.requested_window||'',additionalInfo:row.additional_info||'',customerNote:row.customer_note||'',ownerNote:row.owner_note||'',externalKey:row.external_key||'',quoteRequired:!!row.quote_required,quotedPrice:row.quoted_at?Number(row.quote_cents||0)/100:null};
 // Reuse only the current app's address cache, never external geocoding or a town pin masquerading as a street pin.
 let cache={};try{cache=parse(record.data.naki_geocache_v10||'{}');}catch{}
 const key=[b.streetAddress,b.town].filter(Boolean).join(', ').toLowerCase().replace(/\s+/g,' ').trim();
 const hit=cache[key];if(coords(hit)){b.lat=Number(hit.lat);b.lng=Number(hit.lng);b.geoLabel=hit.label||'';}
 return b;
}
async function state(env,key){
 const row=await env.CUSTOMER_DB.prepare('SELECT saved_at,record_json FROM run_backups WHERE owner_key=?').bind(key).first();
 if(!row)fail('Save your runs to your account first, then try Suggest runs.',409);
 const record=JSON.parse(row.record_json),store=parse(record.data?.[RUNS]);
 if(!store?.runs?.length)fail('Your account has no saved runs. Save this phone copy first.',409);
 return {record,store};
}
async function bookings(env,record,ids){
 if(ids){const fetched=(await Promise.all([...new Set(ids.map(table))].map(async name=>{const keys=ids.filter(id=>table(id)===name),result=await env.CUSTOMER_DB.prepare(`SELECT b.*,(SELECT note FROM owner_booking_notes WHERE booking_id=b.id) AS owner_note,(SELECT updated_at FROM owner_booking_notes WHERE booking_id=b.id) AS note_updated_at FROM ${name} b WHERE id IN (${keys.map(()=>'?').join(',')})`).bind(...keys).all();return result.results||[];}))).flat();return ids.map(id=>{const row=fetched.find(r=>r.id===id);return row?{row,booking:view(row,record)}:null;});}
 const result=await env.CUSTOMER_DB.prepare(`SELECT b.*,(SELECT note FROM owner_booking_notes WHERE booking_id=b.id) AS owner_note,(SELECT updated_at FROM owner_booking_notes WHERE booking_id=b.id) AS note_updated_at FROM (
 SELECT id,status,updated_at,first_name,last_name,street_address,town,area,items_json,pickup_date,pickup_window,requested_date,requested_window,additional_info,customer_note,quote_required,quoted_at,quote_cents,'' AS external_key FROM bookings WHERE status IN ('NEW','CONTACTED','CONFIRMED','ADDED_TO_RUN')
 UNION ALL SELECT id,status,updated_at,first_name,last_name,street_address,town,area,items_json,pickup_date,pickup_window,'' AS requested_date,'' AS requested_window,additional_info,customer_note,quote_required,quoted_at,quote_cents,'' AS external_key FROM jotform_bookings WHERE status IN ('NEW','CONTACTED','CONFIRMED','ADDED_TO_RUN')
 UNION ALL SELECT id,status,updated_at,first_name,last_name,street_address,town,area,items_json,pickup_date,pickup_window,'' AS requested_date,'' AS requested_window,additional_info,customer_note,quote_required,quoted_at,quote_cents,external_key FROM external_bookings WHERE status IN ('NEW','CONTACTED','CONFIRMED','ADDED_TO_RUN')) b ORDER BY id LIMIT 501`).all();
 if(result.results?.length>500)fail('More than 500 waiting bookings. Narrow this planning batch before continuing.');
 return (result.results||[]).map(row=>({row,booking:view(row,record)}));
}
export async function previewSuggestions(env,key,body,{weather=metWeather,now=Date.now()}={}){
 try{settings(body.options);}catch(e){fail(e.message);} // Reject invalid planning inputs before forecast requests.
 const {record,store}=await state(env,key);
 if(body.runStamp!==runStamp(store))fail('This phone and account have different runs. Save or restore your runs first.',409);
 const rows=await bookings(env,record),candidates=rows.map(x=>x.booking);
 // Only public town centres are sent to the existing free forecast integration.
 const keys=[...new Set([...candidates.map(b=>townKey(b.town)),...store.runs.flatMap(r=>(r.data?.stops||[]).map(s=>townKey(s.town)))])].filter(k=>CENTRES[k]).slice(0,10);
 const results=await Promise.allSettled(keys.map(k=>weather({name:k,...CENTRES[k]})));
 const forecast={towns:results.filter(r=>r.status==='fulfilled').map(r=>r.value),updated_at:new Date(now).toISOString()};
 let plan;try{plan=buildGroups({store,bookings:candidates,options:body.options,weather:forecast,now});}catch(e){fail(e.message);}
 return {...plan,id:crypto.randomUUID(),createdAt:now,baseSavedAt:record.savedAt,runStamp:runStamp(store),bookings:candidates,runNames:store.runs.map(r=>({id:r.id,name:r.name})),forecast};
}
function toStop({row,booking:b},id){
 return {id,src:'direct',submission_id:row.id,first_name:row.first_name||'',last_name:row.last_name||'',phone:row.phone||'',email:row.email||'',street:row.street_address||'',town:row.town||'',area:row.area||'',appliances:b.items,additional_info:row.additional_info||'',note:row.owner_note||'',ownerNoteSynced:row.owner_note||'',amount:row.quoted_at?Number(row.quote_cents||0)/100:Number(row.total_cents||0)/100,status:'NEW',historyStatus:'ADDED_TO_RUN',confirmedPickupDate:row.pickup_date||'',...(coords(b)?{lat:b.lat,lng:b.lng,geoLabel:b.geoLabel}:{}),planningGroupId:id.split(':')[0]};
}
export async function approveSuggestions(env,key,body,{now=Date.now()}={}){
 if(!/^[a-zA-Z0-9_-]{8,100}$/.test(body.id||''))fail('Invalid group reference.');
 const {record,store}=await state(env,key),audit=store.shared?.runSuggestionAudit||[];
 const replay=audit.find(a=>a.type==='accepted'&&a.id===body.id);
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical({group:body.group,options:body.options,revisions:body.revisions,pins:body.pins||{}})));
 const requestStamp=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
 if(replay){if(replay.requestStamp!==requestStamp)fail('This group reference belongs to a different approval.',409);return {record,replayed:true};}
 if(!Number.isFinite(body.createdAt)||now-body.createdAt>30*60000||body.createdAt>now+300000)fail('This preview expired. Generate fresh suggestions.',409);
 if(record.savedAt!==body.baseSavedAt||body.runStamp!==runStamp(store))fail('Runs changed after this preview. Generate fresh suggestions.',409);
 const ids=body.group?.bookingIds;
 if(!Array.isArray(ids)||!ids.length||ids.length>50||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||id.length>120))fail('Choose a unique group of bookings.');
 const rows=await bookings(env,record,ids);
 if(rows.some(x=>!x)||rows.some(x=>canonical(body.revisions?.[x.row.id])!==canonical(x.booking.revision)))fail('A booking changed after this preview. Generate fresh suggestions.',409);
 for(const item of rows){const pin=body.pins?.[item.row.id];if(!pin)continue;const addressKey=[item.booking.streetAddress,item.booking.town].join('|');if(pin.addressKey!==addressKey||!coords(pin))fail('A cached address pin no longer matches this booking.',409);item.booking.lat=Number(pin.lat);item.booking.lng=Number(pin.lng);item.booking.geoLabel=String(pin.label||'').slice(0,250);}
 let plan;try{plan=validateGroup({store,bookings:rows.map(x=>x.booking),options:body.options,group:body.group});}catch(e){fail(e.message);}
 if(audit.length>=2000)fail('Suggestion history is full. Export it before making more changes.');
 const run=plan.target||{id:'suggested-'+body.id,name:String(body.group.runName||'Suggested pickup run').slice(0,60),createdAt:now,updatedAt:now,data:{stops:[],bad:[],manual:true,start:{...CENTRES[plan.opt.startTown]},end:{...CENTRES[plan.opt.startTown]},roundTrip:true}};
 if(!plan.target)store.runs.push(run);
 run.data.planningDay=body.group.day;
 if(!run.data.confirmationDate)run.data.confirmationDate=body.group.day; // owner plan only; booking promises untouched
 run.data.runStartTime=plan.opt.startTime;run.data.stopServiceMin=plan.opt.serviceMinutes;run.data.manual=true;run.updatedAt=now;
 const ordered=ids.map(id=>rows.find(x=>x.row.id===id));
 for(const item of ordered){const stop=toStop(item,body.id+':'+item.row.id);if(coords(stop))run.data.stops.push(stop);else (run.data.bad||=[]).push(stop);}
 store.shared||={};store.shared.runSuggestionAudit=[...audit,{id:body.id,type:'accepted',at:now,previewAt:body.createdAt,version:1,runId:run.id,day:body.group.day,bookingIds:ids,reviewedIds:body.group.reviewedIds||[],options:plan.opt,requestStamp,estimate:plan.estimate,edited:!!body.edited}];
 record.data[RUNS]=JSON.stringify(store);record.runCount=store.runs.length;record.savedAt=Math.max(now,record.savedAt+1);
 const encoded=JSON.stringify(record),previous=await env.CUSTOMER_DB.prepare('SELECT record_json FROM run_backups WHERE owner_key=?').bind(key).first();
 if(new TextEncoder().encode(encoded).length+new TextEncoder().encode(previous?.record_json||'').length>1900000)fail('Account backup and safety copy are too large for this group. Export a backup and review storage before continuing.');
 // Single CAS covers every booking revision and the entire group: no per-booking partial writes.
 const names=[...new Set(rows.map(x=>table(x.row.id)))];
 const guards=names.map(name=>`NOT EXISTS(SELECT 1 FROM json_each(?) c LEFT JOIN ${name} b ON b.id=json_extract(c.value,'$.id') WHERE b.id IS NULL OR b.updated_at<>json_extract(c.value,'$.revision') OR b.status<>json_extract(c.value,'$.status') OR COALESCE((SELECT updated_at FROM owner_booking_notes WHERE booking_id=b.id),0)<>json_extract(c.value,'$.note'))`).join(' AND ');
 const args=[encoded,record.savedAt,key,body.baseSavedAt,...names.map(name=>JSON.stringify(rows.filter(x=>table(x.row.id)===name).map(x=>({id:x.row.id,revision:x.row.updated_at,status:x.row.status,note:x.row.note_updated_at||0}))))];
 const result=await env.CUSTOMER_DB.prepare(`UPDATE run_backups SET previous_json=record_json,record_json=?,saved_at=? WHERE owner_key=? AND saved_at=? AND ${guards}`).bind(...args).run();
 if(!result.meta?.changes)fail('A run or booking changed while approving. Generate fresh suggestions.',409);
 // Existing KV mirror is best effort; authoritative D1 and previous snapshot remain intact.
 try{await env.REMINDERS?.put(key,encoded);}catch{}
 return {record,replayed:false};
}
export async function handleRunSuggestions(request,env,key,path,json){
 if(!['/owner/run-suggestions/preview','/owner/run-suggestions/approve'].includes(path))return null;
 if(request.method!=='POST')return json(request,{error:'Use POST.'},405);
 try{const raw=await request.text();if(raw.length>250000)fail('Planning request too large.',413);const body=JSON.parse(raw);const result=path.endsWith('/preview')?await previewSuggestions(env,key,body):await approveSuggestions(env,key,body);const response=json(request,result);response.headers.set('Cache-Control','private, no-store');return response;}catch(e){return json(request,{error:e.status?e.message:'Suggestions could not be saved or loaded. Refresh and retry.'},e.status||503);}
}
