/* Plan against a frozen copy of the currently numbered map stops. Nothing is
 * removed or renumbered while the owner writes their preferred sequence. */
(function(root){
  'use strict';
  function plan(rows,text){
    const tokens=String(text||'').toUpperCase().replace(/→|->|\bTHEN\b/g,',').split(/[,\s]+/).filter(Boolean);
    if(!tokens.length)throw Error('Enter the stop numbers in the order you want.');
    if(tokens.some(t=>t!=='GMS'&&!/^[1-9]\d*$/.test(t)))throw Error('Use stop numbers and GMS, separated by commas.');
    const numbers=tokens.filter(t=>t!=='GMS').map(Number);
    if(!numbers.length)throw Error('Include at least one pickup number.');
    if(new Set(numbers).size!==numbers.length)throw Error('A stop number is repeated. Include each stop once.');
    if(numbers.some(n=>n>rows.length))throw Error(`Use current stop numbers 1–${rows.length}.`);
    if(new Set(rows.map(r=>r.id)).size!==rows.length)throw Error('The run has duplicate stop references. Reopen the run before arranging it.');
    const first=Math.min(...numbers)-1,prefix=rows.slice(0,first),tail=rows.slice(first);
    const explicitlyNamed=new Set(numbers.map(n=>rows[n-1].id));
    const availableYards=tail.filter(r=>r.kind==='unload'&&!explicitlyNamed.has(r.id));
    const chosen=tokens.map(t=>t==='GMS'?(availableYards.shift()||{newUnload:true}):rows[Number(t)-1]);
    const selected=new Set(chosen.filter(r=>!r.newUnload).map(r=>r.id));
    const missing=tail.filter(r=>!selected.has(r.id));
    if(missing.length)throw Error(`Also include ${missing.map(r=>`stop ${rows.indexOf(r)+1}${r.kind==='unload'?' (GMS)':''}`).join(', ')}. No pickups will be left out.`);
    return {order:[...prefix,...chosen],changed:chosen,prefixCount:first,newUnloads:chosen.filter(r=>r.newUnload).length};
  }
  function validate(original,draft){
    const ids=draft.filter(s=>!s.newUnload).map(s=>s.id);
    if(ids.length!==original.length||new Set(ids).size!==ids.length||original.some(s=>!ids.includes(s.id)))throw Error('A pickup is missing or repeated. Reset the draft and try again.');
    if(draft.some(s=>s.newUnload&&s.kind!=='unload'))throw Error('Only GMS unloads can be added while arranging.');
    return true;
  }
  const api={plan,validate};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.NakiRouteOrder=api;
})(typeof window==='object'?window:globalThis);
