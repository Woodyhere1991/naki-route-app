(()=>{'use strict';
const host=document.getElementById('programmeGroups'),money=value=>new Intl.NumberFormat('en-NZ',{style:'currency',currency:'NZD'}).format(value/100);
let busy=false,programmes=[],selected=new Set(),rows=[],invoices=[],retryKey='',retrySelection='',session='';
const el=(tag,content,cls)=>{const node=document.createElement(tag);if(content!==undefined)node.textContent=content;if(cls)node.className=cls;return node;};
function message(value,error=false){const node=host.querySelector('[data-group-status]');if(node){node.textContent=value;node.style.color=error?'#ffb49e':'';}}
async function act(label,fn){if(busy)return;busy=true;host.querySelectorAll('button').forEach(b=>b.disabled=true);message(label);try{await fn();}catch(error){if(ownerToken===session)message(error.message,true);}finally{busy=false;host.querySelectorAll('button').forEach(b=>b.disabled=false);}}
function button(label,action,cls='ghost sm'){const node=el('button',label,cls);node.type='button';node.addEventListener('click',action);return node;}
function clear(){selected.clear();rows=[];invoices=[];programmes=[];session='';host.replaceChildren();host.hidden=true;}
function mount(){host.hidden=!ownerToken;if(!ownerToken){clear();return;}if(host.childElementCount)return;const details=el('details');details.append(el('summary','Kāinga Ora spring clean · group bookings','programme-summary'));const body=el('div');body.dataset.groupBody='';body.append(el('p','A separate list, locked $10 item prices and one combined invoice.','small muted'));body.append(button('Open spring clean group',()=>load()));const status=el('p','','small');status.dataset.groupStatus='';status.setAttribute('role','status');body.append(status);details.append(body);host.append(details);}
async function load(){session=ownerToken;await act('Loading group pickups…',async()=>{const result=await ownerApi('/owner/programmes');if(ownerToken!==session)return;programmes=result.programmes;if(!programmes.length){message('No groups yet.');return;}await fetchRows();if(ownerToken!==session)return;paint();});}
async function fetchRows(){const id=programmes[0].id;const [bookings,papers]=await Promise.all([ownerApi('/owner/programmes/'+id+'/bookings'),ownerApi('/owner/programmes/'+id+'/invoices')]);if(ownerToken!==session)return;rows=bookings.bookings;invoices=papers.invoices;selected=new Set([...selected].filter(id=>rows.some(row=>row.id===id&&row.status==='COMPLETED'&&!row.invoiceId)));}
function paint(){if(ownerToken!==session)return clear();const body=host.querySelector('[data-group-body]'),p=programmes[0];body.replaceChildren();body.append(el('h3',p.label));const share=el('input');share.value=p.shareUrl;share.readOnly=true;share.setAttribute('aria-label','Spring clean share link');body.append(share);const actions=el('div',undefined,'row');actions.style.marginTop='8px';actions.append(button('Copy share link',()=>act('Copying link…',async()=>{await navigator.clipboard.writeText(p.shareUrl);message('Share link copied.');})),button('Refresh group',load));body.append(actions);body.append(el('p','Pickup date and event arrangements: to be confirmed. Group billing is planned; confirm the payer before sending any invoice.','small muted'));const active=rows.filter(row=>!['CANCELLED','DECLINED'].includes(row.status));body.append(el('p',active.length+' pickups · '+money(active.reduce((sum,row)=>sum+row.price.totalCents,0))+' booked · '+rows.filter(row=>row.status==='COMPLETED'&&!row.invoiceId).length+' ready to invoice','programme-count'));const status=el('p','','small');status.dataset.groupStatus='';status.setAttribute('role','status');body.append(status);if(!rows.length)body.append(el('p','No group bookings yet. Anyone using the link will appear here automatically.','small muted'));
for(const row of rows){const card=el('div',undefined,'programme-person');const label=el('label');label.style.display='flex';label.style.gap='10px';const check=el('input');check.type='checkbox';check.style.width='22px';check.style.flex='0 0 22px';check.checked=selected.has(row.id);check.disabled=row.status!=='COMPLETED'||!!row.invoiceId;check.setAttribute('aria-label','Include '+row.name+' in the combined invoice');check.addEventListener('change',()=>{check.checked?selected.add(row.id):selected.delete(row.id);retryKey='';});const title=el('div');title.append(el('b',row.name),el('div',row.address,'small muted'));label.append(check,title);card.append(label);card.append(el('p',row.status.replaceAll('_',' ')+' · '+(row.invoiceId?'In saved draft':'Organiser invoice — do not collect cash'),'small programme-status'));for(const line of row.price.lines)card.append(el('div',line.quantity+' × '+line.item+' @ '+money(line.unitCents)+' = '+money(line.totalCents),'small'));card.append(el('b','Household subtotal: '+money(row.price.totalCents)));body.append(card);}
const controls=el('div',undefined,'row');controls.style.marginTop='14px';controls.append(button('Select completed pickups',()=>{for(const row of rows)if(row.status==='COMPLETED'&&!row.invoiceId)selected.add(row.id);paint();}),button('Preview combined invoice',()=>preview()),button('Save combined invoice draft',()=>saveDraft(),'good sm'));body.append(controls);body.append(el('p','Only completed pickups can be selected. Saved drafts reserve those pickups to prevent duplicate invoices. Nothing is emailed until you review the PDF and tap Email.','small muted'));const previewBox=el('div');previewBox.dataset.invoicePreview='';body.append(previewBox);for(const invoice of invoices){const row=el('div',undefined,'programme-person');row.append(el('b',invoice.status+' · '+money(invoice.snapshot.totalCents)),el('p',invoice.id,'small muted'));row.append(button('Review / download PDF',()=>showInvoice(invoice)));if(invoice.status==='DRAFT')row.append(button('Void draft',()=>act('Voiding invoice draft…',async()=>{await ownerApi('/owner/programmes/'+p.id+'/invoices/'+invoice.id+'/void',{method:'POST',body:'{}'});await fetchRows();paint();message('Draft voided. Its pickups are available for a corrected draft.');})));body.append(row);}}
async function preview(){await act('Building preview…',async()=>{const result=await ownerApi('/owner/programmes/'+programmes[0].id+'/preview',{method:'POST',body:JSON.stringify({bookingIds:[...selected]})});if(ownerToken!==session)return;showInvoice({id:'Unsaved preview',status:'PREVIEW',snapshot:result.snapshot});message('Preview ready. Nothing is saved or emailed.');});}
async function saveDraft(){const ids=[...selected].sort(),fingerprint=JSON.stringify(ids);if(!retryKey||fingerprint!==retrySelection){retryKey=crypto.randomUUID();retrySelection=fingerprint;}await act('Saving combined invoice draft…',async()=>{const result=await ownerApi('/owner/programmes/'+programmes[0].id+'/invoices',{method:'POST',body:JSON.stringify({bookingIds:ids,requestKey:retryKey})});if(ownerToken!==session)return;selected.clear();await fetchRows();paint();showInvoice(result.invoice);message('Draft saved. No email has been sent.');});}
async function makePdf(invoice,recipient){
 await ensurePdf();const {jsPDF}=window.jspdf,doc=new jsPDF({unit:'mm',format:'a4'});let y=20;
 const write=(value,size=11,bold=false)=>{doc.setFont('helvetica',bold?'bold':'normal');doc.setFontSize(size);const lines=doc.splitTextToSize(String(value),174);for(const line of lines){if(y>276){doc.addPage();y=20;}doc.text(line,18,y);y+=6;}y+=2;};
 write('NAKI WHITEWARE REMOVAL',18,true);write((recipient?'INVOICE':invoice.status)+' - Combined whiteware collection',14,true);write(invoice.id,9);
 write('Date: '+new Intl.DateTimeFormat('en-NZ',{dateStyle:'long',timeZone:'Pacific/Auckland'}).format(new Date()));
 write('Invoice to: '+(recipient?.name||invoice.snapshot.payerName));
 if(recipient)write('Email: '+recipient.to);else write('DRAFT - billing details to be confirmed. Not sent.',10);
 for(const pickup of invoice.snapshot.pickups){write(pickup.name+' - '+pickup.address,12,true);for(const line of pickup.price.lines)write(line.quantity+' x '+line.item+' @ '+money(line.unitCents)+' = '+money(line.totalCents));write('Household subtotal: '+money(pickup.price.totalCents),11,true);write('Booking: '+pickup.id,8);}
 write('Grand total NZD '+money(invoice.snapshot.totalCents),16,true);
 if(recipient){write('Bank account: '+BANK_ACCOUNT+' ('+BANK_NAME+')',11,true);write('Reference: '+invoice.id,9);}
 write('Group: '+invoice.snapshot.label,10);return doc;
}
function downloadBase64(data){const bytes=Uint8Array.from(atob(data.pdfBase64),c=>c.charCodeAt(0)),url=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'})),link=el('a');link.href=url;link.download=data.filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
function showInvoice(invoice){
 const target=host.querySelector('[data-invoice-preview]');target.replaceChildren();target.append(el('h3',invoice.status+' — combined whiteware invoice'),el('p','Recipient: '+(invoice.recipientName||invoice.snapshot.payerName)+(invoice.recipientEmail?' · '+invoice.recipientEmail:' · billing details to be confirmed'),'small'));
 for(const pickup of invoice.snapshot.pickups){const section=el('div',undefined,'programme-person');section.append(el('b',pickup.name),el('div',pickup.address,'small muted'));for(const line of pickup.price.lines)section.append(el('div',line.quantity+' × '+line.item+' @ '+money(line.unitCents)+' = '+money(line.totalCents),'small'));section.append(el('b','Subtotal '+money(pickup.price.totalCents)));target.append(section);}
 target.append(el('h3','Grand total '+money(invoice.snapshot.totalCents)));
 target.append(button(invoice.status==='SENT'?'Download sent PDF':'Download draft PDF',()=>act('Preparing PDF…',async()=>{if(['SENT','SENDING','SEND_UNKNOWN'].includes(invoice.status)){downloadBase64(await ownerApi('/owner/programmes/'+programmes[0].id+'/invoices/'+invoice.id+'/pdf'));}else{const doc=await makePdf(invoice);doc.save('Naki spring clean - '+invoice.id+'.pdf');}message('PDF downloaded.');})));
 if(invoice.status==='DRAFT'){
  const form=el('form');form.append(el('h3','When the payer is confirmed'));
  const name=el('input');name.value=invoice.snapshot.payerName;name.required=true;name.maxLength=120;name.setAttribute('aria-label','Invoice recipient name');
  const email=el('input');email.value=invoice.snapshot.payerEmail;email.type='email';email.required=true;email.maxLength=160;email.setAttribute('aria-label','Invoice recipient email');
  const check=el('input');check.type='checkbox';check.required=true;check.style.width='22px';check.style.minHeight='22px';
  const label=el('label');label.style.display='flex';label.style.gap='8px';label.append(check,el('span','I have confirmed this payer and checked every pickup and amount.','small'));
  const send=el('button','Review & email combined invoice','good sm');send.type='submit';
  form.append(el('p','Send only after the organiser has agreed to pay. One email goes to the payer; households are not emailed the group invoice.','small muted'),name,email,label,send);
  form.addEventListener('submit',event=>{event.preventDefault();if(busy||!form.reportValidity())return;const recipient={name:name.value.trim(),to:email.value.trim()};
   act('Preparing the reviewed invoice…',async()=>{
    const doc=await makePdf(invoice,recipient),blob=doc.output('blob');
    // Use the established PDF review surface, with a fresh Send action.
    window.nakiDocumentPreview.show(blob);
    const wrap=document.getElementById('receiptPreview'),sendButton=document.getElementById('receiptSendBtn');
    document.getElementById('receiptReviewOption').hidden=true;
    document.getElementById('receiptRedoBtn').onclick=()=>{closeReceiptPreview();};
    sendButton.textContent='Email '+money(invoice.snapshot.totalCents)+' to '+recipient.to;
    sendButton.onclick=()=>{closeReceiptPreview();act('Emailing the combined invoice…',async()=>{
      try{await ownerApi('/owner/programmes/'+programmes[0].id+'/invoices/'+invoice.id+'/send',{method:'POST',body:JSON.stringify({...recipient,reviewed:true,pdfBase64:doc.output('datauristring').split(',')[1]})});}
      finally{await fetchRows();paint();}
      message('Combined invoice accepted by the email provider. Delivery is not yet confirmed.');
    });};
    wrap.style.display='flex';message('Review the PDF. Nothing is sent until you tap its Email button.');
   });
  });target.append(form);
 }
 if(['SENDING','SEND_UNKNOWN'].includes(invoice.status))target.append(el('p','The send result needs checking in Sent mail. Automatic retries are blocked to prevent duplicate invoices.','small'));
 target.scrollIntoView({behavior:'smooth',block:'nearest'});
}
window.nakiProgrammeGroups={mount,clear,load};mount();
})();