// "Mark as paid" for an invoice. Paid is money only - it never finishes the job:
// the booking keeps its status (New / Scheduled) until the receipt goes out after
// pickup, and the receipt is what marks it COMPLETED. Kept as one small JSON
// ledger in R2 beside the invoice clearance file, so no database migration, and
// keyed by the invoice document id so a later invoice is owing again.
export const INVOICE_PAYMENTS_KEY='owner-analytics/invoice-payments-v1.json';

export async function readInvoicePayments(env){
  if(!env.DOCUMENTS)return {payments:[],etag:''};
  const object=await env.DOCUMENTS.get(INVOICE_PAYMENTS_KEY);
  if(!object)return {payments:[],etag:''};
  const value=await object.json().catch(()=>null);
  return {payments:value?.version===1&&Array.isArray(value.payments)?value.payments:[],etag:object.etag||''};
}
// Read-modify-write guarded by the R2 etag, so two phones saving at once never
// silently drop one of the payments.
async function changePayments(env,change){
  for(let attempt=0;attempt<4;attempt++){
    const {payments,etag}=await readInvoicePayments(env);
    const next=change(payments.slice());
    const options={httpMetadata:{contentType:'application/json'}};
    if(etag)options.onlyIf={etagMatches:etag};
    if(await env.DOCUMENTS.put(INVOICE_PAYMENTS_KEY,JSON.stringify({version:1,payments:next}),options))return next;
  }
  throw Object.assign(new Error('Payments were being changed on another phone. Try again.'),{status:409});
}
// A paid invoice is no longer owing anywhere: Bookings, the customer's page and
// Earnings all read `cleared`. `paidAt` lets the card say when.
export function paidDocuments(rows,payments){
  const byInvoice=new Map(payments.map(p=>[p.invoiceId,p]));
  return rows.map(row=>{
    const paid=row.kind==='INVOICE'&&byInvoice.get(row.id);
    return paid?{...row,cleared:true,paid_at:paid.paidAt,paid_cents:paid.cents,paid_method:paid.method}:row;
  });
}

export async function handleInvoicePayment({request,env,json,now=Date.now()}){
  if(!env.DOCUMENTS)return json(request,{error:'Payment storage is not set up.'},503);
  const body=await request.json().catch(()=>null);
  const invoiceId=String(body?.invoiceId||'').slice(0,120);
  const invoice=invoiceId&&await env.CUSTOMER_DB.prepare("SELECT id,booking_id,amount_cents FROM booking_documents WHERE id=?1 AND kind='INVOICE'").bind(invoiceId).first();
  if(!invoice)return json(request,{error:'That invoice was not found.'},404);
  const cents=body?.amount==null?Number(invoice.amount_cents):Math.round(Number(body.amount)*100);
  if(!Number.isSafeInteger(cents)||cents<=0||cents>10000000)return json(request,{error:'Enter the amount they paid.'},400);
  const bankDate=/^\d{4}-\d{2}-\d{2}T/.test(String(body?.bankDate||''))?String(body.bankDate).slice(0,30):'';
  let saved={invoiceId,bookingId:invoice.booking_id||'',cents,method:body?.method==='bank'?'bank':'manual',bankDate,bankPending:body?.pending===true,paidAt:now};
  try{
    await changePayments(env,list=>{
      // A second tap, or a retry after a dropped signal, keeps the first record.
      const earlier=list.find(p=>p.invoiceId===invoiceId);
      if(earlier){saved=earlier;return list;}
      return [...list,saved];
    });
  }catch(error){return json(request,{error:error.message},error.status||500);}
  return json(request,{ok:true,payment:saved});
}
