import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildZipIndex,createImportReport,addImportIssue,resolveZipFile,
  safeManifestArray,safeDisplayName,assertZipSafety,readJsonEntry
} from '../sjr-archive-utils.mjs';

function fakeFile(name,size=10,content='{}'){
  return {
    name,dir:false,unsafeOriginalName:name,_data:{uncompressedSize:size},
    async:async type=>type==='string'?content:new Uint8Array(size)
  };
}
function fakeZip(entries){
  return {forEach(fn){for(const [name,file] of entries) fn(name,file);}};
}

test('ZIP index prefers exact paths and rejects ambiguous basename fallback',()=>{
  const a=fakeFile('project/characters/a.svg');
  const b=fakeFile('other/a.svg');
  const zip=fakeZip([['project/characters/a.svg',a],['other/a.svg',b]]);
  const index=buildZipIndex(zip),report=createImportReport();
  assert.equal(resolveZipFile(index,['project/characters/a.svg'],report,'A'),a);
  assert.equal(resolveZipFile(index,['missing/a.svg'],report,'A'),null);
  assert.ok(report.issues.some(x=>x.message.includes('belirsiz')));
});

test('ZIP safety rejects traversal and configured size limits',()=>{
  const traversal=fakeFile('../evil.svg');
  assert.throws(()=>assertZipSafety(fakeZip([['../evil.svg',traversal]])),/güvensiz dosya yolu/);

  const large=fakeFile('project/a.bin',101);
  assert.throws(
    ()=>assertZipSafety(fakeZip([['project/a.bin',large]]),{maxEntryBytes:100,maxTotalBytes:1000,maxEntries:5}),
    /büyük bir dosya/
  );

  const many=Array.from({length:3},(_,i)=>['project/'+i+'.txt',fakeFile('project/'+i+'.txt')]);
  assert.throws(()=>assertZipSafety(fakeZip(many),{maxEntries:2}),/çok fazla dosya/);
});

test('import report deduplicates issues and manifest values are bounded',()=>{
  const report=createImportReport();
  addImportIssue(report,'warning','same');
  addImportIssue(report,'warning','same');
  assert.equal(report.issues.length,1);
  assert.deepEqual(safeManifestArray([1,2,3],report,'sounds',2),[1,2]);
  assert.ok(report.issues.some(x=>x.message.includes('2 öğeyle')));
  assert.equal(safeDisplayName('  Hello\u0000World  ','Fallback'),'Hello World');
});

test('JSON entry reader enforces size and parse errors',async()=>{
  const good=fakeFile('data.json',12,'{"ok":true}');
  assert.deepEqual(await readJsonEntry(good,'data.json',100),{ok:true});
  const bad=fakeFile('data.json',10,'{bad');
  await assert.rejects(()=>readJsonEntry(bad,'data.json',100),/geçerli JSON değil/);
  const large=fakeFile('data.json',101,'{}');
  await assert.rejects(()=>readJsonEntry(large,'data.json',100),/metadata boyutunu aşıyor/);
});
