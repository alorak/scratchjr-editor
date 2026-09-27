import test from 'node:test';
import assert from 'node:assert/strict';
import {audioBufferToWav,waveformPeaks,ensureAudioContext,closeAudioContext} from '../audio-utils.mjs';

function fakeBuffer(channels,sampleRate=8000){
  const data=channels.map(values=>Float32Array.from(values));
  return {
    numberOfChannels:data.length,
    sampleRate,
    length:data[0].length,
    getChannelData(i){return data[i];}
  };
}

test('WAV encoder emits a valid PCM RIFF header',()=>{
  const wav=audioBufferToWav(fakeBuffer([[0,1,-1,.5]],8000));
  const view=new DataView(wav);
  const text=(offset,len)=>Array.from({length:len},(_,i)=>String.fromCharCode(view.getUint8(offset+i))).join('');
  assert.equal(text(0,4),'RIFF');
  assert.equal(text(8,4),'WAVE');
  assert.equal(text(12,4),'fmt ');
  assert.equal(text(36,4),'data');
  assert.equal(view.getUint16(20,true),1);
  assert.equal(view.getUint16(22,true),1);
  assert.equal(view.getUint32(24,true),8000);
  assert.equal(view.getUint16(34,true),16);
  assert.equal(wav.byteLength,44+4*2);
});

test('waveform peaks sample the first channel deterministically',()=>{
  const buffer=fakeBuffer([[0,.1,.8,.2,-.9,.3,0,.4]],8000);
  const peaks=waveformPeaks(buffer,4);
  assert.equal(peaks.length,4);
  assert.deepEqual(peaks.map(v=>Number(v.toFixed(2))),[.1,.8,.9,.4]);
});

test('AudioContext helper creates reuses and closes contexts',async()=>{
  let created=0,closed=0;
  class MockContext{
    constructor(){created++;this.state='running';}
    close(){this.state='closed';closed++;return Promise.resolve();}
  }
  const win={AudioContext:MockContext};
  const first=ensureAudioContext(null,win);
  assert.equal(created,1);
  assert.equal(ensureAudioContext(first,win),first);
  await closeAudioContext(first);
  assert.equal(closed,1);
  const second=ensureAudioContext(first,win);
  assert.notEqual(second,first);
  assert.equal(created,2);
});
