import { expect, mock, test } from 'claude-code/testing'

function stubs(on, response = {type: 'transcript', text: 'hello from local voice'}) {
  const clock = mock.clock(on)
  mock.store(on, {})
  mock.env(on, {})
  const calls: string[][] = [], fills: {text: string, mode: string}[] = []
  let isFilled = true
  on('fs.exists', () => ({value: true}))
  on('ui.toast', () => ({value: undefined}))
  on('ui.status', () => ({value: undefined}))
  on('ui.render', () => ({type: 'Text', props: {}, children: ['Existing Claude UI']}))
  on('process.run', ($, e) => {
    calls.push(e.argv)
    const value = e.argv[1] === 'doctor' ? {modelReady: true} : e.argv[1] === 'control' ? {state: 'recording'} : response
    return {value: {exitCode: 0, stdout: JSON.stringify(value), stderr: ''}}
  })
  on('prompt.fill', ($, e) => {fills.push({text: e.text, mode: e.mode});return {isFilled}})
  return {clock, calls, fills, setFilled(value: boolean) {isFilled = value}}
}

test('real Mods host loads plugin and inserts an editable draft', async ($, on) => {
  const h = stubs(on)
  expect(await $.command.run({command: 'aximo-voice', origin: {kind: 'composer'}, args: 'start'})).toEqual({})
  await h.clock.advance(1)
  expect(h.fills).toEqual([{text: 'hello from local voice', mode: 'insert'}])
  expect(h.calls.filter(argv => argv[1] === 'record').length).toBe(1)
})

test('pending dictation renders and inserts on terminal and desktop', async ($, on) => {
  const h = stubs(on)
  h.setFilled(false)
  await $.command.run({command: 'aximo-voice', origin: {kind: 'composer'}, args: 'start'})
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
  await $.command.run({command: 'aximo-voice', origin: {kind: 'composer'}, args: 'insert'})
  expect(h.fills.length).toBe(4)
})

test('cancel before background start never launches microphone', async ($, on) => {
  const h = stubs(on)
  await $.command.run({command: 'aximo-voice', origin: {kind: 'composer'}, args: 'start'})
  await $.command.run({command: 'aximo-voice', origin: {kind: 'composer'}, args: 'cancel'})
  await h.clock.advance(1)
  expect(h.fills).toEqual([])
  expect(h.calls.filter(argv => argv[1] === 'record').length).toBe(0)
})

test('empty speech never fills the prompt', async ($, on) => {
  const h = stubs(on, {type: 'transcript', text: ' '})
  await $.command.run({command: 'aximo-voice', origin: {kind: 'composer'}, args: 'start'})
  await h.clock.advance(1)
  expect(h.fills).toEqual([])
})

test('native error never becomes a model prompt', async ($, on) => {
  const h = stubs(on, {type: 'error', error: 'Microphone permission denied'})
  expect(await $.command.run({command: 'aximo-voice', origin: {kind: 'composer'}, args: 'start'})).toEqual({})
  await h.clock.advance(1)
  expect(h.fills).toEqual([])
})

test('engine-stamped non-person origin is refused before native work', async ($, on) => {
  const h = stubs(on)
  await $.command.run({command: 'aximo-voice', args: 'start', origin: {kind: 'plugin', name: 'other'}})
  await h.clock.advance(1)
  expect(h.calls).toEqual([])
  expect(h.fills).toEqual([])
})
