import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const app=await readFile(new URL('../app.js',import.meta.url),'utf8');
const transfer=await readFile(new URL('../sjr-import-export.mjs',import.meta.url),'utf8');
const stage=await readFile(new URL('../stage-controller.mjs',import.meta.url),'utf8');

test('critical round-trip guards remain wired',()=>{
  assert.match(app,/MAX_PAGES=4/);
  assert.match(transfer,/selectBackgroundSvg\(asset,coverSvg\)/);
  assert.match(app,/function fileToBackgroundAsset\(file\)/);
  assert.match(app,/const a=await fileToBackgroundAsset\(f\)/);
  assert.match(app,/preserveSvg:true/);
  assert.match(transfer,/characters:charManifest/);
  assert.match(transfer,/resolveCurrentPageIndex\(J\.currentPage,pageKeys\)/);
  assert.match(transfer,/dataMetaWithoutJson\(data\)/);
  assert.match(transfer,/jsonMetaWithoutPages\(J,pageKeys\)/);
  assert.match(transfer,/pageMetaWithoutSprites\(sourcePage\)/);
  assert.match(app,/escapeHtml\(c\.name\|\|'Karakter'\)/);
  assert.match(transfer,/assertFileSize\(file,MAX_SJR_BYTES/);
  assert.match(transfer,/assertZipSafety\(zip,ZIP_LIMITS\)/);
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

test('import validates project metadata before replacing state',async()=>{
  const validateAt=transfer.indexOf('validateScratchJrProject(data,MAX_PAGES)');
  const assignAt=transfer.indexOf('Object.assign(state,ns)');
  assert.ok(validateAt>=0&&assignAt>validateAt);
  assert.match(transfer,/readJsonEntry\(dataEntry\.file,'data\.json'\)/);
  const archive=await readFile(new URL('../sjr-archive-utils.mjs',import.meta.url),'utf8');
  assert.match(archive,/readJsonEntry\(entry,label,maxBytes=2\*1024\*1024\)/);
  assert.match(transfer,/checkpoint\(\);\s*Object\.assign\(state,ns\)/);
});

test('import produces a user-visible validation report',async()=>{
  const index=await readFile(new URL('../index.html',import.meta.url),'utf8');
  assert.match(index,/id="importReportOverlay"/);
  assert.match(index,/id="importReportSummary"/);
  assert.match(index,/id="importReportIssues"/);
  assert.match(app,/function showImportReport\(report\)/);
  assert.match(transfer,/const report=await importProject\(file,op\.update\)/);
  assert.match(transfer,/showImportReport\(report\)/);
  assert.match(app,/await sjrTransfer\.runImport\(file\)/);
});

test('manifest and sound maps avoid prototype-key object maps',()=>{
  assert.match(transfer,/const soundNames=new Map\(\)/);
  assert.match(transfer,/Object\.prototype\.hasOwnProperty\.call\(sourcePage,spId\)/);
  assert.match(transfer,/soundGroups=new Map\(\)/);
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
  assert.match(stage,/const pageThumbCache=new WeakMap\(\)/);
  assert.match(stage,/function pageThumbSignature\(page\)/);
  assert.match(stage,/function getPageThumb\(page,w,h\)/);
  assert.match(stage,/function scheduleRenderPages\(delay=80\)/);
  assert.match(stage,/img\.src=getPageThumb\(page,92,69\)/);
  assert.match(stage,/scheduleRenderPages\(0\)/);
  assert.match(index,/id="autosaveStatus"/);
  assert.match(index,/id="autosaveStatusText"/);
});

test('stage navigation avoids rebuilding every library',()=>{
  assert.match(stage,/function renderWorkspace\(opts=\{\}\)/);
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
  assert.match(transfer,/if\(!blob\)return reject\(new Error\('Thumbnail PNG oluşturulamadı'\)\)/);
  assert.doesNotMatch(transfer,/toBlob\(b=>b\.arrayBuffer\(\)\.then\(res\)/);
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
  assert.match(stage,/function renderPages\(\)\{\s*if\(renderPagesTimer\)\{win\.clearTimeout\(renderPagesTimer\);renderPagesTimer=null;\}/);
});


test('import and export expose staged operation progress',async()=>{
  const index=await readFile(new URL('../index.html',import.meta.url),'utf8');
  assert.match(index,/id="operationProgress"/);
  assert.match(index,/id="operationProgressBar"/);
  assert.match(index,/id="operationProgressLabel"/);
  const ui=await readFile(new URL('../ui-utils.mjs',import.meta.url),'utf8');
  assert.match(ui,/export function startOperation\(title,doc=document\)/);
  assert.match(transfer,/startOperation\('Dışa aktarılıyor'\)/);
  assert.match(transfer,/startOperation\('İçe aktarılıyor'\)/);
  assert.match(transfer,/async function importProject\(file,progress=\(\)=>\{\}\)/);
  assert.match(transfer,/Arşiv açılıyor…/);
  assert.match(transfer,/Sayfa '\+\(i\+1\)\+' \/ '\+pages\.length\+' hazırlandı/);
  assert.match(transfer,/zip\.generateAsync\(\{type:zipOutputType,compression:'DEFLATE'\},meta=>/);
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
  const recorder=await readFile(new URL('../audio-recorder.mjs',import.meta.url),'utf8');
  assert.match(ui,/const dialogState=new WeakMap\(\),dialogStack=\[\]/);
  assert.match(ui,/function showDialog\(overlay,initialFocus,onEscape\)/);
  assert.match(ui,/function hideDialog\(overlay,restoreFocus=true\)/);
  assert.match(ui,/if\(e\.key!=='Tab'\) return/);
  assert.match(ui,/stateForDialog\?\.opener\?\.isConnected/);
  assert.match(recorder,/showDialog\(overlay,recBtn,close\)/);
  assert.match(app,/showDialog\(ov,document\.getElementById\('importReportClose'\),closeImportReport\)/);
  assert.match(app,/showDialog\(ov,okBtn,\(\)=>close\(false\)\)/);
  assert.doesNotMatch(app,/document\.addEventListener\('keydown',e=>\{if\(e\.key==='Escape'&&overlay\.classList\.contains\('show'\)\)/);
});

test('page pickers restore focus even after page controls rerender',()=>{
  assert.match(app,/bgBtn\.dataset\.pageBg=String\(i\)/);
  assert.match(app,/charBtn\.dataset\.pageChar=String\(i\)/);
  assert.match(stage,/querySelector\('\[data-page-bg="'\+target\+'"\]'\)\?\.focus\(\)/);
  assert.match(stage,/querySelector\('\[data-page-char="'\+target\+'"\]'\)\?\.focus\(\)/);
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
  assert.match(transfer,/let transferBusy=false/);
  assert.match(transfer,/function setTransferBusy\(busy\)/);
  assert.match(transfer,/if\(transferBusy\)\{showToast\('Başka bir içe\/dışa aktarma işlemi sürüyor'\)/);
  assert.match(transfer,/setTransferBusy\(true\)/);
  assert.match(transfer,/setTransferBusy\(false\)/);
  assert.doesNotMatch(index,/id="operationProgress" role="status"/);
  assert.match(index,/id="operationProgressLabel" role="status" aria-live="polite"/);
  assert.match(ui,/if\(label\.textContent!==nextText\) label\.textContent=nextText/);
  assert.match(transfer,/op\.update\(pct,'Arşiv sıkıştırılıyor…'\)/);
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
  assert.match(transfer,/from '\.\/sjr-archive-utils\.mjs'/);
  assert.match(app,/createAudioRecorder\(\{/);
  assert.doesNotMatch(app,/\/\* ---- SES KAYIT MODALI ---- \*\/\s*\(function\(\)/);
  assert.match(recorder,/export function createAudioRecorder/);
  assert.match(audio,/export function audioBufferToWav/);
  assert.match(archive,/export function assertZipSafety/);
  for(const asset of ['audio-utils.mjs','audio-recorder.mjs','sjr-archive-utils.mjs']) assert.ok(sw.includes(asset),asset+' missing from service worker cache');
});


test('SJR transfer controller owns orchestration while app keeps thin UI wiring',async()=>{
  assert.match(app,/from '\.\/sjr-import-export\.mjs'/);
  assert.match(app,/createSjrTransferController\(\{/);
  assert.match(app,/sjrTransfer\.exportProject\(\)/);
  assert.match(app,/sjrTransfer\.runImport\(file\)/);
  assert.doesNotMatch(app,/async function exportProject/);
  assert.doesNotMatch(app,/async function importProject/);
  assert.match(transfer,/export function createSjrTransferController/);
  assert.match(transfer,/async function exportProject\(pagesArg\)/);
  assert.match(transfer,/async function importProject\(file,progress=\(\)=>\{\}\)/);
  const sw=await readFile(new URL('../sw.js',import.meta.url),'utf8');
  assert.ok(sw.includes('sjr-import-export.mjs'),'SJR transfer controller missing from service-worker cache');
});


test('stage controller owns page rendering interactions and pickers',async()=>{
  const sw=await readFile(new URL('../sw.js',import.meta.url),'utf8');
  assert.match(app,/from '\.\/stage-controller\.mjs'/);
  assert.match(app,/createStageController\(\{/);
  assert.match(app,/stageController\.bind\(\)/);
  assert.doesNotMatch(app,/function renderStage\(\)/);
  assert.doesNotMatch(app,/function renderPages\(\)/);
  assert.match(stage,/export function createStageController/);
  assert.match(stage,/function renderStage\(\)/);
  assert.match(stage,/function renderPages\(\)/);
  assert.match(stage,/function renderTextPanel\(\)/);
  assert.match(stage,/function openBgPick\(pageIndex\)/);
  assert.match(stage,/function openCharPick\(pageIndex\)/);
  assert.ok(sw.includes('stage-controller.mjs'),'stage controller missing from service-worker cache');
});
