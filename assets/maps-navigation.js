/* Explicit app handoff. Keep the complete directions URL so bridge detour
 * waypoints survive. No timers redirect a driver back out of the Maps app.
 * https://developers.google.com/maps/documentation/urls/ios-urlscheme
 * https://developer.chrome.com/docs/android/intents */
(function(root){
  'use strict';
  function links(webUrl,device={}){
    const web=new URL(webUrl);
    if(web.protocol!=='https:'||web.hostname!=='www.google.com'||!web.pathname.startsWith('/maps/dir/'))throw Error('Invalid navigation destination');
    web.hash='';web.searchParams.set('api','1');web.searchParams.set('travelmode','driving');web.searchParams.set('dir_action','navigate');
    const ua=device.userAgent||'',ios=/iPhone|iPad|iPod/i.test(ua)||(device.platform==='MacIntel'&&device.maxTouchPoints>1);
    const app=ios?web.href.replace(/^https:/,'comgooglemapsurl:'):/Android/i.test(ua)
      ?`intent:${web.href.slice(6)}#Intent;scheme=https;package=com.google.android.apps.maps;S.browser_fallback_url=${encodeURIComponent(web.href)};end`
      :web.href;
    return {app,web:web.href};
  }
  function open(webUrl){
    const target=links(webUrl,root.navigator);
    if(target.app!==target.web){
      root.document.getElementById('mapsAppHandoff')?.remove();
      const panel=root.document.createElement('div');panel.id='mapsAppHandoff';panel.setAttribute('role','status');
      panel.style.cssText='position:fixed;bottom:100px;left:12px;right:12px;z-index:12000;padding:14px;border:1px solid #618397;border-radius:12px;background:#08273b;color:white;box-shadow:0 4px 18px #0008';
      const text=root.document.createElement('div');text.textContent='Opening Google Maps…';panel.append(text);
      const native=root.document.createElement('a');native.href=target.app;native.className='good sm';native.textContent='Open Google Maps app';native.style.cssText='display:inline-block;margin:10px 8px 0 0';panel.append(native);
      const fallback=root.document.createElement('a');fallback.href=target.web;fallback.className='ghost sm';fallback.textContent='Use browser instead';fallback.style.cssText='display:inline-block;margin-top:10px';panel.append(fallback);
      const close=root.document.createElement('button');close.type='button';close.className='ghost sm';close.textContent='Close';close.style.cssText='margin:10px 0 0 8px';close.onclick=()=>panel.remove();panel.append(close);
      root.document.body.append(panel);
      root.document.addEventListener('visibilitychange',()=>{if(root.document.hidden)panel.remove();},{once:true});
    }
    root.location.href=target.app;
    return true;
  }
  const api={links,open};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.NakiMaps=api;
})(typeof window==='object'?window:globalThis);
