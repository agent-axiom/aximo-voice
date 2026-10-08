import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
const root=resolve('.');
async function files(dir){const all=[];for(const e of await readdir(dir,{withFileTypes:true})){if(['.git','.research','target','node_modules','bin'].includes(e.name))continue;const p=resolve(dir,e.name);if(e.isDirectory())all.push(...await files(p));else all.push(p);}return all;}
for(const path of await files(root))if(path.endsWith('.md')){
 const content=await readFile(path,'utf8');for(const m of content.matchAll(/\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)){
  const link=m[1].split('#')[0];if(!link||/^[a-z]+:/i.test(link))continue;
  await access(resolve(dirname(path),decodeURIComponent(link))).catch(()=>{throw Error(`Broken link in ${path}: ${link}`)});
 }
}
const manifest=JSON.parse(await readFile('.claude-plugin/plugin.json','utf8'));
assert.equal(manifest.name,'aximo-voice');
const source=await readFile('hooks/register.js','utf8');
assert(!/\$\.prompt\.submit\s*\(/.test(source),'Dictation must never submit');
assert(!/\$\.model\.|\$\.http\.|\$\.tool\.register/.test(source),'No model, network, or model-invocable recording tools');
assert(source.includes("mode: 'insert'"));assert(source.includes('isFilled'));
const models=JSON.parse(await readFile('native/models.json','utf8'));
for(const m of Object.values(models)){assert.match(m.revision,/^[0-9a-f]{40}$/);for(const f of m.files){assert.match(f.sha256,/^[0-9a-f]{64}$/);assert(f.size>0);}}
console.log('Repository links, manifests and no-autosend contract verified.');
