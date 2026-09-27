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
  assert.match(app,/assertZipSafety\(zip,\{maxEntries:MAX_ZIP_ENTRIES,maxEntryBytes:MAX_ZIP_ENTRY,maxTotalBytes:MAX_ZIP_UNCOMPRESSED\}\)/);
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
  for(const asset of ['index.html','app.css','app.js','roundtrip-utils.mjs','ui-utils.mjs','file-utils.mjs','vendor/jszip.min.js','vendor/spark-md5.min.js','vendor/imagetracer_v1.2.6.js']){
    assert.ok(sw.includes(asset),asset+' missing from service-worker cache');
  }
  assert.match(app,/serviceWorker\.register\('\.\/sw\.js'\)/);
});

test('complex SVGs use deterministic raster fallback policy',()=>{
  assert.match(app,/inspectSvgCompatibility\(text\)/);
  assert.match(app,/svgPolicy\.safeDirectVector/);
  assert.match(app,/svgPolicy\.externalRefs/);
});

test('audio lifecycle closes contexts and prevents late recording blobs',async()=>{
  const audio=await readFile(new URL('../audio-utils.mjs',import.meta.url),'utf8');
  const recorder=await readFile(new URL('../audio-recorder.mjs',import.meta.url),'utf8');
  assert.match(audio,/export function closeAudioContext\(ctx\)/);
  assert.match(app,/window\.addEventListener\('pagehide',disposeAudioResources\)/);
  assert.match(app,/audioRecorderController\.dispose\(\)/);
  assert.match(recorder,/discardOnStop/);
  assert.match(recorder,/revokeObjectURL\(blobUrl\)/);
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

test('recorder invalidates pending microphone permission requests',async()=>{
  const recorder=await readFile(new URL('../audio-recorder.mjs',import.meta.url),'utf8');
  assert.match(recorder,/startRequestId/);
  assert.match(recorder,/const requestId=\+\+startRequestId/);
  assert.match(recorder,/requestId!==startRequestId\|\|!overlay\.classList\.contains\('show'\)/);
  assert.match(recorder,/requestedStream\.getTracks\(\)\.forEach\(track=>track\.stop\(\)\)/);
});

test('sound preview cancels stale async decodes',()=>{
  assert.match(app,/playbackGeneration/);
  assert.match(app,/const generation=playbackGeneration/);
  assert.match(app,/if\(generation!==playbackGeneration\) return/);
  assert.match(app,/generation===playbackGeneration&&currentPlayingId===s\.id/);
});

test('import resolver avoids ambiguous basename fallback and unsafe paths',async()=>{
  const archive=await readFile(new URL('../sjr-archive-utils.mjs',import.meta.url),'utf8');
  assert.match(archive,/export function buildZipIndex\(zip\)/);
  assert.match(archive,/export function resolveZipFile\(index,candidates,report,label\)/);
  assert.match(archive,/matches\.length>1/);
  assert.match(archive,/belirsiz olduğu için atlandı/);
  assert.match(archive,/normalizeArchivePath\(original\)/);
  assert.doesNotMatch(app,/function buildZipIndex\(zip\)/);
});

test('import validates project metadata before replacing state',()=>{
  const validateAt=app.indexOf('validateScratchJrProject(data,MAX_PAGES)');
  const assignAt=app.indexOf('Object.assign(state,ns)');
  assert.ok(validateAt>=0&&assignAt>validateAt);
  assert.match(app,/readJsonEntry\(dataFile,'data\.json'\)/);
  assert.match(app,/MAX_METADATA_BYTES=2\*MB/);
  assert.match(app,/checkpoint\(\);\s*Object\.assign\(state,ns\)/);
});

test('import produces a user-visible validation report',async()=>{
  const index=await readFile(new URL('../index.html',import.meta.url),'utf8');
  assert.match(index,/id="importReportOverlay"/);
  assert.match(index,/id="importReportSummary"/);
  assert.match(index,/id="importReportIssues"/);
  assert.match(app,/function showImportReport\(report\)/);
  assert.match(app,/const report=await importSRJ\(file,op\.update\)/);
  assert.match(app,/showImportReport\(report\)/);
});

test('manifest and sound maps avoid prototype-key object maps',()=>{
  assert.match(app,/const sndNameByFile=new Map\(\)/);
  assert.match(app,/Object\.prototype\.hasOwnProperty\.call\(po,spId\)/);
  assert.match(app,/soundGroups=new Map\(\)/);
});

test('confirmation modal sanitizes its limited HTML surface',()=>{
  assert.match(app,/function setSafeModalHtml\(target,html\)/);
  assert.match(app,/allowedTags=new Set\(\['B','SPAN','DIV'\]\)/);
  assert.match(app,/if\(a\.name!=='class'\)el\.removeAttribute\(a\.name\)/);
  assert.doesNotMatch(app,/document\.getElementById\('confirmBody'\)\.innerHTML=/);
});

test('CSP keeps runtime resources same-origin',async()=>{
  const index=await readFile(new URL('../index.html',import.meta.url),'utf8');
  assert.match(index,/Content-Security-Policy/);
  assert.match(index,/script-src 'self'/);
  assert.match(index,/connect-src 'self'/);
  assert.match(index,/object-src 'none'/);
});

test('minimal CI runs syntax checks and node tests',async()=>{
  const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  const workflow=await readFile(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');
  assert.equal(pkg.scripts.ci,'npm run check && npm test');
  assert.match(pkg.scripts.check,/node --check app\.js/);
  assert.match(workflow,/actions\/checkout@v4/);
  assert.match(workflow,/actions\/setup-node@v4/);
  assert.match(workflow,/npm run ci/);
});

test('page thumbnails are cached and high-frequency updates are debounced',async()=>{
  const index=await readFile(new URL('../index.html',import.meta.url),'utf8');
  assert.match(app,/const pageThumbCache=new WeakMap\(\)/);
  assert.match(app,/function pageThumbSignature\(page\)/);
  assert.match(app,/function getPageThumb\(page,w,h\)/);
  assert.match(app,/function scheduleRenderPages\(delay=80\)/);
  assert.match(app,/img\.src=getPageThumb\(p,92,69\)/);
  assert.match(app,/scheduleRenderPages\(0\)/);
  assert.match(index,/id="autosaveStatus"/);
  assert.match(index,/id="autosaveStatusText"/);
});

test('stage navigation avoids rebuilding every library',()=>{
  assert.match(app,/function renderWorkspace\(opts=\{\}\)/);
  assert.match(app,/if\(name==='stage'\)\{ renderWorkspace\(\); \}/);
  assert.doesNotMatch(app,/if\(name==='stage'\)\{ render\(\); \}/);
});

test('autosave status reflects saving saved and error states',()=>{
  assert.match(app,/setAutosaveStatus\('saving','Değişiklik var'\)/);
  assert.match(app,/setAutosaveStatus\('saving','Kaydediliyor…'\)/);
  assert.match(app,/setAutosaveStatus\('saved',savedTimeLabel\(\)\)/);
  assert.match(app,/setAutosaveStatus\('error','Kayıt başarısız'\)/);
  assert.match(app,/render\(\{autosave:false\}\)/);
});

test('technical cleanup removes deprecated base64 and dead path merge code',()=>{
  assert.match(app,/new TextEncoder\(\)\.encode/);
  assert.doesNotMatch(app,/unescape\(encodeURIComponent/);
  assert.doesNotMatch(app,/function mergePathsByColor/);
  assert.doesNotMatch(app,/Aynı renk path'ler compound path/);
});

test('export thumbnail rejects null canvas blobs',()=>{
  assert.match(app,/if\(!blob\) return rej\(new Error\('Thumbnail PNG oluşturulamadı'\)\)/);
  assert.doesNotMatch(app,/toBlob\(b=>b\.arrayBuffer\(\)\.then\(res\)/);
});

test('real-world SJR archive test is part of npm test discovery',async()=>{
  const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  const archiveTest=await readFile(new URL('./sjr-archive-roundtrip.test.mjs',import.meta.url),'utf8');
  assert.equal(pkg.scripts.test,'node --test tests/*.test.mjs');
  assert.match(archiveTest,/public-animal-race-shape\.json/);
  assert.match(archiveTest,/project\/data\.json/);
  assert.match(archiveTest,/project\/characters\/Horse\.svg/);
  assert.match(archiveTest,/project\/backgrounds\/Farm\.svg/);
  assert.match(archiveTest,/project\/sounds\/horse\.wav/);
});

test('autosave generations prevent stale status updates',()=>{
  assert.match(app,/autosaveGeneration=0/);
  assert.match(app,/const generation=\+\+autosaveGeneration/);
  assert.match(app,/if\(generation!==autosaveGeneration\) return/);
});

test('manual page renders cancel queued thumbnail work',()=>{
  assert.match(app,/function renderPages\(\)\{\s*if\(renderPagesTimer\)\{clearTimeout\(renderPagesTimer\);renderPagesTimer=null;\}/);
});


test('import and export expose staged operation progress',async()=>{
  const index=await readFile(new URL('../index.html',import.meta.url),'utf8');
  assert.match(index,/id="operationProgress"/);
  assert.match(index,/id="operationProgressBar"/);
  assert.match(index,/id="operationProgressLabel"/);
  const ui=await readFile(new URL('../ui-utils.mjs',import.meta.url),'utf8');
  assert.match(ui,/export function startOperation\(title,doc=document\)/);
  assert.match(app,/startOperation\('Dışa aktarılıyor'\)/);
  assert.match(app,/startOperation\('İçe aktarılıyor'\)/);
  assert.match(app,/async function importSRJ\(file,progress=\(\)=>\{\}\)/);
  assert.match(app,/Arşiv açılıyor…/);
  assert.match(app,/Sayfa '\+\(i\+1\)\+' \/ '\+pages\.length\+' hazırlandı/);
  assert.match(app,/zip\.generateAsync\(\{type:'blob',compression:'DEFLATE'\},meta=>/);
});

test('tabs use roving keyboard navigation and tabpanel semantics',async()=>{
  const index=await readFile(new URL('../index.html',import.meta.url),'utf8');
  assert.match(index,/id="tab-chars"[^>]*aria-controls="panel-chars"[^>]*tabindex="0"/);
  assert.match(index,/id="tab-bg"[^>]*tabindex="-1"/);
  assert.match(index,/id="panel-stage" role="tabpanel" aria-labelledby="tab-stage"/);
  assert.match(app,/\['ArrowRight','ArrowLeft','Home','End'\]/);
  assert.match(app,/t\.tabIndex=active\?0:-1/);
  assert.match(app,/p\.hidden=!active/);
});

test('dialogs share focus trap escape handling and focus restoration',async()=>{
  const ui=await readFile(new URL('../ui-utils.mjs',import.meta.url),'utf8');
  assert.match(ui,/const dialogState=new WeakMap\(\),dialogStack=\[\]/);
  assert.match(ui,/function showDialog\(overlay,initialFocus,onEscape\)/);
  assert.match(ui,/function hideDialog\(overlay,restoreFocus=true\)/);
  assert.match(ui,/if\(e\.key!=='Tab'\) return/);
  assert.match(ui,/stateForDialog\?\.opener\?\.isConnected/);
  assert.match(app,/showDialog\(overlay,recBtn,closeModal\)/);
  assert.match(app,/showDialog\(ov,document\.getElementById\('importReportClose'\),closeImportReport\)/);
  assert.match(app,/showDialog\(ov,okBtn,\(\)=>close\(false\)\)/);
  assert.doesNotMatch(app,/document\.addEventListener\('keydown',e=>\{if\(e\.key==='Escape'&&overlay\.classList\.contains\('show'\)\)/);
});

test('page pickers restore focus even after page controls rerender',()=>{
  assert.match(app,/bgBtn\.dataset\.pageBg=String\(i\)/);
  assert.match(app,/charBtn\.dataset\.pageChar=String\(i\)/);
  assert.match(app,/querySelector\('\[data-page-bg="'\+target\+'"\]'\)\?\.focus\(\)/);
  assert.match(app,/querySelector\('\[data-page-char="'\+target\+'"\]'\)\?\.focus\(\)/);
});

test('mobile tablet layout exposes horizontal pages and coarse touch targets',async()=>{
  const css=await readFile(new URL('../app.css',import.meta.url),'utf8');
  assert.match(css,/@media \(max-width:720px\)/);
  assert.match(css,/\.pages-panel\{display:flex;flex-direction:row/);
  assert.match(css,/scroll-snap-type:x proximity/);
  assert.match(css,/\.sidebar-col\{order:3;width:100%;flex-direction:column/);
  assert.match(css,/\.srec-trim-handle\{width:26px\}/);
  assert.match(css,/@media \(pointer:coarse\)/);
  assert.match(css,/\.page-del\{width:30px;height:30px/);
});


test('transfer operations are mutually exclusive and progress announcements stay quiet',async()=>{
  const index=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const ui=await readFile(new URL('../ui-utils.mjs',import.meta.url),'utf8');
  assert.match(app,/let transferBusy=false/);
  assert.match(app,/function setTransferBusy\(busy\)/);
  assert.match(app,/if\(transferBusy\) return showToast\('Başka bir içe\/dışa aktarma işlemi sürüyor'\)/);
  assert.match(app,/setTransferBusy\(true\)/);
  assert.match(app,/setTransferBusy\(false\)/);
  assert.doesNotMatch(index,/id="operationProgress" role="status"/);
  assert.match(index,/id="operationProgressLabel" role="status" aria-live="polite"/);
  assert.match(ui,/if\(label\.textContent!==nextText\) label\.textContent=nextText/);
  assert.match(app,/op\.update\(pct,'Arşiv sıkıştırılıyor…'\)/);
});


test('app imports extracted utility modules and service worker caches them',async()=>{
  const ui=await readFile(new URL('../ui-utils.mjs',import.meta.url),'utf8');
  const file=await readFile(new URL('../file-utils.mjs',import.meta.url),'utf8');
  const sw=await readFile(new URL('../sw.js',import.meta.url),'utf8');
  assert.match(app,/from '\.\/ui-utils\.mjs'/);
  assert.match(app,/from '\.\/file-utils\.mjs'/);
  assert.match(app,/createDialogManager\(document\)/);
  assert.doesNotMatch(app,/function showDialog\(overlay,initialFocus,onEscape\)/);
  assert.doesNotMatch(app,/function b64\(value\)/);
  assert.match(ui,/export function createDialogManager/);
  assert.match(file,/export function b64/);
  assert.match(file,/export function colorToHex/);
  assert.match(sw,/\.\/ui-utils\.mjs/);
  assert.match(sw,/\.\/file-utils\.mjs/);
});


test('audio recorder and SJR archive helpers are extracted and cached offline',async()=>{
  const recorder=await readFile(new URL('../audio-recorder.mjs',import.meta.url),'utf8');
  const audio=await readFile(new URL('../audio-utils.mjs',import.meta.url),'utf8');
  const archive=await readFile(new URL('../sjr-archive-utils.mjs',import.meta.url),'utf8');
  const sw=await readFile(new URL('../sw.js',import.meta.url),'utf8');
  assert.match(app,/from '\.\/audio-recorder\.mjs'/);
  assert.match(app,/from '\.\/audio-utils\.mjs'/);
  assert.match(app,/from '\.\/sjr-archive-utils\.mjs'/);
  assert.match(app,/createAudioRecorder\(\{/);
  assert.doesNotMatch(app,/\/\* ---- SES KAYIT MODALI ---- \*\/\s*\(function\(\)/);
  assert.match(recorder,/export function createAudioRecorder/);
  assert.match(audio,/export function audioBufferToWav/);
  assert.match(archive,/export function assertZipSafety/);
  for(const asset of ['audio-utils.mjs','audio-recorder.mjs','sjr-archive-utils.mjs']) assert.ok(sw.includes(asset),asset+' missing from service worker cache');
});
