/* Owner-only aggregate report; uses the same authenticated API as bookings. */
(() => {
  const labels={numbers:'Number Garden',patterns:'Pattern Detective',bridge:'Number Bridge',pack:'Pocket Packer',robot:'Route Robot',share:'Fair Share Picnic',round:'The Kind Round',sorter:'Stop, Think, Load'};
  const num=value=>Number.isSafeInteger(Number(value))&&Number(value)>=0?Number(value):0;
  const el=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
  window.KidsActivityPanel={mount({api,token}){
    const card=document.getElementById('kidsActivityCard'),body=document.getElementById('kidsActivityBody'),range=document.getElementById('kidsActivityRange'),refresh=document.getElementById('kidsActivityRefresh');
    let request=0;
    async function load(){
      if(!token()){visibility();return;}
      const current=++request,session=token(),days=range.value;refresh.disabled=true;body.textContent='Loading game activity…';
      try{
        const data=await api('/owner/kids-activity?days='+days);
        if(current!==request||token()!==session||range.value!==days)return;
        body.replaceChildren();
        const totals=el('p',`${num(data.totals.starts)} ${num(data.totals.starts)===1?'play':'plays'} started · ${num(data.totals.finishes)} ${num(data.totals.finishes)===1?'round':'rounds'} completed`);totals.style.fontWeight='800';body.append(totals);
        if(!num(data.totals.starts))body.append(el('p','No counted plays in this period yet. Counting begins with this update.'));
        const table=el('table');table.className='kids-activity-table';const caption=el('caption','Activity by game');table.append(caption);
        const head=el('thead'),headRow=el('tr');for(const name of ['Game','Plays','Finished']){const th=el('th',name);th.scope='col';headRow.append(th);}head.append(headRow);table.append(head);
        const tbody=el('tbody');
        for(const row of [...(data.games||[])].filter(r=>labels[r.game]).sort((a,b)=>num(b.starts)-num(a.starts))){const tr=el('tr'),name=el('th',labels[row.game]);name.scope='row';tr.append(name,el('td',String(num(row.starts))),el('td',String(num(row.finishes))));tbody.append(tr);}
        table.append(tbody);body.append(table);
        if(data.daily?.length>1){const details=el('details'),summary=el('summary','Daily totals');details.append(summary);for(const day of data.daily){const line=el('div',`${String(day.day)} · ${num(day.starts)} plays · ${num(day.finishes)} finished`);line.style.padding='5px 0';details.append(line);}body.append(details);}
        const updated=el('p',`Updated ${new Date(data.updatedAt).toLocaleString('en-NZ',{timeZone:'Pacific/Auckland'})} · New Zealand time`);updated.className='small muted';body.append(updated);
      }catch(e){if(current===request&&token()===session)body.textContent='Could not load game activity. Check your connection and tap Refresh.';}
      finally{if(current===request)refresh.disabled=false;}
    }
    function visibility(){card.style.display=token()?'':'none';if(!token()){request++;body.replaceChildren();refresh.disabled=false;}}
    card.addEventListener('toggle',()=>{if(card.open)load();});range.addEventListener('change',load);refresh.addEventListener('click',load);visibility();
    return {visibility,load};
  }};
})();
