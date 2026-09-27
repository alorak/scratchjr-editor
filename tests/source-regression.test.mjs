import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const app=await readFile(new URL('../app.js',import.meta.url),'utf8');

test('critical round-trip guards remain wired',()=>{
  assert.match(app,/MAX_PAGES=4/);
  assert.match(app,/selectBackgroundSvg\(asset,coverSvg\)/);
  assert.match(app,/function fileToBackgroundAsset\(file\)/);
  assert.match(app,/const a=await fileToBackgroundAsset\(f\)/);
  assert.match(app,/preserveSvg:true/);
  assert.match(app,/characters:charManifest/);
  assert.match(app,/resolveCurrentPageIndex\(J\.currentPage,pageKeys\)/);
  assert.match(app,/dataMetaWithoutJson\(data\)/);
  assert.match(app,/jsonMetaWithoutPages\(J,pageKeys\)/);
  assert.match(app,/pageMetaWithoutSprites\(po\)/);
  assert.match(app,/escapeHtml\(c\.name\|\|'Karakter'\)/);
  assert.match(app,/assertFileSize\(file,MAX_SJR_BYTES/);
  assert.match(app,/assertZipSafety\(zip\)/);
  assert.match(app,/restoreAutosave/);
  assert.doesNotMatch(app,/setAttribute\('stroke','#1a1a1a'\)/);
  assert.doesNotMatch(app,/state\.current=0; state\.selected=null/);
});

test('autosave failures are visible rather than silently swallowed',()=>{
  assert.match(app,/Otomatik kayıt başarısız oldu/);
  assert.doesNotMatch(app,/idbPut\(autosavePayload\(\)\)\.catch\(\(\)=>\{\}\)/);
});

test('runtime has no remote CDN or Google Font dependencies',async()=>{
  const index=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const css=await readFile(new URL('../app.css',import.meta.url),'utf8');
  assert.doesNotMatch(index,/https?:\/\//);
  assert.doesNotMatch(css,/fonts\.googleapis|fonts\.gstatic/);
  assert.doesNotMatch(app,/cdnjs\.cloudflare|cdn\.jsdelivr|unpkg\.com|fonts\.googleapis|fonts\.gstatic/);
  assert.match(index,/vendor\/jszip\.min\.js/);
  assert.match(index,/vendor\/spark-md5\.min\.js/);
  assert.match(index,/vendor\/imagetracer_v1\.2\.6\.js/);
});

test('service worker caches all runtime dependencies',async()=>{
  const sw=await readFile(new URL('../sw.js',import.meta.url),'utf8');
  for(const asset of ['index.html','app.css','app.js','roundtrip-utils.mjs','vendor/jszip.min.js','vendor/spark-md5.min.js','vendor/imagetracer_v1.2.6.js']){
    assert.ok(sw.includes(asset),asset+' missing from service-worker cache');
  }
  assert.match(app,/serviceWorker\.register\('\.\/sw\.js'\)/);
});

test('complex SVGs use deterministic raster fallback policy',()=>{
  assert.match(app,/inspectSvgCompatibility\(text\)/);
  assert.match(app,/svgPolicy\.safeDirectVector/);
  assert.match(app,/svgPolicy\.externalRefs/);
});

test('audio lifecycle closes contexts and prevents late recording blobs',()=>{
  assert.match(app,/function closeAudioContext\(ctx\)/);
  assert.match(app,/window\.addEventListener\('pagehide',disposeAudioResources\)/);
  assert.match(app,/discardOnStop/);
  assert.match(app,/URL\.revokeObjectURL\(blobUrl\)/);
});

test('unsafe SVG fallback is rejected instead of nesting SVG data URLs',()=>{
  assert.match(app,/SVG güvenli biçimde rasterize edilemedi/);
  assert.doesNotMatch(app,/wrapRasterSvg\(svgDataURL/);
});

test('pagehide audio cleanup does not trigger a sound-list rerender',()=>{
  assert.match(app,/stopCurrentSound\(false\)/);
});

test('service worker refreshes assets from network before cached fallback',async()=>{
  const sw=await readFile(new URL('../sw.js',import.meta.url),'utf8');
  assert.match(sw,/async function networkFirst\(request,fallbackRequest=request,cacheRequest=request\)/);
  assert.match(sw,/networkFirst\(event\.request,'\.\/index\.html','\.\/index\.html'\)/);
  assert.match(sw,/const response=await fetch\(request\)/);
  assert.match(sw,/caches\.match\(fallbackRequest\)/);
  assert.doesNotMatch(sw,/caches\.match\(event\.request\)[\s\S]{0,160}if\(cached\) return cached/);
});

test('SVG security policy runs before browser rendering',()=>{
  const start=app.indexOf('async function fileToAsset(file)');
  const end=app.indexOf('/* ---------- arkaplan asset dönüşümü ---------- */',start);
  const fn=app.slice(start,end);
  const inspectAt=fn.indexOf('inspectSvgCompatibility(text)');
  const loadAt=fn.indexOf('loadImage(svgDataURL)');
  assert.ok(inspectAt>=0&&loadAt>=0&&inspectAt<loadAt);
  assert.match(fn,/svgPolicy\.activeContent/);
});

test('backgrounds share the same complex-SVG fallback policy',()=>{
  const start=app.indexOf('async function fileToBackgroundAsset(file)');
  const end=app.indexOf('/* ---------- kütüphane \/ yerleştirme ---------- */',start);
  const fn=app.slice(start,end);
  assert.match(fn,/policy\.safeDirectVector/);
  assert.match(fn,/svgToPngPreview\(rawURL/);
  assert.match(fn,/policy\.activeContent/);
});

test('ImageTracer output re-enters SVG policy and normalization',()=>{
  assert.match(app,/const tracedPolicy=inspectSvgCompatibility\(traced\)/);
  assert.match(app,/normalizeSvgForChar\(traced/);
  assert.match(app,/normalizeSvgForBackground\(traced\)/);
});

test('recorder invalidates pending microphone permission requests',()=>{
  assert.match(app,/startRequestId/);
  assert.match(app,/const requestId=\+\+startRequestId/);
  assert.match(app,/requestId!==startRequestId\|\|!overlay\.classList\.contains\('show'\)/);
  assert.match(app,/requestedStream\.getTracks\(\)\.forEach\(t=>t\.stop\(\)\)/);
});

test('sound preview cancels stale async decodes',()=>{
  assert.match(app,/playbackGeneration/);
  assert.match(app,/const generation=playbackGeneration/);
  assert.match(app,/if\(generation!==playbackGeneration\) return/);
  assert.match(app,/generation===playbackGeneration&&currentPlayingId===s\.id/);
});
