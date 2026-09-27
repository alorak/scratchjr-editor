import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const app=await readFile(new URL('../app.js',import.meta.url),'utf8');

test('critical round-trip guards remain wired',()=>{
  assert.match(app,/MAX_PAGES=4/);
  assert.match(app,/function backgroundSvg\(asset\).*asset&&asset\.vector&&asset\.svgText/);
  assert.match(app,/sjrDataMeta/);
  assert.match(app,/sjrJsonMeta/);
  assert.match(app,/restoreAutosave/);
  assert.doesNotMatch(app,/setAttribute\('stroke','#1a1a1a'\)/);
});
