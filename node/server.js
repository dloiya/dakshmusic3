import express from 'express';
import cors from 'cors';
import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const app=express(); app.use(cors()); app.use(express.json());
const PORT=process.env.PORT||9876;
let state={running:false,current:null,completed:0,failed:0,lastError:null,process:null};
const bin=x=>spawnSync(x,['--version'],{shell:true,encoding:'utf8'}).status===0;
app.get('/api/status',(req,res)=>res.json({...state,process:undefined,capabilities:{node:process.version,ffmpeg:bin('ffmpeg'),mdl:bin('npx'),ytdlp:bin('yt-dlp')}}));
app.post('/api/acquire',(req,res)=>{
 const {url,output='downloads'}=req.body||{}; if(!url)return res.status(400).json({error:'url is required'}); if(state.process)return res.status(409).json({error:'node is busy'});
 fs.mkdirSync(output,{recursive:true}); state.running=true; state.current=url; state.lastError=null;
 const args=['--yes','@mdlx/cli',url,'--output',path.resolve(output),'--parallel','1','--format','flac','--bitrate','best','--no-po-token'];
 const child=spawn('npx',args,{shell:false}); state.process=child;
 child.stdout.on('data',d=>process.stdout.write('[mdl] '+d)); child.stderr.on('data',d=>process.stderr.write('[mdl] '+d));
 child.on('close',code=>{state.running=false;state.process=null;state.current=null;if(code===0)state.completed++;else{state.failed++;state.lastError=`MusicDL exited ${code}`;}});
 res.status(202).json({accepted:true,url});
});
app.post('/api/stop',(req,res)=>{if(state.process){state.process.kill('SIGTERM');return res.json({stopped:true})}res.json({stopped:false})});
app.listen(PORT,()=>console.log(`DakshMusic local node: http://127.0.0.1:${PORT}`));
