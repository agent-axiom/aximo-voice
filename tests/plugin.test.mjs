import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register, parseResult, statusText, newState, modelDetails, parseSetupEvent, RUNTIME_VERSION } from '../hooks/register.js';

function deferred() { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; }
const manifest = JSON.parse(readFileSync(new URL('../native/models.json', import.meta.url)));
function harness({ modelReady = true, fill = true, exists = true, ask = 'Cancel', helperResponse, refusedCommands = [], spawn, health = {}, manifestText = JSON.stringify(manifest) } = {}) {
  const hooks = new Map(), tasks = [], intervals = [], calls = [], statuses = [], toasts = [], inserts = [], questions = [];
  const running = deferred(); let nativeState = 'recording';
  const $ = {
    plugin: {root:'/plugin'},
    env:{get:async()=>undefined}, fs:{exists:async()=>exists,read:async()=>manifestText},
    store:{get:async()=>undefined,set:async(...args)=>calls.push(['store',...args])},
    command:{register:async x=>{calls.push(['register',x]);if(refusedCommands.includes(x.name))throw new Error('Command name taken');}},
    clock:{after:(ms, fn)=>{const timer={fn,cancelled:false,cancel(){this.cancelled=true;}};tasks.push(timer);return timer;},every:(ms,fn)=>{const timer={fn,cancelled:false,cancel(){this.cancelled=true;}};intervals.push(timer);return timer;}},
    process:{run:async(argv, options)=>{
      calls.push([argv, options]);
      if(argv[1]==='doctor') return {exitCode:0,stdout:JSON.stringify({type:'doctor',engine:argv[3],runtimeVersion:RUNTIME_VERSION,setupProgressProtocol:1,modelReady,...health})};
      if(argv[1]==='record') return running.promise;
      if(argv[1]==='control') return {exitCode:0,stdout:JSON.stringify({state:nativeState})};
      return helperResponse || {exitCode:0,stdout:'{"type":"ready"}'};
    },spawn: args => {
      calls.push([args.argv, {stream:true}]);
      if (spawn) return spawn(args);
      return (async function* () {
        if (args.argv[1] !== 'setup-model') {
          if (helperResponse?.stderr) yield {stream:'stderr',text:helperResponse.stderr};
          exists=true;return {code:helperResponse?.exitCode || 0,signal:null};
        }
        const engine=args.argv[3], totalBytes=modelDetails(manifest,engine).bytes;
        yield {stream:'stdout',text:JSON.stringify({type:'progress',operation:'setup-model',protocol:1,engine,stage:'downloading',bytesCompleted:1,totalBytes,reusedBytes:0})+'\n'};
        modelReady=true;
        yield {stream:'stdout',text:JSON.stringify({type:'ready',operation:'setup-model',protocol:1,engine})+'\n'};
        return {code:0,signal:null};
      })();
    }},
    prompt:{fill:async input=>{inserts.push(input);if(fill instanceof Error)throw fill;return{isFilled:fill};}},
    ui:{status:x=>statuses.push(x),invalidate:()=>{},toast:x=>toasts.push(x),ask:async(...args)=>{questions.push(args);return typeof ask==='function'?ask(...args):Array.isArray(ask)?ask.shift():ask;},resolve:()=>({Box:'Box',Text:'Text',Button:'Button'})}
  };
  register((event,matcher,fn)=>{if(typeof matcher==='function')fn=matcher;hooks.set(event==='command.run'?`command:${matcher.command}`:event,fn);return {catch(){}};});
  let started;const begin=()=>started ||= hooks.get('session.start')($,{},async e=>e);
  return {$, calls,statuses,toasts,inserts,tasks,intervals,running,questions,
    render:async(surface='terminal')=>{globalThis.h=(type,props,...children)=>({type,props,children});return hooks.get('ui.render')($,{surface},async()=>null);},
    begin,
    command:async(args,origin={kind:'composer'},command='av')=>{await begin();return hooks.get(`command:${command}`)($,{command,args,origin},async()=>({text:'other command'}));},
    end:(reason='other')=>hooks.get('session.end')($,{reason},async e=>e),
    tick:()=>intervals.at(-1).fn(), run:()=>tasks.at(-1).cancelled?Promise.resolve():tasks.at(-1).fn(),
    setNativeState:x=>{nativeState=x;},setFill:x=>{fill=x;}
  };
}
const transcript=text=>({exitCode:0,stdout:JSON.stringify({type:'transcript',text})});
const count=(h,action)=>h.calls.filter(x=>Array.isArray(x[0])&&x[0][1]===action).length;

test('registers all three immediate names without touching microphone',async()=>{
 const h=harness();await h.begin();const specs=h.calls.filter(c=>c[0]==='register').map(c=>c[1]);assert.deepEqual(specs.map(s=>s.name),['av','avoice','aximo-voice']);assert(specs.every(s=>s.immediate===true));assert(specs.every(s=>s.argumentHint===specs[0].argumentHint));assert.equal(count(h,'record'),0);
});
for(const name of ['av','avoice','aximo-voice'])test(`${name} starts dictation with no argument and returns no model text`,async()=>{
 const h=harness();assert.deepEqual(await h.command('',{kind:'composer'},name),{});const done=h.run();h.running.resolve(transcript('draft'));await done;assert.deepEqual(h.inserts,[{text:'draft',mode:'insert'}]);assert.equal(count(h,'record'),1);
});
test('all names control one recording and preserve legacy stop/cancel',async()=>{
 const h=harness();await h.command('start');const done=h.run();await h.command('start',{kind:'composer'},'avoice');await h.command('stop',{kind:'composer'},'aximo-voice');assert.equal(count(h,'record'),1);assert.equal(h.tasks.length,1);await h.command('cancel',{kind:'composer'},'avoice');h.running.resolve(transcript('discard'));await done;assert.deepEqual(h.inserts,[]);
});
test('a refused short name passes through and other aliases still work',async()=>{
 const h=harness({refusedCommands:['av']});assert.deepEqual(await h.command('start'),{text:'other command'});assert.equal(count(h,'doctor'),0);assert.match(h.toasts[0],/could not register \/av/);await h.command('start',{kind:'composer'},'avoice');await h.command('cancel',{kind:'composer'},'aximo-voice');await h.run();assert.equal(count(h,'record'),0);
});
test('help and setup guidance consistently use the short command',async()=>{
 const h=harness();await h.command('unknown');assert.match(h.statuses.at(-1),/Use \/av \[/);await h.command('setup zz');assert.match(h.statuses.at(-1),/\/av setup en/);assert.match(statusText(newState()),/\/av to dictate/);
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
 const h=harness({modelReady:false});await h.command('start');assert.equal(h.tasks.length,0);assert.equal(count(h,'setup-model'),0);assert.equal(h.questions.length,1);assert.match(h.questions[0][0],/Choose a dictation language/);
});
test('missing runtime opens setup without launching microphone',async()=>{
 const h=harness({exists:false});await h.command('start');assert.equal(h.tasks.length,0);assert.equal(h.questions.length,1);assert.match(h.questions[0][0],/Choose a dictation language/);
});
test('declined or free-text setup consent never downloads',async()=>{
 for(const answer of ['Cancel','sure maybe','']){const h=harness({ask:answer});await h.command('setup ru');assert.equal(count(h,'setup-model'),0);}
});
test('explicit setup selects Russian model and verifies installation',async()=>{
 const h=harness({ask:'Download model'});await h.command('setup ru');await h.run();const c=h.calls.find(x=>Array.isArray(x[0])&&x[0][1]==='setup-model');assert.deepEqual(c[0].slice(2,4),['--engine','gigaam']);assert.equal(count(h,'doctor'),3);assert.equal(count(h,'record'),0);
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
 const h=harness();for(const command of ['av','avoice','aximo-voice'])for(const origin of [{kind:'plugin',name:'other'},{kind:'bridge'},{kind:'sdk'},null])for(const args of ['start','setup ru','insert'])await h.command(args,origin,command);
 assert.equal(h.tasks.length,0);assert.equal(count(h,'doctor'),0);assert.equal(count(h,'record'),0);
});

test('runtime installation errors are shown and model download never follows a failure',async()=>{
 const h=harness({exists:false,ask:'Download model',helperResponse:{exitCode:1,stdout:'',stderr:'Runtime checksum mismatch; runtime was not installed.'}});
 await h.command('setup en');await h.run();assert.match(h.statuses.at(-1),/checksum mismatch/);assert.equal(count(h,'setup-model'),0);
});

function buttons(tree) {
 if(!tree||typeof tree!=='object')return [];
 return [...(tree.type==='Button'?[tree.props]:[]),...tree.children.flatMap(buttons)];
}
const setupEvent=(engine,type='progress',extra={})=>({type,protocol:1,operation:'setup-model',engine,...(type==='progress'?{stage:'downloading',bytesCompleted:123000000,totalBytes:modelDetails(manifest,engine).bytes,reusedBytes:0}:{}),...extra});
const chunk=event=>({stream:'stdout',text:JSON.stringify(event)+'\n'});

test('first /av chooses a language, asks accurate pinned consent, and ends on explicit Start',async()=>{
 const h=harness({modelReady:false,ask:['Russian (GigaAM)','Download model']});
 await h.command('');assert.equal(h.questions.length,2);const consent=h.questions[1][0];
 assert.match(consent,/885952086 bytes \(886.0 MB/);assert.match(consent,/MIT/);assert(consent.includes(manifest.gigaam.revision));assert(consent.includes(manifest.gigaam.repo));
 assert.equal(count(h,'setup-model'),0);await h.run();
 assert.equal(count(h,'record'),0);assert.equal(h.tasks.length,1);assert.equal(h.inserts.length,0);
 assert(h.statuses.some(s=>s?.includes('Downloading 0.0 / 886.0 MB')));
 for(const surface of ['terminal','desktop'])assert.deepEqual(buttons(await h.render(surface)).map(b=>b.label),['Start','Cancel']);
 await buttons(await h.render()).find(b=>b.label==='Start').onPress();assert.equal(h.tasks.length,2);
});

test('model consent exactly matches pinned manifests and independent licenses',async()=>{
 for(const [language,engine,size,license] of [['en','parakeet',670619706,'CC BY 4.0'],['ru','gigaam',885952086,'MIT']]) {
  const h=harness();await h.command(`setup ${language}`);const question=h.questions[0][0];
  assert(question.includes(`${size} bytes`));assert(question.includes(license));assert(question.includes(modelDetails(manifest,engine).source));
  assert.match(question,/Microphone access is requested only when you choose Start/);assert.equal(count(h,'setup-model'),0);
 }
 assert.equal(RUNTIME_VERSION,readFileSync(new URL('../native/Cargo.toml',import.meta.url),'utf8').match(/^version = "([^"]+)"/m)[1]);
});

test('language choice rejects free text and decline does not download or change engine',async()=>{
 for(const answer of ['Cancel','ru','yes','']) {
  const h=harness({modelReady:false,ask:answer});await h.command('');assert.equal(h.questions.length,1);assert.equal(h.tasks.length,0);assert.equal(h.calls.filter(c=>c[0]==='store').length,0);
 }
});

test('cancel while consent is pending ignores the late answer',async()=>{
 const answer=deferred();const h=harness({ask:()=>answer.promise});const setup=h.command('setup ru');
 while(!h.questions.length)await Promise.resolve();await h.command('cancel');answer.resolve('Download model');await setup;
 assert.equal(h.tasks.length,0);assert.equal(count(h,'setup-model'),0);
});

test('cancel before the setup timer fires prevents network work',async()=>{
 const h=harness({ask:'Download model'});await h.command('setup ru');await h.command('cancel');await h.run();
 assert.equal(count(h,'setup-model'),0);assert.equal(h.calls.filter(c=>c[0]==='store').length,0);assert.equal(count(h,'record'),0);
});

test('stream progress handles split lines, verification and reuse without microphone capture',async()=>{
 const h=harness({ask:'Download model',spawn:async function*({argv}) {
  const engine=argv[3];const text=JSON.stringify(setupEvent(engine));yield {stream:'stdout',text:text.slice(0,35)};yield {stream:'stdout',text:text.slice(35)+'\n'};
  yield chunk(setupEvent(engine,'progress',{stage:'verifying',reusedBytes:42000000}));yield chunk(setupEvent(engine,'ready'));return {code:0,signal:null};
 }});
 await h.command('setup en');await h.run();assert(h.statuses.some(s=>s?.includes('Downloading 123.0 / 670.6 MB')));assert(h.statuses.some(s=>s?.includes('Verifying SHA-256 · 42.0 MB verified files reused')));assert.match(h.statuses.at(-1),/Ready · Choose Start/);assert.equal(count(h,'record'),0);
});

test('cancel during download sends native cancel, blocks overlapping work, and ignores late ready',async()=>{
 const gate=deferred(),begun=deferred();const h=harness({ask:'Download model',spawn:async function*({argv}) {yield chunk(setupEvent(argv[3]));begun.resolve();await gate.promise;yield chunk(setupEvent(argv[3],'ready'));return {code:0,signal:null};}});
 await h.command('setup ru');const done=h.run();await begun.promise;await h.command('cancel');await h.command('setup en');await h.command('start');
 assert.equal(h.tasks.length,1);assert(h.calls.some(c=>Array.isArray(c[0])&&c[0].includes('cancel')));gate.resolve();await done;
 assert.equal(h.calls.filter(c=>c[0]==='store').length,0);assert.equal(count(h,'record'),0);assert.deepEqual(buttons(await h.render()),[]);
});

test('session end during setup cancels helper and suppresses late success',async()=>{
 const gate=deferred(),begun=deferred();const h=harness({ask:'Download model',spawn:async function*({argv}) {yield chunk(setupEvent(argv[3]));begun.resolve();await gate.promise;yield chunk(setupEvent(argv[3],'ready'));return {code:0,signal:null};}});
 await h.command('setup ru');const done=h.run();await begun.promise;await h.end('clear');gate.resolve();await done;
 assert.equal(h.calls.filter(c=>c[0]==='store').length,0);assert.equal(count(h,'record'),0);assert.equal(h.intervals.at(-1).cancelled,true);assert.equal(h.statuses.at(-1),undefined);
});

for(const message of ['SHA-256 mismatch','Not enough free disk space','HTTPS certificate verification failed','Network connection was lost'])test(`${message} fails visibly and Retry never auto-starts microphone`,async()=>{
 let attempts=0;const h=harness({ask:'Download model',spawn:async function*({argv}) {if(attempts++===0)yield chunk(setupEvent(argv[3],'error',{error:message}));else yield chunk(setupEvent(argv[3],'ready'));return {code:attempts===1?1:0,signal:null};}});
 await h.command('setup ru');await h.run();assert.match(h.statuses.at(-1),new RegExp(message));assert.deepEqual(buttons(await h.render()).map(b=>b.label),['Retry','Cancel']);
 assert.equal(h.calls.filter(c=>c[0]==='store').length,0);await buttons(await h.render()).find(b=>b.label==='Retry').onPress();assert.equal(h.questions.length,2);await h.run();
 assert.match(h.statuses.at(-1),/Ready · Choose Start/);assert.equal(count(h,'record'),0);
});

test('unsupported runtime versions and progress protocols fail before model network work',async()=>{
 for(const health of [{runtimeVersion:'0.0.1'},{runtimeVersion:undefined},{setupProgressProtocol:2},{setupProgressProtocol:undefined}]) {
  const h=harness({ask:'Download model',health});await h.command('setup en');assert.match(h.statuses.at(-1),/Unsupported Aximo Voice runtime/);assert.equal(h.questions.length,0);assert.equal(h.tasks.length,0);assert.equal(count(h,'record'),0);
 }
});

test('administrator-denied streaming is shown, with no fallback that bypasses policy',async()=>{
 const h=harness({ask:'Download model',spawn:()=>{throw new Error('process.spawn denied by organization policy');}});await h.command('setup en');await h.run();
 assert.match(h.statuses.at(-1),/denied by organization policy/);assert.equal(count(h,'setup-model'),1);assert.equal(count(h,'record'),0);assert.equal(h.calls.filter(c=>c[0]==='store').length,0);
});

test('malformed or oversized progress, wrong engine, and nonzero exit cannot activate model',async()=>{
 for(const event of [setupEvent('gigaam'),setupEvent('parakeet','progress',{protocol:2}),setupEvent('parakeet','progress',{totalBytes:1}),setupEvent('parakeet','progress',{bytesCompleted:-1}),setupEvent('parakeet','progress',{reusedBytes:Infinity}),{type:'transcript',text:'not a setup result'}]) {
  assert.throws(()=>parseSetupEvent(JSON.stringify(event),'parakeet',modelDetails(manifest,'parakeet').bytes));
 }
 assert.throws(()=>parseSetupEvent('x'.repeat(8193),'parakeet',1));
 for(const result of [undefined,{code:1,signal:null}]) {
  const h=harness({ask:'Download model',spawn:async function*({argv}) {yield chunk(setupEvent(argv[3],'ready'));return result;}});await h.command('setup en');await h.run();assert.match(h.statuses.at(-1),/without verified completion/);assert.equal(h.calls.filter(c=>c[0]==='store').length,0);
 }
});

test('setup blocked by pending transcript preserves it',async()=>{
 const h=harness({fill:false,ask:'Download model'});await h.command('start');const done=h.run();h.running.resolve(transcript('keep'));await done;await h.command('setup ru');assert.equal(h.questions.length,0);h.setFill(true);await h.command('insert');assert.equal(h.inserts.at(-1).text,'keep');
});

test('cancel during the final store write restores the previous selected engine',async()=>{
 const written=deferred(),finish=deferred();const h=harness({ask:'Download model'});const stored=[];
 h.$.store.set=async(key,value)=>{stored.push([key,value]);if(stored.length===1){written.resolve();await finish.promise;}};
 await h.command('setup ru');const done=h.run();await written.promise;await h.command('cancel');finish.resolve();await done;
 assert.deepEqual(stored,[['engine','gigaam'],['engine','parakeet']]);assert.equal(count(h,'record'),0);
});

test('clear during pending setup holds overlap guard until its stream exits',async()=>{
 const gate=deferred(),begun=deferred();const h=harness({ask:'Download model',spawn:async function*({argv}){yield chunk(setupEvent(argv[3]));begun.resolve();await gate.promise;yield chunk(setupEvent(argv[3],'ready'));return {code:0,signal:null};}});
 await h.command('setup ru');const done=h.run();await begun.promise;await h.end('clear');await h.command('setup en');assert.equal(h.tasks.length,1);
 gate.resolve();await done;await h.command('setup en');assert.equal(h.tasks.length,2);assert.equal(h.calls.filter(c=>c[0]==='store').length,0);
});
