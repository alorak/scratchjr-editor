export function audioContextCtor(win=globalThis.window){
  return win?.AudioContext||win?.webkitAudioContext||null;
}

export function ensureAudioContext(ctx,win=globalThis.window){
  const Ctor=audioContextCtor(win);
  if(!Ctor) throw new Error('Web Audio desteklenmiyor');
  return (!ctx||ctx.state==='closed')?new Ctor():ctx;
}

export function closeAudioContext(ctx){
  if(ctx&&ctx.state!=='closed') return ctx.close().catch(()=>{});
  return Promise.resolve();
}

export function audioBufferToWav(buf){
  const channels=buf.numberOfChannels,sampleRate=buf.sampleRate,length=buf.length;
  const ab=new ArrayBuffer(44+length*channels*2),dv=new DataView(ab);
  const write=(offset,text)=>{for(let i=0;i<text.length;i++)dv.setUint8(offset+i,text.charCodeAt(i));};
  write(0,'RIFF');dv.setUint32(4,36+length*channels*2,true);write(8,'WAVE');
  write(12,'fmt ');dv.setUint32(16,16,true);dv.setUint16(20,1,true);
  dv.setUint16(22,channels,true);dv.setUint32(24,sampleRate,true);
  dv.setUint32(28,sampleRate*channels*2,true);dv.setUint16(32,channels*2,true);dv.setUint16(34,16,true);
  write(36,'data');dv.setUint32(40,length*channels*2,true);
  let offset=44;
  for(let i=0;i<length;i++){
    for(let ch=0;ch<channels;ch++){
      const sample=Math.max(-1,Math.min(1,buf.getChannelData(ch)[i]));
      dv.setInt16(offset,sample<0?sample*0x8000:sample*0x7fff,true);
      offset+=2;
    }
  }
  return ab;
}

export function waveformPeaks(audioBuffer,count=300){
  const data=audioBuffer.getChannelData(0);
  const block=Math.max(1,Math.floor(data.length/count));
  const peaks=[];
  for(let i=0;i<count;i++){
    let peak=0;
    const start=i*block,end=Math.min(data.length,start+block);
    for(let j=start;j<end;j++) peak=Math.max(peak,Math.abs(data[j]||0));
    peaks.push(peak);
  }
  return peaks;
}
