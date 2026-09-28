// Pickup notes belong to a booking, not a disposable run stop. Owner-only API.
export async function ownerBookingNote({request,env,bookingId,json}) {
  const table=bookingId.startsWith('JOTFORM-')?'jotform_bookings':bookingId.startsWith('PICKUP-')?'external_bookings':'bookings';
  const booking=await env.CUSTOMER_DB.prepare(`SELECT id FROM ${table} WHERE id=?1`).bind(bookingId).first();
  if(!booking)return json(request,{error:'Booking not found'},404);
  const read=()=>env.CUSTOMER_DB.prepare('SELECT note,updated_at FROM owner_booking_notes WHERE booking_id=?1').bind(bookingId).first();
  if(request.method==='GET')return json(request,{note:(await read())?.note||''});
  if(request.method!=='PUT')return json(request,{error:'Method not allowed'},405);
  let body;try{body=await request.json();}catch{return json(request,{error:'Invalid note'},400);}
  if(typeof body?.note!=='string'||body.note.length>1500||typeof body.expectedNote!=='string'||body.expectedNote.length>1500)
    return json(request,{error:'Notes must be at most 1500 characters. Refresh the booking before saving.'},400);
  const note=body.note.trim(), expected=body.expectedNote;
  const current=(await read())?.note||'';
  if(current===note)return json(request,{ok:true,note}); // Retry after a lost successful reply.
  if(current!==expected)return json(request,{error:'This pickup note changed on another device. Your note is still kept on this phone; check the booking note before replacing it.'},409);
  const result=await env.CUSTOMER_DB.prepare(`INSERT INTO owner_booking_notes(booking_id,note,updated_at) VALUES(?1,?2,?3)
    ON CONFLICT(booking_id) DO UPDATE SET note=excluded.note,updated_at=excluded.updated_at WHERE owner_booking_notes.note=?4`)
    .bind(bookingId,note,Date.now(),expected).run();
  if(!result.meta?.changes)return json(request,{error:'This pickup note changed. Check the booking and try again.'},409);
  return json(request,{ok:true,note});
}
export async function ownerNotesFor(db,ids){
  const notes=new Map();
  for(let i=0;i<ids.length;i+=50){
    const chunk=ids.slice(i,i+50);
    const rows=await db.prepare(`SELECT booking_id,note FROM owner_booking_notes WHERE booking_id IN (${chunk.map(()=>'?').join(',')})`).bind(...chunk).all();
    for(const row of rows.results||[])notes.set(row.booking_id,row.note);
  }
  return notes;
}
