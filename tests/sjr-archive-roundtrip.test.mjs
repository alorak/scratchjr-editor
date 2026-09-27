import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {
  validateScratchJrProject,mergeSpriteMeta,mergePreservedSounds,mergeLayerOrder
} from '../roundtrip-utils.mjs';

const fixture=JSON.parse(await readFile(new URL('./fixtures/public-animal-race-shape.json',import.meta.url),'utf8'));

async function loadVendoredJSZip(){
  const source=await readFile(new URL('../vendor/jszip.min.js',import.meta.url),'utf8');
  const module={exports:{}};
  const sandbox={
    module,exports:module.exports,require:createRequire(import.meta.url),
    Buffer,Uint8Array,ArrayBuffer,Promise,setTimeout,clearTimeout,setImmediate,clearImmediate,console
  };
  sandbox.global=sandbox; sandbox.self=sandbox; sandbox.window=sandbox;
  vm.runInNewContext(source,sandbox,{filename:'vendor/jszip.min.js'});
  const JSZip=module.exports||sandbox.JSZip;
  assert.equal(typeof JSZip,'function');
  return JSZip;
}

test('real-world ScratchJr metadata survives archive and helper round trip',async()=>{
  const validation=validateScratchJrProject(fixture,4);
  assert.deepEqual(validation.errors,[]);
  assert.deepEqual(validation.pageKeys,['page 1']);

  const page=fixture.json['page 1'];
  const horse=page['Horse 1'];
  const edited=mergeSpriteMeta(horse,{xcoor:210});

  assert.deepEqual(edited.scripts,horse.scripts);
  assert.deepEqual(edited.sounds,horse.sounds);
  assert.equal(edited.homeflip,true);
  assert.equal(edited.homescale,0.3);
  assert.equal(edited.defaultScale,0.5);
  assert.equal(edited.speed,2);
  assert.equal(edited.homex,335);
  assert.equal(edited.xcoor,210);
  assert.deepEqual(mergeLayerOrder(page.layers,page.sprites),page.layers);
  assert.deepEqual(
    mergePreservedSounds(horse.sounds,x=>x,['recording.wav'],['horse.wav','recording.wav']),
    ['pop.mp3','horse.wav','recording.wav']
  );

  const JSZip=await loadVendoredJSZip();
  const zip=new JSZip(),root=zip.folder('project');
  root.file('data.json',JSON.stringify(fixture));
  root.folder('characters').file('Horse.svg','<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path fill="#8b5a2b" d="M1 1L9 1L9 9L1 9Z"/></svg>');
  root.folder('backgrounds').file('Farm.svg','<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><rect width="480" height="360" fill="#dff4cf"/></svg>');
  root.folder('sounds').file('horse.wav',Buffer.from([82,73,70,70,0,0,0,0,87,65,86,69]));

  const bytes=await zip.generateAsync({type:'nodebuffer'});
  const reopened=await JSZip.loadAsync(bytes);
  const data=JSON.parse(await reopened.file('project/data.json').async('string'));

  assert.deepEqual(data,fixture);
  assert.ok(reopened.file('project/characters/Horse.svg'));
  assert.ok(reopened.file('project/backgrounds/Farm.svg'));
  assert.ok(reopened.file('project/sounds/horse.wav'));
  assert.deepEqual(data.json['page 1']['Horse 1'].scripts,horse.scripts);
  assert.deepEqual(data.json['page 1'].layers,['Text 1','Horse 1']);
});
