// The report lives in memory only. No financial response is saved to localStorage.
(() => {
  let model,statsUI,report=null,requestVersion=0,period='30',tab='earnings',lens='completed',year='all',shownCompletion='',lastFocus=null;
  const ready=Promise.all([import('./earnings-model.js'),import('./business-stats.js')]).then(([value,stats])=>{model=value;statsUI=stats;});
  const money=cents=>new Intl.NumberFormat('en-NZ',{style:'currency',currency:'NZD',maximumFractionDigits:2}).format(cents/100);
  const section=document.createElement('section');section.id='earningsPage';section.className='view-panel view-earnings';
  section.innerHTML=`<div class="earnings-head"><div><h1>Earnings</h1><p>Your completed work, at a glance.</p></div><div class="earnings-head-actions"><button class="ghost" onclick="setAppView('today');document.getElementById('runActions').hidden=false;document.getElementById('manageRuns').setAttribute('aria-expanded','true')">← Back</button><button id="earningsRefresh" class="ghost">Refresh</button></div></div>
    <p class="earnings-note">Owner only · New Zealand dollars · Before expenses</p>
    <div id="earningsStatus" role="status" class="earnings-note"></div>
    <div id="earningsContent" hidden></div>`;
  document.querySelector('.wrap').append(section);
  const dialog=document.createElement('dialog');dialog.id='dayEarningsDialog';dialog.setAttribute('aria-labelledby','dayEarningsTitle');
  dialog.innerHTML='<h2 id="dayEarningsTitle">Run complete</h2><div id="dayEarningsBody"></div><button id="dayEarningsOpen">View earnings</button><button id="dayEarningsClose" class="ghost">Close</button>';
  document.body.append(dialog);
  document.getElementById('dayEarningsClose').onclick=()=>dialog.close();
  document.getElementById('dayEarningsOpen').onclick=()=>{dialog.close();setAppView('earnings');};
  dialog.addEventListener('close',()=>{document.getElementById('dayEarningsBody').textContent='';lastFocus?.focus?.();});
  dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
  document.getElementById('earningsRefresh').onclick=()=>load();

  function clear() {
    requestVersion++;report=null;document.getElementById('earningsContent').replaceChildren();
    document.getElementById('earningsContent').hidden=true;
    document.getElementById('earningsStatus').textContent='Sign in as the owner to see earnings.';
    if(dialog.open)dialog.close();document.getElementById('dayEarningsBody').textContent='';
  }
  function localRows() {
    // Active state is newer than its persisted run record while a send is finishing.
    const store={runs:runStore.runs.map(run=>run.id===runStore.activeRunId?{...run,data:state}:run),shared:{...runStore.shared,unpaid:state.unpaid||runStore.shared.unpaid||[]}};
    return model.stopRows(store);
  }
  function entries() {
    const clearance=report?.invoiceClearance;const local=localRows().map(r=>((clearance?.stopIds||[]).includes(r.key)||r.aliases.some(a=>(clearance?.bookingIds||[]).includes(a)))&&!(r.invoiceAt>clearance.cutoff)?{...r,owing:false}:r),keys=new Set(local.map(r=>r.key));
    const remote=(report?.records||[]).filter(r=>r.kind!=='stop'||!keys.has(r.key));
    return model.buildEntries([...remote,...local]);
  }
  async function load() {
    if(!ownerToken){clear();return false;}
    const token=ownerToken,version=++requestVersion;
    document.getElementById('earningsStatus').textContent='Checking completed bookings and receipts…';
    document.getElementById('earningsRefresh').disabled=true;
    try {
      await ready;
      const data=await ownerApi('/owner/earnings',{cache:'no-store'});
      if(token!==ownerToken||version!==requestVersion)return false;
      report=data;paint();return true;
    } catch(error) {
      if(version===requestVersion&&token===ownerToken){
        report=null;document.getElementById('earningsContent').hidden=true;
        document.getElementById('earningsContent').replaceChildren();
        document.getElementById('earningsStatus').textContent=error.message||'Earnings could not be loaded. Reconnect and tap Refresh.';
      }
      return false;
    } finally {if(version===requestVersion)document.getElementById('earningsRefresh').disabled=false;}
  }
  function groups(list,scrap=[]) {
    const today=model.nzDay(),monthly=period==='12'||period==='all';
    let start;
    if(monthly){const d=new Date(`${today.slice(0,7)}-01T12:00:00Z`);d.setUTCMonth(d.getUTCMonth()-11);start=period==='all'?(list.find(e=>e.completed&&e.day)?.day.slice(0,7)||today.slice(0,7)):d.toISOString().slice(0,7);}
    else {const d=new Date(`${today}T12:00:00Z`);d.setUTCDate(d.getUTCDate()-Number(period)+1);start=d.toISOString().slice(0,10);}
    const buckets=new Map(),cursor=new Date(`${monthly?start+'-01':start}T12:00:00Z`),end=monthly?today.slice(0,7):today;
    while((monthly?cursor.toISOString().slice(0,7):cursor.toISOString().slice(0,10))<=end&&buckets.size<1200){
      const key=cursor.toISOString().slice(0,monthly?7:10);buckets.set(key,{key,cents:0,jobs:0,scrap:0});
      if(monthly)cursor.setUTCMonth(cursor.getUTCMonth()+1);else cursor.setUTCDate(cursor.getUTCDate()+1);
    }
    for(const row of list){if(!row.completed||!row.day||row.day>today)continue;const b=buckets.get(row.day.slice(0,monthly?7:10));if(b){b.cents+=row.cents;b.jobs++;}}
    for(const pay of scrap){if(!pay.day||pay.day>today)continue;const b=buckets.get(pay.day.slice(0,monthly?7:10));if(b){b.cents+=pay.cents;b.scrap+=pay.cents;}}
    return [...buckets.values()];
  }
  function label(key) {
    const date=new Date(`${key.length===7?key+'-01':key}T12:00:00Z`);
    return date.toLocaleDateString('en-NZ',{timeZone:'UTC',...(key.length===7?{month:'short',year:'numeric'}:{day:'numeric',month:'short'})});
  }
  function chart(buckets) {
    if(!buckets.length)return '<p class="earnings-empty">No dated work recorded yet.</p>';
    const max=Math.max(100,...buckets.map(b=>b.cents)),width=720,height=280,left=82,bottom=232,step=(width-left-12)/buckets.length;
    let svg=`<svg class="earnings-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Recorded earnings over time; exact numbers in the table below"><title>Recorded earnings over time</title>`;
    for(let i=0;i<=3;i++){const y=bottom-i*62;svg+=`<line class="guide" x1="${left}" x2="708" y1="${y}" y2="${y}"/><text x="${left-10}" y="${y+5}" text-anchor="end">${esc(money(Math.round(max*i/3)))}</text>`;}
    buckets.forEach((b,i)=>{const h=b.cents/max*186;svg+=`<rect class="bar" x="${left+i*step+step*.15}" y="${bottom-h}" width="${Math.max(.5,step*.7)}" height="${h}" rx="2"><title>${esc(label(b.key))}: ${esc(money(b.cents))} · ${b.jobs} jobs</title></rect>`;
      if(i===0||i===buckets.length-1||i===Math.floor((buckets.length-1)/2))svg+=`<text x="${left+i*step+step/2}" y="258" text-anchor="${i===0?'start':i===buckets.length-1?'end':'middle'}">${esc(label(b.key))}</text>`;
    });
    return svg+'</svg>';
  }
  function paint() {
    if(!ownerToken||!report||!model){clear();return;}
    const list=entries(),summary=model.summarise(list),payments=report.scrap||[],scrap=model.scrapSummary(payments),buckets=groups(list,payments);
    const split=(pickups,scrapCents)=>scrapCents?`<em class="earnings-split">Pickups ${money(pickups)} · Scrap ${money(scrapCents)}</em>`:'';
    const number=(label,value,detail,extra='',scrapCents=0)=>`<div class="earnings-number ${extra}"><span>${label}</span><strong>${money(value+scrapCents)}</strong>${split(value,scrapCents)}<small>${detail}</small></div>`;
    const warnings=[];
    if(report.stats?.sources?.unavailable)warnings.push('Historical source snapshot unavailable. These totals contain current saved bookings and receipts only.');
    if(summary.missingPrices)warnings.push(`${summary.missingPrices} completed job${summary.missingPrices===1?' has':'s have'} no usable saved price and ${summary.missingPrices===1?'is':'are'} excluded from the money total.`);
    if(summary.recalculatedPrices)warnings.push(`${summary.recalculatedPrices} incorrect older calculator prices were recalculated from your current appliance rates and any recorded travel fee.`);
    if(summary.pricesToReview)warnings.push(`${summary.pricesToReview} older calculator amounts look unusually high and need checking. Their collections count, but these amounts are excluded.`);
    if(summary.undatedJobs)warnings.push(`${summary.undatedJobs} job${summary.undatedJobs===1?' has':'s have'} no completion date. Included in All-time only.`);
    if(summary.estimatedDates)warnings.push(`${summary.estimatedDates} older job date${summary.estimatedDates===1?' uses':'s use'} the saved pickup or submission day.`);
    document.getElementById('earningsStatus').textContent=`Checked ${new Date(report.asOf).toLocaleTimeString('en-NZ',{timeZone:'Pacific/Auckland',hour:'numeric',minute:'2-digit'})} · ${summary.jobs} completed jobs recorded`;
    const tabs=`<div class="earnings-tabs" aria-label="Earnings page"><button data-earnings-tab="earnings" aria-pressed="${tab==='earnings'}">Earnings</button><button data-earnings-tab="stats" aria-pressed="${tab==='stats'}">Business stats</button></div>`;
    if(tab==='stats'){
      document.getElementById('earningsContent').innerHTML=tabs+statsUI.renderBusinessStats(report.stats,list,{lens,year});
      document.getElementById('earningsContent').hidden=false;bindTabs();
      section.querySelectorAll('[data-stats-lens]').forEach(button=>button.onclick=()=>{lens=button.dataset.statsLens;paint();});
      const select=section.querySelector('#statsYear');if(select)select.onchange=()=>{year=select.value;paint();};
      return;
    }
    document.getElementById('earningsContent').innerHTML=tabs+`<div class="earnings-grid">
      ${number('Today',summary.todayCents,'NZ collection day','',scrap.todayCents)}${number('This week',summary.weekCents,'Monday to today','',scrap.weekCents)}
      ${number('This month',summary.monthCents,'Month to today','',scrap.monthCents)}${number('All-time recorded',summary.allTimeCents,summary.firstDay?'Records from '+label(summary.firstDay):'Available saved history','total',scrap.allTimeCents)}</div>
      ${scrapCard(payments,scrap)}
      <div class="earnings-secondary"><p>Receipted<b>${money(summary.receiptedCents)}</b></p><p>Invoices still owing<b>${money(summary.owingCents)}</b></p></div>
      <p class="earnings-note">Completed work uses each booking’s saved price, or its latest saved receipt amount. A Done booking alone does not confirm payment. Totals are before fuel, disposal and other expenses. Older bookings are counted as collected unless there is evidence otherwise. Historical dates use the saved pickup or submission day when needed.</p>
      ${warnings.length?`<div class="earnings-warning">${warnings.map(esc).join('<br>')}</div>`:''}
      <div class="card"><div class="earnings-chart-title"><h2>Earnings over time</h2><strong>${money(buckets.reduce((s,b)=>s+b.cents,0))}</strong></div>
      <div class="earnings-periods" aria-label="Chart period">${[['7','7 days'],['30','30 days'],['12','12 months'],['all','All-time']].map(([key,text])=>`<button class="ghost" data-earnings-period="${key}" aria-pressed="${period===key}">${text}</button>`).join('')}</div>
      ${chart(buckets)}<details><summary>See the numbers</summary><table class="earnings-table"><thead><tr><th>Date</th><th>Jobs</th><th>Scrap</th><th>Total</th></tr></thead><tbody>${buckets.slice().reverse().map(b=>`<tr><td>${esc(label(b.key))}</td><td>${b.jobs}</td><td>${b.scrap?money(b.scrap):'—'}</td><td>${money(b.cents)}</td></tr>`).join('')}</tbody></table></details></div>`;
    document.getElementById('earningsContent').hidden=false;
    bindTabs();
    section.querySelectorAll('[data-earnings-period]').forEach(button=>button.onclick=()=>{period=button.dataset.earningsPeriod;paint();});
    bindScrap();
  }
  // ---- Scrap yard receipts: photo -> amount read -> Woody checks it -> saved ----
  function scrapCard(payments,scrap) {
    const recent=payments.slice().sort((a,b)=>b.day.localeCompare(a.day)||b.createdAt-a.createdAt).slice(0,8);
    return `<div class="card scrap-card"><div class="earnings-chart-title"><h2>Scrap money</h2><strong>${money(scrap.allTimeCents)}</strong></div>
      <p class="earnings-note">Take a photo of your scrap yard docket. The amount is read for you to check before it is added to your totals.</p>
      <div class="scrap-actions"><button id="scrapScan">📷 Scan scrap receipt</button><button id="scrapManual" class="ghost">Type it in</button></div>
      ${recent.length?`<ul class="scrap-list">${recent.map(p=>`<li><span><b>${money(p.cents)}</b> ${esc(label(p.day))}${p.yard?' · '+esc(p.yard):''}${p.weightKg?' · '+esc(p.weightKg)+' kg':''}</span><span>${p.photo?`<button class="ghost" data-scrap-photo="${esc(p.id)}">Photo</button>`:''}<button class="ghost" data-scrap-remove="${esc(p.id)}">Remove</button></span></li>`).join('')}</ul>`:'<p class="earnings-empty">No scrap payments added yet.</p>'}</div>`;
  }
  const scrapDialog=document.createElement('dialog');scrapDialog.id='scrapDialog';scrapDialog.setAttribute('aria-labelledby','scrapTitle');
  scrapDialog.innerHTML=`<h2 id="scrapTitle">Scrap payment</h2><img id="scrapPreview" alt="Your scrap receipt photo" hidden>
    <p id="scrapStatus" role="status" class="earnings-note"></p>
    <label>Amount paid ($)<input id="scrapAmount" type="number" inputmode="decimal" min="0" step="0.01" required></label>
    <label>Date<input id="scrapDay" type="date"></label>
    <label>Scrap yard<input id="scrapYard" type="text" maxlength="80" placeholder="e.g. GMS New Plymouth"></label>
    <label>Weight (kg, optional)<input id="scrapWeight" type="number" inputmode="decimal" min="0" step="0.1"></label>
    <button id="scrapSave">Add to earnings</button><button id="scrapCancel" class="ghost">Cancel</button>`;
  document.body.append(scrapDialog);
  const scrapFile=document.createElement('input');scrapFile.type='file';scrapFile.accept='image/*';scrapFile.setAttribute('capture','environment');scrapFile.hidden=true;scrapFile.style.display='none';section.append(scrapFile);
  let scrapImage='',scrapBusy=false;
  const byId=id=>document.getElementById(id);
  byId('scrapCancel').onclick=()=>scrapDialog.close();
  scrapDialog.addEventListener('close',()=>{scrapImage='';byId('scrapPreview').hidden=true;byId('scrapPreview').removeAttribute('src');});
  function openScrap(image) {
    scrapImage=image||'';byId('scrapAmount').value='';byId('scrapYard').value='';byId('scrapWeight').value='';
    byId('scrapDay').value=model.nzDay();byId('scrapDay').max=model.nzDay();
    byId('scrapPreview').hidden=!image;if(image)byId('scrapPreview').src=image;
    byId('scrapStatus').textContent=image?'Reading the receipt…':'';byId('scrapSave').disabled=false;
    if(!scrapDialog.open)scrapDialog.showModal();
  }
  // Phone photos are several MB. Shrink to a readable 1600px JPEG before sending.
  function shrink(file) {
    return new Promise((resolve,reject)=>{
      const url=URL.createObjectURL(file),img=new Image();
      img.onload=()=>{const scale=Math.min(1,1600/Math.max(img.width,img.height)),canvas=document.createElement('canvas');
        canvas.width=Math.round(img.width*scale);canvas.height=Math.round(img.height*scale);
        canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);URL.revokeObjectURL(url);resolve(canvas.toDataURL('image/jpeg',0.82));};
      img.onerror=()=>{URL.revokeObjectURL(url);reject(Error('That photo could not be opened.'));};
      img.src=url;
    });
  }
  scrapFile.onchange=async()=>{
    const file=scrapFile.files[0];scrapFile.value='';if(!file)return;
    let image;
    try{image=await shrink(file);}catch(error){openScrap('');byId('scrapStatus').textContent=error.message+' Type the amount in instead.';return;}
    openScrap(image);
    try{
      const res=await ownerActionFetch(`${API}/owner/scrap/read`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image})});
      const {read}=await res.json();if(!scrapDialog.open||scrapImage!==image)return;
      if(read.amount!=null)byId('scrapAmount').value=read.amount.toFixed(2);
      if(read.day&&read.day<=model.nzDay())byId('scrapDay').value=read.day;
      if(read.yard)byId('scrapYard').value=read.yard;
      if(read.weightKg!=null)byId('scrapWeight').value=read.weightKg;
      byId('scrapStatus').textContent=read.amount!=null?'Check the amount matches your receipt, then add it.':'The amount could not be read. Type it in from the receipt.';
    }catch(error){if(scrapDialog.open&&scrapImage===image)byId('scrapStatus').textContent=(error.message||'The receipt could not be read.')+' You can still type the amount in.';}
  };
  byId('scrapSave').onclick=async()=>{
    if(scrapBusy)return;
    const amount=Number(byId('scrapAmount').value);
    if(!(amount>0)){byId('scrapStatus').textContent='Enter the amount the scrap yard paid you.';byId('scrapAmount').focus();return;}
    scrapBusy=true;byId('scrapSave').disabled=true;byId('scrapStatus').textContent='Saving…';
    try{
      const res=await ownerActionFetch(`${API}/owner/scrap`,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({amount,day:byId('scrapDay').value,yard:byId('scrapYard').value,weightKg:byId('scrapWeight').value,image:scrapImage||undefined})});
      const {payment}=await res.json();
      scrapDialog.close();flash(`✓ Scrap ${money(payment.cents)} added to earnings.`);await load();
    }catch(error){byId('scrapStatus').textContent=(error.message||'Not saved.')+' Nothing was added. Try again.';byId('scrapSave').disabled=false;}
    finally{scrapBusy=false;}
  };
  function bindScrap() {
    const scan=byId('scrapScan'),manual=byId('scrapManual');
    if(scan)scan.onclick=()=>scrapFile.click();
    if(manual)manual.onclick=()=>openScrap('');
    section.querySelectorAll('[data-scrap-remove]').forEach(button=>button.onclick=async()=>{
      const pay=(report?.scrap||[]).find(p=>p.id===button.dataset.scrapRemove);if(!pay)return;
      if(!confirm(`Remove the ${money(pay.cents)} scrap payment from ${label(pay.day)}? Your totals will go down by that amount.`))return;
      button.disabled=true;
      try{await ownerApi(`/owner/scrap/${encodeURIComponent(pay.id)}`,{method:'DELETE'});flash('Scrap payment removed.');await load();}
      catch(error){button.disabled=false;alert(error.message||'It could not be removed. Try again.');}
    });
    section.querySelectorAll('[data-scrap-photo]').forEach(button=>button.onclick=async()=>{
      button.disabled=true;
      try{
        const res=await boundedFetch(`${API}/owner/scrap/${encodeURIComponent(button.dataset.scrapPhoto)}/photo`,{headers:{Authorization:`Bearer ${ownerToken}`}});
        if(!res.ok)throw Error('The photo could not be loaded.');
        const url=URL.createObjectURL(await res.blob());window.open(url,'_blank');setTimeout(()=>URL.revokeObjectURL(url),60000);
      }catch(error){alert(error.message);}finally{button.disabled=false;}
    });
  }
  function bindTabs(){section.querySelectorAll('[data-earnings-tab]').forEach(button=>button.onclick=()=>{tab=button.dataset.earningsTab;paint();});}
  function pending() {
    return [...(state.stops||[]),...(state.bad||[])].filter(s=>!isUnload(s)&&!((s.status==='DONE'&&s.invoiceStage!=='before')||s.historyStatus==='COMPLETED'||Number(s.collectedAt)>100000000000)).length;
  }
  function capture(){return {runId:runStore.activeRunId,pending:pending()};}
  async function completed(before) {
    if(!before?.pending||before.runId!==runStore.activeRunId||pending())return;
    const signature=before.runId+'|'+[...(state.stops||[]),...(state.bad||[])].map(s=>s.id+':'+s.collectedAt).join('|');
    if(signature===shownCompletion)return;shownCompletion=signature;
    lastFocus=document.activeElement;document.getElementById('dayEarningsBody').textContent='Checking today’s completed work…';
    if(!dialog.open)dialog.showModal();
    if(!ownerToken){document.getElementById('dayEarningsBody').textContent='Sign in as the owner to see today’s earnings.';return;}
    const token=ownerToken,loaded=await load();
    if(!dialog.open||token!==ownerToken||!ownerToken)return;
    if(!loaded){document.getElementById('dayEarningsBody').textContent='Your run is complete. Reconnect and open Earnings for the full day total.';return;}
    const list=entries(),today=model.nzDay(),todayRows=list.filter(e=>e.completed&&e.day===today),total=todayRows.reduce((sum,e)=>sum+e.cents,0),scrapToday=model.scrapSummary(report?.scrap||[],today).todayCents;
    document.getElementById('dayEarningsBody').innerHTML=`<p>Today’s completed work</p><strong class="day-total">${money(total+scrapToday)}</strong><p>${todayRows.length} job${todayRows.length===1?'':'s'} today${scrapToday?` · Scrap ${money(scrapToday)}`:''} · Before expenses</p><p class="earnings-note">Saved booking prices and receipts, counting each job once. Done alone does not confirm payment.</p>${todayRows.some(e=>e.missingPrice)?'<p class="earnings-warning">Some completed jobs have no saved price.</p>':''}`;
  }
  window.nakiEarnings={load,clear,capture,completed,paint};
  window.addEventListener('online',()=>{if(document.body.dataset.view==='earnings')load();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){if(dialog.open)dialog.close();const content=document.getElementById('earningsContent');content.hidden=true;content.replaceChildren();report=null;requestVersion++;}else if(document.body.dataset.view==='earnings')load();});
  if(document.body.dataset.view==='earnings')load();
})();
