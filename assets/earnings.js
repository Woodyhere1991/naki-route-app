// The report lives in memory only. No financial response is saved to localStorage.
(() => {
  let model,statsUI,report=null,requestVersion=0,period='30',tab='earnings',lens='completed',year='all',shownCompletion='',lastFocus=null;
  const ready=Promise.all([import('./earnings-model.js'),import('./business-stats.js')]).then(([value,stats])=>{model=value;statsUI=stats;});
  const money=cents=>new Intl.NumberFormat('en-NZ',{style:'currency',currency:'NZD',maximumFractionDigits:2}).format(cents/100);
  const section=document.createElement('section');section.id='earningsPage';section.className='view-panel view-earnings';
  section.innerHTML=`<div class="earnings-head"><div><h1>Earnings</h1><p>Your completed work, at a glance.</p></div><button id="earningsRefresh" class="ghost">Refresh</button></div>
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
    const local=localRows(),keys=new Set(local.map(r=>r.key));
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
  function groups(list) {
    const today=model.nzDay(),monthly=period==='12'||period==='all';
    let start;
    if(monthly){const d=new Date(`${today.slice(0,7)}-01T12:00:00Z`);d.setUTCMonth(d.getUTCMonth()-11);start=period==='all'?(list.find(e=>e.completed&&e.day)?.day.slice(0,7)||today.slice(0,7)):d.toISOString().slice(0,7);}
    else {const d=new Date(`${today}T12:00:00Z`);d.setUTCDate(d.getUTCDate()-Number(period)+1);start=d.toISOString().slice(0,10);}
    const buckets=new Map(),cursor=new Date(`${monthly?start+'-01':start}T12:00:00Z`),end=monthly?today.slice(0,7):today;
    while((monthly?cursor.toISOString().slice(0,7):cursor.toISOString().slice(0,10))<=end&&buckets.size<1200){
      const key=cursor.toISOString().slice(0,monthly?7:10);buckets.set(key,{key,cents:0,jobs:0});
      if(monthly)cursor.setUTCMonth(cursor.getUTCMonth()+1);else cursor.setUTCDate(cursor.getUTCDate()+1);
    }
    for(const row of list){if(!row.completed||!row.day||row.day>today)continue;const b=buckets.get(row.day.slice(0,monthly?7:10));if(b){b.cents+=row.cents;b.jobs++;}}
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
    const list=entries(),summary=model.summarise(list),buckets=groups(list);
    const number=(label,value,detail,extra='')=>`<div class="earnings-number ${extra}"><span>${label}</span><strong>${money(value)}</strong><small>${detail}</small></div>`;
    const warnings=[];
    if(report.stats?.sources?.unavailable)warnings.push('Historical source snapshot unavailable. These totals contain current saved bookings and receipts only.');
    if(summary.missingPrices)warnings.push(`${summary.missingPrices} completed job${summary.missingPrices===1?' has':'s have'} no saved price and ${summary.missingPrices===1?'is':'are'} excluded from the money total.`);
    if(summary.undatedJobs)warnings.push(`${summary.undatedJobs} job${summary.undatedJobs===1?' has':'s have'} no completion date. Included in All-time only.`);
    if(summary.estimatedDates)warnings.push(`${summary.estimatedDates} older job date${summary.estimatedDates===1?' uses':'s use'} the saved pickup day.`);
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
      ${number('Today',summary.todayCents,'NZ collection day')}${number('This week',summary.weekCents,'Monday to today')}
      ${number('This month',summary.monthCents,'Month to today')}${number('All-time recorded',summary.allTimeCents,summary.firstDay?'Records from '+label(summary.firstDay):'Available saved history','total')}</div>
      <div class="earnings-secondary"><p>Receipted<b>${money(summary.receiptedCents)}</b></p><p>Invoices still owing<b>${money(summary.owingCents)}</b></p></div>
      <p class="earnings-note">Completed work uses each booking’s saved price, or its latest saved receipt amount. A Done booking alone does not confirm payment. Totals are before fuel, disposal and other expenses. Older requests without collection evidence are excluded. See Business stats for the wider booking history.</p>
      ${warnings.length?`<div class="earnings-warning">${warnings.map(esc).join('<br>')}</div>`:''}
      <div class="card"><div class="earnings-chart-title"><h2>Earnings over time</h2><strong>${money(buckets.reduce((s,b)=>s+b.cents,0))}</strong></div>
      <div class="earnings-periods" aria-label="Chart period">${[['7','7 days'],['30','30 days'],['12','12 months'],['all','All-time']].map(([key,text])=>`<button class="ghost" data-earnings-period="${key}" aria-pressed="${period===key}">${text}</button>`).join('')}</div>
      ${chart(buckets)}<details><summary>See the numbers</summary><table class="earnings-table"><thead><tr><th>Date</th><th>Jobs</th><th>Completed work</th></tr></thead><tbody>${buckets.slice().reverse().map(b=>`<tr><td>${esc(label(b.key))}</td><td>${b.jobs}</td><td>${money(b.cents)}</td></tr>`).join('')}</tbody></table></details></div>`;
    document.getElementById('earningsContent').hidden=false;
    bindTabs();
    section.querySelectorAll('[data-earnings-period]').forEach(button=>button.onclick=()=>{period=button.dataset.earningsPeriod;paint();});
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
    const list=entries(),today=model.nzDay(),todayRows=list.filter(e=>e.completed&&e.day===today),total=todayRows.reduce((sum,e)=>sum+e.cents,0);
    document.getElementById('dayEarningsBody').innerHTML=`<p>Today’s completed work</p><strong class="day-total">${money(total)}</strong><p>${todayRows.length} job${todayRows.length===1?'':'s'} today · Before expenses</p><p class="earnings-note">Saved booking prices and receipts, counting each job once. Done alone does not confirm payment.</p>${todayRows.some(e=>e.missingPrice)?'<p class="earnings-warning">Some completed jobs have no saved price.</p>':''}`;
  }
  window.nakiEarnings={load,clear,capture,completed,paint};
  window.addEventListener('online',()=>{if(document.body.dataset.view==='earnings')load();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){if(dialog.open)dialog.close();const content=document.getElementById('earningsContent');content.hidden=true;content.replaceChildren();report=null;requestVersion++;}else if(document.body.dataset.view==='earnings')load();});
  if(document.body.dataset.view==='earnings')load();
})();
