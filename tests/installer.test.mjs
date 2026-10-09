import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, copyFile, readFile, rm, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const unix = process.platform !== 'win32';
const ASSET_URL='https://github.com/agent-axiom/aximo-voice/releases/download/v0.1.0/aximo-voice-native-linux-x86_64.tar.gz';
const helper='#!/bin/sh\nprintf \'%s\\n\' \'{"version":"0.1.0"}\'\n';
async function fixture({empty=false,badHash=false,url=ASSET_URL,duplicate=false,link=false,badExecutable=false}={}) {
 const root=await mkdtemp(join(tmpdir(),'voice-install-test-'));
 for(const dir of ['scripts','tools','payload'])await mkdir(join(root,dir));
 await copyFile(new URL('../scripts/install-runtime.sh',import.meta.url),join(root,'scripts/install-runtime.sh'));
 await writeFile(join(root,'payload/aximo-voice-native'),badExecutable?'#!/bin/sh\nexit 1\n':helper,{mode:0o755});
 await writeFile(join(root,'payload/libonnxruntime.so.1'),'fake runtime library');
 const members=['aximo-voice-native','libonnxruntime.so.1'];
 if(link){await symlink('/etc/passwd',join(root,'payload/bad-link'));members.push('bad-link');}
 const archive=join(root,'payload.tar.gz');
 execFileSync('tar',['-czf',archive,'-C',join(root,'payload'),...members]);
 const sha=badHash?'a'.repeat(64):createHash('sha256').update(await readFile(archive)).digest('hex');
 const line=`linux-x86_64 ${sha} ${url}\n`;
 await writeFile(join(root,'scripts/runtime-manifest.txt'),empty?'# no release\n':line.repeat(duplicate?2:1));
 await writeFile(join(root,'tools/uname'),'#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; esac\n',{mode:0o755});
 await writeFile(join(root,'tools/curl'),'#!/bin/sh\nfor last; do :; done\ncp "$FIXTURE_ARCHIVE" "$last"\n',{mode:0o755});
 const run=()=>execFileSync('sh',[join(root,'scripts/install-runtime.sh')],{encoding:'utf8',env:{...process.env,FIXTURE_ARCHIVE:archive,PATH:`${root}/tools:${process.env.PATH}`},stdio:['ignore','pipe','pipe']});
 return {root,run,close:()=>rm(root,{recursive:true,force:true})};
}
test('runtime installer fails closed before any release is published',{skip:!unix},async()=>{
 const f=await fixture({empty:true});try{assert.throws(f.run,/source preview/);}finally{await f.close();}
});
test('runtime installer verifies and installs helper plus its runtime libraries',{skip:!unix},async()=>{
 const f=await fixture();try{f.run();assert.equal(await readFile(join(f.root,'bin/aximo-voice-native'),'utf8'),helper);assert.equal(await readFile(join(f.root,'bin/libonnxruntime.so.1'),'utf8'),'fake runtime library');}finally{await f.close();}
});
test('checksum mismatch preserves existing runtime',{skip:!unix},async()=>{
 const f=await fixture({badHash:true});try{await mkdir(join(f.root,'bin'));await writeFile(join(f.root,'bin/aximo-voice-native'),'existing');assert.throws(f.run,/checksum mismatch/);assert.equal(await readFile(join(f.root,'bin/aximo-voice-native'),'utf8'),'existing');}finally{await f.close();}
});
test('runtime installer rejects untrusted and moving URLs',{skip:!unix},async()=>{
 for(const url of ['http://github.com/binary','https://evil.example/binary','https://github.com/agent-axiom/aximo-voice/releases/latest/download/bin']){const f=await fixture({url});try{assert.throws(f.run,/Untrusted/);}finally{await f.close();}}
});
test('runtime installer refuses symlink destinations',{skip:!unix},async()=>{
 const f=await fixture();try{await symlink(join(f.root,'tools'),join(f.root,'bin'));assert.throws(f.run,/symlink/);}finally{await f.close();}
});
test('runtime installer rejects duplicate manifest entries',{skip:!unix},async()=>{
 const f=await fixture({duplicate:true});try{assert.throws(f.run,/Duplicate/);}finally{await f.close();}
});
test('runtime archive links are refused before extraction',{skip:!unix},async()=>{
 const f=await fixture({link:true});try{assert.throws(f.run,/regular files/);}finally{await f.close();}
});
test('a runtime that cannot launch never replaces a working installation',{skip:!unix},async()=>{
 const f=await fixture({badExecutable:true});try{await mkdir(join(f.root,'bin'));await writeFile(join(f.root,'bin/aximo-voice-native'),'existing');assert.throws(f.run);assert.equal(await readFile(join(f.root,'bin/aximo-voice-native'),'utf8'),'existing');}finally{await f.close();}
});
