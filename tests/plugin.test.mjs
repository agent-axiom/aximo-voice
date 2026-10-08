import test from 'node:test';
import assert from 'node:assert/strict';
import { register, parseResult, statusText, newState } from '../hooks/register.js';

function deferred() { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; }
function harness({ modelReady = true, fill = true, exists = true, ask = 'Cancel', helperResponse } = {}) {
  const hooks = new Map(), tasks = [], intervals = [], calls = [], statuses = [], toasts = [], inserts = [];
  const running = deferred(); let nativeState = 'recording';
  const $ = {
    plugin: {root:'/plugin'},
    env:{get:async()=>undefined}, fs:{exists:async()=>exists},
    store:{get:async()=>undefined,set:async(...args)=>calls.push(['store',...args])},
    command:{register:async x=>calls.push(['register',x])},
    clock:{after:(ms, fn)=>{const timer={fn,cancelled:false,cancel(){this.cancelled=true;}};tasks.push(timer);return timer;},every:(ms,fn)=>{const timer={fn,cancelled:false,cancel(){this.cancelled=true;}};intervals.push(timer);return timer;}},
    process:{run:async(argv, options)=>{
      calls.push([argv, options]);
      if(argv[1]==='doctor') return {exitCode:0,stdout:JSON.stringify({type:'doctor',modelReady})};
      if(argv[1]==='record') return running.promise;
      if(argv[1]==='control') return {exitCode:0,stdout:JSON.stringify({state:nativeState})};
      return helperResponse || {exitCode:0,stdout:'{"type":"ready"}'};
    }},
    prompt:{fill:async input=>{inserts.push(input);if(fill instanceof Error)throw fill;return{isFilled:fill};}},
    ui:{status:x=>statuses.push(x),invalidate:()=>{},toast:x=>toasts.push(x),ask:async()=>ask,resolve:()=>({Box:'Box',Text:'Text',Button:'Button'})}
  };
  register((event,matcher,fn)=>{if(typeof matcher==='function')fn=matcher;hooks.set(event,fn);return {catch(){}};});
  return {$, calls,statuses,toasts,inserts,tasks,intervals,running,
    begin:()=>hooks.get('session.start')($,{},async e=>e),
    command:(args,origin={kind:'composer'})=>hooks.get('command.run')($,{args,origin}),
    end:(reason='other')=>hooks.get('session.end')($,{reason},async e=>e),
    tick:()=>intervals.at(-1).fn(), run:()=>tasks.at(-1).cancelled?Promise.resolve():tasks.at(-1).fn(),
    setNativeState:x=>{nativeState=x;},setFill:x=>{fill=x;}
  };
}
const transcript=text=>({exitCode:0,stdout:JSON.stringify({type:'transcript',text})});
const count=(h,action)=>h.calls.filter(x=>Array.isArray(x[0])&&x[0][1]===action).length;

test('registers an immediate namespaced command without touching microphone',async()=>{
 const h=harness();await h.begin();assert.equal(h.calls[0][1].name,'aximo-voice');assert.equal(h.calls[0][1].immediate,true);assert.equal(count(h,'record'),0);
});
test('start records in background and inserts editable text without returning it to model',async()=>{
 const h=harness();await h.begin();assert.deepEqual(await h.command('start'),{});const done=h.run();await h.tick();assert.match(h.statuses.at(-1),/Recording/);h.running.resolve(transcript('  hello world  '));await done;
 assert.deepEqual(h.inserts,[{text:'hello world',mode:'insert'}]);assert.equal(h.intervals[0].cancelled,true);assert.match(h.toasts.at(-1),/Edit it/);
});
test('double start never launches overlapping recorders',async()=>{
 const h=harness();await h.command('start');const done=h.run();await h.command('start');await h.command('nonsense');await h.command('start');assert.equal(h.tasks.length,1);h.running.resolve(transcript('ok'));await done;
});
test('stop and repeated stop use control without spawning another recorder',async()=>{
 const h=harness();await h.command('start');const done=h.run();await h.command('stop');await h.command('stop');assert.equal(count(h,'record'),1);assert.equal(count(h,'control'),2);h.running.resolve(transcript('done'));await done;assert.equal(h.inserts.length,1);
});
test('cancel suppresses even a late successful transcript and blocks new capture until exit',async()=>{
 const h=harness();await h.command('start');const done=h.run();await h.command('cancel');await h.command('start');assert.equal(h.tasks.length,1);h.running.resolve(transcript('must not appear'));await done;assert.deepEqual(h.inserts,[]);await h.command('start');assert.equal(h.tasks.length,2);
});
test('failed fill preserves pending transcript and blocks replacement until explicit retry',async()=>{
 const h=harness({fill:false});await h.command('start');const done=h.run();h.running.resolve(transcript('keep me'));await done;await h.command('start');assert.equal(h.tasks.length,1);h.setFill(true);await h.command('insert');assert.equal(h.inserts.length,2);assert.deepEqual(h.inserts[0],h.inserts[1]);await h.command('insert');assert.equal(h.inserts.length,2);
});
test('fill exception preserves text; cancel discards it',async()=>{
 const h=harness({fill:new Error('blocked')});await h.command('start');const done=h.run();h.running.resolve(transcript('private'));await done;await h.command('cancel');await h.command('insert');assert.equal(h.inserts.length,1);
});
test('empty and whitespace transcripts do not fill',async()=>{
 const h=harness();await h.command('start');const done=h.run();h.running.resolve(transcript('   '));await done;assert.equal(h.inserts.length,0);assert.equal(h.toasts.at(-1),'No speech detected.');
});
test('missing model never starts microphone or silently downloads',async()=>{
 const h=harness({modelReady:false});await h.command('start');assert.equal(h.tasks.length,0);assert.equal(count(h,'setup-model'),0);assert.match(h.statuses.at(-1),/Download/);
});
test('missing runtime gives actionable setup error',async()=>{
 const h=harness({exists:false});await h.command('start');assert.equal(h.tasks.length,0);assert.match(h.statuses.at(-1),/setup/);
});
test('declined or free-text setup consent never downloads',async()=>{
 for(const answer of ['Cancel','sure maybe','']){const h=harness({ask:answer});await h.command('setup ru');assert.equal(count(h,'setup-model'),0);}
});
test('explicit setup selects Russian model and verifies installation',async()=>{
 const h=harness({ask:'Install and download'});await h.command('setup ru');const c=h.calls.find(x=>Array.isArray(x[0])&&x[0][1]==='setup-model');assert.deepEqual(c[0].slice(-2),['--engine','gigaam']);assert.equal(count(h,'doctor'),1);assert.equal(count(h,'record'),0);
});
test('session shutdown clears pending work and rejects a late result',async()=>{
 const h=harness();await h.command('start');const done=h.run();await h.end();h.running.resolve(transcript('secret'));await done;assert.equal(h.inserts.length,0);assert.equal(h.intervals[0].cancelled,true);assert.equal(h.statuses.at(-1),undefined);
});
test('clear allows another recording without accepting pre-clear result',async()=>{
 const h=harness();await h.command('start');const done=h.run();await h.end('clear');h.running.resolve(transcript('old'));await done;assert.equal(h.inserts.length,0);await h.command('start');assert.equal(h.tasks.length,2);
});
test('ending before scheduled work begins prevents microphone launch',async()=>{
 const h=harness();await h.command('start');await h.end();await h.run();assert.equal(count(h,'record'),0);
});
test('invalid helper data and failed processes are rejected',()=>{
 for(const value of [undefined,{exitCode:0,stdout:'not json'},{exitCode:0,stdout:'[]'},{exitCode:1,stdout:'{}'},{exitCode:0,stdout:'{"type":"error","error":"no mic"}'}])assert.throws(()=>parseResult(value));
});
test('overlong transcript is rejected, never inserted',async()=>{
 const h=harness();await h.command('start');const done=h.run();h.running.resolve(transcript('x'.repeat(100001)));await done;assert.equal(h.inserts.length,0);assert.match(h.statuses.at(-1),/Unexpected/);
});
test('helper failure releases active state and permits recovery',async()=>{
 const h=harness();await h.command('start');const done=h.run();h.running.reject(new Error('Microphone permission denied'));await done;assert.match(h.statuses.at(-1),/permission denied/);await h.command('start');assert.equal(h.tasks.length,2);
});
test('status text never includes the transcript',()=>{
 const s=newState();s.pending='private dictated text';s.phase='review';assert.doesNotMatch(statusText(s),/private/);
});

test('automated, remote and unclassified command origins cannot capture audio',async()=>{
 const h=harness();for(const origin of [{kind:'plugin',name:'other'},{kind:'bridge'},{kind:'sdk'},null]) await h.command('start',origin);
 assert.equal(h.tasks.length,0);assert.equal(count(h,'doctor'),0);assert.equal(count(h,'record'),0);
});
