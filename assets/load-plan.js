/* Count-only estimate: 18 total standard spaces, up to 12 fridge/freezer
 * spaces. Maximise fridge count first, then fill the trailer as fully as
 * possible. No vehicle dimensions, weight or live contents are measured. */
(function(root){
  'use strict';
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function parse(raw){
    let name=String(raw??'').replace(/\s+/g,' ').trim(),quantity=1;
    const match=name.match(/\s+[x×*]\s*(\d+)\s*$/i)||name.match(/^(\d+)\s*[x×*]\s*/i);
    if(match){const q=Number(match[1]);if(Number.isSafeInteger(q)&&q>0&&q<=1000){quantity=q;name=name.replace(match[0],'').trim();}}
    return {name,quantity};
  }
  function largeChest(s){
    if(/\blarge\b|over\s*1[.,]5\s*m|(?:bigger|longer|more) than\s*1[.,]5\s*m|>\s*1[.,]5\s*m/.test(s))return true;
    const length=s.match(/(\d+(?:[.,]\d+)?)\s*(mm|cm|metres?|meters?|m)\b/);
    if(!length)return false;
    const metres=Number(length[1].replace(',','.'))/({mm:1000,cm:100}[length[2]]||1);
    return metres>1.5||metres===1.5&&/over|above|(?:bigger|longer|more) than|>/.test(s);
  }
  function classify(name){
    const s=name.toLowerCase();
    if(/chest freezer/.test(s))return {group:'cold',label:largeChest(s)?'Large chest freezers (>1.5 m)':'Chest freezers',half:largeChest(s)?3:2};
    if(/bar fridge|mini fridge|microwave|\btvs?\b|television|bicycl|\bbikes?\b|exercise|elliptical|cross[ -]?trainer|lawn[ -]?mower|treadmill/.test(s))return {group:'small',label:name,half:0};
    if(/fridge|refrigerator/.test(s)&&/large|french|double[ -]?door|side[ -]by[ -]side|american/.test(s))return {group:'cold',label:'Big fridges',half:3,fridge:true};
    if(/fridge|refrigerator|freezer/.test(s))return {group:'cold',label:'Fridges / upright freezers',half:2,fridge:true};
    if(/washing machine|\bwasher\b/.test(s))return {group:'standard',label:'Washing machines',half:2};
    if(/dishwasher/.test(s))return {group:'standard',label:'Dishwashers',half:2};
    if(/dryer/.test(s))return {group:'standard',label:'Dryers',half:2};
    if(/oven|stove/.test(s))return {group:'standard',label:'Ovens / stoves',half:2};
    if(/^others?\b/.test(s))return {group:'small',label:name,half:0};
    return {group:'check',label:name,half:0};
  }
  function items(stops){
    const result=[],occurrences=new Map();let number=0;
    for(const stop of stops||[]){
      if(['DONE','CANCELLED','DECLINED','COMPLETED'].includes(stop.status))continue;
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
  // Exact subset choices. Half-units express 1.5-space appliances only;
  // no half-space filler is invented to make the total reach 18.
  function options(list,capacity,preferFridges=false){
    const choices=Array(capacity+1).fill(null);choices[0]=[];
    for(const item of list)for(let space=capacity;space>=item.half;space--){
      const previous=choices[space-item.half];
      if(!previous)continue;
      const candidate=[...previous,item],old=choices[space];
      const priority=preferFridges?candidate.filter(i=>i.fridge).length:0,oldPriority=preferFridges&&old?old.filter(i=>i.fridge).length:0;
      if(!old||priority>oldPriority||priority===oldPriority&&candidate.length>old.length)choices[space]=candidate;
    }
    return choices;
  }
  function allocate(list){
    const cold=options(list.filter(i=>i.group==='cold'),24,true);
    const standard=options(list.filter(i=>i.group==='standard'),36);
    let best={fridges:-1,used:0,count:0,trailer:[]};
    for(let f=0;f<cold.length;f++)if(cold[f])for(let s=0;s+f<=36;s++)if(standard[s]){
      const score={fridges:cold[f].filter(i=>i.fridge).length,used:f+s,count:cold[f].length+standard[s].length};
      if(score.fridges>best.fridges||score.fridges===best.fridges&&(score.used>best.used||score.used===best.used&&score.count>best.count))
        best={...score,trailer:[...cold[f],...standard[s]]};
    }
    const selected=new Set(best.trailer.map(i=>i.key));
    return {trailer:best.trailer,units:best.used/2,coldUnits:best.trailer.filter(i=>i.group==='cold').reduce((n,i)=>n+i.half/2,0),
      leftover:list.filter(i=>i.half>0&&!selected.has(i.key)),small:list.filter(i=>i.group==='small'),check:list.filter(i=>i.group==='check'),
      itemCount:list.filter(i=>!i.missing).length};
  }
  function build(stops){
    const loads=[[]];
    for(const item of items(stops)){if(item.unload){if(loads.at(-1).length)loads.push([]);}else loads.at(-1).push(item);}
    if(loads.length>1&&!loads.at(-1).length)loads.pop();
    return loads.map((list,index)=>({...allocate(list),index}));
  }
  function countRows(list){
    const counts=new Map();
    for(const item of list){const key=item.label.toLowerCase();if(!counts.has(key))counts.set(key,{name:item.label,count:0});counts.get(key).count++;}
    return `<ul class="ls-counts">${[...counts.values()].map(i=>`<li><span>${esc(i.name)}</span><b>× ${i.count}</b></li>`).join('')}</ul>`;
  }
  function summary(stops){
    const plans=build(stops);
    if(!plans.some(p=>p.itemCount||p.check.length))return '<p>No items left scheduled on this run.</p>';
    return plans.map(p=>{
      const left=18-p.units;
      return `<section class="ls-load">${plans.length>1?`<h3>Load ${p.index+1} · before the next unload</h3>`:''}
        <div class="ls-capacity"><b>${p.units}<small> / 18 trailer spaces</small></b><span>${left===0?'Trailer spaces filled':left===0.5?'½ space spare — too small for a standard appliance':`${left} spaces unused`}</span></div>
        <section class="ls-group ls-trailer"><h3>On the trailer · ${p.trailer.length} appliance${p.trailer.length===1?'':'s'}</h3>${p.trailer.length?countRows(p.trailer):'<p class="lp-note">No full-size appliances to assign.</p>'}</section>
        <section class="ls-group ls-leftover"><h3>Larger items left over · ${p.leftover.length}</h3>${p.leftover.length?countRows(p.leftover):'<p class="lp-note">None.</p>'}</section>
        <section class="ls-group ls-small"><h3>Small items / gaps · ${p.small.length}</h3>${p.small.length?countRows(p.small):'<p class="lp-note">None.</p>'}</section>
        ${p.check.length?`<section class="ls-group ls-check"><h3>Check details</h3>${countRows(p.check)}</section>`:''}
      </section>`;
    }).join('');
  }
  const api={parse,classify,items,allocate,build,summary};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.NakiLoadPlan=api;
})(typeof window==='object'?window:globalThis);
