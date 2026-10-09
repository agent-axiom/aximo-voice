// No Node imports: Claude loads this ES module in its Mods sandbox.
// Keep every Mods API call literal and in this file for Claude's validator.
const COMMANDS = ['av', 'avoice', 'aximo-voice'];
const ACTIVE = new Set(['starting', 'loading', 'recording', 'stopping', 'transcribing', 'cancelling']);

export function newState() {
  return { phase: 'idle', engine: 'parakeet', pending: '', error: '', session: null,
    generation: 0, heartbeat: null, scheduled: null, polling: false, desired: null,
    inserting: false, ended: false, helper: '', windows: false, busy: false };
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
    setup: 'Setting up the local runtime and model…', review: 'Transcript ready · Insert to retry · Cancel to discard',
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
  if (!await $.fs.exists(state.helper)) {
    throw new Error('Native voice runtime is not installed. Run /av setup. This source preview requires a verified native build; see docs/installation.md.');
  }
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

async function start($, state) {
  if (state.busy || ACTIVE.has(state.phase) || state.ended) return;
  if (state.pending) { $.ui.toast('Insert or discard the pending dictation first.'); return; }
  state.busy = true;
  const epoch = state.generation;
  state.phase = 'starting'; redraw($, state);
  try {
    await resolveHelper($, state);
    const health = parseResult(await $.process.run([state.helper, 'doctor', '--engine', state.engine], { timeoutMs: 30000 }));
    if (state.ended || epoch !== state.generation) return;
    if (!health.modelReady) throw new Error('Download the speech model first with /av setup.');
    state.error = ''; state.desired = null; state.phase = 'starting';
    state.session = crypto.randomUUID();
    const session = state.session;
    const generation = ++state.generation;
    state.heartbeat = $.clock.every(1000, async () => poll($, state, generation));
    state.scheduled = $.clock.after(1, async () => record($, state, generation, session));
    redraw($, state);
  } finally { if (epoch === state.generation || state.session) state.busy = false; }
}

async function stop($, state, cancel) {
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

async function setup($, state, language) {
  if (state.busy || ACTIVE.has(state.phase) || state.phase === 'setup') return;
  if (state.pending) { $.ui.toast('Insert or discard the pending dictation before setup.'); return; }
  if (language && !['en', 'ru'].includes(language)) throw new Error('Use /av setup en or /av setup ru.');
  state.busy = true;
  const epoch = state.generation;
  try {
    const engine = language === 'ru' ? 'gigaam' : 'parakeet';
    const accepted = await $.ui.ask(`Install the local voice runtime from agent-axiom/aximo-voice on GitHub and download the ${engine === 'gigaam' ? 'GigaAM Russian' : 'Parakeet'} speech model from Hugging Face (up to 1 GB)? Audio stays on this computer; microphone access is requested only when you start dictation. Model licenses are linked in docs/model-licenses.md.`, ['Install and download', 'Cancel']);
    if (accepted !== 'Install and download' || state.ended || epoch !== state.generation) return;
    state.phase = 'setup'; redraw($, state);
    state.windows = (await $.env.get('OS')) === 'Windows_NT';
    state.helper = `${$.plugin.root}/bin/aximo-voice-native${state.windows ? '.exe' : ''}`;
    if (!await $.fs.exists(state.helper)) {
      const argv = state.windows
        ? ['powershell.exe', '-NoProfile', '-File', `${$.plugin.root}/scripts/install-runtime.ps1`]
        : ['sh', `${$.plugin.root}/scripts/install-runtime.sh`];
      const installed = await $.process.run(argv, { timeoutMs: 600000 });
      if (installed.exitCode !== 0) {
        const detail = typeof installed.stderr === 'string'
          ? installed.stderr.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, 350) : '';
        throw new Error(detail || 'Runtime installation failed. See docs/installation.md for build artifacts and release status.');
      }
    }
    if (state.ended || epoch !== state.generation) return;
    parseResult(await $.process.run([state.helper, 'setup-model', '--engine', engine], { timeoutMs: 600000 }));
    const health = parseResult(await $.process.run([state.helper, 'doctor', '--engine', engine], { timeoutMs: 30000 }));
    if (!health.modelReady) throw new Error('Model installation did not pass verification. Run setup again.');
    if (state.ended || epoch !== state.generation) return;
    state.engine = engine;
    await $.store.set('engine', engine);
    if (state.ended || epoch !== state.generation) return;
    state.phase = 'idle'; state.error = '';
    $.ui.toast('Ready. Run /av, speak, then choose Stop.');
    redraw($, state);
  } finally { if (epoch === state.generation) state.busy = false; }
}

async function dispatch($, state, args) {
  const epoch = state.generation;
  try {
    const [action = '', language, ...extra] = args.trim().split(/\s+/);
    if (extra.length) throw new Error('Use /av [start|stop|cancel|status|insert|setup en|setup ru].');
    if (action === 'setup') await setup($, state, language);
    else if (language) throw new Error('This action takes no extra arguments.');
    else if (action === 'cancel') await stop($, state, true);
    else if (action === 'stop') await stop($, state, false);
    else if (action === 'insert') await insert($, state);
    else if (action === 'status') redraw($, state);
    else if (action === 'start') await start($, state);
    else if (!action) {
      if (state.session) await stop($, state, false);
      else if (state.pending) await insert($, state);
      else await start($, state);
    } else throw new Error('Use /av [start|stop|cancel|status|insert|setup en|setup ru].');
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

function commandFailed($) {
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
        await $.command.register({ name, description: name === 'av' ? 'Dictate locally into the editable prompt' : 'Alias for /av: local dictation', argumentHint: '[start|stop|cancel|status|insert|setup en|setup ru]', immediate: true });
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
    if (!ACTIVE.has(state.phase) && !state.pending) return previous;
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return previous;
    const { Box, Text, Button } = $.ui.resolve(e);
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
