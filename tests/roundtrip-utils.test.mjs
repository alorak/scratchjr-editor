import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  cloneJson,hasSvgTransform,hasSvgRootPresentation,inspectSvgCompatibility,normalizeArchivePath,validateScratchJrProject,
  dataMetaWithoutJson,jsonMetaWithoutPages,pageMetaWithoutSprites,
  resolveCurrentPageIndex,selectBackgroundSvg,
  mergeSpriteMeta,mergePreservedSounds,mergeLayerOrder
} from '../roundtrip-utils.mjs';

const fixture=JSON.parse(await readFile(new URL('./fixtures/roundtrip-project.json',import.meta.url),'utf8'));

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

test('transform and inherited root presentation trigger safe handling',()=>{
  assert.equal(hasSvgTransform('<g transform="translate(10 20)"><path d="M0 0"/></g>'),true);
  assert.equal(hasSvgTransform('<path d="M0 0L10 10"/>'),false);
  assert.equal(hasSvgRootPresentation('<svg fill="#f00"><path d="M0 0"/></svg>'),true);
  assert.equal(hasSvgRootPresentation('<svg viewBox="0 0 10 10"><path fill="#f00" d="M0 0"/></svg>'),false);
});

test('imported raster background preserves its original ScratchJr SVG',()=>{
  const original='<svg width="480" height="360"><image href="data:image/png;base64,AA=="/></svg>';
  const asset={vector:false,preserveSvg:true,svgText:original,dataURL:'data:image/svg+xml;base64,xyz'};
  assert.equal(selectBackgroundSvg(asset,()=>'<svg>WRAPPED</svg>'),original);
});

test('new raster background still uses the stage cover wrapper',()=>{
  const asset={vector:false,preserveSvg:false,svgText:'<svg><image/></svg>'};
  assert.equal(selectBackgroundSvg(asset,()=>'<svg>WRAPPED</svg>'),'<svg>WRAPPED</svg>');
});

test('fixture metadata is normalized without losing unknown fields',()=>{
  const dataMeta=dataMetaWithoutJson(fixture);
  assert.equal(dataMeta.customDataField.keep,true);
  assert.equal('json' in dataMeta,false);

  const keys=fixture.json.pages;
  const jsonMeta=jsonMetaWithoutPages(fixture.json,keys);
  assert.equal(jsonMeta.customProjectField,'keep-me');
  assert.equal('pages' in jsonMeta,false);
  assert.equal('currentPage' in jsonMeta,false);
  assert.equal('page 1' in jsonMeta,false);

  const pageMeta=pageMetaWithoutSprites(fixture.json['page 1']);
  assert.equal(pageMeta.customPageField,42);
  assert.deepEqual(pageMeta.layers,['Text 1','Cat 1']);
  assert.equal('sprites' in pageMeta,false);
  assert.equal('Cat 1' in pageMeta,false);
  assert.equal('Text 1' in pageMeta,false);
});

test('fixture current page survives import mapping',()=>{
  assert.equal(resolveCurrentPageIndex(fixture.json.currentPage,fixture.json.pages),2);
  assert.equal(resolveCurrentPageIndex('missing',fixture.json.pages),0);
});

test('fixture sprite behavior survives metadata merge',()=>{
  const source=fixture.json['page 1']['Cat 1'];
  const out=mergeSpriteMeta(source,{xcoor:222});
  assert.deepEqual(out.scripts,source.scripts);
  assert.deepEqual(out.sounds,source.sounds);
  assert.equal(out.customSpriteField,'keep');
});

test('cloneJson deep-clones metadata',()=>{
  const a={x:{y:1}}; const b=cloneJson(a); b.x.y=2; assert.equal(a.x.y,1);
});

test('SVG policy routes arcs and complex geometry to fallback',()=>{
  const arc=inspectSvgCompatibility('<svg viewBox="0 0 10 10"><path d="M1 1 A 4 4 0 0 1 8 8"/></svg>');
  assert.equal(arc.arcPaths,1);
  assert.equal(arc.safeDirectVector,false);
  assert.ok(arc.fallbackReasons.includes('arc-command'));

  const rect=inspectSvgCompatibility('<svg viewBox="0 0 10 10"><rect x="1" y="1" width="8" height="8"/></svg>');
  assert.equal(rect.unsupportedTags.rect,1);
  assert.equal(rect.safeDirectVector,false);
  assert.ok(rect.fallbackReasons.includes('unsupported-elements'));
});

test('SVG policy catches root styles, non-zero viewBox origin and external refs',()=>{
  const root=inspectSvgCompatibility('<svg fill="#f00" viewBox="5 5 10 10"><path d="M5 5L6 6"/></svg>');
  assert.equal(root.rootPresentation,true);
  assert.equal(root.viewBoxOriginNonZero,true);
  assert.equal(root.safeDirectVector,false);

  const external=inspectSvgCompatibility('<svg viewBox="0 0 10 10"><image href="https://example.com/a.png"/></svg>');
  assert.equal(external.externalRefs,true);
  assert.equal(external.safeDirectVector,false);
});

test('simple path-only SVG remains eligible for direct vector normalization',()=>{
  const info=inspectSvgCompatibility('<svg viewBox="0 0 10 10"><path fill="#f00" d="M0 0L10 0L10 10Z"/></svg>');
  assert.equal(info.safeDirectVector,true);
  assert.deepEqual(info.fallbackReasons,[]);
});

test('relative and CSS SVG references are rejected for offline safety',()=>{
  const relative=inspectSvgCompatibility('<svg><image href="images/a.png"/></svg>');
  assert.equal(relative.externalRefs,true);
  assert.ok(relative.unsafeReferences.includes('images/a.png'));

  const rootRelative=inspectSvgCompatibility('<svg><image href="/assets/a.png"/></svg>');
  assert.equal(rootRelative.externalRefs,true);

  const cssUrl=inspectSvgCompatibility('<svg><style>.x{fill:url(https://example.com/p.svg)}</style><path class="x" d="M0 0"/></svg>');
  assert.equal(cssUrl.externalRefs,true);
  assert.ok(cssUrl.fallbackReasons.includes('style-element'));

  const imported=inspectSvgCompatibility('<svg><style>@import "theme.css";</style><path d="M0 0"/></svg>');
  assert.equal(imported.externalRefs,true);
  assert.ok(imported.unsafeReferences.includes('@import'));
});

test('data and local-fragment SVG references remain offline-safe',()=>{
  const data=inspectSvgCompatibility('<svg><image href="data:image/png;base64,AA=="/></svg>');
  assert.equal(data.externalRefs,false);
  const fragment=inspectSvgCompatibility('<svg><defs><linearGradient id="g"/></defs><path fill="url(#g)" d="M0 0"/></svg>');
  assert.equal(fragment.externalRefs,false);
});

test('style elements and scripts cannot enter direct-vector path',()=>{
  const style=inspectSvgCompatibility('<svg viewBox="0 0 10 10"><style>.x{fill:red}</style><path class="x" d="M0 0"/></svg>');
  assert.equal(style.styleElementCount,1);
  assert.equal(style.safeDirectVector,false);
  assert.ok(style.fallbackReasons.includes('style-element'));

  const script=inspectSvgCompatibility('<svg viewBox="0 0 10 10"><script>alert(1)</script><path d="M0 0"/></svg>');
  assert.equal(script.activeContent,true);
  assert.equal(script.safeDirectVector,false);
  assert.ok(script.fallbackReasons.includes('active-content'));
});

test('archive paths reject traversal and absolute paths',()=>{
  assert.equal(normalizeArchivePath('project/characters/a.svg'),'project/characters/a.svg');
  assert.equal(normalizeArchivePath('./project//characters/a.svg'),'project/characters/a.svg');
  assert.equal(normalizeArchivePath('../evil.svg'),null);
  assert.equal(normalizeArchivePath('project/../../evil.svg'),null);
  assert.equal(normalizeArchivePath('/absolute/a.svg'),null);
  assert.equal(normalizeArchivePath('C:\\temp\\a.svg'),null);
  assert.equal(normalizeArchivePath(''),null);
});

test('ScratchJr project validation rejects malformed page metadata',()=>{
  const bad=validateScratchJrProject({json:{pages:'page 1'}},4);
  assert.ok(bad.errors.some(x=>x.includes('pages')));

  const duplicate=validateScratchJrProject({json:{pages:['page 1','page 1'],'page 1':{sprites:[]}}},4);
  assert.ok(duplicate.errors.some(x=>x.includes('yinelenen')));

  const tooMany=validateScratchJrProject({json:{pages:['a','b','c','d','e'],a:{},b:{},c:{},d:{},e:{}}},4);
  assert.ok(tooMany.errors.some(x=>x.includes('en fazla 4')));
});

test('ScratchJr project validation reports recoverable missing sprites',()=>{
  const result=validateScratchJrProject({json:{pages:['page 1'],'page 1':{sprites:['Missing 1']}}},4);
  assert.deepEqual(result.errors,[]);
  assert.ok(result.warnings.some(x=>x.includes('Missing 1')));
  assert.deepEqual(result.pageKeys,['page 1']);
});
