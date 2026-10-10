import { expect, mock, test } from 'claude-code/testing'

const MODELS = {
  parakeet: {repo: 'istupakov/parakeet-tdt-0.6b-v3-onnx', revision: '8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce', license: 'cc-by-4.0', files: [{size: 670619706, sha256: 'a'.repeat(64)}]},
  gigaam: {repo: 'istupakov/gigaam-v3-onnx', revision: '322c3b29492673eb7d0b434bfa9dfb8653e34d02', license: 'mit', files: [{size: 885952086, sha256: 'a'.repeat(64)}]},
}
const BAND = {plugin: 'aximo-voice', component: 'AbovePrompt', requestId: 'above', viewport: {columns: 100, rows: 30}, props: {hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 100, scroll: {offset: 0, bodyRows: 8}, view: {}}} as const

async function stubs($, on, response = {type: 'transcript', text: 'hello from local voice'}, refusedCommands: string[] = [], missingCommandHandler = false, setup: {modelReady?: boolean, answers?: string[], failure?: string, denySpawn?: boolean, runtimeVersion?: string, delayMs?: number} = {}) {
  const clock = mock.clock(on)
  mock.store(on, {})
  mock.env(on, {})
  const calls: string[][] = [], fills: {text: string, mode: string}[] = [], commands: {name: string, immediate?: boolean}[] = [], toasts: string[] = [], questions: string[] = [], statuses: string[] = []
  on('session.start', () => ({cwd: '/work'}))
  if (!missingCommandHandler) on('command.run', () => ({text: 'other command'}))
  on('command.register', ($, e) => {
    commands.push(e)
    return refusedCommands.includes(e.name) ? {deny: 'Command name taken'} : {value: {command: e.name}}
  })
  let isFilled = true
  on('fs.exists', () => ({value: true}))
  on('ui.toast', ($, e) => {toasts.push(e.text);return {value: undefined}})
  on('ui.status', ($, e) => {statuses.push(e.text);return {value: undefined}})
  on('fs.read', () => ({value: JSON.stringify(MODELS)}))
  on('tool.call', {tool: 'AskUserQuestion'}, ($, e) => {const question = e.questions[0].question;questions.push(question);return {result: {answers: {[question]: setup.answers?.shift() || 'Cancel'}}}})
  on('ui.render', () => ({type: 'Text', props: {}, children: ['Existing Claude UI']}))
  let modelReady = setup.modelReady !== false, cancelled = false
  on('process.spawn', async function* ($, e) {
    calls.push([...e.argv])
    if (setup.denySpawn) return {deny: 'Blocked by organization policy'}
    const engine = e.argv[3]
    const envelope = {protocol: 1, operation: 'setup-model', engine}
    yield {stream: 'stdout', text: JSON.stringify({...envelope, type: 'progress', stage: 'downloading', bytesCompleted: 100000000, totalBytes: MODELS[engine].files[0].size, reusedBytes: 0}) + '\n'}
    if (setup.delayMs) await clock.sleep(setup.delayMs)
    if (cancelled) {yield {stream: 'stdout', text: JSON.stringify({...envelope, type: 'cancelled'})+'\n'};return {value: {code: 0, signal: null}}}
    yield {stream: 'stdout', text: JSON.stringify({...envelope, type: 'progress', stage: 'verifying', bytesCompleted: MODELS[engine].files[0].size, totalBytes: MODELS[engine].files[0].size, reusedBytes: 0}) + '\n'}
    if (setup.failure) {yield {stream: 'stdout', text: JSON.stringify({...envelope, type: 'error', error: setup.failure})+'\n'};return {value: {code: 1, signal: null}}}
    modelReady = true
    yield {stream: 'stdout', text: JSON.stringify({...envelope, type: 'ready'}) + '\n'}
    return {value: {code: 0, signal: null}}
  })
  on('process.run', ($, e) => {
    calls.push(e.argv)
    if (e.argv[1] === 'control' && e.argv.at(-1) === 'cancel') cancelled = true
    const value = e.argv[1] === 'doctor' ? {type: 'doctor', engine: e.argv[3], runtimeVersion: setup.runtimeVersion || '0.1.0', setupProgressProtocol: 1, modelReady} : e.argv[1] === 'control' ? {state: 'recording'} : response
    return {value: {exitCode: 0, stdout: JSON.stringify(value), stderr: ''}}
  })
  on('prompt.fill', ($, e) => {fills.push({text: e.text, mode: e.mode});return {isFilled}})
  await $.session.start({surface: 'terminal', isInteractive: true, cwd: '/work'})
  return {clock, calls, fills, commands, toasts, questions, statuses, setFilled(value: boolean) {isFilled = value}}
}

test('real Mods host loads plugin and inserts an editable draft', async ($, on) => {
  const h = await stubs($, on)
  expect(await $.command.run({command: 'av', origin: {kind: 'composer'}, args: 'start'})).toEqual({})
  await h.clock.advance(1)
  expect(h.fills).toEqual([{text: 'hello from local voice', mode: 'insert'}])
  expect(h.calls.filter(argv => argv[1] === 'record').length).toBe(1)
})

test('pending dictation renders and inserts on terminal and desktop', async ($, on) => {
  const h = await stubs($, on)
  h.setFilled(false)
  await $.command.run({command: 'av', origin: {kind: 'composer'}, args: 'start'})
  await h.clock.advance(1)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({plugin: 'aximo-voice', component: 'AbovePrompt', surface,
      requestId: 'above', viewport: {columns: 100, rows: 30},
      props: {hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 100, scroll: {offset: 0, bodyRows: 8}, view: {}}})
    expect(await ui.find({key: 'aximo-insert'})).toBeDefined()
    expect(await ui.find({key: 'aximo-cancel'})).toBeDefined()
    await ui.press({key: 'aximo-insert'})
    await ui.unmount()
  }
  expect(h.fills.length).toBe(3)
  h.setFilled(true)
  await $.command.run({command: 'av', origin: {kind: 'composer'}, args: 'insert'})
  expect(h.fills.length).toBe(4)
})

test('cancel before background start never launches microphone', async ($, on) => {
  const h = await stubs($, on)
  await $.command.run({command: 'av', origin: {kind: 'composer'}, args: 'start'})
  await $.command.run({command: 'av', origin: {kind: 'composer'}, args: 'cancel'})
  await h.clock.advance(1)
  expect(h.fills).toEqual([])
  expect(h.calls.filter(argv => argv[1] === 'record').length).toBe(0)
})

test('empty speech never fills the prompt', async ($, on) => {
  const h = await stubs($, on, {type: 'transcript', text: ' '})
  await $.command.run({command: 'av', origin: {kind: 'composer'}, args: 'start'})
  await h.clock.advance(1)
  expect(h.fills).toEqual([])
})

test('native error never becomes a model prompt', async ($, on) => {
  const h = await stubs($, on, {type: 'error', error: 'Microphone permission denied'})
  expect(await $.command.run({command: 'av', origin: {kind: 'composer'}, args: 'start'})).toEqual({})
  await h.clock.advance(1)
  expect(h.fills).toEqual([])
})

test('engine-stamped non-person origin is refused before native work', async ($, on) => {
  const h = await stubs($, on)
  await $.command.run({command: 'av', args: 'start', origin: {kind: 'plugin', name: 'other'}})
  await h.clock.advance(1)
  expect(h.calls).toEqual([])
  expect(h.fills).toEqual([])
})

test('real Mods host accepts registration calls for all immediate names', async ($, on) => {
  const h = await stubs($, on)
  expect(h.commands.map(c => c.name)).toEqual(['av', 'avoice', 'aximo-voice'])
  expect(h.commands.every(c => c.immediate === true)).toBe(true)
  expect(h.calls).toEqual([])
})

for (const command of ['avoice', 'aximo-voice']) {
  test(`${command} alias inserts an editable draft`, async ($, on) => {
    const h = await stubs($, on)
    expect(await $.command.run({command, args: '', origin: {kind: 'composer'}})).toEqual({})
    await h.clock.advance(1)
    expect(h.fills).toEqual([{text: 'hello from local voice', mode: 'insert'}])
  })
  test(`${command} alias refuses non-person origins`, async ($, on) => {
    const h = await stubs($, on)
    await $.command.run({command, args: 'start', origin: {kind: 'plugin', name: 'other'}})
    await h.clock.advance(1)
    expect(h.calls).toEqual([])
    expect(h.fills).toEqual([])
  })
}

test('short and legacy names share one cancellable session', async ($, on) => {
  const h = await stubs($, on)
  await $.command.run({command: 'av', args: '', origin: {kind: 'composer'}})
  await $.command.run({command: 'avoice', args: 'start', origin: {kind: 'composer'}})
  await $.command.run({command: 'aximo-voice', args: 'cancel', origin: {kind: 'composer'}})
  await h.clock.advance(1)
  expect(h.calls.filter(argv => argv[1] === 'doctor').length).toBe(1)
  expect(h.calls.filter(argv => argv[1] === 'record').length).toBe(0)
  expect(h.fills).toEqual([])
})

test('a refused short name passes through while another alias stays usable', async ($, on) => {
  const h = await stubs($, on, undefined, ['av'])
  expect(await $.command.run({command: 'av', args: 'start', origin: {kind: 'composer'}})).toEqual({text: 'other command'})
  expect(h.calls).toEqual([])
  await $.command.run({command: 'avoice', args: 'start', origin: {kind: 'composer'}})
  await h.clock.advance(1)
  expect(h.fills).toEqual([{text: 'hello from local voice', mode: 'insert'}])
})


test('a refused name preserves downstream errors without a voice failure toast', async ($, on) => {
  const h = await stubs($, on, undefined, ['av'], true)
  let failure = ''
  try {
    await $.command.run({command: 'av', args: 'start', origin: {kind: 'composer'}})
  } catch (error) { failure = String(error) }
  expect(failure).toMatch(/no implementation for command.run/)
  expect(h.toasts).toEqual(['Aximo Voice could not register /av. Check /help for the available voice commands.'])
  expect(h.calls).toEqual([])
})

test('first /av streams setup through the real Mods host and leaves Start on both surfaces', async ($, on) => {
  const h = await stubs($, on, undefined, [], false, {modelReady: false, answers: ['Russian (GigaAM)', 'Download model']})
  expect(await $.command.run({command: 'av', args: '', origin: {kind: 'composer'}})).toEqual({})
  expect(h.questions.length).toBe(2)
  expect(h.questions[1]).toMatch(/885952086 bytes/)
  expect(h.questions[1]).toMatch(/MIT/)
  await h.clock.advance(1)
  expect(h.calls.filter(argv => argv[1] === 'setup-model').length).toBe(1)
  expect(h.calls.filter(argv => argv[1] === 'record').length).toBe(0)
  expect(h.statuses.some(text => text?.includes('Downloading 100.0 / 886.0 MB'))).toBe(true)
  expect(h.statuses.some(text => text?.includes('Verifying SHA-256'))).toBe(true)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({...BAND, surface})
    expect(await ui.find({key: 'aximo-start'})).toBeDefined()
    expect(await ui.find({key: 'aximo-cancel'})).toBeDefined()
    await ui.unmount()
  }
  expect(h.fills).toEqual([])
  const ui = await $.ui.mount({...BAND, surface: 'terminal'})
  await ui.press({key: 'aximo-start'})
  await h.clock.advance(1)
  expect(h.calls.filter(argv => argv[1] === 'record').length).toBe(1)
  expect(h.fills).toEqual([{text: 'hello from local voice', mode: 'insert'}])
})

test('first-run model consent decline does not launch a stream', async ($, on) => {
  const h = await stubs($, on, undefined, [], false, {modelReady: false, answers: ['English (Parakeet)', 'Cancel']})
  await $.command.run({command: 'av', args: '', origin: {kind: 'composer'}})
  await h.clock.advance(1)
  expect(h.calls.filter(argv => argv[1] === 'setup-model').length).toBe(0)
  expect(h.calls.filter(argv => argv[1] === 'record').length).toBe(0)
  expect(h.questions[1]).toMatch(/670619706 bytes/)
  expect(h.questions[1]).toMatch(/CC BY 4.0/)
})

test('setup Cancel on desktop prevents scheduled download and capture', async ($, on) => {
  const h = await stubs($, on, undefined, [], false, {answers: ['Download model']})
  await $.command.run({command: 'av', args: 'setup ru', origin: {kind: 'composer'}})
  const ui = await $.ui.mount({...BAND, surface: 'desktop'})
  await ui.press({key: 'aximo-cancel'})
  await h.clock.advance(1)
  expect(h.calls.filter(argv => argv[1] === 'setup-model').length).toBe(0)
  expect(h.calls.filter(argv => argv[1] === 'record').length).toBe(0)
})

test('setup error renders Retry and Cancel through real terminal and desktop elements', async ($, on) => {
  const h = await stubs($, on, undefined, [], false, {answers: ['Download model', 'Cancel'], failure: 'SHA-256 mismatch'})
  await $.command.run({command: 'av', args: 'setup en', origin: {kind: 'composer'}})
  await h.clock.advance(1)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({...BAND, surface})
    expect(await ui.find({key: 'aximo-retry'})).toBeDefined()
    expect(await ui.find({key: 'aximo-cancel'})).toBeDefined()
    await ui.unmount()
  }
  expect(h.statuses.at(-1)).toMatch(/SHA-256 mismatch/)
  const ui = await $.ui.mount({...BAND, surface: 'terminal'})
  await ui.press({key: 'aximo-retry'})
  expect(h.questions.length).toBe(2)
  expect(h.calls.filter(argv => argv[1] === 'record').length).toBe(0)
})

test('administrator-denied stream fails visibly with no alternate process route', async ($, on) => {
  const h = await stubs($, on, undefined, [], false, {answers: ['Download model'], denySpawn: true})
  await $.command.run({command: 'av', args: 'setup en', origin: {kind: 'composer'}})
  await h.clock.advance(1)
  expect(h.statuses.at(-1)).toMatch(/Blocked by organization policy/)
  expect(h.calls.filter(argv => argv[1] === 'setup-model').length).toBe(1)
  expect(h.calls.filter(argv => argv[1] === 'record').length).toBe(0)
})

test('incompatible helper fails before download or microphone in the actual host', async ($, on) => {
  const h = await stubs($, on, undefined, [], false, {answers: ['Download model'], runtimeVersion: '9.0.0'})
  await $.command.run({command: 'av', args: 'setup en', origin: {kind: 'composer'}})
  await h.clock.advance(1)
  expect(h.statuses.at(-1)).toMatch(/Unsupported Aximo Voice runtime/)
  expect(h.questions).toEqual([])
  expect(h.calls.filter(argv => argv[1] === 'setup-model').length).toBe(0)
  expect(h.calls.filter(argv => argv[1] === 'record').length).toBe(0)
})

test('Cancel during a pending stream waits for native cancellation before Retry or Start', async ($, on) => {
  const h = await stubs($, on, undefined, [], false, {answers: ['Download model'], delayMs: 1000})
  await $.command.run({command: 'av', args: 'setup ru', origin: {kind: 'composer'}})
  await h.clock.advance(1)
  const ui = await $.ui.mount({...BAND, surface: 'terminal'})
  await ui.press({key: 'aximo-cancel'})
  await $.command.run({command: 'av', args: 'start', origin: {kind: 'composer'}})
  expect(h.statuses.at(-1)).toMatch(/Cancelling setup/)
  await h.clock.advance(1000)
  expect(h.calls.some(argv => argv[1] === 'control' && argv.at(-1) === 'cancel')).toBe(true)
  expect(h.calls.filter(argv => argv[1] === 'record').length).toBe(0)
  expect(h.fills).toEqual([])
  expect(await ui.find({key: 'aximo-start'})).toBeUndefined()
})
