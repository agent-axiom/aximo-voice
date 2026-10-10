import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, readdirSync, statSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
const binary = resolve(process.env.AXIMO_MANAGER_BIN || 'native/target/release/aximo-voice');
const available = process.platform !== 'win32' && existsSync(binary);
if (process.env.AXIMO_REQUIRE_MANAGER_TESTS && !available) throw Error('Required management binary is unavailable');

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aximo-manager-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home'), kit = join(dir, 'kit'), commands = join(dir, 'commands');
  for (const path of [home,commands,join(kit,'bin'),join(kit,'share/aximo-voice/plugin/.claude-plugin'),join(kit,'share/aximo-voice/plugin/bin')]) mkdirSync(path,{recursive:true});
  copyFileSync(binary,join(kit,'bin/aximo-voice')); chmodSync(join(kit,'bin/aximo-voice'),0o755);
  writeFileSync(join(kit,'share/aximo-voice/plugin/.claude-plugin/plugin.json'),JSON.stringify({name:'aximo-voice',version:'0.1.0'}));
  writeFileSync(join(kit,'share/aximo-voice/plugin/.claude-plugin/marketplace.json'),JSON.stringify({name:'aximo',owner:{name:'Axiom'},plugins:[{name:'aximo-voice',source:'./'}]}));
  const helper=join(kit,'share/aximo-voice/plugin/bin/aximo-voice-native');
  writeFileSync(helper,'#!/bin/sh\nprintf \'%s\\n\' \'{"type":"doctor","version":"0.1.0","runtimeLoaded":true,"microphoneChecked":false,"telemetryEnabled":false,"setupProgressProtocol":1,"modelReady":false}\'\n',{mode:0o755});
  function manifest() {
    const files=[];
    function walk(path,rel='') { for(const name of readdirSync(path)){const absolute=join(path,name),file=rel?`${rel}/${name}`:name;if(file==='share/aximo-voice/KIT-METADATA.json')continue;if(statSync(absolute).isDirectory())walk(absolute,file);else files.push({file,size:statSync(absolute).size,sha256:createHash('sha256').update(readFileSync(absolute)).digest('hex')});} }
    walk(kit);writeFileSync(join(kit,'share/aximo-voice/KIT-METADATA.json'),JSON.stringify({schemaVersion:1,version:'0.1.0',pluginVersion:'0.1.0',runtimeVersion:'0.1.0',cliVersion:'0.1.0',compatibility:{minimumMacOS:'13.4'},platform:process.platform==='darwin'?`macos-${process.arch==='arm64'?'aarch64':'x86_64'}`:'linux-x86_64',files}));
  }
  manifest();
  const state=join(dir,'claude-state.json'), log=join(dir,'calls.jsonl');writeFileSync(state,JSON.stringify({markets:[],plugins:[]}));
  writeFileSync(join(commands,'claude'),`#!/usr/bin/env node
const fs=require('node:fs');const a=process.argv.slice(2),s=JSON.parse(fs.readFileSync(process.env.MOCK_STATE));fs.appendFileSync(process.env.MOCK_LOG,JSON.stringify(a)+'\\n');let result={outcome:'ok'};
if(a[0]==='--version'){console.log(process.env.MOCK_VERSION||'2.1.293 (Claude Code)');process.exit(0);}
if(a.join(' ')==='plugin marketplace list --json')result=s.markets;
else if(a.join(' ')==='plugin list --json')result=s.plugins;
else if(a[1]==='marketplace'&&a[2]==='add'){s.markets=[{name:'aximo',source:'directory',path:a[3]}];}
else if(a[1]==='marketplace'&&a[2]==='remove'){s.markets=[];}
else if(a[1]==='install'){s.plugins=[{id:'aximo-voice@aximo',version:'0.1.0',folderVersion:'0.1.0',scope:'user',enabled:true,installPath:s.markets[0].path,readFromFolder:s.markets[0].path}];}
else if(a[1]==='update'&&process.env.MOCK_FAIL_UPDATE){console.error('simulated update failure');process.exit(1);}
else if(a[1]==='uninstall'){s.plugins=[];}
else if(a[1]!=='update'){console.error('unexpected command '+a);process.exit(1);}
fs.writeFileSync(process.env.MOCK_STATE,JSON.stringify(s));console.log(JSON.stringify(result));
`,{mode:0o755});
  const env={...process.env,HOME:home,XDG_DATA_HOME:join(home,'data'),PATH:`${commands}:${process.env.PATH}`,MOCK_STATE:state,MOCK_LOG:log};
  const data=process.platform==='darwin'?join(home,'Library/Application Support/aximo-voice'):join(home,'data/aximo-voice');
  const run=(args,extra={},input)=>spawnSync(join(kit,'bin/aximo-voice'),args,{env:{...env,...extra},encoding:'utf8',input});
  return {dir,kit,commands,state,log,env,data,helper,manifest,run,calls:()=>existsSync(log)?readFileSync(log,'utf8').trim().split('\n').map(JSON.parse):[]};
}
const managed=(name,fn)=>test(name,{skip:!available},fn);
managed('package-only doctor never invokes Claude or a microphone',t=>{const f=fixture(t),r=f.run(['doctor','--package-only']);assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).registrationChecked,false);assert.equal(f.calls().length,0);});
managed('setup is repeatable, user-scoped, verified and never downloads models',t=>{const f=fixture(t);for(let i=0;i<2;i++){const r=f.run(['setup']);assert.equal(r.status,0,r.stderr);}assert.equal(f.calls().filter(c=>c[2]==='add').length,1);assert.equal(f.calls().filter(c=>c[1]==='install').length,1);assert.equal(f.calls().filter(c=>c[1]==='update').length,1);assert(f.calls().filter(c=>['install','update'].includes(c[1])).every(c=>c.includes('--scope')&&c.includes('user')));assert(!existsSync(join(f.data,'models')));assert.equal(f.run(['doctor']).status,0);});
managed('foreign marketplace and project scope are never migrated implicitly',t=>{const f=fixture(t);writeFileSync(f.state,JSON.stringify({markets:[{name:'aximo',source:'github',repo:'agent-axiom/aximo-voice'}],plugins:[]}));const r=f.run(['setup']);assert.equal(r.status,1);assert.match(r.stderr,/another source/);assert(!f.calls().some(c=>['add','install','update','remove'].includes(c[2])||['install','update','uninstall'].includes(c[1])));});
managed('outdated Claude and damaged kits fail before any mutation',t=>{const f=fixture(t);assert.equal(f.run(['setup'],{MOCK_VERSION:'2.1.280 (Claude Code)'}).status,1);assert(!f.calls().some(c=>c[1]==='install'));writeFileSync(f.helper,'tampered');const r=f.run(['setup']);assert.equal(r.status,1);assert.match(r.stderr,/integrity/);assert(!existsSync(join(f.data,'installed')));});
managed('unknown files and links are refused by package verification',t=>{const f=fixture(t);writeFileSync(join(f.kit,'unknown'),'x');assert.match(f.run(['doctor','--package-only']).stderr,/unlisted/);rmSync(join(f.kit,'unknown'));symlinkSync('/tmp',join(f.kit,'link'));assert.match(f.run(['doctor','--package-only']).stderr,/link/);});
managed('failed update restores the exact prior kit',t=>{const f=fixture(t);assert.equal(f.run(['setup']).status,0);const before=readFileSync(join(f.data,'installed/share/aximo-voice/KIT-METADATA.json'),'utf8');writeFileSync(join(f.kit,'new-note'),'new');f.manifest();const r=f.run(['setup'],{MOCK_FAIL_UPDATE:'1'});assert.equal(r.status,1);assert.match(r.stderr,/previous kit restored/);assert.equal(readFileSync(join(f.data,'installed/share/aximo-voice/KIT-METADATA.json'),'utf8'),before);assert(!existsSync(join(f.data,'installed/new-note')));});
managed('uninstall preserves models and repeated uninstall succeeds',t=>{const f=fixture(t);assert.equal(f.run(['setup']).status,0);mkdirSync(join(f.data,'models/parakeet'),{recursive:true});writeFileSync(join(f.data,'models/parakeet/model.onnx'),'keep');const first=f.run(['uninstall']);assert.equal(first.status,0,first.stderr);assert.match(first.stdout,/Retained models/);assert.equal(readFileSync(join(f.data,'models/parakeet/model.onnx'),'utf8'),'keep');assert.equal(f.run(['uninstall']).status,0);});
managed('model removal needs exact typed confirmation',t=>{const f=fixture(t);assert.equal(f.run(['setup']).status,0);mkdirSync(join(f.data,'models/parakeet'),{recursive:true});writeFileSync(join(f.data,'models/parakeet/model.onnx'),'keep');const r=f.run(['uninstall','--delete-models'],{},'yes\n');assert.equal(r.status,0,r.stderr);assert(existsSync(join(f.data,'models/parakeet/model.onnx')));});
managed('Brew failure retains the installed kit and models',t=>{const f=fixture(t);assert.equal(f.run(['setup']).status,0);writeFileSync(join(f.commands,'brew'),'#!/bin/sh\nexit 1\n',{mode:0o755});const r=f.run(['update']);assert.equal(r.status,1);assert.match(r.stderr,/Brew upgrade failed/);assert(existsSync(join(f.data,'installed/share/aximo-voice/KIT-METADATA.json')));});

managed('explicit model deletion only removes known files and preserves unrelated data',t=>{const f=fixture(t);assert.equal(f.run(['setup']).status,0);mkdirSync(join(f.data,'models/parakeet'),{recursive:true});writeFileSync(join(f.data,'models/parakeet/encoder-model.int8.onnx'),'weights');writeFileSync(join(f.data,'models/parakeet/personal-note'),'keep');const r=f.run(['uninstall','--delete-models'],{},'DELETE\n');assert.equal(r.status,0,r.stderr);assert(!existsSync(join(f.data,'models/parakeet/encoder-model.int8.onnx')));assert.equal(readFileSync(join(f.data,'models/parakeet/personal-note'),'utf8'),'keep');});
