export const INVOICE_CLEARANCE_KEY='owner-analytics/invoice-clearance-v1.json';
export async function readInvoiceClearance(env){
  if(!env.DOCUMENTS)return {invoiceIds:[],stopIds:[],cutoff:0};
  const object=await env.DOCUMENTS.get(INVOICE_CLEARANCE_KEY);
  if(!object)return {invoiceIds:[],stopIds:[],cutoff:0};
  const value=await object.json();
  return value.version===1&&Array.isArray(value.invoiceIds)&&Array.isArray(value.stopIds)?value:{invoiceIds:[],stopIds:[],cutoff:0};
}
export function clearedDocuments(rows,clearance){
  const ids=new Set(clearance.invoiceIds);
  return rows.map(row=>({...row,cleared:row.kind==='INVOICE'&&ids.has(row.id)}));
}
export function clearFinancialStops(rows,clearance){
  const ids=new Set(clearance.stopIds),bookings=new Set(clearance.bookingIds||[]);
  return rows.map(row=>row.kind==='stop'&&(ids.has(row.key)||row.aliases?.some(a=>bookings.has(a)))&&!(row.invoiceAt>clearance.cutoff)?{...row,owing:false}:row);
}
