import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, copyFile, readFile, rm, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const unix = process.platform !== 'win32';
async function fixture(manifest) {
 const root=await mkdtemp(join(tmpdir(),'voice-install-test-'));
 await mkdir(join(root,'scripts'));await mkdir(join(root,'tools'));
 await copyFile(new URL('../scripts/install-runtime.sh',import.meta.url),join(root,'scripts/install-runtime.sh'));
 await writeFile(join(root,'scripts/runtime-manifest.txt'),manifest);
 await writeFile(join(root,'tools/uname'),'#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; esac\n',{mode:0o755});
 await writeFile(join(root,'tools/curl'),'#!/bin/sh\nfor last; do :; done\nprintf fake-runtime > "$last"\n',{mode:0o755});
 const run=()=>execFileSync('sh',[join(root,'scripts/install-runtime.sh')],{encoding:'utf8',env:{...process.env,PATH:`${root}/tools:${process.env.PATH}`},stdio:['ignore','pipe','pipe']});
 return {root,run,close:()=>rm(root,{recursive:true,force:true})};
}
const ASSET_URL='https://github.com/agent-axiom/aximo-voice/releases/download/v0.1.0/aximo-voice-native-linux-x86_64';
const sha=createHash('sha256').update('fake-runtime').digest('hex');
test('runtime installer fails closed before any release is published',{skip:!unix},async()=>{
 const f=await fixture('# no release\n');try{assert.throws(f.run,/source preview/);}finally{await f.close();}
});
test('runtime installer verifies bytes before replacing old runtime',{skip:!unix},async()=>{
 const f=await fixture(`linux-x86_64 ${sha} ${ASSET_URL}\n`);try{f.run();assert.equal(await readFile(join(f.root,'bin/aximo-voice-native'),'utf8'),'fake-runtime');}finally{await f.close();}
});
test('checksum mismatch preserves existing runtime',{skip:!unix},async()=>{
 const f=await fixture(`linux-x86_64 ${'a'.repeat(64)} ${ASSET_URL}\n`);try{await mkdir(join(f.root,'bin'));await writeFile(join(f.root,'bin/aximo-voice-native'),'existing');assert.throws(f.run,/checksum mismatch/);assert.equal(await readFile(join(f.root,'bin/aximo-voice-native'),'utf8'),'existing');}finally{await f.close();}
});
test('runtime installer rejects untrusted and moving URLs',{skip:!unix},async()=>{
 for(const url of ['http://github.com/binary','https://evil.example/binary','https://github.com/agent-axiom/aximo-voice/releases/latest/download/bin']){const f=await fixture(`linux-x86_64 ${sha} ${url}\n`);try{assert.throws(f.run,/Untrusted/);}finally{await f.close();}}
});
test('runtime installer refuses symlink destinations',{skip:!unix},async()=>{
 const f=await fixture(`linux-x86_64 ${sha} ${ASSET_URL}\n`);try{await symlink(join(f.root,'tools'),join(f.root,'bin'));assert.throws(f.run,/symlink/);}finally{await f.close();}
});
test('runtime installer rejects duplicate manifest entries',{skip:!unix},async()=>{
 const line=`linux-x86_64 ${sha} ${ASSET_URL}\n`;const f=await fixture(line+line);try{assert.throws(f.run,/Duplicate/);}finally{await f.close();}
});
