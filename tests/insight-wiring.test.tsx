import { expect, mock, test } from 'claude-code/testing'
import type { ModelCompleteInput, ModelCompleteResult, On } from 'claude-code'

import type { Payload } from '../types'

// Trouble, progress and advice inside the mod: the engine under it is mocked
// and the model call answered by the test. What the page gets, what the
// narrator is told, and that a full path reaches neither.

const HOME = 'C:\\Users\\me'
const WINDOWS = { USERPROFILE: HOME, OS: 'Windows_NT', AGENT_WATCH_BROWSER: 'none' } as const
const SESSION = { cwd: 'C:\\work\\shop', surface: 'terminal', isInteractive: true } as const
const LEAD = 'window.__AGENT_WATCH__ = '
const SPAWN = {
  tool_use_id: 'toolu_1',
  prompt: 'Find where login is handled.',
  description: 'find the auth flow',
  subagentType: 'Explore',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-fable-5-2',
  background: true,
  fork: false,
} as const
const ASK_GUI = {
  command: 'agent-watch',
  args: 'gui',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
} as const
const USED = { input_tokens: 1500, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const STORY = { now: 'Reading the sign-in code', how: 'It reads the code before it changes anything.' }

type Rig = { asked: ModelCompleteInput[]; reply: ModelCompleteResult; written: { path: string; text: string }[] }

function rig(on: On): Rig {
  const r: Rig = { asked: [], reply: { isAnswered: true, text: JSON.stringify(STORY), usage: USED }, written: [] }

  mock.env(on, WINDOWS)
  // A claude.ai login: the money guard lets the narrator run.
  on('session.authorize', () => ({ value: { handle: 'h1', kind: 'bearer' } }))
  on('command.register', () => ({ value: { command: 'agent-watch' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__agent-watch__snapshot' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('agent.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.read', (_, e) => ({ value: e.path.endsWith('index.html') ? '<script src="__AW_SID__.js"></script>' : '' }))
  on('fs.write', (_, e) => {
    r.written.push({ path: e.path, text: e.text })

    return { value: undefined }
  })
  on('model.complete', (_, e) => {
    r.asked.push(e)

    return { value: r.reply }
  })
  on('tool.call', () => ({ result: {}, text: 'Line 1: done' }))

  return r
}

function dataOf(r: Rig): Payload {
  const text = r.written.filter(one => one.text.startsWith(LEAD)).at(-1)?.text ?? ''

  return JSON.parse(text.slice(LEAD.length, -2)) as Payload
}

test('an edit outside the project shows as trouble, naming only the file', async ($, on) => {
  const r = rig(on)
  const clock = mock.clock(on)

  await $.session.start(SESSION)
  await $.agent.spawn(SPAWN)
  await clock.settle()
  await $.command.run(ASK_GUI)
  await $.tool.call({
    tool: 'Edit',
    file_path: 'C:\\Users\\me\\elsewhere\\settings.json',
    old_string: 'debug = false',
    new_string: 'debug = true',
    agentId: 'a1',
  })
  await clock.advance(2000)

  expect(dataOf(r).cards?.agents.a1?.trouble).toEqual([
    {
      sign: 'outside',
      evidence: 'Changed a file outside this project: settings.json',
      advice: 'It changed settings.json outside this project. Check that change before anything else.',
    },
  ])
  expect(r.asked.length).toBe(1)
  expect(r.asked[0]?.prompt).toContain('Trouble the rules found: Changed a file outside this project: settings.json')
  // The full path is judged inside the mod and goes nowhere.
  expect(r.written.some(one => one.text.includes('elsewhere'))).toBe(false)
  expect(r.asked.some(one => one.prompt.includes('elsewhere'))).toBe(false)
})

test('an edit inside the project is no trouble', async ($, on) => {
  const r = rig(on)
  const clock = mock.clock(on)

  await $.session.start(SESSION)
  await $.agent.spawn(SPAWN)
  await clock.settle()
  await $.command.run(ASK_GUI)
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\Work\\Shop\\src\\auth.py', old_string: 'a', new_string: 'b', agentId: 'a1' })
  await clock.advance(2000)

  expect(dataOf(r).cards?.agents.a1?.trouble).toBeUndefined()
})

test('an agent reading the same file three times shows going in circles, and the narrator is told', async ($, on) => {
  const r = rig(on)
  const clock = mock.clock(on)

  await $.session.start(SESSION)
  await $.agent.spawn(SPAWN)
  await clock.settle()

  for (const _ of [1, 2, 3]) {
    await $.tool.call({ tool: 'Read', file_path: 'C:\\work\\shop\\config.py', agentId: 'a1' })
  }

  await clock.settle()
  await $.command.run(ASK_GUI)
  await clock.advance(2000)

  expect(dataOf(r).cards?.agents.a1?.trouble?.[0]).toEqual({
    sign: 'circles',
    evidence: 'Read config.py 3 times',
    advice: 'It has done the same step 3 times. If it keeps on, stop it and tell it exactly where to look.',
  })
  expect(r.asked[0]?.prompt).toContain('Read config.py 3 times (going in circles)')
  expect(r.asked[0]?.prompt).toContain('Files it read (names only): config.py')
})

test("the narrator's progress and advice reach the page", async ($, on) => {
  const r = rig(on)
  const clock = mock.clock(on)

  r.reply = {
    isAnswered: true,
    text: JSON.stringify({ ...STORY, progress: 'Half the handlers read', percent: '50', advice: 'Nothing to do, it is on track' }),
    usage: USED,
  }
  await $.session.start(SESSION)
  await $.agent.spawn(SPAWN)
  await clock.settle()
  await $.command.run(ASK_GUI)
  await $.tool.call({ tool: 'Read', file_path: 'C:\\work\\shop\\auth.py', agentId: 'a1' })
  await clock.advance(2000)

  const card = dataOf(r).cards?.agents.a1

  expect(card?.mode).toBe('told')
  expect(card?.told?.progress).toBe('Half the handlers read')
  expect(card?.told?.percent).toBe(50)
  expect(card?.advice).toBe('Nothing to do, it is on track')
  expect(dataOf(r).cards?.narrator.tokensIn).toBe(1500)
})

test('the narrator reads the brief up to 600 letters', async ($, on) => {
  const r = rig(on)
  const clock = mock.clock(on)

  await $.session.start(SESSION)
  await $.agent.spawn({ ...SPAWN, prompt: `Find where login is handled. ${'Detail. '.repeat(58)}The tail is here.` })
  await clock.settle()
  await $.command.run(ASK_GUI)
  await $.tool.call({ tool: 'Read', file_path: 'C:\\work\\shop\\auth.py', agentId: 'a1' })
  await clock.advance(2000)

  expect(r.asked[0]?.prompt).toContain('The tail is here.')
})
