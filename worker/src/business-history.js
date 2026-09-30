import {bookingRows,nzDay,rowsFromBackup} from '../../assets/earnings-model.js';
import {canonicalTown,cleanItem,mergeStatsRows,isTestBooking} from '../../assets/business-stats-model.js';
export const HISTORY_KEY='owner-analytics/business-history-v1.json';
export async function readBusinessHistory(env) {
  if(!env.DOCUMENTS)return {jobs:[],sources:{unavailable:true}};
  try {
    const object=await env.DOCUMENTS.get(HISTORY_KEY);
    if(!object)return {jobs:[],sources:{unavailable:true}};
    const snapshot=await object.json();
    if(snapshot.version!==1||!Array.isArray(snapshot.jobs))throw Error('Unsupported history');
    return snapshot;
  }catch{return {jobs:[],sources:{unavailable:true},note:'Historical source snapshot could not be read. Current saved bookings and receipts remain available.'};}
}
export function historyFinancialRows(history,today=nzDay()) {
  // Owner's requested historical assumption. Current live status still wins by rank.
  return mergeStatsRows(history.jobs||[]).filter(r=>!r.cancelled&&!r.test&&(r.completed||r.requestedDay&&r.requestedDay<today)).map(r=>({kind:'booking',key:r.key,aliases:r.aliases,rank:-1,source:'HISTORICAL_SHEET',
    status:'COMPLETED',assumed:!r.completed,at:0,completedAt:r.completedDay?Date.parse(r.completedDay+'T00:00:00+12:00'):0,
    pickupDay:r.requestedDay||'',cents:r.cents,priceReviewCents:r.priceReviewCents,recalculatedPrice:r.recalculatedPrice}));
}
export async function customerIdentity(email,phone){
  const e=String(email||'').trim().toLowerCase();let p=String(phone||'').replace(/\D/g,'');if(p.startsWith('64'))p='0'+p.slice(2);
  const key=/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)?'email:'+e:p.length>=8?'phone:'+p:'';if(!key)return '';
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key)));
  return [...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');
}
function items(value){try{return (Array.isArray(value)?value:JSON.parse(value||'[]')).map(cleanItem).filter(Boolean);}catch{return [];}}
export async function businessStatistics(env,history,backup,entries){
  const [jobs,documents]=await Promise.all([
    env.CUSTOMER_DB.prepare(`SELECT id,first_name,last_name,email,phone,town,items_json,created_at,status,'' AS submission_id,'' AS external_key,'WEBSITE' AS source FROM bookings
      UNION ALL SELECT id,first_name,last_name,email,phone,town,items_json,created_at,status,submission_id,'' AS external_key,'JOTFORM' AS source FROM jotform_bookings
      UNION ALL SELECT id,first_name,last_name,email,phone,town,items_json,created_at,status,'' AS submission_id,external_key,'PICKUP_RUN' AS source FROM external_bookings`).all(),
    env.CUSTOMER_DB.prepare(`SELECT id,booking_id,email,items_json,kind FROM booking_documents WHERE kind='RECEIPT'`).all()
  ]);
  const metadata=await Promise.all((jobs.results||[]).map(async row=>({key:row.id,aliases:bookingRows([row])[0].aliases,
    rank:row.source==='WEBSITE'?30:row.source==='JOTFORM'?20:10,source:row.source,name:[row.first_name,row.last_name].filter(Boolean).join(' ').slice(0,100),
    customerId:await customerIdentity(row.email,row.phone),town:canonicalTown(row.town),items:items(row.items_json),requestedDay:nzDay(row.created_at),
    cancelled:['CANCELLED','DECLINED'].includes(row.status),test:isTestBooking([row.first_name,row.last_name].filter(Boolean).join(' '),row.email),completed:row.status==='COMPLETED'})));
  metadata.push(...await Promise.all((documents.results||[]).map(async row=>({key:'document:'+row.id,aliases:[row.booking_id||'document:'+row.id],
    rank:-2,source:'RECEIPT',customerId:await customerIdentity(row.email,''),test:isTestBooking('',row.email),items:items(row.items_json)}))));
  const raw=backup?.data?.naki_pickup_runs_v1;let store=null;try{store=typeof raw==='string'?JSON.parse(raw):raw;}catch{}
  if(store?.runs){
    const stops=[...store.runs.flatMap(run=>[...(run.data?.stops||[]),...(run.data?.bad||[])]),...(store.shared?.unpaid||[])].filter(s=>s&&s.kind!=='unload');
    const records=rowsFromBackup(backup);
    for(let i=0;i<stops.length;i++){const s=stops[i],r=records[i];if(!r)continue;
      metadata.push({key:r.key,aliases:r.aliases,rank:1,source:'SAVED_RUN',name:String(s.name||[s.first_name,s.last_name].filter(Boolean).join(' ')).slice(0,100),
        customerId:await customerIdentity(s.email,s.phone),town:canonicalTown(s.town),items:items(s.items||s.appliances||[]),
        completed:r.status==='COMPLETED',completedDay:nzDay(r.completedAt)});
    }
  }
  return {rows:mergeStatsRows([...(history.jobs||[]).map(r=>({...r,rank:0})),...metadata],entries),sources:history.sources||{},
    snapshotAt:history.updatedAt||'',note:history.note||'',asOf:new Date().toISOString()};
}
