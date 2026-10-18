/* Leaflet map and Sortable list edit a local draft. The application owns save,
 * stale-run validation and persistence; this view never changes a live run. */
(function(root){
  'use strict';
  let active=null;
  function open(options){
    active?.destroy();
    const doc=root.document,$=id=>doc.getElementById(id),dialog=$('routeOrderDialog');
    let order=[...options.rows],finishLast=false,selected=null,added=0,map=null,markers=null,line=null,sortable=null,disposed=false,revision=0,timer=null;
    const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const list=$('routeOrderList'),status=$('routeOrderMapState');
    function draft(){return {order:[...order],finishLast};}
    function notify(){options.onChange(draft());$('routeOrderError').textContent='';}
    function highlight(){
      list.querySelectorAll('[data-order-key]').forEach(row=>row.classList.toggle('is-selected',row.dataset.orderKey===selected));
      const index=order.findIndex(s=>String(s.id)===selected);
      $('routeOrderAddGms').textContent=index<0?'Add GMS':`GMS after ${index+1}`;
    }
    function select(id,scroll){
      selected=String(id);highlight();
      if(scroll){const row=[...list.children].find(el=>el.dataset.orderKey===selected);if(row)list.scrollTop=row.offsetTop-list.offsetTop-list.clientHeight/2+row.clientHeight/2;}
    }
    function renderList(){
      const scroll=list.scrollTop;
      list.innerHTML=order.map((stop,index)=>`<div class="route-order-row ${stop.kind==='unload'?'is-yard':''}" data-order-key="${esc(stop.id)}">
        <button type="button" class="route-order-handle" aria-label="Drag stop ${index+1}">☰</button><span class="route-order-number">${index+1}</span>
        <div class="route-order-label"><b>${stop.kind==='unload'?'♻ GMS unload':esc(options.name(stop))}</b><small>${esc(options.address(stop))}</small></div>
        ${stop.newUnload?'<button type="button" class="ghost route-order-remove" data-order-remove aria-label="Remove added GMS unload">×</button>':''}
        <div class="route-order-arrows"><button type="button" class="ghost" data-order-step="-1" aria-label="Move stop ${index+1} up" ${index===0?'disabled':''}>↑</button><button type="button" class="ghost" data-order-step="1" aria-label="Move stop ${index+1} down" ${index===order.length-1?'disabled':''}>↓</button></div></div>`).join('');
      list.scrollTop=scroll;highlight();
    }
    function points(){return [options.start,...order,...(!finishLast&&options.end?[options.end]:[])];}
    function fit(){if(map){const bounds=points().map(p=>[p.lat,p.lng]);map.fitBounds(bounds,{padding:[20,20],maxZoom:13});}}
    function renderMap(){
      const current=++revision;clearTimeout(timer);
      if(!map)return;
      markers.clearLayers();line.clearLayers();
      const L=root.L;
      L.circle([options.bridge.lat,options.bridge.lng],{radius:100,color:'#d83b3b',fillOpacity:.25}).bindPopup('Bertrand Road Bridge · blocked').addTo(markers);
      L.marker([options.start.lat,options.start.lng],{icon:options.pin('S','',true)}).bindPopup('Start').addTo(markers);
      order.forEach((stop,index)=>{
        const marker=L.marker([stop.lat,stop.lng],{icon:stop.kind==='unload'?options.unloadIcon(index+1):options.pin(index+1,stop.area,false),routeOrderKey:stop.id});
        marker.bindPopup(`<b>${index+1}. ${stop.kind==='unload'?'GMS unload':esc(options.name(stop))}</b><br>${esc(options.address(stop))}`)
          .on('click',()=>select(stop.id,true)).addTo(markers);
      });
      if(!finishLast&&options.end)L.marker([options.end.lat,options.end.lng],{icon:options.pin('E','',true)}).bindPopup('Final destination').addTo(markers);
      status.textContent='Updating driving route…';
      const seq=points();
      timer=setTimeout(async()=>{
        try{
          const route=await options.route(seq);
          if(disposed||current!==revision)return;
          L.geoJSON({type:'Feature',geometry:route.geometry},{style:{color:'#2f80ff',weight:5,opacity:.85}}).addTo(line);
          status.textContent='Map matches the list · Bertrand Road Bridge avoided';
        }catch(e){if(!disposed&&current===revision)status.textContent='Driving line unavailable. You can still arrange and save stops.';}
      },250);
    }
    function changed(){renderList();renderMap();notify();}
    function onClick(event){
      const row=event.target.closest('[data-order-key]');if(!row)return;
      const id=row.dataset.orderKey,index=order.findIndex(s=>String(s.id)===id);if(index<0)return;
      const step=event.target.closest('[data-order-step]');
      if(step){const target=index+Number(step.dataset.orderStep);if(target<0||target>=order.length)return;const [stop]=order.splice(index,1);order.splice(target,0,stop);selected=id;changed();return;}
      if(event.target.closest('[data-order-remove]')){
        order.splice(index,1);selected=null;
        if(options.endIsGms&&!order.some(s=>s.kind==='unload')){finishLast=false;$('routeOrderFinish').checked=false;}
        changed();return;
      }
      select(id,false);
      if(map)markers.eachLayer(layer=>{if(String(layer.options?.routeOrderKey)===id)layer.openPopup();});
    }
    function addGms(){
      const index=order.findIndex(s=>String(s.id)===selected);let id;
      do{id=`draft-gms-${++added}`;}while(order.some(s=>String(s.id)===id));
      const stop={...options.yard,id,kind:'unload',newUnload:true};
      order.splice(index<0?order.length:index+1,0,stop);selected=stop.id;
      if(options.endIsGms){finishLast=true;$('routeOrderFinish').checked=true;}
      changed();select(stop.id,true);
    }
    function reset(){order=[...options.rows];selected=null;finishLast=false;$('routeOrderFinish').checked=false;changed();fit();}
    function finish(){finishLast=$('routeOrderFinish').checked;renderMap();notify();}
    function close(){if(!dialog.open)session.destroy();}
    const session={getDraft:draft,getMap:()=>map,fit,destroy(){
      if(disposed)return;disposed=true;revision++;clearTimeout(timer);sortable?.destroy();map?.remove();map=null;
      list.removeEventListener('click',onClick);dialog.removeEventListener('close',close);
      if(active===session)active=null;options.onClose?.();
    }};
    active=session;
    $('routeOrderTitle').textContent='Arrange stops · '+options.runName;
    $('routeOrderHint').textContent='Hold ☰ to drag. Tap a pin to find its row. Add GMS after the selected stop.';
    $('routeOrderFinishRow').hidden=!options.end;$('routeOrderFinish').checked=false;
    $('routeOrderAddGms').onclick=addGms;$('routeOrderFit').onclick=fit;$('routeOrderReset').onclick=reset;$('routeOrderFinish').onchange=finish;
    list.addEventListener('click',onClick);dialog.addEventListener('close',close);
    status.textContent='Loading map…';renderList();notify();dialog.showModal();
    options.loadSortable().then(()=>{
      if(disposed)return;
      sortable=root.Sortable.create(list,{draggable:'.route-order-row',handle:'.route-order-handle',animation:150,delay:180,delayOnTouchOnly:true,touchStartThreshold:8,forceFallback:true,fallbackTolerance:5,scroll:list,scrollSensitivity:55,scrollSpeed:12,
        onStart:event=>{if(disposed)return;selected=event.item.dataset.orderKey;highlight();},
        onEnd:()=>{if(disposed)return;const ids=[...list.children].filter(el=>el.dataset.orderKey&&!el.classList.contains('sortable-fallback')).map(el=>el.dataset.orderKey);const byId=new Map(order.map(s=>[String(s.id),s]));order=ids.map(id=>byId.get(id));changed();}
      });
    }).catch(()=>{if(!disposed)$('routeOrderHint').textContent='Drag unavailable. Use ↑ ↓ to move stops.';});
    options.loadMap().then(ok=>{
      if(disposed)return;
      if(!ok)throw Error('Map unavailable');
      const L=root.L;
      map=L.map('routeOrderMap',{zoomControl:true,rotate:true,touchRotate:true,rotateControl:{closeOnZeroBearing:false}});
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(map);
      markers=L.layerGroup().addTo(map);line=L.layerGroup().addTo(map);
      if(options.viewport){map.setView(options.viewport.center,options.viewport.zoom);if(map.setBearing)map.setBearing(options.viewport.bearing||0);}else fit();
      map.invalidateSize();renderMap();
    }).catch(()=>{if(!disposed)status.textContent='Map unavailable. You can still arrange stops below.';});
    return session;
  }
  root.NakiRouteOrganizer={open};
})(window);
