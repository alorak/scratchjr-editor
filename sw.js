const CACHE_NAME='scratchjr-editor-v2';
const CORE=[
  './',
  './index.html',
  './app.css',
  './app.js',
  './roundtrip-utils.mjs',
  './ui-utils.mjs',
  './file-utils.mjs',
  './audio-utils.mjs',
  './audio-recorder.mjs',
  './sjr-archive-utils.mjs',
  './sjr-import-export.mjs',
  './stage-controller.mjs',
  './asset-pipeline.mjs',
  './library-controller.mjs',
  './vendor/jszip.min.js',
  './vendor/spark-md5.min.js',
  './vendor/imagetracer_v1.2.6.js'
];

self.addEventListener('install',event=>{
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache=>cache.addAll(CORE))
      .then(()=>self.skipWaiting())
  );
});

self.addEventListener('activate',event=>{
  event.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

async function cacheSuccessful(request,response){
  if(response&&response.status===200){
    const cache=await caches.open(CACHE_NAME);
    await cache.put(request,response.clone());
  }
  return response;
}

async function networkFirst(request,fallbackRequest=request,cacheRequest=request){
  try{
    const response=await fetch(request);
    return await cacheSuccessful(cacheRequest,response);
  }catch(err){
    const cached=await caches.match(fallbackRequest);
    if(cached) return cached;
    throw err;
  }
}

self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET') return;
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin) return;

  if(event.request.mode==='navigate'){
    event.respondWith(networkFirst(event.request,'./index.html','./index.html'));
    return;
  }

  // Online iken her zaman ağdaki güncel asset'i al ve cache'i yenile.
  // Ağ yoksa son başarılı kopyaya dön. Böylece sabit cache adı yeni deployları
  // süresiz olarak eski app.js/app.css ile kilitlemez.
  event.respondWith(networkFirst(event.request));
});
