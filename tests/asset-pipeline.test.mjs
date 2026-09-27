import test from 'node:test';
import assert from 'node:assert/strict';
import {scalePathData,createAssetPipeline} from '../asset-pipeline.mjs';

test('scalePathData scales absolute and relative path coordinates',()=>{
  assert.equal(
    scalePathData('M10 20 L30 40 H50 V60 C1 2 3 4 5 6 Z',2,3),
    'M20 60L60 120H100V180C2 6 6 12 10 18Z'
  );
  assert.equal(scalePathData('m1 2 l3 4',2,2),'m2 4l6 8');
});

test('scalePathData preserves arc flags while scaling radii and endpoints',()=>{
  assert.equal(
    scalePathData('M0 0 A10 20 45 1 0 30 40',2,3),
    'M0 0A20 60 45 1 0 60 120'
  );
});

test('asset pipeline conversion settings are bounded and stable',()=>{
  const pipeline=createAssetPipeline({
    document:{},
    window:{},
    showToast(){}
  });
  assert.deepEqual(pipeline.getConversion(),{mode:'embed',colors:16});
  assert.deepEqual(pipeline.setConversion({mode:'trace',colors:24}),{mode:'trace',colors:24});
  assert.deepEqual(pipeline.setConversion({colors:999}),{mode:'trace',colors:64});
  assert.deepEqual(pipeline.setConversion({mode:'unknown',colors:1}),{mode:'trace',colors:2});
});

test('SVG security policy rejects external references before rendering',async()=>{
  const previous=globalThis.FileReader;
  class MockFileReader{
    readAsText(file){this.result=file.text;queueMicrotask(()=>this.onload?.());}
  }
  globalThis.FileReader=MockFileReader;
  try{
    const pipeline=createAssetPipeline({
      document:{},
      window:{Image:class{}},
      showToast(){}
    });
    const file={
      name:'unsafe.svg',
      type:'image/svg+xml',
      text:'<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/a.png"/></svg>'
    };
    await assert.rejects(
      ()=>pipeline.fileToAsset(file),
      /harici veya göreli kaynak içeriyor/
    );
  }finally{
    globalThis.FileReader=previous;
  }
});
