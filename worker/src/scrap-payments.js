// Scrap yard payments (GMS docket money). Kept as one small JSON ledger in R2
// beside the invoice clearance file, so no database migration is needed, plus
// the docket photo under scrap-receipts/. Money is always integer NZ cents.
import {validDay,nzDay} from '../../assets/earnings-model.js';

export const SCRAP_LEDGER_KEY='owner-analytics/scrap-payments-v1.json';
const READ_MODEL='gpt-5.6-luna';
const MAX_IMAGE_BYTES=3*1024*1024;

export async function readScrapLedger(env){
  if(!env.DOCUMENTS)return {payments:[],etag:''};
  const object=await env.DOCUMENTS.get(SCRAP_LEDGER_KEY);
  if(!object)return {payments:[],etag:''};
  const value=await object.json().catch(()=>null);
  return {payments:value?.version===1&&Array.isArray(value.payments)?value.payments:[],etag:object.etag||''};
}

// Read-modify-write guarded by the R2 etag, so two phones saving at once never
// silently drop one of the payments.
async function changeLedger(env,change){
  for(let attempt=0;attempt<4;attempt++){
    const {payments,etag}=await readScrapLedger(env);
    const next=change(payments.slice());
    const body=JSON.stringify({version:1,payments:next});
    const options={httpMetadata:{contentType:'application/json'}};
    if(etag)options.onlyIf={etagMatches:etag};
    const written=await env.DOCUMENTS.put(SCRAP_LEDGER_KEY,body,options);
    if(written)return next;
  }
  throw Object.assign(new Error('Scrap payments were being changed on another phone. Try again.'),{status:409});
}

export function cleanScrapPayment(input,now=Date.now()){
  const cents=Math.round(Number(input?.amount)*100);
  if(!Number.isSafeInteger(cents)||cents<=0||cents>5000000)return {error:'Enter the amount the scrap yard paid you.'};
  const day=validDay(input?.day)?input.day:nzDay(now);
  if(day>nzDay(now))return {error:'That date is in the future.'};
  const weight=input?.weightKg===''||input?.weightKg==null?null:Number(input.weightKg);
  return {payment:{cents,day,
    yard:String(input?.yard||'').trim().slice(0,80),
    weightKg:Number.isFinite(weight)&&weight>0&&weight<100000?Math.round(weight*10)/10:null,
    note:String(input?.note||'').trim().slice(0,200)}};
}

function imageBytes(base64){
  const clean=String(base64||'').replace(/^data:[^,]*,/,'');
  if(!clean||clean.length>MAX_IMAGE_BYTES*4/3+4)return null;
  try{const bin=atob(clean);const out=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)out[i]=bin.charCodeAt(i);return out;}catch{return null;}
}

const READ_SCHEMA={type:'object',additionalProperties:false,required:['amount','date','yard','weightKg','readable'],properties:{
  readable:{type:'boolean'},
  amount:{type:['number','null'],description:'Total NZ dollars paid to the seller, after any deductions.'},
  date:{type:['string','null'],description:'Docket date as YYYY-MM-DD.'},
  yard:{type:['string','null'],description:'Name of the scrap yard or buyer.'},
  weightKg:{type:['number','null'],description:'Total net weight in kilograms, if shown.'}}};

export async function readScrapDocket(env,base64){
  if(!env.OPENAI_API_KEY)return {error:'Photo reading is not switched on. Type the amount in instead.'};
  const bytes=imageBytes(base64);
  if(!bytes)return {error:'That photo could not be read. Try a smaller photo, or type the amount in.'};
  let response;
  try{
    response=await fetch('https://api.openai.com/v1/responses',{method:'POST',
      headers:{Authorization:`Bearer ${env.OPENAI_API_KEY}`,'Content-Type':'application/json'},
      body:JSON.stringify({model:READ_MODEL,
        input:[{role:'user',content:[
          {type:'input_text',text:'This is a photo of a scrap metal yard docket or payment receipt in New Zealand. Read the total amount paid to the seller in NZ dollars, the docket date, the yard name and the total net weight in kg. Use null for anything you cannot read clearly. Set readable to false if this is not a scrap payment receipt.'},
          {type:'input_image',image_url:`data:image/jpeg;base64,${String(base64).replace(/^data:[^,]*,/,'')}`}]}],
        text:{format:{type:'json_schema',name:'scrap_docket',strict:true,schema:READ_SCHEMA}}})});
  }catch{return {error:'Could not reach the photo reader. Type the amount in instead.'};}
  const data=await response.json().catch(()=>null);
  if(!response.ok||!data)return {error:'The photo reader did not answer. Type the amount in instead.'};
  const text=data.output_text||(data.output||[]).flatMap(o=>o.content||[]).map(c=>c.text||'').join('');
  let read;try{read=JSON.parse(text);}catch{return {error:'The photo reader did not answer. Type the amount in instead.'};}
  if(!read.readable)return {error:'That does not look like a scrap receipt. Type the amount in instead.'};
  return {read:{amount:Number.isFinite(read.amount)&&read.amount>0?Math.round(read.amount*100)/100:null,
    day:validDay(read.date)?read.date:null,yard:read.yard||'',weightKg:Number.isFinite(read.weightKg)?read.weightKg:null}};
}

export async function handleScrap({request,env,path,json}){
  if(!path.startsWith('/owner/scrap'))return null;
  if(!env.DOCUMENTS)return json(request,{error:'Scrap storage is not set up.'},503);
  if(path==='/owner/scrap/read'&&request.method==='POST'){
    const body=await request.json().catch(()=>null);
    const result=await readScrapDocket(env,body?.image);
    return json(request,result,result.error?422:200);
  }
  if(path==='/owner/scrap'&&request.method==='GET'){
    const {payments}=await readScrapLedger(env);
    return json(request,{payments});
  }
  if(path==='/owner/scrap'&&request.method==='POST'){
    const body=await request.json().catch(()=>null);
    const {payment,error}=cleanScrapPayment(body);
    if(error)return json(request,{error},400);
    // A retry after a dropped connection carries the same key, so it can never add the money twice.
    const requestKey=String(request.headers.get('Idempotency-Key')||'').slice(0,80);
    if(requestKey){
      const earlier=(await readScrapLedger(env)).payments.find(p=>p.requestKey===requestKey);
      if(earlier)return json(request,{payment:earlier});
    }
    const id=`SCRAP-${Date.now()}-${crypto.randomUUID().slice(0,8)}`;
    const bytes=body?.image?imageBytes(body.image):null;
    if(bytes)await env.DOCUMENTS.put(`scrap-receipts/${id}.jpg`,bytes,{httpMetadata:{contentType:'image/jpeg'}});
    let saved={id,...payment,photo:Boolean(bytes),createdAt:Date.now(),...(requestKey?{requestKey}:{})};
    try{await changeLedger(env,list=>{
      const earlier=requestKey&&list.find(p=>p.requestKey===requestKey);
      if(earlier){saved=earlier;return list;}
      return [...list,saved];
    });}
    catch(e){return json(request,{error:e.message},e.status||500);}
    return json(request,{payment:saved});
  }
  const photo=path.match(/^\/owner\/scrap\/(SCRAP-[\w-]+)\/photo$/);
  if(photo&&request.method==='GET'){
    const object=await env.DOCUMENTS.get(`scrap-receipts/${photo[1]}.jpg`);
    if(!object)return json(request,{error:'No photo saved for that payment.'},404);
    const response=json(request,{});
    const headers=new Headers(response.headers);headers.set('Content-Type','image/jpeg');headers.set('Cache-Control','private, no-store');
    return new Response(object.body,{headers});
  }
  const one=path.match(/^\/owner\/scrap\/(SCRAP-[\w-]+)$/);
  if(one&&request.method==='DELETE'){
    // The photo stays in storage; only the payment comes off the totals.
    let found=false;
    try{await changeLedger(env,list=>list.filter(p=>{if(p.id===one[1]){found=true;return false;}return true;}));}
    catch(e){return json(request,{error:e.message},e.status||500);}
    return found?json(request,{ok:true}):json(request,{error:'That scrap payment was not found.'},404);
  }
  return json(request,{error:'Not found'},404);
}
