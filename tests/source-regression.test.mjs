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
