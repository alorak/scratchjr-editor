import test from 'node:test';
import assert from 'node:assert/strict';
import {cloneJson,hasSvgTransform,mergeSpriteMeta,mergePreservedSounds,mergeLayerOrder} from '../roundtrip-utils.mjs';

test('sprite scripts and unknown metadata survive merge',()=>{
  const original={id:'Cat 1',scripts:[[['onflag']],[[1,2]]],customField:{keep:true},speed:4};
  const merged=mergeSpriteMeta(original,{xcoor:120});
  assert.deepEqual(merged.scripts,original.scripts);
  assert.deepEqual(merged.customField,{keep:true});
  assert.equal(merged.speed,4);
  assert.equal(merged.xcoor,120);
  merged.customField.keep=false;
  assert.equal(original.customField.keep,true);
});

test('per-sprite sounds stay scoped while new sounds are appended',()=>{
  const map=x=>x==='old.wav'?'old.wav':x;
  const out=mergePreservedSounds(['pop.mp3','old.wav'],map,['new.wav'],['old.wav','new.wav']);
  assert.deepEqual(out,['pop.mp3','old.wav','new.wav']);
});

test('new sprites receive the project sound list',()=>{
  const out=mergePreservedSounds(undefined,x=>x,[],['a.wav','b.wav']);
  assert.deepEqual(out,['pop.mp3','a.wav','b.wav']);
});

test('layer order keeps existing order and appends new sprites',()=>{
  assert.deepEqual(mergeLayerOrder(['B','A','deleted'],['A','B','C']),['B','A','C']);
});

test('transform-bearing SVGs are detected for non-destructive raster fallback',()=>{
  assert.equal(hasSvgTransform('<g transform="translate(10 20)"><path d="M0 0"/></g>'),true);
  assert.equal(hasSvgTransform('<path d="M0 0L10 10"/>'),false);
});

test('cloneJson deep-clones metadata',()=>{
  const a={x:{y:1}}; const b=cloneJson(a); b.x.y=2; assert.equal(a.x.y,1);
});
