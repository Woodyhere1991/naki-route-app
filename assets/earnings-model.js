// Shared by the private owner API and the phone. Money is always integer NZ cents.
const dayFormatter = new Intl.DateTimeFormat('en-NZ', {timeZone:'Pacific/Auckland', year:'numeric',month:'2-digit',day:'2-digit'});
export function validDay(value) {
  return typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10)===value;
}
export function nzDay(value) {
  if(arguments.length===0)value=Date.now();
  if (validDay(value)) return value;
  if (value==null || value==='' || Number(value)<100000000000) return '';
  const date=new Date(value); if (!Number.isFinite(date.getTime())) return '';
  const parts=Object.fromEntries(dayFormatter.formatToParts(date).map(p=>[p.type,p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function moneyCents(value) {
  if (value==null || value==='' || typeof value==='boolean') return null;
  const n=Number(value);
  return Number.isFinite(n)&&n>=0&&n<=1000000 ? Math.round(n*100) : null;
}
function aliases(row) {
  const out=[row.id];
  if(row.external_key) out.push(row.external_key);
  if(row.submission_id) out.push(row.submission_id,`pickup:${row.submission_id}`);
  if(row.id?.startsWith('WEB-')||row.id?.startsWith('JOTFORM-')) out.push(`pickup:${row.id}`);
  return [...new Set(out.filter(Boolean))];
}
export function bookingRows(rows) {
  return rows.map(r=>({kind:'booking',aliases:aliases(r),key:r.id,source:r.source,
    status:r.status,at:Number(r.updated_at)||0,completedAt:Number(r.completed_at)||0,
    pickupDay:validDay(r.pickup_date)?r.pickup_date:'',
    cents:r.quoted_at!=null ? Number(r.quote_cents) : r.quote_required ? null : Number(r.total_cents),
    rank:r.source==='WEBSITE'?30:r.source==='JOTFORM'?20:10}));
}
export function documentRows(rows) {
  return rows.map(r=>({kind:r.kind==='RECEIPT'?'receipt':'invoice',key:`document:${r.id}`,
    aliases:[r.booking_id||`document:${r.id}`],at:Number(r.created_at)||0,cents:Number(r.amount_cents),cleared:r.cleared===true}));
}
export function stopRows(store) {
  if(!store || !Array.isArray(store.runs)) return [];
  const pool=store.runs.flatMap(run=>[...(run.data?.stops||[]),...(run.data?.bad||[])]);
  pool.push(...(store.shared?.unpaid||[]));
  return pool.filter(s=>s && s.kind!=='unload').map(s=>{
    const sub=String(s.submission_id||'');
    const keys=[`stop:${s.id}`];
    if(sub) keys.push(sub,`pickup:${sub}`);
    if(s.historyBookingKey)keys.push(s.historyBookingKey);
    if(!sub && !s.historyBookingKey)keys.push(`pickup:${s.unpaidSourceId||s.id}`);
    if(s.unpaidSourceId)keys.push(`stop:${s.unpaidSourceId}`);
    // Do not count a prepared PDF, a future pickup, or a billed-before-pickup copy.
    const completed=s.status==='DONE'&&s.invoiceStage!=='before' || s.historyStatus==='COMPLETED' || Number(s.collectedAt)>100000000000;
    const amount=s.receiptSent&&s.receiptAmount!=null?s.receiptAmount:s.amount??s.invoiceAmount;
    return {kind:'stop',key:keys[0],aliases:[...new Set(keys)],source:'SAVED_RUN',rank:0,
      status:completed?'COMPLETED':s.status==='DONE'?'ADDED_TO_RUN':s.status,
      completedAt:Number(s.collectedAt)||0,at:Number(s.completionChangedAt)||0,pickupDay:validDay(s.confirmedPickupDate)?s.confirmedPickupDate:'',
      cents:moneyCents(amount),receipted:s.receiptSent===true&&completed,
      invoiceAt:Number(s.invoiceAt)||0,owing:s.invoiceSent===true&&s.paid!==true&&s.invoiceCleared!==true};
  });
}
export function rowsFromBackup(record) {
  const raw=record?.data?.naki_pickup_runs_v1;
  if(!raw)return [];
  try{return stopRows(typeof raw==='string'?JSON.parse(raw):raw);}catch{return [];}
}
export function buildEntries(rows) {
  // Only stable job IDs join records. Two visits to the same address stay separate.
  const groups=[], byAlias=new Map();
  for(const row of rows) {
    const keys=(row.aliases||[]).filter(Boolean);if(!keys.length)continue;
    const matches=[...new Set(keys.map(k=>byAlias.get(k)).filter(Boolean))];
    const group=matches[0]||{rows:[],aliases:new Set()};
    if(!matches.length)groups.push(group);
    for(const other of matches.slice(1)) {
      group.rows.push(...other.rows);other.rows=[];
      for(const key of other.aliases){group.aliases.add(key);byAlias.set(key,group);}
    }
    group.rows.push(row);
    for(const key of keys){group.aliases.add(key);byAlias.set(key,group);}
  }
  const entries=[];
  for(const group of groups) {
    if(!group.rows.length)continue;
    const bookings=group.rows.filter(r=>r.kind==='booking').sort((a,b)=>b.rank-a.rank||b.at-a.at);
    const stops=group.rows.filter(r=>r.kind==='stop').sort((a,b)=>b.completedAt-a.completedAt);
    const primary=bookings[0];
    if(primary && ['CANCELLED','DECLINED'].includes(primary.status))continue;
    const receipt=group.rows.filter(r=>r.kind==='receipt').sort((a,b)=>b.at-a.at||a.key.localeCompare(b.key))[0];
    const invoice=group.rows.filter(r=>r.kind==='invoice').sort((a,b)=>b.at-a.at||a.key.localeCompare(b.key))[0];
    const latestStop=stops.slice().sort((a,b)=>b.at-a.at)[0];
    const doneStop=latestStop?.at>0&&latestStop.status!=='COMPLETED'?undefined:stops.find(r=>r.status==='COMPLETED');
    const undone=latestStop&&latestStop.status!=='COMPLETED'&&latestStop.at>0&&latestStop.at>(primary?.at||0);
    const completed=Boolean(receipt)||(!undone&&(primary?.status==='COMPLETED'||Boolean(doneStop)));
    const owing=invoice?.cleared?0:invoice && (!receipt||invoice.at>receipt.at) ? invoice.cents : stops.some(r=>r.owing)?(primary?.cents??doneStop?.cents??0):0;
    if(!completed && !owing)continue;
    const amount=receipt?.cents??primary?.cents??doneStop?.cents??null;
    const priced=Number.isSafeInteger(amount)&&amount>=0;
    const localDate=nzDay(doneStop?.completedAt);
    const historicalDate=bookings.map(r=>nzDay(r.completedAt)).find(Boolean);
    const actualDate=localDate||nzDay(primary?.completedAt)||historicalDate||nzDay(receipt?.at);
    const day=actualDate||primary?.pickupDay||doneStop?.pickupDay||'';
    const receipted=receipt?receipt.cents:doneStop?.receipted?doneStop.cents:null;
    entries.push({key:primary?.key||doneStop?.key||receipt?.key||invoice?.key,
      aliases:[...group.aliases],cents:completed&&priced?amount:0,completed,day,
      assumed:completed&&!receipt&&!doneStop&&primary?.assumed===true,
      priceReviewCents:completed&&!priced?primary?.priceReviewCents??null:null,
      recalculatedPrice:completed&&!receipt&&primary?.recalculatedPrice===true,
      receiptedCents:completed&&Number.isSafeInteger(receipted)?receipted:null,
      owingCents:Number.isSafeInteger(owing)&&owing>0?owing:0,
      missingPrice:completed&&!priced,dateEstimated:completed&&!actualDate&&Boolean(day),
      source:receipt?'RECEIPT':primary?'BOOKING':'SAVED_RUN'});
  }
  return entries.sort((a,b)=>a.day.localeCompare(b.day)||a.key.localeCompare(b.key));
}
export function summarise(entries,today=nzDay()) {
  const date=new Date(`${today}T12:00:00Z`),weekday=(date.getUTCDay()+6)%7;
  date.setUTCDate(date.getUTCDate()-weekday);const week=date.toISOString().slice(0,10);
  const total=(filter)=>entries.filter(e=>e.completed&&filter(e)).reduce((sum,e)=>sum+e.cents,0);
  return {todayCents:total(e=>e.day===today),weekCents:total(e=>e.day>=week&&e.day<=today),
    monthCents:total(e=>e.day.slice(0,7)===today.slice(0,7)&&e.day<=today),allTimeCents:total(()=>true),
    jobs:entries.filter(e=>e.completed).length,
    assumedJobs:entries.filter(e=>e.completed&&e.assumed).length,
    assumedCents:total(e=>e.assumed),confirmedCents:total(e=>!e.assumed),
    receiptedCents:entries.reduce((s,e)=>s+(e.receiptedCents??0),0),
    owingCents:entries.reduce((s,e)=>s+e.owingCents,0),
    missingPrices:entries.filter(e=>e.missingPrice).length,
    pricesToReview:entries.filter(e=>e.priceReviewCents>0).length,
    recalculatedPrices:entries.filter(e=>e.recalculatedPrice).length,
    undatedJobs:entries.filter(e=>e.completed&&!e.day).length,
    estimatedDates:entries.filter(e=>e.dateEstimated).length,
    firstDay:entries.find(e=>e.completed&&e.day)?.day||''};
}
