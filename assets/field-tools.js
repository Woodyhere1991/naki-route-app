/* Field reliability helpers. No customer data or API responses are cached by the service worker. */
const fieldScriptLoads = new Map();
function loadFieldScript(src) {
  if (!fieldScriptLoads.has(src)) fieldScriptLoads.set(src,new Promise((resolve,reject)=>{
    const script=document.createElement('script'); script.src=src;
    script.onload=resolve; script.onerror=()=>{fieldScriptLoads.delete(src);reject(Error('Could not load this feature. Please reconnect and retry.'));};
    document.head.append(script);
  }));
  return fieldScriptLoads.get(src);
}
async function ensurePdf() {
  if (!window.jspdf) await loadFieldScript('/assets/vendor/jspdf.umd.min.js');
}
let mapLoadBusy;
async function ensureMap() {
  if (map) return true;
  if (!mapLoadBusy) mapLoadBusy=(async()=>{
    try {
      await loadFieldScript('/assets/vendor/leaflet.js');
      await loadFieldScript('/assets/vendor/leaflet-rotate-src.js');
      if (!map) initMap();
      return true;
    } catch(e) { setBanner('#bannerOsrm','Map unavailable — your pickup list and Navigate buttons still work. Open the map to retry.'); return false; }
    finally { mapLoadBusy=null; }
  })();
  return mapLoadBusy;
}
async function boundedFetch(url, options={}, timeout=15000) {
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeout);
  try {
    const response=await fetch(url,{...options,signal:controller.signal});
    const body=await response.arrayBuffer();
    return new Response([204,205,304].includes(response.status)?null:body,{status:response.status,statusText:response.statusText,headers:response.headers});
  }
  finally { clearTimeout(timer); }
}
async function ownerActionFetch(url, options={}) {
  if (!ownerToken) { setAppView('bookings'); throw Error('Sign in on the Bookings tab, then try again.'); }
  const body=String(options.body||'');
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(url+'|'+body))),b=>b.toString(16).padStart(2,'0')).join('');
  const storageKey='naki_action_'+hash;
  let key=localStorage.getItem(storageKey);
  if(!key) { key=crypto.randomUUID(); localStorage.setItem(storageKey,key); }
  const res=await boundedFetch(url,{...options,headers:{...options.headers,Authorization:`Bearer ${ownerToken}`,'Idempotency-Key':key}},90000);
  const result=await res.clone().json();
  // Keep the reference for ambiguous responses so a retry cannot send twice.
  if (res.ok || (res.status>=400&&res.status<500&&res.status!==409)) localStorage.removeItem(storageKey);
  if(!res.ok) {
    const data=result;
    if(res.status===401) {ownerToken='';localStorage.removeItem(OWNER_TOKEN_KEY);paintCloudState('Sign in to save to your account.',true);}
    throw Error(data.error||'This action could not be completed. Please try again.');
  }
  return res;
}

let fieldRetryTimer=null, fieldLastSave=0, fieldLocalSaveFailed=false;
function paintFieldSave(text,bad=false) {
  const el=document.getElementById('fieldSave'); if(!el) return;
  if(fieldLocalSaveFailed){el.textContent='Changes not saved on phone — keep this screen open';el.classList.add('pending');return;}
  const waiting=loadJSON('naki_pending_reminder_cancels_v1',[]).length;
  el.textContent=waiting?`${text} · ${waiting} payment reminder cancellation waiting`:text;el.classList.toggle('pending',bad||waiting>0);
}
function retryFieldSync() {
  if(fieldLocalSaveFailed)save();
  if(navigator.onLine===false) {paintCloudState('Saved on phone · offline, waiting to sync',true);return;}
  flushReminderCancellations();
  flushExternalBookingSyncs();
  flushDirectCompletions();
  pushCloudBackup(true);
}
function queueReminderCancellation(id) {
  const ids=loadJSON('naki_pending_reminder_cancels_v1',[]);
  if(!ids.includes(id)) saveJSON('naki_pending_reminder_cancels_v1',[...ids,id]);
}
let cancellationBusy=false;
async function flushReminderCancellations() {
  if(!ownerToken||navigator.onLine===false||cancellationBusy) return;
  cancellationBusy=true;
  try {
    for(const id of loadJSON('naki_pending_reminder_cancels_v1',[])) {
      try { await ownerActionFetch(`${API}/cancel-reminder`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});
        saveJSON('naki_pending_reminder_cancels_v1',loadJSON('naki_pending_reminder_cancels_v1',[]).filter(x=>x!==id));
      } catch(e) {paintCloudState('Saved on phone · payment reminder cancellation waiting to sync',true);break;}
    }
  } finally {cancellationBusy=false;}
}

const fieldRouteCache=new Map();
let fieldRouteController;
async function fetchRouteData(url) {
  const cached=fieldRouteCache.get(url);
  if(cached&&Date.now()-cached.at<15*60000) return cached.data;
  fieldRouteController?.abort();
  const controller=fieldRouteController=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),12000);
  try {
    const res=await fetch(url,{signal:controller.signal}); if(!res.ok) throw Error('Road routing unavailable');
    const data=await res.json();if(data.code!=='Ok') throw Error('Road routing unavailable');
    if(fieldRouteCache.size>12) fieldRouteCache.delete(fieldRouteCache.keys().next().value);
    fieldRouteCache.set(url,{data,at:Date.now()});return data;
  } finally {clearTimeout(timeout);}
}

function messageDeliveryLabel(s) {
  const m=markFor(s);
  // Existing prepared marks came from the same Messages handoff.
  const textSent=m.textConfirmed||m.textPrepared;
  if(m.emailFailed) return textSent?'Text sent · email needs retry':'Email needs retry';
  if(textSent) return m.email?'Text + email sent':'Text sent';
  if(m.email) return 'Email sent';
  return m.contacted||m.text?'Previously sent':'Not sent';
}
function recordMessageDelivery(recipients, changes) {
  state.messageHistory=state.messageHistory||{};
  const bucket=state.messageHistory[messageBucket()]=state.messageHistory[messageBucket()]||{};
  recipients.forEach(s=>{const k=messageMarkKey(s);bucket[k]={...markFor(s),...(bucket[k]||{}),stopId:s.id,deliveryVersion:2,...changes};});
  save();
}
// The owner sends every text when Messages opens; record that handoff immediately.
function markTextsSentOnOpen(recipients) {
  recordMessageDelivery(recipients.filter(s=>goodPhone(s.phone)),{textConfirmed:true,textPrepared:false});
}

function weatherRunDate() { return state.confirmationDate||localIso(new Date()); }
const wxValue=value=>value==null?'—':esc(value);
function renderRunWeather() {
  const summary=$('#weatherSummary'),content=$('#weatherContent'),updated=$('#weatherUpdated'),button=$('#weatherRefresh');
  if(!summary||!content) return;
  const locations=weatherLocations(),date=weatherRunDate();button.disabled=weatherState.loading||!locations.length;
  if(!locations.length) {summary.textContent='Run weather — add pickups to see places';content.textContent='Weather will follow the places in this run.';updated.textContent='';return;}
  if(!weatherState.towns.length) {summary.textContent=weatherState.loading?'Run weather — loading…':'Weather unavailable — tap Refresh';content.textContent=weatherState.error||'Loading your forecast…';updated.textContent='';return;}
  const first=weatherState.towns.find(t=>t.name===locations[0].name)||weatherState.towns[0],day=first.days?.find(d=>d.date===date);
  summary.innerHTML=day?`${weatherIcon(day,26)}<span>${esc(dayName(date))} · ${esc(first.name)} · ${wxValue(day.high)}°</span>`:`<span>${esc(dayName(date))} · forecast not available for this date</span>`;
  const sources=[...new Set(weatherState.towns.map(t=>t.source))].join(' / ');
  const time=weatherState.updatedAt?new Date(weatherState.updatedAt).toLocaleString('en-NZ',{weekday:'short',hour:'numeric',minute:'2-digit'}):'time not provided';
  updated.textContent=`${sources} · forecast updated ${time}${weatherState.loading?' · checking…':''}`;
  const stale=weatherState.error||navigator.onLine===false||Date.now()-Date.parse(weatherState.updatedAt||0)>12*3600000;
  const opened=new Set([...content.querySelectorAll('details[data-weather-key][open]')].map(d=>d.dataset.weatherKey));
  content.innerHTML=(stale?`<p class="weather-alert">${esc(weatherState.error||'Saved forecast — reconnect or refresh before relying on it.')}</p>`:'')+weatherState.towns.map(t=>{
    const d=t.days?.find(x=>x.date===date);
    const stop=state.stops.find(s=>s.status!=='DONE'&&s.town===t.name&&routeTiming[s.id]);
    const arrive=stop?stopArriveMin(routeTiming[stop.id]):null;
    const hours=(t.hours||[]).filter(h=>h.time.slice(0,10)===date&&+h.time.slice(11,13)>=6&&+h.time.slice(11,13)<=19);
    return `<details class="weather-town" data-weather-key="${esc(t.name)}"><summary>${d?weatherIcon(d,32):''}<span class="weather-town-label"><strong>${esc(t.name)}${d?` · ${wxValue(d.high)}°`:''}</strong><small>${d?`${esc(d.condition||'Forecast')} · Rain ${wxValue(d.rain_mm)} mm · Wind ${wxValue(d.wind)} km/h`:'Forecast unavailable'}${arrive!=null?` · arrival ${esc(fmtClockShort(arrive))}`:''}</small>${d?.alerts?.length?`<small class="weather-alert">${esc(d.alerts.join(' · '))}</small>`:''}</span></summary>${d?weatherDayHtml(d):'<p class="small muted">Forecast not available for the selected date.</p>'}${hours.length?`<details data-weather-key="${esc(t.name)}-hours"><summary>Forecast through the day</summary><div class="weather-hours">${hours.map(h=>`<div class="weather-day"><b>${esc(h.time.slice(11))}${h.interval_hours>1?' · '+h.interval_hours+'h':''}</b><span>${esc(h.condition)}</span><span>${wxValue(h.temperature)}°</span><span>${wxValue(h.rain_mm)} mm</span><span>Wind ${wxValue(h.wind)} km/h</span><span>Gust ${wxValue(h.gust)} km/h</span></div>`).join('')}</div></details>`:''}<details data-weather-key="${esc(t.name)}-days"><summary>Other days</summary><div class="weather-days">${(t.days||[]).map(weatherDayHtml).join('')}</div></details></details>`;
  }).join('')+'<p class="small muted">App notices are forecast estimates. “—” means the provider has no value. Rain amounts cover the labelled forecast period.</p><p class="small"><a href="https://www.metservice.com/warnings/home" target="_blank" rel="noopener">Check official MetService warnings</a></p><p class="small muted">Weather: <a href="https://www.met.no/en" target="_blank" rel="noopener">MET Norway</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>. Daily summaries calculated by this app.</p>';
  content.querySelectorAll('details[data-weather-key]').forEach(d=>{d.open=opened.has(d.dataset.weatherKey);});
}
async function loadRunWeather(force=false) {
  const locations=weatherLocations(),key=weatherKey(locations);
  if(!locations.length) {weatherState={key:'',towns:[],loading:false};renderWeather();return;}
  if(weatherState.key!==key) {
    const cached=loadJSON('naki_weather_cache_v1',{});
    weatherState=cached.key===key?{...cached,loading:false}:{key,towns:[],loading:false};
  }
  if(weatherState.loading||(!force&&weatherState.towns.length&&Date.now()-(weatherState.checkedAt||0)<30*60000)) {renderWeather();return;}
  weatherState.loading=true;weatherState.error='';renderWeather();
  try {
    const res=await boundedFetch(`${API}/weather`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({locations})},25000);
    const data=await res.json();if(!res.ok) throw Error(data.error||'Weather unavailable');
    if(weatherState.key!==key)return;
    weatherState.towns=data.towns||[];weatherState.checkedAt=Date.now();
    const dates=weatherState.towns.map(t=>Date.parse(t.updated_at||data.updated_at)).filter(Number.isFinite);
    weatherState.updatedAt=dates.length?new Date(Math.min(...dates)).toISOString():data.updated_at;
    weatherState.error=data.failed?.length?`Forecast missing for ${data.failed.join(', ')}`:'';
    try{localStorage.setItem('naki_weather_cache_v1',JSON.stringify({...weatherState,loading:false}));}catch{}
  }catch(e){if(weatherState.key===key)weatherState.error='Could not refresh — showing saved weather if available.';}
  if(weatherState.key===key){weatherState.loading=false;renderWeather();}
}

function fieldBoot() {
  document.getElementById('bookingLoadMore').onclick=()=>loadDirectBookings(true,true);
  document.getElementById('fieldSave')?.addEventListener('click',()=>{if(!ownerToken)setAppView('bookings');else retryFieldSync();});
  window.addEventListener('online',()=>{retryFieldSync();refreshOwnerData();refreshWeather(true);});
  window.addEventListener('offline',()=>{paintCloudState('Saved on phone · offline, waiting to sync',true);renderWeather();});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){retryFieldSync();refreshWeather(false);loadGms(false);}});
  fieldRetryTimer=setInterval(()=>{if(!document.hidden){retryFieldSync();refreshWeather(false);}},60000);
  document.getElementById('insightsCard')?.addEventListener('toggle',()=>{if(document.getElementById('insightsCard').open)loadInsights();});
  if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});
  loadFieldScript('/assets/vendor/Sortable.min.js').then(()=>renderList()).catch(()=>{});
}

const ownerPages={};
let ownerSearchTimer;
function queueOwnerSearch(kind) {
  clearTimeout(ownerSearchTimer);
  ownerSearchTimer=setTimeout(()=>kind==='bookings'?loadDirectBookings(true):loadCustomers(true),400);
}
async function loadOwnerCollection(kind,search,more=false) {
  const button=document.getElementById(kind==='bookings'?'bookingLoadMore':'customerLoadMore');
  let page=ownerPages[kind];
  if(!page||page.search!==search) page=ownerPages[kind]={search,rows:[],nextOffset:0,hasMore:false,version:0};
  const version=++page.version,offset=more?page.nextOffset:0;
  button.disabled=true;
  try {
    const data=await ownerApi(`/owner/${kind}?q=${encodeURIComponent(search)}&offset=${offset}`);
    if(ownerPages[kind]!==page||version!==page.version) throw Error('Search updated — loading the latest results.');
    // Replace the refreshed first page, retaining only older pages explicitly loaded.
    const keep=offset===0?page.rows.filter(r=>!page.firstIds?.has(r.id)):page.rows;
    const ordered=offset===0?(data[kind]||[]).concat(keep):keep.concat(data[kind]||[]);
    const rows=new Map(ordered.map(r=>[r.id,r]));
    (data[kind]||[]).forEach(r=>rows.set(r.id,r));page.rows=[...rows.values()];
    if(offset===0)page.firstIds=new Set((data[kind]||[]).map(r=>r.id));
    if(offset===0&&!more&&page.nextOffset<=(data.pageSize||100) || more) {page.nextOffset=data.nextOffset||page.rows.length;page.hasMore=Boolean(data.hasMore);}
    button.hidden=!page.hasMore;
    const hint=document.getElementById(kind==='bookings'?'bookingPageHint':'customerPageHint');
    if(hint)hint.hidden=!page.hasMore;
    return {...data,[kind]:page.rows};
  } finally {button.disabled=false;}
}

// Customer totals and local word-by-word search need the complete directory.
// Publish only after every page succeeds; coalesce refreshes for the same login.
let completeCustomersRequest=null;
function loadCompleteCustomers() {
  const session=ownerToken;
  if(completeCustomersRequest?.session===session) return completeCustomersRequest.promise;
  const pending={session};
  pending.promise=(async()=>{
    const rows=new Map();let offset=0;
    for(;;){
      const data=await ownerApi('/owner/customers?offset='+offset);
      if(ownerToken!==session) throw Error('Owner sign-in changed.');
      if(!Array.isArray(data.customers)) throw Error('Could not verify the customer list. Please refresh.');
      for(const row of data.customers) rows.set(row.id,row);
      if(!data.hasMore) return {customers:[...rows.values()]};
      const next=Number(data.nextOffset);
      if(!Number.isInteger(next)||next<=offset||next>100000) throw Error('Could not load all customers. Please refresh.');
      offset=next;
    }
  })().finally(()=>{if(completeCustomersRequest===pending)completeCustomersRequest=null;});
  completeCustomersRequest=pending;
  return pending.promise;
}
function customerDirectorySummary(customers,contacts,visibleCount,search) {
  const total=customers.length+contacts.length;
  const installed=customers.filter(c=>c.pwaInstalledAt).length;
  const count=search
    ? visibleCount+' of '+total+' customers and contacts match'
    : customers.length+' customer'+(customers.length===1?'':'s')+(contacts.length?' + '+contacts.length+' saved contact'+(contacts.length===1?'':'s'):'');
  return count+' · 📲 '+installed+' recorded app install'+(installed===1?'':'s');
}
