// Shared links identify an offer, never a price supplied by the browser.
export const SPRING_CLEAN_ITEMS = Object.freeze([
  'Fridge or upright freezer','Fridge/freezer','Large or French-door fridge','Bar fridge',
  'Chest freezer (small or medium)','Large chest freezer (over 1.5 m)',
  'Oven or stove','Front-loading washing machine','Top-loading washing machine','Dryer'
]);
const parse = value => JSON.parse(value || '{}');
const fail = (message, status=400) => { throw Object.assign(new Error(message), {status}); };
const text = (value, max=180) => String(value || '').trim().slice(0,max);
const privateJson = (json, request, body, status=200) => {
  const response=json(request,body,status);
  response.headers.set('Cache-Control','private, no-store');
  return response;
};

export async function programmeByToken(db, token) {
  return db.prepare('SELECT * FROM partner_programmes WHERE token=?1').bind(text(token,100)).first();
}

export function programmeOffer(row) {
  const terms=parse(row.terms_json);
  return {id:row.id,label:row.label,active:!!row.active,version:row.version,
    unitCents:terms.unitCents,items:SPRING_CLEAN_ITEMS,
    pickupDate:terms.pickupDate||'',street:terms.street||'',town:terms.town||'',
    message:'Group collection request. Pickup date and event arrangements will be confirmed. No individual payment is requested; these pickups are grouped for one organiser invoice.'};
}

export function programmePrice(row, items, address) {
  if (!row?.active) fail('This group booking link is not accepting requests.',409);
  const terms=parse(row.terms_json);
  if (terms.unitCents !== 1000) fail('This offer needs an owner pricing review.',409);
  if (!Array.isArray(items)||!items.length||items.length>10||items.some(item=>!SPRING_CLEAN_ITEMS.includes(item)))
    fail('This link is for fridges, freezers, washing machines, dryers and stoves only. Choose up to 10 items.');
  const normal=value=>text(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9 ]/g,'').replace(/\s+/g,' ').trim();
  if(terms.town && normal(address.town)!==normal(terms.town)) fail('This event is for '+terms.town+'. Please contact Woody about this address.');
  if(terms.street && !normal(address.streetAddress).endsWith(' '+normal(terms.street))) fail('This event is for '+terms.street+'. Please contact Woody about this address.');
  const counts=new Map();for(const item of items)counts.set(item,(counts.get(item)||0)+1);
  const lines=[...counts].map(([item,quantity])=>({item,quantity,unitCents:terms.unitCents,totalCents:quantity*terms.unitCents}));
  return {programmeId:row.id,label:row.label,version:row.version,billing:'ORGANISER',
    unitCents:terms.unitCents,lines,totalCents:items.length*terms.unitCents,
    pickupDate:terms.pickupDate||'',terms:structuredClone(terms)};
}

export function programmeBookingStatement(db, bookingId, snapshot, key, requestJson, now) {
  return db.prepare(`INSERT INTO programme_bookings(booking_id,programme_id,request_key,request_json,snapshot_json,created_at)
    VALUES(?1,?2,?3,?4,?5,?6)`).bind(bookingId,snapshot.programmeId,key,requestJson,JSON.stringify(snapshot),now);
}

export async function programmeForBooking(db, bookingId) {
  return db.prepare(`SELECT p.*,c.invoice_id FROM programme_bookings p
    LEFT JOIN programme_invoice_claims c ON c.booking_id=p.booking_id WHERE p.booking_id=?1`).bind(bookingId).first();
}

export async function programmeTags(db, ids) {
  ids=ids.filter(id=>id.startsWith('WEB-GROUP-'));
  if(!ids.length)return new Map();
  const result=await db.prepare(`SELECT booking_id,snapshot_json FROM programme_bookings
    WHERE booking_id IN (${ids.map((_,i)=>'?'+(i+1)).join(',')})`).bind(...ids).all();
  return new Map((result.results||[]).map(row=>[row.booking_id,parse(row.snapshot_json)]));
}

// Guard legacy send paths too, including old run cards with no canonical id.
export async function individualBillingBlocked(env, body) {
  if(!env.CUSTOMER_DB)return false;
  const id=text(body.bookingId),email=text(body.to,160).toLowerCase();
  return !!await env.CUSTOMER_DB.prepare(`SELECT p.booking_id FROM programme_bookings p
    JOIN bookings b ON b.id=p.booking_id WHERE b.status NOT IN ('CANCELLED','DECLINED')
    AND ((?1!='' AND (b.id=?1 OR EXISTS(SELECT 1 FROM external_bookings e WHERE e.external_key=?1 AND e.email=b.email COLLATE NOCASE AND e.street_address=b.street_address COLLATE NOCASE)))
    OR (?1='' AND b.email=?2 COLLATE NOCASE)) LIMIT 1`).bind(id,email).first();
}

export async function publicProgrammeRequest({request,env,path,json,sendMail,syncBookingToSheet,ownerEmail}) {
  if(path==='/customer/programme-bookings' && request.method==='POST'){
    const reply=(body,status=200)=>privateJson(json,request,body,status);
    try{
      const raw=await request.text();if(raw.length>12000)return reply({error:'That request is too large.'},413);
      let body;try{body=JSON.parse(raw);}catch{return reply({error:'Please check the form and try again.'},400);}
      const token=text(body.programmeToken,100),key=text(body.requestKey,100);
      if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key))fail('Please reload the form before booking.');
      if(env.BOT_RATE_LIMIT){const limit=await env.BOT_RATE_LIMIT.limit({key:'group-booking:'+request.headers.get('CF-Connecting-IP')});if(!limit.success)return reply({error:'Too many requests. Please wait a minute and retry.'},429);}
      const name=text(body.name,120),phone=text(body.phone,30),email=text(body.email,160).toLowerCase();
      const street=text(body.streetAddress,180),town=text(body.town,100),notes=text(body.notes,1500);
      if(!name||!/[0-9]/.test(street)||!town||phone.replace(/\D/g,'').length<8)fail('Enter your name, phone number, street number and address, and town.');
      if(email&&!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))fail('Check your email address, or leave it blank.');
      const items=body.items;
      const requestJson=JSON.stringify({token,name,phone,email,street,town,notes,items});
      const db=env.CUSTOMER_DB;
      const previous=await db.prepare('SELECT booking_id,request_json,snapshot_json FROM programme_bookings WHERE request_key=?1').bind(key).first();
      if(previous){
        if(previous.request_json!==requestJson)fail('The form changed after an earlier request. Reload to start a new request.',409);
        return reply({ok:true,bookingId:previous.booking_id,totalCents:parse(previous.snapshot_json).totalCents,reused:true});
      }
      const programme=await programmeByToken(db,token);
      const price=programmePrice(programme,items,{streetAddress:street,town});
      const createdAt=Date.now(),id='WEB-GROUP-'+createdAt+'-'+crypto.randomUUID();
      const split=name.indexOf(' '),firstName=split<0?name:name.slice(0,split),lastName=split<0?'':name.slice(split+1);
      const account=email?await db.prepare('SELECT id FROM customers WHERE email=?1 COLLATE NOCASE').bind(email).first():null;
      const statements=[db.prepare(`INSERT INTO bookings(id,customer_id,status,first_name,last_name,phone,email,
        street_address,town,area,rural_option,items_json,additional_info,referral_source,referral_details,
        total_cents,quote_required,created_at,updated_at,requested_date)
        VALUES(?1,?2,'NEW',?3,?4,?5,?6,?7,?8,'','Main town or main road - no travel fee',?9,?10,'Other',?11,?12,0,?13,?13,?14)`)
        .bind(id,account?.id||null,firstName,lastName,phone,email,street,town,JSON.stringify(items),notes,
          programme.label+' — organiser invoice; no individual payment',price.totalCents,createdAt,price.pickupDate),
        programmeBookingStatement(db,id,price,key,requestJson,createdAt),
        db.prepare("INSERT INTO booking_events(id,booking_id,event_type,detail,created_at) VALUES(?1,?2,'CREATED',?3,?4)")
          .bind(crypto.randomUUID(),id,'Programme '+programme.id+' / price version '+programme.version,createdAt)];
      try{await db.batch(statements);}catch(error){
        const saved=await db.prepare('SELECT booking_id,request_json,snapshot_json FROM programme_bookings WHERE request_key=?1').bind(key).first();
        if(saved?.request_json===requestJson)return reply({ok:true,bookingId:saved.booking_id,totalCents:parse(saved.snapshot_json).totalCents,reused:true});
        throw error;
      }
      const booking=await db.prepare('SELECT * FROM bookings WHERE id=?1').bind(id).first();
      let sheetBackedUp=true;try{await syncBookingToSheet(env,booking);}catch{sheetBackedUp=false;}
      const details=[programme.label,'Booking: '+id,'Name: '+name,'Phone: '+phone,'Address: '+street+', '+town,
        ...price.lines.map(line=>line.quantity+' × '+line.item+' @ $10 = $'+(line.totalCents/100).toFixed(2)),
        'Group total for this household: $'+(price.totalCents/100).toFixed(2),
        'Pickup date and event arrangements will be confirmed. No individual payment is requested.',
        "Please leave only the booked appliances inside your property boundary, accessible and empty. We cannot take furniture, packaging or boxes.",notes].filter(Boolean).join('\n');
      let customerEmailed=false,ownerEmailed=false;
      if(email)customerEmailed=await sendMail(env,{to:email,name,subject:programme.label+' — request received',text:'Thank you! Your group collection request has been saved.\n\n'+details}).catch(()=>false);
      ownerEmailed=await sendMail(env,{to:ownerEmail,name:'Woody',subject:'GROUP BOOKING — '+programme.label+' — '+name,text:details}).catch(()=>false);
      await db.prepare("INSERT INTO booking_events(id,booking_id,event_type,detail,created_at) VALUES(?1,?2,?3,?4,?5)")
        .bind(crypto.randomUUID(),id,ownerEmailed&&(!email||customerEmailed)?'EMAIL_SENT':'EMAIL_FAILED',
          'Group booking confirmation: owner '+ownerEmailed+', customer '+customerEmailed,Date.now()).run().catch(()=>{});
      return reply({ok:true,bookingId:id,totalCents:price.totalCents,customerEmailed,sheetBackedUp},201);
    }catch(error){return reply({error:error.status?error.message:'Your request could not be confirmed. Retry using the same form; it will not create a second booking.'},error.status||500);}
  }
  const match=path.match(/^\/customer\/programmes\/([a-z0-9-]+)$/);
  if(!match||request.method!=='GET')return null;
  const row=await programmeByToken(env.CUSTOMER_DB,match[1]);
  if(!row)return privateJson(json,request,{error:'That group booking link was not found.'},404);
  // Deliberately no participants, billing email, invoice or owner notes.
  return privateJson(json,request,{offer:programmeOffer(row)});
}

async function groupBookings(db,id) {
  const result=await db.prepare(`SELECT b.id,b.status,b.first_name,b.last_name,b.street_address,b.town,b.items_json,
    b.updated_at,b.pickup_date,p.snapshot_json,c.invoice_id FROM programme_bookings p
    JOIN bookings b ON b.id=p.booking_id LEFT JOIN programme_invoice_claims c ON c.booking_id=b.id
    WHERE p.programme_id=?1 ORDER BY b.created_at,b.id`).bind(id).all();
  return (result.results||[]).map(row=>({id:row.id,status:row.status,name:[row.first_name,row.last_name].filter(Boolean).join(' '),
    address:[row.street_address,row.town].filter(Boolean).join(', '),household:row.street_address.trim().toLowerCase(),
    pickupDate:row.pickup_date,updatedAt:row.updated_at,invoiceId:row.invoice_id||'',price:parse(row.snapshot_json)}));
}

export function invoiceSnapshot(programme, bookings, selectedIds) {
  if(!Array.isArray(selectedIds)||!selectedIds.length||selectedIds.length>200||new Set(selectedIds).size!==selectedIds.length)
    fail('Select 1–200 different completed pickups.');
  const selected=selectedIds.map(id=>bookings.find(row=>row.id===id));
  if(selected.some(row=>!row))fail('A selected pickup does not belong to this group.');
  if(selected.some(row=>row.status!=='COMPLETED'))fail('Only completed pickups can go on the combined invoice.',409);
  if(selected.some(row=>row.invoiceId))fail('A selected pickup already belongs to an invoice draft. Open that draft or void it first.',409);
  for(const row of selected){
    if(row.price.programmeId!==programme.id||row.price.billing!=='ORGANISER'||!Array.isArray(row.price.lines)||!row.price.lines.length)
      fail('A pickup has an invalid stored price. Refresh and review it.',409);
    const total=row.price.lines.reduce((sum,line)=>{
      if(!SPRING_CLEAN_ITEMS.includes(line.item)||!Number.isInteger(line.quantity)||line.quantity<1||line.unitCents!==1000||line.totalCents!==line.quantity*line.unitCents)
        fail('A pickup has an invalid stored price. Refresh and review it.',409);
      return sum+line.totalCents;
    },0);
    if(total!==row.price.totalCents)fail('Stored pickup totals do not match.',409);
  }
  selected.sort((a,b)=>a.id.localeCompare(b.id));
  const terms=parse(programme.terms_json);
  return {programmeId:programme.id,label:programme.label,currency:'NZD',payerName:terms.payerName||'',
    payerEmail:terms.payerEmail||'',payerConfirmed:terms.payerConfirmed===true,
    pickupDate:terms.pickupDate||'',households:new Set(selected.map(row=>row.household)).size,
    pickups:selected.map(({household,invoiceId,...row})=>row),
    totalCents:selected.reduce((sum,row)=>sum+row.price.totalCents,0)};
}

export async function ownerProgrammeRequest({request,env,path,json,sendMail}) {
  if(!path.startsWith('/owner/programmes'))return null;
  const db=env.CUSTOMER_DB;
  const reply=(body,status=200)=>privateJson(json,request,body,status);
  try{
    if(path==='/owner/programmes'&&request.method==='GET'){
      const result=await db.prepare('SELECT * FROM partner_programmes ORDER BY label').all();
      return reply({programmes:(result.results||[]).map(row=>({...programmeOffer(row),terms:parse(row.terms_json),
        shareUrl:'https://nakiwhitewareremoval.vip/spring-clean.html?group='+row.token}))});
    }
    const match=path.match(/^\/owner\/programmes\/([^/]+)(?:\/(bookings|invoices|preview))?$/);
    const invoiceMatch=path.match(/^\/owner\/programmes\/([^/]+)\/invoices\/([^/]+)(?:\/(void|send|pdf))?$/);
    const id=decodeURIComponent(match?.[1]||invoiceMatch?.[1]||'');
    const programme=await db.prepare('SELECT * FROM partner_programmes WHERE id=?1').bind(id).first();
    if(!programme)return reply({error:'Group not found.'},404);
    if(match?.[2]==='bookings'&&request.method==='GET')return reply({bookings:await groupBookings(db,id)});
    if(match?.[2]==='invoices'&&request.method==='GET'){
      const result=await db.prepare('SELECT id,status,created_at,snapshot_json,recipient_email,recipient_name FROM programme_invoices WHERE programme_id=?1 ORDER BY created_at DESC').bind(id).all();
      return reply({invoices:(result.results||[]).map(row=>({id:row.id,status:row.status,createdAt:row.created_at,recipientEmail:row.recipient_email,recipientName:row.recipient_name,snapshot:parse(row.snapshot_json)}))});
    }
    if(invoiceMatch && invoiceMatch[3]==='pdf' && request.method==='GET'){
      const invoice=await db.prepare('SELECT pdf_r2_key FROM programme_invoices WHERE id=?1 AND programme_id=?2').bind(invoiceMatch[2],id).first();
      const file=invoice?.pdf_r2_key&&env.DOCUMENTS?await env.DOCUMENTS.get(invoice.pdf_r2_key):null;
      if(!file)return reply({error:'No sent PDF is stored for this invoice.'},404);
      const bytes=new Uint8Array(await file.arrayBuffer());let bin='';for(let i=0;i<bytes.length;i+=0x8000)bin+=String.fromCharCode(...bytes.subarray(i,i+0x8000));
      return reply({pdfBase64:btoa(bin),filename:invoiceMatch[2]+'.pdf'});
    }
    if(invoiceMatch && invoiceMatch[3]==='send' && request.method==='POST'){
      const invoice=await db.prepare('SELECT * FROM programme_invoices WHERE id=?1 AND programme_id=?2').bind(invoiceMatch[2],id).first();
      if(!invoice)return reply({error:'Invoice draft not found.'},404);
      if(invoice.status==='SENT')return reply({ok:true,alreadySent:true,to:invoice.recipient_email});
      if(invoice.status!=='DRAFT')return reply({error:'This invoice is void, sending, or its send outcome is uncertain. Check Sent mail; it will not be sent again automatically.'},409);
      const raw=await request.text();if(raw.length>2800000)return reply({error:'The invoice PDF is too large.'},413);
      let body;try{body=JSON.parse(raw);}catch{return reply({error:'Invalid send request.'},400);}
      const to=text(body.to,160).toLowerCase(),name=text(body.name,120),pdf=String(body.pdfBase64||'');
      if(body.reviewed!==true||!name||!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to))fail('Review the payer name and email, and confirm the selected pickups before sending.');
      if(!/^[A-Za-z0-9+/=]+$/.test(pdf)||pdf.length<100||pdf.length>2000000||!atob(pdf.slice(0,8)).startsWith('%PDF-'))fail('The invoice PDF could not be verified. Preview it again.');
      if(!env.DOCUMENTS)fail('Invoice storage is not ready.',503);
      const snapshot=parse(invoice.snapshot_json);
      const count=await db.prepare("SELECT COUNT(*) AS n FROM programme_invoice_claims c JOIN bookings b ON b.id=c.booking_id WHERE c.invoice_id=?1 AND b.status='COMPLETED'").bind(invoice.id).first();
      if(Number(count?.n)!==snapshot.pickups.length)fail('The selected pickups changed. Void this draft and review the group again.',409);
      const claim=await db.prepare("UPDATE programme_invoices SET status='SENDING',recipient_email=?1,recipient_name=?2 WHERE id=?3 AND status='DRAFT' RETURNING id").bind(to,name,invoice.id).first();
      if(!claim)fail('This invoice is already being processed. Refresh before sending.',409);
      const r2Key='programme:'+invoice.id+'.pdf';
      try{const bytes=Uint8Array.from(atob(pdf),c=>c.charCodeAt(0));await env.DOCUMENTS.put(r2Key,bytes,{httpMetadata:{contentType:'application/pdf'}});}
      catch{await db.prepare("UPDATE programme_invoices SET status='DRAFT' WHERE id=?1 AND status='SENDING'").bind(invoice.id).run();fail('The PDF was not stored, so no email was sent. Please retry.',503);}
      await db.prepare('UPDATE programme_invoices SET pdf_r2_key=?1 WHERE id=?2').bind(r2Key,invoice.id).run();
      let sent=false;try{sent=await sendMail(env,{kind:'group-invoice',to,name,subject:'Combined invoice — '+programme.label,
        text:'Hi '+name+',\n\nYour combined whiteware collection invoice is attached.\nInvoice: '+invoice.id+'\nTotal: NZD '+(snapshot.totalCents/100).toFixed(2)+'\n\nPlease use the bank details and reference on the attached invoice.\n\nThanks,\nWoody\nNaki Whiteware Removal',
        attachment:[{name:invoice.id+'.pdf',content:pdf}]});}catch{/* An uncertain send is locked for review, never replayed. */}
      await db.prepare('UPDATE programme_invoices SET status=?1,emailed_at=?2 WHERE id=?3 AND status=\'SENDING\'').bind(sent?'SENT':'SEND_UNKNOWN',sent?Date.now():null,invoice.id).run();
      return sent?reply({ok:true,to}):reply({error:'The send outcome is uncertain. Check Sent mail before taking further action. This invoice is locked against duplicate sending.'},409);
    }
    if(invoiceMatch&&request.method==='POST'&&invoiceMatch[3]==='void'){
      const draft=await db.prepare('SELECT status FROM programme_invoices WHERE id=?1 AND programme_id=?2').bind(invoiceMatch[2],id).first();
      if(!draft)return reply({error:'Invoice not found.'},404);
      if(draft.status==='VOID')return reply({ok:true});
      if(draft.status!=='DRAFT')return reply({error:'Only an unsent draft can be voided. Check the sent invoice before making any correction.'},409);
      await db.batch([
        db.prepare("DELETE FROM programme_invoice_claims WHERE invoice_id=?1 AND EXISTS(SELECT 1 FROM programme_invoices WHERE id=?1 AND programme_id=?2 AND status='DRAFT')").bind(invoiceMatch[2],id),
        db.prepare("UPDATE programme_invoices SET status='VOID' WHERE id=?1 AND programme_id=?2 AND status='DRAFT'").bind(invoiceMatch[2],id)
      ]);
      return reply({ok:true});
    }
    if(match&&['preview','invoices'].includes(match[2])&&request.method==='POST'){
      const body=await request.json();
      const key=text(body.requestKey,100);
      const ids=Array.isArray(body.bookingIds)?[...body.bookingIds].sort():[];
      const requestJson=JSON.stringify({programmeId:id,ids});
      if(match[2]==='invoices'){
        if(!/^[a-zA-Z0-9-]{16,100}$/.test(key))fail('A retry key is required.');
        const existing=await db.prepare('SELECT * FROM programme_invoices WHERE request_key=?1').bind(key).first();
        if(existing){
          if(existing.request_json!==requestJson)fail('This retry key belongs to another selection.',409);
          return reply({invoice:{id:existing.id,status:existing.status,snapshot:parse(existing.snapshot_json)}});
        }
      }
      const snapshot=invoiceSnapshot(programme,await groupBookings(db,id),ids);
      if(match[2]==='preview')return reply({snapshot});
      const invoiceId='GROUP-'+crypto.randomUUID();
      // D1 batch is atomic. Competing drafts cannot both claim the same pickup.
      // Claims also compare booking versions, closing the read/issue race.
      const statements=[db.prepare(`INSERT INTO programme_invoices(id,programme_id,request_key,request_json,snapshot_json,created_at) VALUES(?1,?2,?3,?4,?5,?6)`)
        .bind(invoiceId,id,key,requestJson,JSON.stringify(snapshot),Date.now())];
      for(const row of snapshot.pickups)statements.push(db.prepare(`INSERT INTO programme_invoice_claims(booking_id,invoice_id)
        VALUES((SELECT b.id FROM bookings b WHERE b.id=?1 AND b.status='COMPLETED' AND b.updated_at=?2),?3)`)
        .bind(row.id,row.updatedAt,invoiceId));
      try{await db.batch(statements);}catch(error){
        const saved=await db.prepare('SELECT * FROM programme_invoices WHERE request_key=?1').bind(key).first();
        if(saved?.request_json===requestJson)return reply({invoice:{id:saved.id,status:saved.status,snapshot:parse(saved.snapshot_json)}});
        fail('A pickup changed or is already in another invoice. Refresh the group and try again.',409);
      }
      return reply({invoice:{id:invoiceId,status:'DRAFT',snapshot}},201);
    }
    return reply({error:'Group action not found.'},404);
  }catch(error){return reply({error:error.status?error.message:'The group could not be loaded. Please retry.'},error.status||500);}
}
