/* Space planner based on Woody's 3 x 3 x 2 trailer pattern. Not a weight,
 * dimension or restraint calculation. Unknown footprints stay visible. */
(function(root){
  'use strict';
  const GROUPS={big:'Big / double-door fridges',tall:'Fridges & upright freezers',box:'Washers, dryers & dishwashers',gap:'Gap-fill candidates',check:'Other / check size'};
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function parse(raw){
    let name=String(raw??'').replace(/\s+/g,' ').trim(),quantity=1;
    const suffix=name.match(/\s+[x×*]\s*(\d+)\s*$/i),prefix=name.match(/^(\d+)\s*[x×*]\s*/i);
    const match=suffix||prefix;
    if(match){const q=Number(match[1]);if(Number.isSafeInteger(q)&&q>0&&q<=1000){quantity=q;name=name.replace(match[0],'').trim();}}
    return {name,quantity};
  }
  function classify(name){
    const s=name.toLowerCase();
    if(/fridge|refrigerator/.test(s)&&/large|french|double[ -]?door|side[ -]by[ -]side|american/.test(s))return {group:'big',label:'Big fridge',half:3};
    if(/bar fridge|mini fridge|microwave|\btvs?\b|television|bicycl|\bbikes?\b|exercise|elliptical|cross[ -]?trainer|lawn[ -]?mower|treadmill/.test(s))return {group:'gap',label:name,half:0};
    if(!/chest/.test(s)&&/fridge|refrigerator|upright freezer/.test(s))return {group:'tall',label:/upright/.test(s)?'Fridge / upright':'Fridge',half:2};
    if(/washing machine|\bwasher\b/.test(s))return {group:'box',label:'Washer',half:2};
    if(/dishwasher/.test(s))return {group:'box',label:'Dishwasher',half:2};
    if(/dryer/.test(s))return {group:'box',label:'Dryer',half:2};
    return {group:'check',label:name,half:0};
  }
  function items(stops){
    const result=[],occurrences=new Map();let number=0;
    for(const stop of stops||[]){
      if(stop.status==='DONE'||['CANCELLED','DECLINED','COMPLETED'].includes(stop.status))continue;
      number++;
      if(stop.kind==='unload'){result.push({unload:true,stopId:stop.id});continue;}
      const rawItems=Array.isArray(stop.appliances)?stop.appliances:[];
      if(!rawItems.some(v=>String(v??'').trim()))result.push({key:`${stop.id}|missing`,stopId:stop.id,number,name:'Items not recorded',label:'Items not recorded',group:'check',half:0,missing:true});
      for(const raw of rawItems){
        const parsed=parse(raw);if(!parsed.name)continue;
        for(let i=0;i<parsed.quantity;i++){
          const base=JSON.stringify([String(stop.id),parsed.name.toLowerCase()]),ordinal=occurrences.get(base)||0;
          occurrences.set(base,ordinal+1);
          result.push({key:base+'|'+ordinal,stopId:stop.id,number,name:parsed.name,...classify(parsed.name)});
        }
      }
    }
    return result;
  }
  function pack(list,uteKeys={}){
    const cells=Array.from({length:2},()=>Array.from({length:3},()=>Array(6).fill(null)));
    const placements=[],ute=[],gaps=[],check=[],overflow=[];
    const main=[];
    for(const item of list){
      if(uteKeys[item.key]&&!item.missing)ute.push(item);
      else if(item.group==='gap')gaps.push(item);
      else if(item.group==='check')check.push(item);
      else main.push(item);
    }
    const place=(item,level,rows=item.group==='box'?[1,0,2]:[2,0,1])=>{
      for(const row of rows)for(let col=0;col<=6-item.half;col++){
        if(cells[level][row].slice(col,col+item.half).some(Boolean))continue;
        // A top space needs a planned appliance beneath it. This is a visual
        // support check only, not approval to stack a particular appliance.
        if(level===1&&cells[0][row].slice(col,col+item.half).some(v=>!v))continue;
        for(let j=col;j<col+item.half;j++)cells[level][row][j]=item.key;
        placements.push({...item,level,row,col});return true;
      }
      return false;
    };
    // Wider fridges first prevents a one-space appliance fragmenting their row.
    const sorted=[...main].sort((a,b)=>(a.group==='big'?0:a.group==='tall'?1:2)-(b.group==='big'?0:b.group==='tall'?1:2));
    for(const item of sorted){
      if(item.group==='big'){if(!place(item,0))overflow.push(item);continue;}
      let placed=false;
      for(const row of item.group==='box'?[1,0,2]:[2,0,1]){
        if(place(item,0,[row])||place(item,1,[row])){placed=true;break;}
      }
      if(!placed)overflow.push(item);
    }
    return {placements,ute,gaps,check,overflow,cells,units:main.reduce((n,i)=>n+i.half/2,0),
      placed:placements.reduce((n,i)=>n+i.half/2,0),groups:Object.keys(GROUPS).map(key=>{
        const members=list.filter(i=>i.group===key&&!i.missing),counts=new Map();
        members.forEach(i=>counts.set(i.label,(counts.get(i.label)||0)+1));
        return {key,name:GROUPS[key],count:members.length,details:[...counts].map(([name,count])=>`${name} × ${count}`).join(' · ')};
      })};
  }
  function build(stops,uteKeys={}){
    const loads=[[]];
    for(const item of items(stops)){if(item.unload){if(loads.at(-1).length)loads.push([]);}else loads.at(-1).push(item);}
    if(loads.length>1&&!loads.at(-1).length)loads.pop();
    return loads.map((list,index)=>({...pack(list,uteKeys),index,itemCount:list.filter(i=>!i.missing).length}));
  }
  function icon(group){
    return group==='box'?'<span class="lp-appliance lp-machine" aria-hidden="true"></span>':group==='big'||group==='tall'?'<span class="lp-appliance lp-fridge" aria-hidden="true"></span>':'';
  }
  function chip(item,area){
    const move=area==='ute'?'auto':'ute',action=area==='ute'?'Return to automatic plan':'Plan on ute';
    return `<button type="button" class="lp-chip ${item.group}" data-load-key="${esc(item.key)}" data-load-move="${move}" title="${esc(action+' · '+item.name+' · pickup '+item.number)}"><span>${esc(item.name)}</span><small>#${item.number} · ${action}</small></button>`;
  }
  function layer(plan,level){
    return `<section class="lp-layer"><h4>${level?'Top layer':'Bottom layer'}</h4><div class="lp-trailer"><div class="lp-tow" aria-hidden="true"></div><div class="lp-direction">FRONT · UTE END</div>${[0,1,2].map(row=>{
      const placed=plan.placements.filter(p=>p.level===level&&p.row===row);
      const blocks=placed.map(p=>`<button type="button" class="lp-block ${p.group}" style="grid-column:${p.col+1}/span ${p.half}" data-load-key="${esc(p.key)}" data-load-move="ute" title="${esc(p.name+' · pickup '+p.number+' · tap to plan on ute')}">${icon(p.group)}<b>${esc(p.label)}</b><small>#${p.number}${p.half===3?' · 1½ spaces':''}</small></button>`);
      for(let col=0;col<6;col++)if(!plan.cells[level][row][col]){
        const span=col<5&&!plan.cells[level][row][col+1]?2:1;
        blocks.push(`<span class="lp-empty" style="grid-column:${col+1}/span ${span}" aria-label="${span===2?'One standard space':'Half a standard space'} unused">${span===2?'1 space':'½'}</span>`);
        col+=span-1;
      }
      return `<div class="lp-row-name">${['Front row','Middle row','Back row'][row]}</div><div class="lp-row">${blocks.join('')}</div>${row===0?'<div class="lp-gap-strip">↔ Half-depth gap · thin items</div>':''}`;
    }).join('')}<div class="lp-direction">BACK OF TRAILER</div></div></section>`;
  }
  function render(stops,uteKeys={}){
    const plans=build(stops,uteKeys);
    if(!plans.some(p=>p.itemCount||p.check.length))return '<p>No items left scheduled on this run.</p>';
    return plans.map(p=>`<section class="lp-load"><h3>${plans.length>1?'Load '+(p.index+1)+' · ':''}${p.units} / 18 standard spaces planned</h3>${plans.length>1?'<p class="lp-note">Separate load between scheduled unloads.</p>':''}
      <div class="lp-summary">${p.groups.filter(g=>g.count).map(g=>`<span class="${g.key}"><b>${g.count}</b> ${esc(g.name)}${g.key==='box'||g.key==='gap'?`<small>${esc(g.details)}</small>`:''}</span>`).join('')}</div>
      <p class="lp-note">Big fridge = 1½ spaces. Two fill one row. Tap a block to plan it on the ute.</p>
      <div class="lp-layers">${layer(p,0)}${layer(p,1)}</div>
      <section class="lp-gap-list"><h4>Trailer gap · front to middle</h4><p class="lp-note">Half-depth space for thinner items. Check actual sizes; these are candidates, not confirmed fits.</p><div class="lp-chips">${p.gaps.map(i=>chip(i,'gap')).join('')||'<span class="lp-note">No gap-fill items recorded.</span>'}</div></section>
      <section class="lp-ute"><div class="lp-ute-cab" aria-hidden="true">UTE CAB</div><h4>Ute tray · ${p.ute.length} planned</h4><p class="lp-note">Flexible two-layer area. Washers, dryers and dishwashers can be easier to stack here. Tray width and gaps need your check.</p><div class="lp-chips">${p.ute.map(i=>chip(i,'ute')).join('')||'<span class="lp-note">Tap a trailer block or gap candidate to move it here.</span>'}</div></section>
      ${p.overflow.length?`<section class="lp-warning"><h4>${p.overflow.length} appliance${p.overflow.length===1?'':'s'} not placed</h4><p class="lp-note">Check the ute or plan an unload. Big fridges are kept on the bottom layer.</p><div class="lp-chips">${p.overflow.map(i=>chip(i,'overflow')).join('')}</div></section>`:''}
      ${p.check.length?`<section class="lp-warning"><h4>Check these sizes / details</h4><div class="lp-chips">${p.check.map(i=>i.missing?`<p>Pickup #${i.number}: items not recorded</p>`:chip(i,'check')).join('')}</div></section>`:''}</section>`).join('');
  }
  const api={parse,classify,items,pack,build,render};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.NakiLoadPlan=api;
})(typeof window==='object'?window:globalThis);
