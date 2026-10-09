import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
const binary=resolve(process.argv[2]);
const engine=process.argv[3] || 'parakeet';
if (!['parakeet','gigaam'].includes(engine)) throw Error('Unknown smoke model');
const work=await mkdtemp(join(tmpdir(),'aximo-smoke-'));
// A clean data directory proves setup, not a previous machine's model cache.
const env={...process.env,XDG_DATA_HOME:join(work,'data')};
const run=(args,timeout=180000)=>JSON.parse(execFileSync(binary,args,{env,timeout,encoding:'utf8',maxBuffer:1024*1024}));
try {
  if(run(['doctor','--engine',engine]).modelReady)throw Error('Expected a fresh empty model cache');
  run(['setup-model','--engine',engine],600000);
  if(!run(['doctor','--engine',engine]).modelReady)throw Error('Model not verified after setup');
  const wav=Buffer.alloc(44+32000);wav.write('RIFF',0);wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(32000,40);
  const path=join(work,'silence.wav');await writeFile(path,wav);
  const result=run(['transcribe-file','--engine',engine,'--file',path]);
  if(result.type!=='transcript'||typeof result.text!=='string')throw Error('Inference contract failed');
  console.log(`Verified ${engine}: pinned download, relocated binary and real-model silence inference. No microphone or speech-accuracy claim.`);
} finally {await rm(work,{recursive:true,force:true});}
