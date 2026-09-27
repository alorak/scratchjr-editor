import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {createSjrTransferController} from '../sjr-import-export.mjs';

async function loadVendor(path,globalName){
  const source=await readFile(new URL(path,import.meta.url),'utf8');
  const module={exports:{}};
  const sandbox={
    module,exports:module.exports,require:createRequire(import.meta.url),
    Buffer,Uint8Array,ArrayBuffer,Promise,setTimeout,clearTimeout,setImmediate,clearImmediate,console
  };
  sandbox.global=sandbox;sandbox.self=sandbox;sandbox.window=sandbox;
  vm.runInNewContext(source,sandbox,{filename:path});
  return typeof module.exports==='function'||Object.keys(module.exports||{}).length?module.exports:sandbox[globalName];
}

const JSZip=await loadVendor('../vendor/jszip.min.js','JSZip');
const SparkMD5=await loadVendor('../vendor/spark-md5.min.js','SparkMD5');

function fakeDocument(){
  const nodes=new Map();
  const make=(id,value='')=>({id,value,textContent:'',disabled:false});
  nodes.set('pname',make('pname','Controller Test'));
  nodes.set('importBtn',make('importBtn'));
  nodes.set('exportBtn',make('exportBtn'));
  const body={appendChild(){}};
  return {
    body,
    getElementById(id){return nodes.get(id)||null;},
    createElement(tag){
      if(tag==='canvas'){
        const ctx={
          fillStyle:'',font:'',textAlign:'',textBaseline:'',
          fillRect(){},drawImage(){},save(){},restore(){},translate(){},scale(){},fillText(){}
        };
        return {
          width:0,height:0,getContext(){return ctx;},
          toBlob(cb){cb(new Blob([Uint8Array.from([137,80,78,71])]));}
        };
      }
      if(tag==='a'){
        return {href:'',download:'',clicked:false,click(){this.clicked=true;},remove(){}};
      }
      return {};
    }
  };
}

function freshState(){
  return {
    pages:[],current:0,charLib:[],bgLib:[],sounds:[],
    selected:null,selectedText:null,sjrDataMeta:null,sjrJsonMeta:null
  };
}
function newPage(){
  return {chars:[],texts:[],bg:{mode:'color',color:'#eaf4ff',asset:null,bgId:null},sjrMeta:null};
}

async function minimalSjr(){
  const zip=new JSZip(),root=zip.folder('project');
  root.file('data.json',JSON.stringify({
    id:'fixture',name:'Imported Project',version:'Webv01',
    json:{pages:['page 1'],currentPage:'page 1','page 1':{textstartat:36,sprites:[],layers:[]}}
  }));
  return zip.generateAsync({type:'nodebuffer'});
}

test('controller imports a minimal SJR and applies state only after checkpoint',async()=>{
  const state=freshState(),doc=fakeDocument(),order=[],progress=[];
  let uid=1;
  const controller=createSjrTransferController({
    document:doc,
    window:{JSZip,SparkMD5,Image:class{},DOMParser:class{}},
    JSZip,SparkMD5,state,newPage,nextId:()=> 'i'+uid++,
    checkpoint:()=>order.push('checkpoint'),
    render:()=>order.push('render'),
    setTab:name=>order.push('tab:'+name),
    showToast:()=>{},
    startOperation:()=>({update(){},close(){}}),
    showImportReport:()=>{}
  });

  const report=await controller.importProject(await minimalSjr(),(pct,label)=>progress.push([pct,label]));
  assert.equal(report.pages,1);
  assert.equal(state.pages.length,1);
  assert.equal(state.current,0);
  assert.equal(state.sjrDataMeta.id,'fixture');
  assert.equal(doc.getElementById('pname').value,'Imported Project');
  assert.deepEqual(order,['checkpoint','render','tab:chars']);
  assert.equal(progress.at(-1)[0],100);
  assert.equal(controller.isBusy(),false);
});

test('controller exports a minimal project and restores transfer buttons',async()=>{
  const state=freshState(),doc=fakeDocument(),progress=[],toasts=[],downloads=[];
  state.pages=[newPage()];
  state.sjrDataMeta={id:'fixture'};
  state.sjrJsonMeta={};

  const originalCreate=doc.createElement.bind(doc);
  doc.createElement=tag=>{
    const el=originalCreate(tag);
    if(tag==='a'){
      const originalClick=el.click.bind(el);
      el.click=()=>{originalClick();downloads.push({href:el.href,download:el.download});};
    }
    return el;
  };

  const controller=createSjrTransferController({
    document:doc,
    window:{
      JSZip,SparkMD5,
      URL:{createObjectURL:()=> 'blob:test',revokeObjectURL(){}},
      setTimeout(fn){fn();}
    },
    JSZip,SparkMD5,state,newPage,nextId:()=> 'i1',
    checkpoint(){},render(){},setTab(){},
    showToast:(msg,kind)=>toasts.push([msg,kind]),
    startOperation:()=>({
      update:(pct,label)=>progress.push([pct,label]),
      close:()=>progress.push(['closed'])
    }),
    showImportReport:()=>{}
  });

  const ok=await controller.exportProject();
  assert.equal(ok,true);
  assert.equal(downloads.length,1);
  assert.equal(downloads[0].download,'Controller Test.sjr');
  assert.equal(doc.getElementById('importBtn').disabled,false);
  assert.equal(doc.getElementById('exportBtn').disabled,false);
  assert.ok(progress.some(([pct])=>pct===100));
  assert.ok(toasts.some(([msg])=>msg.includes('.sjr indirildi')));
});

test('runImport reports results through the injected UI callback',async()=>{
  const state=freshState(),doc=fakeDocument(),reports=[];
  let uid=1;
  const controller=createSjrTransferController({
    document:doc,
    window:{JSZip,SparkMD5,Image:class{},DOMParser:class{}},
    JSZip,SparkMD5,state,newPage,nextId:()=> 'i'+uid++,
    checkpoint(){},render(){},setTab(){},showToast(){},
    startOperation:()=>({update(){},close(){}}),
    showImportReport:report=>reports.push(report)
  });
  const report=await controller.runImport(await minimalSjr());
  assert.equal(report.pages,1);
  assert.equal(reports.length,1);
  assert.equal(reports[0],report);
  assert.equal(controller.isBusy(),false);
});
