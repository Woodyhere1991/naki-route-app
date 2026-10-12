// Booking-wide updates use a complete directory and shared drafts across runs.
let bookingMessageRows = [], bookingMessageSession = "", bookingMessageLoading = false;
let bookingMessageError = "", bookingMessageRequest = null;
function bookingMessageState(){
  runStore.shared = runStore.shared || {};
  return runStore.shared.bookingMessages = runStore.shared.bookingMessages || {};
}
function messageScope(){ return bookingMessageState().enabled ? "bookings" : "run"; }
function messageSelectionState(){ return messageScope()==="bookings" ? bookingMessageState() : state; }
function messageSelectionBucket(){
  return messageScope()==="bookings" ? `update:${localIso(new Date())}:${Boolean(bookingMessageState().includePast)}` : messageBucket();
}
function injuryUpdateMessage(){
  return "Hey Woody here from Naki Whiteware Removal. I've injured myself, so whiteware collections are delayed while I recover. I'll be in touch to arrange a pickup once I'm able to resume. Sorry for the inconvenience, and thanks for your patience.";
}
function messageCandidates(){
  if(messageScope()!=="bookings") return pickupsOnly(state.stops).filter(s=>s.status!=="DONE");
  if(!ownerToken || bookingMessageSession!==ownerToken) return [];
  const includePast=Boolean(bookingMessageState().includePast);
  const closed=status=>["DONE","COMPLETED","CANCELLED","DECLINED"].includes(status);
  const rows=bookingMessageRows.filter(b=>includePast || !closed(b.status)).map(b=>({
    id:`booking:${b.id}`, submission_id:b.id, src:"direct", first_name:b.firstName||"", last_name:b.lastName||"",
    phone:b.phone||"", email:b.email||"", street:b.streetAddress||"", town:b.town||"",
    messageStatus:bookingStatusWord(b)
  }));
  const seen=new Set();
  // Sheet pickups without a cloud booking still need to receive the update.
  for(const run of runStore.runs){
    const data=run.id===runStore.activeRunId ? state : run.data;
    for(const s of pickupsOnly((data.stops||[]).concat(data.bad||[]))){
      if(bookingMessageRows.some(b=>stopBelongsToBooking(s,b))) continue;
      if(!includePast && (closed(s.status)||closed(s.historyStatus)||s.collectedAt)) continue;
      const key=messageMarkKey(s); if(seen.has(key)) continue; seen.add(key);
      rows.push({...originalStopLocation(s),id:`run:${run.id}:${s.id}`,messageStatus:closed(s.status)?"Done":`On ${run.name}`});
    }
  }
  return rows.sort((a,b)=>fullName(a).localeCompare(fullName(b)));
}
async function loadBookingMessageRecipients(){
  if(bulkSendBusy) return;
  const session=ownerToken;
  if(!session){bookingMessageError="Sign in on the Bookings tab to load all bookings.";renderContacts();return;}
  if(bookingMessageRequest?.session===session) return bookingMessageRequest.promise;
  const pending={session};
  bookingMessageLoading=true;bookingMessageError="";renderContacts();
  pending.promise=(async()=>{
    const rows=new Map();let offset=0;
    try{
      for(;;){
        const data=await ownerApi(`/owner/bookings?offset=${offset}`);
        if(ownerToken!==session) throw Error("Sign-in changed. Reload bookings.");
        if(!Array.isArray(data.bookings)) throw Error("Could not verify the booking list. Please retry.");
        for(const row of data.bookings) rows.set(row.id,row);
        if(!data.hasMore) break;
        const next=Number(data.nextOffset);
        if(!Number.isInteger(next)||next<=offset||next>100000) throw Error("Could not load all bookings. Please retry.");
        offset=next;
      }
      bookingMessageRows=[...rows.values()];bookingMessageSession=session;
    }catch(error){bookingMessageError=error.message;}
    finally{if(bookingMessageRequest===pending){bookingMessageLoading=false;bookingMessageRequest=null;renderContacts();}}
  })();
  bookingMessageRequest=pending;
  return pending.promise;
}
window.setMessageScope = scope => {
  if(bulkSendBusy)return;
  bookingMessageState().enabled=scope==="bookings";save();renderContacts();
  if(scope==="bookings")void loadBookingMessageRecipients();
};
window.setMessageIncludePast = checked => {
  if(bulkSendBusy)return;
  bookingMessageState().includePast=checked;save();renderContacts();
};
function messageScopeControls(){
  const all=messageScope()==="bookings";
  return `<label>Who to message</label><div class="row" style="margin:6px 0">
    <button class="${all?'ghost':'good'} sm grow" onclick="setMessageScope('run')" ${bulkSendBusy?'disabled':''}>Active run</button>
    <button class="${all?'good':'ghost'} sm grow" onclick="setMessageScope('bookings')" ${bulkSendBusy?'disabled':''}>All bookings</button></div>
    ${all?`<p class="small muted">Includes unscheduled bookings and pickups on every run.</p>
    <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" style="width:auto" onchange="setMessageIncludePast(this.checked)" ${bookingMessageState().includePast?'checked':''} ${bulkSendBusy?'disabled':''}/> Include completed, cancelled and declined bookings</label>
    <button class="ghost sm" onclick="loadBookingMessageRecipients()" ${bookingMessageLoading||bulkSendBusy?'disabled':''}>${bookingMessageLoading?'Loading all bookings…':'Refresh all bookings'}</button>
    <p class="small" role="status">${esc(bookingMessageLoading?'Loading every page of bookings…':bookingMessageError||`${bookingMessageRows.length} bookings loaded`)}${!ownerToken?' <button class="ghost sm" onclick="setAppView(\'bookings\')">Sign in</button>':''}</p>`:''}`;
}
