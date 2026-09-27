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
