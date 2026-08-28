let ffmpegPromise;

async function loadFFmpeg(onProgress){
  if(ffmpegPromise)return ffmpegPromise;
  ffmpegPromise=(async()=>{
    onProgress('loading ffmpeg.wasm');
    const {FFmpeg}=await import('https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js');
    const {toBlobURL}=await import('https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js');
    const ffmpeg=new FFmpeg();
    const base='https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
    await ffmpeg.load({
      coreURL:await toBlobURL(`${base}/ffmpeg-core.js`,'text/javascript'),
      wasmURL:await toBlobURL(`${base}/ffmpeg-core.wasm`,'application/wasm')
    });
    return ffmpeg;
  })().catch(e=>{ffmpegPromise=null;throw e});
  return ffmpegPromise;
}

export async function processAudio(blob,{onProgress=()=>{}}={}){
  if(!blob||blob.size<1024)throw Error('Invalid audio payload');
  const type=(blob.type||'').toLowerCase();
  if(type==='audio/flac'||type==='audio/x-flac'){
    onProgress('validating FLAC');
    return new Blob([blob],{type:'audio/flac'});
  }
  onProgress('initializing transcoder');
  const ffmpeg=await loadFFmpeg(onProgress);
  const ext=type.includes('webm')?'webm':type.includes('ogg')?'ogg':type.includes('mpeg')?'mp3':type.includes('mp4')?'m4a':'input';
  const input=`input.${ext}`,output='output.flac';
  try{
    onProgress('loading audio into WASM');
    await ffmpeg.writeFile(input,new Uint8Array(await blob.arrayBuffer()));
    ffmpeg.on('progress',({progress})=>onProgress(`transcoding ${(progress*100).toFixed(0)}%`));
    onProgress('transcoding to FLAC');
    const code=await ffmpeg.exec(['-i',input,'-vn','-map_metadata','0','-c:a','flac','-compression_level','8',output],120000);
    if(code!==0)throw Error(`ffmpeg exited with code ${code}`);
    const data=await ffmpeg.readFile(output);
    if(!data||data.length<1024)throw Error('ffmpeg produced an invalid FLAC');
    return new Blob([data],{type:'audio/flac'});
  }finally{
    await ffmpeg.deleteFile(input).catch(()=>{});
    await ffmpeg.deleteFile(output).catch(()=>{});
  }
}

export async function sha256(blob){
  const digest=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
}
