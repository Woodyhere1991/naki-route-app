import {buildGroups,validateGroup,runStamp,nzDay,CENTRES,coords,editedMetrics,weatherFor} from './run-suggestions-model.mjs';
const demo=new URLSearchParams(location.search).get('suggestions-demo')==='1';
const el=id=>document.getElementById(id),escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const AUDIT='naki_run_suggestion_audit_v1';
let preview=null,busy=false,focusBefore=null,editIds=new Set(),demoStore={activeRunId:'example-run',runs:[{id:'example-run',name:'Example Waitara run',data:{stops:[{id:'existing-demo',submission_id:'DEMO-OLD',town:'Waitara',appliances:['Fridge'],status:'NEW',...CENTRES.waitara}],bad:[]}}],shared:{}};
const dateOffset=n=>{const d=new Date(nzDay()+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
const demoBookings=()=>[
 {id:'DEMO-A',firstName:'Example pickup A',status:'NEW',streetAddress:'Example address A',town:'Waitara',items:['Fridge'],...CENTRES.waitara},
 {id:'DEMO-B',firstName:'Example pickup B',status:'NEW',streetAddress:'Example address B',town:'Bell Block',items:['Washing machine'],...CENTRES.bellblock},
 {id:'DEMO-C',firstName:'Example pickup C',status:'NEW',streetAddress:'Example address C',town:'Waitara',items:['Dryer']},
 {id:'DEMO-D',firstName:'Example pickup D',status:'NEW',streetAddress:'Example address D',town:'Hawera',items:['Fridge'],requestedDate:dateOffset(1),...CENTRES.hawera},
 {id:'DEMO-E',firstName:'Example pickup E',status:'CANCELLED',streetAddress:'Example address E',town:'Waitara',items:['Fridge'],...CENTRES.waitara}
];
function localStore(){return {...runStore,runs:runStore.runs.map(r=>r.id===runStore.activeRunId?{...r,data:runDataSnapshot()}:r)};}
function log(type,group,extra={}){
 const key=demo?'naki_run_suggestion_demo_audit_v1':AUDIT;
 const events=JSON.parse(localStorage.getItem(key)||'[]');
 if(events.length>=2000)throw Error('Suggestion history is full. Export your backup before continuing.');
 events.push({type,at:Date.now(),previewId:preview?.id,version:1,groupId:group?.id,day:group?.day,runId:group?.runId,bookingIds:group?.bookingIds||[],...extra});
 localStorage.setItem(key,JSON.stringify(events));
}
const dialog=document.createElement('dialog');dialog.id='runSuggestionsDialog';dialog.setAttribute('aria-labelledby','runSuggestionsTitle');
dialog.innerHTML=`<div class="suggestions-heading"><h2 id="runSuggestionsTitle">Suggest runs</h2><button class="ghost" id="suggestionsClose" aria-label="Close suggestions">Close</button></div>
 <p>${demo?'Demo — synthetic bookings. Approvals here are simulated.':'Preview groups, review them, then approve a whole group.'}</p>
 <form id="suggestionsSettings"><div class="suggestions-grid">
 <label>Plan for<select id="suggestionsTarget"><option value="">New runs for unassigned bookings</option></select></label>
 <label>Start / return town<select id="suggestionsStart"><option value="">Choose your town</option>${Object.keys(CENTRES).map(k=>`<option value="${k}">${k.replace('newplymouth','New Plymouth').replace('bellblock','Bell Block')}</option>`).join('')}</select></label>
 <label class="suggestions-wide">Days you can work (one date per line)<textarea id="suggestionsDays" rows="3" placeholder="YYYY-MM-DD"></textarea></label>
 <label>Start time<input id="suggestionsStartTime" type="time" required></label><label>Finish time<input id="suggestionsEndTime" type="time" required></label>
 <label>Pickup limit / run<input id="suggestionsPickups" type="number" min="1" max="50" required></label><label>Item limit / run<input id="suggestionsItems" type="number" min="1" max="200" required></label>
 <label>Run time limit (minutes)<input id="suggestionsMinutes" type="number" min="15" max="720" required></label><label>Loading / stop (minutes)<input id="suggestionsService" type="number" min="1" max="120" required></label>
 <label class="suggestions-wide">Nearby area limit (km, approximate)<input id="suggestionsCorridor" type="number" min="1" max="100" required></label></div>
 <label class="suggestions-check"><input id="suggestionsAvailable" type="checkbox">I can work these days and have checked these load limits.</label>
 <p class="small muted">Availability is unverified until you tick this. Limits are yours, not learned from past trips. Item counts do not measure weight or vehicle space.</p>
 <button class="good" id="suggestionsGenerate" type="submit">Suggest groups</button></form>
 <p id="suggestionsStatus" role="status" aria-live="polite"></p><div id="suggestionsPreview"></div>
 <details><summary>Recent decisions on this phone</summary><div id="suggestionsHistory" class="small"></div></details>`;
document.body.append(dialog);
function status(text){el('suggestionsStatus').textContent=text;}
function setBusy(value){busy=value;dialog.querySelectorAll('button').forEach(b=>b.disabled=value);el('suggestionsSettings').querySelectorAll('input,textarea,select').forEach(i=>i.disabled=value);}
function options(){return {targetRunId:el('suggestionsTarget').value,startTown:el('suggestionsStart').value,days:el('suggestionsDays').value.split(/[\s,]+/).filter(Boolean),startTime:el('suggestionsStartTime').value,endTime:el('suggestionsEndTime').value,maxPickups:+el('suggestionsPickups').value,maxItems:+el('suggestionsItems').value,maxMinutes:+el('suggestionsMinutes').value,serviceMinutes:+el('suggestionsService').value,corridorKm:+el('suggestionsCorridor').value,availabilityConfirmed:el('suggestionsAvailable').checked};}
function history(){let items=[];try{items=JSON.parse(localStorage.getItem(demo?'naki_run_suggestion_demo_audit_v1':AUDIT)||'[]');}catch{}el('suggestionsHistory').textContent=items.slice(-10).reverse().map(x=>`${new Date(x.at).toLocaleString('en-NZ')} — ${x.type} (${x.bookingIds?.length||0} bookings)`).join('\n')||'No decisions recorded on this phone yet.';}
function open(target=''){
 focusBefore=document.activeElement;
 const store=demo?demoStore:localStore();
 el('suggestionsTarget').innerHTML='<option value="">New runs for unassigned bookings</option>'+store.runs.map(r=>`<option value="${escape(r.id)}">${escape(r.name)}</option>`).join('');
 el('suggestionsTarget').value=target;
 el('suggestionsDays').value=store.runs.find(r=>r.id===target)?.data?.confirmationDate||'';
 if(demo){el('suggestionsDays').value=[dateOffset(1),dateOffset(2)].join('\n');for(const [id,value] of [['suggestionsStart','inglewood'],['suggestionsStartTime','08:00'],['suggestionsEndTime','16:00'],['suggestionsPickups','5'],['suggestionsItems','8'],['suggestionsMinutes','480'],['suggestionsService','10'],['suggestionsCorridor','20']])el(id).value=value;}
 el('suggestionsAvailable').checked=false;preview=null;el('suggestionsPreview').replaceChildren();status('Enter the days and limits you want to plan with.');history();dialog.showModal();
}
const button=document.createElement('button');button.id='suggestRuns';button.className='good sm';button.textContent='Suggest runs';button.onclick=()=>open();el('directRefresh').before(button);
const runButton=document.createElement('button');runButton.id='suggestThisRun';runButton.className='ghost';runButton.textContent='Suggest bookings for this run';runButton.onclick=()=>open(demo?'example-run':runStore.activeRunId);el('runActions').prepend(runButton);
function close(){if(busy)return;dialog.close();focusBefore?.focus();}
el('suggestionsClose').onclick=close;dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
function edited(group,type='edited'){editIds.add(group.id);const current=groupFromUI(group);log(type,current);const card=el('suggestions-'+group.id),store=demo?demoStore:localStore(),metrics=editedMetrics(store,preview.bookings,preview.options,current);card.querySelector('[data-estimate]').textContent=`Edited: ${metrics.pickups} pickups / ${metrics.items} items · about ${metrics.estimate.km} km / ${metrics.estimate.minutes} minutes. Dates and entered limits will be checked again.`;const wx=weatherFor(preview.forecast,preview.bookings.filter(b=>current.bookingIds.includes(b.id)).map(b=>b.town),current.day);card.querySelector('[data-weather]').textContent=`${wx.label}. Forecast ${wx.horizon?wx.horizon.join(' to '):'range unavailable'}. ${wx.updatedAt?'Updated '+new Date(wx.updatedAt).toLocaleString('en-NZ'):''}`;history();}
function groupFromUI(group){const card=el('suggestions-'+group.id);return {...group,day:card.querySelector('[data-day]').value,bookingIds:[...card.querySelectorAll('[data-booking]')].filter(e=>e.querySelector('[data-include]').checked).map(e=>e.dataset.booking),reviewedIds:[...card.querySelectorAll('[data-booking]')].filter(e=>e.querySelector('[data-reviewed]')?.checked).map(e=>e.dataset.booking),townOnlyConfirmed:card.querySelector('[data-town-only]').checked};}
function renderPreview(){
 const byId=new Map(preview.bookings.map(b=>[b.id,b]));
 el('suggestionsPreview').innerHTML=`<p class="small">${preview.groups.length} suggested groups. Customer dates and messages stay unchanged. Existing stop and unload order stays in place.</p>`+preview.groups.map(g=>{
  const wx=g.weather,horizon=wx.horizon?`Forecast dates ${wx.horizon.join(' to ')}.`:'No forecast dates available.';
  return `<section class="card suggestion-group" id="suggestions-${escape(g.id)}"><h3>${escape(g.runName)}</h3><label>Planning day<select data-day>${preview.options.days.map(d=>`<option${d===g.day?' selected':''}>${escape(d)}</option>`).join('')}</select></label>
  <p class="small">${escape(g.reasons.filter(r=>!r.startsWith('Within entered limits')).join(' · '))}<br>${escape(g.confidence)} confidence. Distance-based estimates; check roads and loading yourself.</p><p class="small" data-estimate>${g.pickups} pickups / ${g.items} items · about ${g.estimate.km} km / ${g.estimate.minutes} minutes for the run.</p>
  <p class="small muted" data-weather>${escape(wx.label)}. ${escape(horizon)} ${wx.updatedAt?'Updated '+escape(new Date(wx.updatedAt).toLocaleString('en-NZ'))+'.':''} ${escape(wx.source||'')}</p>
  <div class="suggestion-stops">${g.bookingIds.map(id=>{const b=byId.get(id),notes=[b.additionalInfo,b.customerNote,b.ownerNote].filter(Boolean).join(' · ');return `<article data-booking="${escape(id)}"><label class="suggestions-check"><input data-include type="checkbox" checked><span>${escape([b.firstName,b.lastName].filter(Boolean).join(' ')||id)} — ${escape(b.town)}<br><small>${escape(b.items.join(', '))}${coords(b)?'':' · needs an address pin'}</small></span></label>${notes?`<p class="small">${escape(notes)}</p><label class="suggestions-check"><input data-reviewed type="checkbox">I checked these notes for this day.</label>`:''}<div class="row"><button type="button" class="ghost sm" data-up aria-label="Move ${escape(b.firstName||id)} earlier">↑ Earlier</button><button type="button" class="ghost sm" data-down aria-label="Move ${escape(b.firstName||id)} later">↓ Later</button></div></article>`;}).join('')}</div>
  <label class="suggestions-check"><input type="checkbox" data-town-only>I will check any missing address pins before driving. Town-only stops go to Needs address.</label>
  <div class="row"><button class="good" data-approve>Approve this group</button><button class="ghost" data-reject>Skip this group</button></div></section>`;
 }).join('')+`<details><summary>${preview.held.length} bookings held for review</summary><ul>${preview.held.map(h=>`<li>${escape(byId.get(h.id)?.firstName||h.id)}: ${escape(h.reason)}</li>`).join('')}</ul></details>`;
 for(const group of preview.groups){const card=el('suggestions-'+group.id);
  card.addEventListener('change',event=>{if(event.target.hasAttribute('data-day'))card.querySelectorAll('[data-reviewed]').forEach(i=>i.checked=false);edited(group);card.querySelector('[data-approve]').textContent='Approve edited group';status('Edited group. Dates and limits will be checked again on approval.');});
  card.querySelectorAll('[data-up],[data-down]').forEach(b=>b.onclick=()=>{const row=b.closest('[data-booking]');if(b.hasAttribute('data-up')&&row.previousElementSibling)row.parentNode.insertBefore(row,row.previousElementSibling);if(b.hasAttribute('data-down')&&row.nextElementSibling)row.parentNode.insertBefore(row.nextElementSibling,row);edited(group);card.querySelector('[data-approve]').textContent='Approve edited group';});
  card.querySelector('[data-reject]').onclick=()=>{log('rejected',groupFromUI(group));card.hidden=true;history();status('Group skipped. No runs changed.');};
  card.querySelector('[data-approve]').onclick=()=>approve(group);
 }
}
el('suggestionsSettings').onsubmit=async event=>{
 event.preventDefault();if(busy)return;setBusy(true);status('Checking suitable groups and days…');
 try{
  const opt=options(),store=demo?demoStore:localStore();
  if(demo){const bookings=demoBookings(),now=Date.now(),forecast={updated_at:new Date(now).toISOString(),towns:Object.keys(CENTRES).map(name=>({name,source:'Synthetic demo forecast',updated_at:new Date(now).toISOString(),days:opt.days.map((date,i)=>({date,rain_mm:i===0?12:1,wind:20,partial:false}))}))};preview={...buildGroups({store,bookings,options:opt,weather:forecast}),forecast,bookings,id:crypto.randomUUID(),createdAt:now,runStamp:runStamp(store),baseSavedAt:1};}
  else {if(!ownerToken)throw Error('Sign in on Bookings first.');preview=await ownerApi('/owner/run-suggestions/preview',{method:'POST',body:JSON.stringify({options:opt,runStamp:runStamp(store)})});
   for(const b of preview.bookings){const query=fullAddr({street:b.streetAddress,town:b.town}),hit=geocache[normKey(query)];if(coords(hit)&&addressResultUsable(hit,query)&&!cachedHitSuspect(query,hit)){b.lat=+hit.lat;b.lng=+hit.lng;b.geoLabel=hit.label||'';b.cachedPin={lat:b.lat,lng:b.lng,label:b.geoLabel,addressKey:[b.streetAddress,b.town].join('|')};}}
   Object.assign(preview,buildGroups({store,bookings:preview.bookings,options:opt,weather:preview.forecast}));
  }
  preview.groups.forEach((g,i)=>g.id=preview.id+'-'+i);editIds=new Set();log('suggested',null,{groups:preview.groups.map(g=>({id:g.id,bookingIds:g.bookingIds,runId:g.runId,day:g.day,reasons:g.reasons,confidence:g.confidence})),options:preview.options});renderPreview();history();status(demo?'Demo preview ready — no real bookings changed.':'Preview ready. Review notes, order and capacity before approving.');
 }catch(e){preview=null;el('suggestionsPreview').replaceChildren();status(e.message);}finally{setBusy(false);}
};
el('suggestionsSettings').addEventListener('change',()=>{if(preview){el('suggestionsPreview').replaceChildren();preview=null;status('Planning settings changed. Generate fresh suggestions.');}});
async function approve(original){
 if(busy||!preview)return;setBusy(true);status('Checking and saving the whole group…');
 const session=ownerToken,group=groupFromUI(original),store=demo?demoStore:localStore(),stamp=runStamp(store);let heldCloudLock=false,savedOnAccount=false;
 try{
  if(stamp!==preview.runStamp)throw Error('Your runs changed. Generate fresh suggestions.');
  validateGroup({store,bookings:preview.bookings,options:preview.options,group});
  const revisions=Object.fromEntries(preview.bookings.filter(b=>group.bookingIds.includes(b.id)).map(b=>[b.id,b.revision]));
  if(demo){const run=group.runId?demoStore.runs.find(r=>r.id===group.runId):{id:'demo-'+group.id,name:group.runName,data:{stops:[],bad:[]}};if(!group.runId)demoStore.runs.push(run);run.data.planningDay=group.day;for(const id of group.bookingIds){const b=preview.bookings.find(x=>x.id===id);const stop={id,submission_id:id,town:b.town,status:'NEW',appliances:b.items,...(coords(b)?{lat:b.lat,lng:b.lng}:{})};(coords(b)?run.data.stops:run.data.bad).push(stop);}log('accepted',group);status('Demo: group approval simulated. No real runs or bookings changed.');}
  else {
   if(!session||cloudBackupBusy)throw Error('Wait for account syncing to finish, then retry.');
   clearTimeout(cloudBackupTimer);cloudBackupBusy=true;heldCloudLock=true;
   const pins=Object.fromEntries(preview.bookings.filter(b=>group.bookingIds.includes(b.id)&&b.cachedPin).map(b=>[b.id,b.cachedPin]));
   const out=await ownerApi('/owner/run-suggestions/approve',{method:'POST',body:JSON.stringify({id:group.id,createdAt:preview.createdAt,baseSavedAt:preview.baseSavedAt,runStamp:preview.runStamp,group,options:preview.options,revisions,pins,edited:editIds.has(group.id)})});
   savedOnAccount=true;
   if(ownerToken!==session||runStamp(localStore())!==stamp)throw Error('Group saved to your account, but this phone changed. Restore from account to review it; do not overwrite your phone copy.');
   const next=JSON.parse(out.record.data[RUNS_LS]);
   // Do not adopt anything until the local write succeeds. A lost reply is safely replayable.
   localStorage.setItem(RUNS_LS,JSON.stringify(next));runStore=next;state=loadActiveRun();
   setSyncMark(out.record.savedAt,JSON.stringify({runCount:out.record.runCount,data:out.record.data}));lastCloudPush='';fieldLastSave=out.record.savedAt;
   log('accepted',group,{edited:editIds.has(group.id)});renderRunSwitcher();render();renderDirectBookings();
   status(`Group saved: ${group.bookingIds.length} bookings. Customer dates and messages unchanged.${group.bookingIds.some(id=>!coords(preview.bookings.find(b=>b.id===id)))?' Check Needs address before driving.':''}`);
  }
  // Every remaining group used the earlier run revision; regenerate before the next approval.
  el('suggestionsPreview').replaceChildren();preview=null;history();
 }catch(e){status(savedOnAccount?'Group saved to your account. This phone could not finish updating: '+e.message:e.message);}finally{if(heldCloudLock)cloudBackupBusy=false;setBusy(false);}
}
window.nakiRunSuggestions={open,demo};
if(demo)open();
