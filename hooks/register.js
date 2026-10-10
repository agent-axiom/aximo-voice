// No Node imports: Claude loads this ES module in its Mods sandbox.
// Keep every Mods API call literal and in this file for Claude's validator.
const COMMANDS = ['av', 'avoice', 'aximo-voice'];
export const RUNTIME_VERSION = '0.1.0';
const SETUP = new Set(['setup-choice', 'setup-confirm', 'setup-runtime', 'setup-download', 'setup-cancelling', 'setup-error']);
const ACTIVE = new Set(['starting', 'loading', 'recording', 'stopping', 'transcribing', 'cancelling']);

export function newState() {
  return { phase: 'idle', engine: 'parakeet', pending: '', error: '', session: null,
    generation: 0, heartbeat: null, scheduled: null, polling: false, desired: null,
    inserting: false, ended: false, helper: '', windows: false, busy: false,
    setupLanguage: '', setupJob: null, setupProgress: '' };
}

export function parseResult(result) {
  if (!result || typeof result.stdout !== 'string' || result.stdout.length > 262144) {
    throw new Error('Invalid response from the local voice helper.');
  }
  let value;
  try { value = JSON.parse(result.stdout.trim()); }
  catch { throw new Error('The local voice helper returned an invalid response.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid helper response.');
  if (result.exitCode !== 0 || value.type === 'error' || value.error) {
    throw new Error(typeof value.error === 'string' ? value.error.slice(0, 500) : 'The local voice helper failed.');
  }
  return value;
}

export function statusText(state) {
  const language = state.engine === 'gigaam' ? 'RU' : 'Parakeet';
  const labels = { idle: `Ready · ${language} · /av to dictate`, starting: 'Starting local dictation…',
    loading: 'Loading the local speech model…', recording: 'Recording · Stop to insert · Cancel to discard · 60 s limit',
    stopping: 'Stopping microphone…', transcribing: 'Transcribing locally…', cancelling: 'Cancelling…',
    'setup-choice': 'Choose a dictation language. Microphone is off.',
    'setup-confirm': 'Review the model download. Microphone is off.',
    'setup-runtime': 'Installing the verified local runtime… Microphone is off.',
    'setup-download': state.setupProgress || 'Preparing the local speech model… Microphone is off.',
    'setup-cancelling': 'Cancelling setup… Microphone is off.',
    'setup-error': `${state.error || 'Setup failed.'} Choose Retry or Cancel.`,
    ready: 'Ready · Choose Start to begin dictation. Microphone is off.', review: 'Transcript ready · Insert to retry · Cancel to discard',
    error: state.error || 'Voice setup needs attention.' };
  return labels[state.phase] || labels.idle;
}

function redraw($, state) {
  $.ui.status(statusText(state));
  $.ui.invalidate('ui.render');
}

function fail($, state, error, terminal = false) {
  if (state.session && !terminal) {
    $.ui.toast(error instanceof Error ? error.message.slice(0, 500) : 'Voice command failed.');
    return;
  }
  state.phase = 'error';
  state.error = error instanceof Error ? error.message.slice(0, 500) : 'Local dictation failed.';
  redraw($, state);
}

async function resolveHelper($, state) {
  state.windows = (await $.env.get('OS')) === 'Windows_NT';
  state.helper = `${$.plugin.root}/bin/aximo-voice-native${state.windows ? '.exe' : ''}`;
  return $.fs.exists(state.helper);
}

async function control($, state, action, session = state.session) {
  if (!session) return { state: 'idle' };
  return parseResult(await $.process.run([state.helper, 'control', '--session', session, '--action', action], { timeoutMs: 3000 }));
}

async function poll($, state, generation) {
  if (state.polling || state.ended || generation !== state.generation || !state.session) return;
  state.polling = true;
  try {
    const result = await control($, state, 'heartbeat');
    if (generation !== state.generation || state.ended) return;
    if (state.desired) {
      await control($, state, state.desired);
    } else if (['loading', 'recording', 'transcribing'].includes(result.state)) {
      state.phase = result.state;
    }
    redraw($, state);
  } catch (error) {
    if (state.ended || generation !== state.generation) return;
    // Do not invent success or start a second recorder. The native lease expires
    // if heartbeat is unavailable; record's final result owns the terminal state.
    state.error = 'Voice control unavailable; recording will stop automatically.';
    $.ui.status(state.error);
  } finally { state.polling = false; }
}

async function insert($, state) {
  if (!state.pending || state.inserting || state.ended) return;
  state.inserting = true;
  const text = state.pending;
  const epoch = state.generation;
  try {
    const filled = await $.prompt.fill({ text, mode: 'insert' });
    if (state.ended || epoch !== state.generation) return;
    if (filled?.isFilled) {
      if (state.pending === text) state.pending = '';
      state.phase = 'idle';
      $.ui.toast('Dictation inserted. Edit it, then press Enter when ready.');
    } else {
      state.phase = 'review';
      $.ui.toast('Close the dialog, then choose Insert. Your dictation is still held in memory.');
    }
    redraw($, state);
  } catch {
    if (!state.ended && epoch === state.generation) {
      state.phase = 'review';
      $.ui.toast('Could not insert yet. Choose Insert to retry, or Cancel to discard.');
      redraw($, state);
    }
  } finally { if (epoch === state.generation) state.inserting = false; }
}

async function record($, state, generation, session) {
  if (state.ended || generation !== state.generation) return;
  state.scheduled = null;
  try {
    if (state.desired === 'cancel') { state.phase = 'idle'; return; }
    const result = parseResult(await $.process.run([state.helper, 'record', '--session', session, '--engine', state.engine], { timeoutMs: 180000 }));
    if (state.ended || generation !== state.generation) return;
    if (state.desired === 'cancel' || result.type === 'cancelled') {
      state.pending = '';
      state.phase = 'idle';
    } else if (result.type === 'transcript' && typeof result.text === 'string' && result.text.length <= 100000) {
      state.pending = result.text.trim();
      state.phase = state.pending ? 'review' : 'idle';
      if (!state.pending) $.ui.toast('No speech detected.');
    } else {
      throw new Error('Unexpected result from the local voice helper.');
    }
  } catch (error) {
    if (!state.ended && generation === state.generation) {
      if (state.desired === 'cancel') state.phase = 'idle';
      else fail($, state, error, true);
    }
  } finally {
    if (generation === state.generation) {
      state.heartbeat?.cancel(); state.heartbeat = null;
      state.session = null; state.desired = null;
      if (!state.ended) { redraw($, state); await insert($, state); }
    }
  }
}

function checkHealth(health, engine) {
  if (health.runtimeVersion !== RUNTIME_VERSION || health.setupProgressProtocol !== 1) {
    throw new Error(`Unsupported Aximo Voice runtime ${typeof health.runtimeVersion === 'string' ? health.runtimeVersion.slice(0, 40) : 'unknown'} or setup protocol. Reinstall the matching plugin/runtime package (expected ${RUNTIME_VERSION}, protocol 1), then Retry.`);
  }
  if (health.type !== 'doctor' || health.engine !== engine || typeof health.modelReady !== 'boolean') {
    throw new Error('Invalid readiness response from the local voice helper. Reinstall the matching plugin/runtime package.');
  }
  return health;
}

async function doctor($, state, engine) {
  return checkHealth(parseResult(await $.process.run([state.helper, 'doctor', '--engine', engine], { timeoutMs: 30000 })), engine);
}

async function start($, state) {
  if (state.busy || state.setupJob || ACTIVE.has(state.phase) || state.ended) return;
  if (state.pending) { $.ui.toast('Insert or discard the pending dictation first.'); return; }
  state.busy = true;
  const epoch = state.generation;
  state.phase = 'starting'; redraw($, state);
  try {
    const exists = await resolveHelper($, state);
    if (state.ended || epoch !== state.generation) return;
    const health = exists ? await doctor($, state, state.engine) : null;
    if (state.ended || epoch !== state.generation) return;
    if (!health?.modelReady) {
      state.busy = false; state.phase = 'idle';
      await setup($, state);
      return;
    }
    state.error = ''; state.desired = null; state.phase = 'starting';
    state.session = crypto.randomUUID();
    const session = state.session;
    const generation = ++state.generation;
    state.heartbeat = $.clock.every(1000, async () => poll($, state, generation));
    state.scheduled = $.clock.after(1, async () => record($, state, generation, session));
    redraw($, state);
  } catch (error) {
    if (!state.ended && epoch === state.generation && !state.session) {
      state.phase = 'setup-error'; state.error = error instanceof Error ? error.message.slice(0, 500) : 'Voice preflight failed.'; redraw($, state);
    }
  } finally { if (epoch === state.generation || state.session) state.busy = false; }
}

async function stop($, state, cancel) {
  if (SETUP.has(state.phase) || state.setupJob) {
    if (cancel) await cancelSetup($, state);
    return;
  }
  if (!state.session) {
    if (state.busy) {
      if (cancel && state.phase === 'starting') { state.generation++; state.busy = false; state.phase = 'idle'; redraw($, state); }
      return;
    }
    if (cancel && !state.inserting) { state.pending = ''; state.phase = 'idle'; redraw($, state); }
    return;
  }
  // Record stays active until its subprocess exits, preventing overlapping mics.
  if (state.desired !== 'cancel') state.desired = cancel ? 'cancel' : 'stop';
  state.phase = state.desired === 'cancel' ? 'cancelling' : 'stopping';
  redraw($, state);
  try { await control($, state, state.desired); }
  catch { /* Native may not have made its directory yet; heartbeat retries. */ }
}

export function modelDetails(manifest, engine) {
  const model = manifest?.[engine];
  if (!model || !Array.isArray(model.files) || !model.files.length ||
      !/^istupakov\/[a-z0-9.-]+$/.test(model.repo) || !/^[0-9a-f]{40}$/.test(model.revision) ||
      model.license !== (engine === 'gigaam' ? 'mit' : 'cc-by-4.0') ||
      !model.files.every(file => Number.isSafeInteger(file.size) && file.size > 0 && /^[0-9a-f]{64}$/.test(file.sha256))) {
    throw new Error('The bundled model manifest is invalid. Reinstall the plugin before downloading.');
  }
  const bytes = model.files.reduce((sum, file) => sum + file.size, 0);
  if (!Number.isSafeInteger(bytes)) throw new Error('Invalid model download size.');
  return { bytes, source: `https://huggingface.co/${model.repo}/tree/${model.revision}`,
    name: engine === 'gigaam' ? 'GigaAM Russian' : 'Parakeet English',
    license: engine === 'gigaam' ? 'MIT' : 'CC BY 4.0',
    licenseUrl: engine === 'gigaam' ? `https://huggingface.co/${model.repo}/tree/${model.revision}` : 'https://creativecommons.org/licenses/by/4.0/' };
}

export function parseSetupEvent(line, engine, bytes) {
  if (line.length > 8192) throw new Error('Model setup response exceeded the safe line limit.');
  let event;
  try { event = JSON.parse(line); } catch { throw new Error('Invalid model setup progress. Reinstall the matching plugin/runtime package.'); }
  if (!event || event.protocol !== 1 || event.operation !== 'setup-model' || event.engine !== engine) {
    throw new Error('Unsupported model setup progress protocol. Reinstall the matching plugin/runtime package.');
  }
  if (event.type === 'error') throw new Error(typeof event.error === 'string' ? event.error.slice(0, 500) : 'Model setup failed.');
  if (['ready', 'cancelled'].includes(event.type)) return event;
  if (event.type !== 'progress' || !['checking', 'downloading', 'verifying', 'installing'].includes(event.stage) ||
      event.totalBytes !== bytes || !Number.isSafeInteger(event.bytesCompleted) || event.bytesCompleted < 0 || event.bytesCompleted > bytes ||
      !Number.isSafeInteger(event.reusedBytes) || event.reusedBytes < 0 || event.reusedBytes > bytes) {
    throw new Error('Invalid model setup progress counters. Reinstall the matching plugin/runtime package.');
  }
  return event;
}

function setupProgress(event) {
  const amount = `${(event.bytesCompleted / 1000000).toFixed(1)} / ${(event.totalBytes / 1000000).toFixed(1)} MB`;
  const stages = { checking: 'Checking cached files', downloading: `Downloading ${amount}`, verifying: 'Verifying SHA-256', installing: 'Activating verified model' };
  const reused = event.reusedBytes ? ` · ${(event.reusedBytes / 1000000).toFixed(1)} MB verified files reused` : '';
  return `${stages[event.stage]}${reused} · Microphone is off`;
}

async function setupHeartbeat($, state, job) {
  if (state.setupJob !== job || state.ended || job.polling || !job.session) return;
  job.polling = true;
  try {
    await control($, state, job.cancelled ? 'cancel' : 'heartbeat', job.session);
  } catch {
    // A freshly spawned helper may not have created its control directory yet.
    // The native lease cancels setup if heartbeat delivery remains unavailable.
  } finally { job.polling = false; }
}

async function cancelSetup($, state) {
  const job = state.setupJob;
  if (!job) {
    state.generation++; state.busy = false; state.phase = 'idle'; state.error = ''; redraw($, state);
    return;
  }
  if (job.cancelled) return;
  job.cancelled = true;
  state.phase = 'setup-cancelling'; redraw($, state);
  if (!job.started) {
    job.scheduled.cancel(); state.setupJob = null; state.phase = 'idle'; redraw($, state);
  } else if (job.session) {
    try { await control($, state, 'cancel', job.session); } catch { /* Heartbeat retries. */ }
  } else {
    // Returning the supported stream stops its process. Do not claim idle until
    // the pending stream read settles; the installer owns rollback on shutdown.
    job.stream?.return().catch(() => {});
  }
}

async function installRuntime($, state, job) {
  state.phase = 'setup-runtime'; redraw($, state);
  const argv = state.windows
    ? ['powershell.exe', '-NoProfile', '-File', `${$.plugin.root}/scripts/install-runtime.ps1`]
    : ['sh', `${$.plugin.root}/scripts/install-runtime.sh`];
  const stream = $.process.spawn({ argv });
  job.stream = stream;
  let detail = '';
  while (true) {
    const item = await stream.next();
    if (item.done) {
      if (!job.cancelled && item.value?.code !== 0) throw new Error(detail.trim() || 'Runtime installation failed. See docs/installation.md for verified release status.');
      return;
    }
    if (item.value.stream === 'stderr') detail = (detail + item.value.text).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(-500);
    if (job.cancelled) { await stream.return(); return; }
  }
}

async function downloadModel($, state, job) {
  const { engine, details } = job;
  job.session = crypto.randomUUID();
  job.heartbeat = $.clock.every(1000, async () => setupHeartbeat($, state, job));
  state.phase = 'setup-download'; state.setupProgress = ''; redraw($, state);
  // Verified on Claude Code 2.1.293: an async iterator of {stream,text}; its
  // terminal value is {code,signal}. No unsupported spawn/kill or signal option.
  const stream = $.process.spawn({ argv: [state.helper, 'setup-model', '--engine', engine, '--progress-json', '--session', job.session] });
  job.stream = stream;
  let buffer = '', terminal = null, exit = null;
  while (true) {
    const item = await stream.next();
    if (item.done) { exit = item.value; break; }
    if (state.ended || job.epoch !== state.generation) { await stream.return(); return false; }
    if (item.value.stream !== 'stdout') continue;
    if (typeof item.value.text !== 'string' || item.value.text.length > 262144) throw new Error('Invalid model setup stream.');
    buffer += item.value.text;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      if (terminal) throw new Error('Unexpected data after model setup completed.');
      const event = parseSetupEvent(line, engine, details.bytes);
      if (event.type === 'progress') {
        if (!job.cancelled) { state.setupProgress = setupProgress(event); redraw($, state); }
      } else terminal = event;
    }
    if (buffer.length > 8192) throw new Error('Model setup response exceeded the safe line limit.');
  }
  if (buffer.trim()) {
    if (terminal) throw new Error('Unexpected data after model setup completed.');
    terminal = parseSetupEvent(buffer, engine, details.bytes);
  }
  if (job.cancelled || terminal?.type === 'cancelled') return false;
  if (exit?.code !== 0 || terminal?.type !== 'ready') throw new Error('Model setup ended without verified completion. Choose Retry.');
  return true;
}

async function finishSetup($, state, job) {
  if (state.ended || job.epoch !== state.generation || state.setupJob !== job) return;
  job.started = true;
  try {
    if (job.installRuntime) await installRuntime($, state, job);
    if (job.cancelled || state.ended || job.epoch !== state.generation) return;
    await doctor($, state, job.engine);
    if (job.cancelled || state.ended || job.epoch !== state.generation) return;
    if (!await downloadModel($, state, job)) return;
    const health = await doctor($, state, job.engine);
    if (!health.modelReady) throw new Error('Model installation did not pass verification. Choose Retry.');
    if (job.cancelled || state.ended || job.epoch !== state.generation) return;
    await $.store.set('engine', job.engine);
    if (job.cancelled || state.ended || job.epoch !== state.generation) {
      // Store writes are asynchronous. Cancellation may arrive while one is
      // pending; restore this session's previous selection before releasing
      // the setup overlap guard. Verified model files can remain cached.
      await $.store.set('engine', state.engine);
      return;
    }
    state.engine = job.engine; state.phase = 'ready'; state.error = '';
    $.ui.toast('Ready. Choose Start when you want to turn on the microphone.');
  } catch (error) {
    if (!job.cancelled && !state.ended && job.epoch === state.generation) {
      state.phase = 'setup-error'; state.error = error instanceof Error ? error.message.slice(0, 500) : 'Local voice setup failed.';
    }
  } finally {
    job.heartbeat?.cancel();
    // Releasing a stream after an error stops the child. Stop heartbeats too, so
    // native cancellation/rollback remains a backstop if the host shuts down.
    try { await job.stream?.return(); } catch { /* Preserve the original failure. */ }
    if (state.setupJob === job) {
      state.setupJob = null;
      if (!state.ended && job.epoch === state.generation) {
        if (job.cancelled || !['ready', 'setup-error'].includes(state.phase)) state.phase = 'idle';
        redraw($, state);
      }
    }
  }
}

async function setup($, state, language) {
  if (state.busy || state.setupJob || state.ended || ACTIVE.has(state.phase)) return;
  if (state.pending) { $.ui.toast('Insert or discard the pending dictation before setup.'); return; }
  if (language && !['en', 'ru'].includes(language)) throw new Error('Use /av setup en or /av setup ru.');
  state.busy = true;
  const epoch = state.generation;
  try {
    state.phase = 'setup-choice'; state.error = ''; redraw($, state);
    if (!language) {
      const chosen = await $.ui.ask('Choose a dictation language. Audio is recognized locally. Setup does not turn on your microphone.', ['English (Parakeet)', 'Russian (GigaAM)', 'Cancel']);
      if (state.ended || epoch !== state.generation) return;
      if (!['English (Parakeet)', 'Russian (GigaAM)'].includes(chosen)) { state.phase = 'idle'; redraw($, state); return; }
      language = chosen === 'Russian (GigaAM)' ? 'ru' : 'en';
    }
    state.setupLanguage = language;
    const engine = language === 'ru' ? 'gigaam' : 'parakeet';
    const details = modelDetails(JSON.parse(await $.fs.read(`${$.plugin.root}/native/models.json`)), engine);
    const exists = await resolveHelper($, state);
    if (exists) await doctor($, state, engine);
    if (state.ended || epoch !== state.generation) return;
    state.phase = 'setup-confirm'; redraw($, state);
    const runtime = exists ? '' : 'Also install the checksum-verified runtime from https://github.com/agent-axiom/aximo-voice/releases (additional download). ';
    const accepted = await $.ui.ask(`${runtime}Download ${details.name}: ${details.bytes} bytes (${(details.bytes / 1000000).toFixed(1)} MB, model weights only). Source: ${details.source}. License: ${details.license}, ${details.licenseUrl}. Recognizes audio locally; audio is not uploaded for recognition. Recognized text is sent to Claude only when you submit it. Downloads can take several minutes. Fully verified files may be reused on Retry; partial files restart. Microphone access is requested only when you choose Start.`, ['Download model', 'Cancel']);
    if (state.ended || epoch !== state.generation) return;
    if (accepted !== 'Download model') { state.phase = 'idle'; redraw($, state); return; }
    const job = { engine, details, installRuntime: !exists, epoch, session: null, started: false, cancelled: false, polling: false, stream: null, heartbeat: null, scheduled: null };
    state.setupJob = job; state.setupProgress = ''; state.phase = exists ? 'setup-download' : 'setup-runtime';
    job.scheduled = $.clock.after(1, async () => finishSetup($, state, job));
    redraw($, state);
  } catch (error) {
    if (!state.ended && epoch === state.generation) {
      state.phase = 'setup-error'; state.error = error instanceof Error ? error.message.slice(0, 500) : 'Local voice setup failed.'; redraw($, state);
    }
  } finally { if (epoch === state.generation) state.busy = false; }
}

async function dispatch($, state, args) {
  const epoch = state.generation;
  try {
    const [action = '', language, ...extra] = args.trim().split(/\s+/);
    if (extra.length) throw new Error('Use /av [start|stop|cancel|status|insert|retry|setup en|setup ru].');
    if (action === 'setup') await setup($, state, language);
    else if (language) throw new Error('This action takes no extra arguments.');
    else if (action === 'cancel') await stop($, state, true);
    else if (action === 'stop') await stop($, state, false);
    else if (action === 'insert') await insert($, state);
    else if (action === 'status') redraw($, state);
    else if (action === 'retry') await setup($, state, state.setupLanguage);
    else if (action === 'start') await start($, state);
    else if (!action) {
      if (state.session) await stop($, state, false);
      else if (state.pending) await insert($, state);
      else await start($, state);
    } else throw new Error('Use /av [start|stop|cancel|status|insert|retry|setup en|setup ru].');
  } catch (error) { if (!state.ended && epoch === state.generation) fail($, state, error); }
  // Returning text would expose it to Claude. Dictation never goes here.
  return {};
}

async function runCommand($, state, commands, e, next) {
  // A short name may already belong to another plugin. Never intercept it if
  // this host refused our registration; the other names remain available.
  if (!commands.has(e.command)) return next(e);
  if (e.origin?.kind !== 'composer') {
    $.ui.toast('Run voice commands from your local Claude Code prompt. Automated and remote callers cannot start the microphone.');
    return {};
  }
  return dispatch($, state, e.args || '');
}

function commandFailed($, e, next) {
  if (next.called) return next(e);
  $.ui.toast('Voice command could not finish. Use /av status.');
  return {};
}

export function register(on) {
  const state = newState();
  const commands = new Set();
  on('session.start', async ($, e, next) => {
    state.ended = false;
    const engine = await $.store.get('engine');
    state.engine = engine === 'gigaam' ? 'gigaam' : 'parakeet';
    commands.clear();
    // CommandSpec has no aliases field. Register each supported name with the
    // same state/dispatcher rather than inventing a host alias option.
    for (const name of COMMANDS) {
      try {
        await $.command.register({ name, description: name === 'av' ? 'Dictate locally into the editable prompt' : 'Alias for /av: local dictation', argumentHint: '[start|stop|cancel|status|insert|retry|setup en|setup ru]', immediate: true });
        commands.add(name);
      } catch {
        $.ui.toast(`Aximo Voice could not register /${name}. Check /help for the available voice commands.`);
      }
    }
    return next(e);
  });
  // Literal matchers keep all three names visible to the Mods validator.
  on('command.run', { command: 'av' }, async ($, e, next) => runCommand($, state, commands, e, next)).catch(commandFailed);
  on('command.run', { command: 'avoice' }, async ($, e, next) => runCommand($, state, commands, e, next)).catch(commandFailed);
  on('command.run', { command: 'aximo-voice' }, async ($, e, next) => runCommand($, state, commands, e, next)).catch(commandFailed);
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const previous = await next(e);
    if (!ACTIVE.has(state.phase) && !SETUP.has(state.phase) && state.phase !== 'ready' && !state.pending) return previous;
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return previous;
    const { Box, Text, Button } = $.ui.resolve(e);
    if (SETUP.has(state.phase) || state.phase === 'ready') {
      return h(Box, { flexDirection: 'column' }, previous,
        h(Text, {}, statusText(state)),
        h(Box, { gap: 1 },
          state.phase === 'ready' ? h(Button, { key: 'aximo-start', label: 'Start', onPress: async () => dispatch($, state, 'start') }) : null,
          state.phase === 'setup-error' ? h(Button, { key: 'aximo-retry', label: 'Retry', onPress: async () => dispatch($, state, 'retry') }) : null,
          h(Button, { key: 'aximo-cancel', label: 'Cancel', onPress: async () => dispatch($, state, 'cancel') })));
    }
    return h(Box, { flexDirection: 'column' }, previous,
      h(Text, {}, statusText(state)),
      h(Box, { gap: 1 },
        state.pending ? h(Button, { key: 'aximo-insert', label: 'Insert', onPress: async () => dispatch($, state, 'insert') })
          : h(Button, { key: 'aximo-stop', label: 'Stop', onPress: async () => dispatch($, state, 'stop') }),
        h(Button, { key: 'aximo-cancel', label: 'Cancel', onPress: async () => dispatch($, state, 'cancel') })));
  });
  on('session.end', async ($, e, next) => {
    state.ended = true; state.generation++;
    state.scheduled?.cancel(); state.heartbeat?.cancel();
    state.pending = '';
    const job = state.setupJob;
    // Keep a started job as an overlap guard across /clear and /resume until
    // its stream has actually settled. A scheduled job never launched a child.
    if (job && !job.started) state.setupJob = null;
    if (job) {
      job.cancelled = true; job.scheduled?.cancel(); job.heartbeat?.cancel();
      if (job.session) {
        try { await $.process.run([state.helper, 'control', '--session', job.session, '--action', 'cancel'], { timeoutMs: 800 }); } catch { /* The setup lease also expires. */ }
      }
      job.stream?.return().catch(() => {});
    }
    const session = state.session; state.session = null;
    if (session) {
      try { await $.process.run([state.helper, 'control', '--session', session, '--action', 'cancel'], { timeoutMs: 800 }); }
      catch { /* Native lease is a second line of defence if shutdown is abrupt. */ }
    }
    state.phase = 'idle'; state.busy = false; state.inserting = false; state.error = '';
    state.ended = !['clear', 'resume'].includes(e.reason);
    $.ui.status(undefined);
    return next(e);
  });
}
