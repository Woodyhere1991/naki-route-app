const CACHE='naki-field-20260905-1';
const FILES=['/','/index.html','/manifest.webmanifest','/assets/field-tools.js','/assets/vendor/leaflet.js','/assets/vendor/leaflet.css','/assets/vendor/leaflet-rotate-src.js','/assets/vendor/Sortable.min.js','/assets/vendor/jspdf.umd.min.js','/assets/naki-whiteware-logo-tight.png','/assets/icon-192.png','/assets/icon-180.png','/assets/icon-512.png','/assets/icon-maskable-512.png','/assets/vendor/images/layers.png','/assets/vendor/images/layers-2x.png','/assets/vendor/images/marker-icon.png','/assets/vendor/images/marker-icon-2x.png','/assets/vendor/images/marker-shadow.png'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(FILES))));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  for(const key of await caches.keys()) if(key.startsWith('naki-field-')&&key!==CACHE) await caches.delete(key);
  await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  // Never cache accounts, APIs, documents, weather requests or third-party tiles.
  if(event.request.method!=='GET'||url.origin!==self.location.origin||!FILES.includes(url.pathname)||url.search) return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),6000);
    try {const response=await fetch(event.request,{signal:controller.signal});if(response.ok) await cache.put(event.request,response.clone());else {const saved=await cache.match(event.request);if(saved)return saved;}return response;}
    catch(error){const saved=await cache.match(event.request);if(saved)return saved;throw error;}
    finally {clearTimeout(timer);}
  })());
});
