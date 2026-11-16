import { expect, mock, test } from 'claude-code/testing'
import type { ModelCompleteInput, ModelCompleteResult, On } from 'claude-code'

import type { Payload } from '../types'

// The narrator follow-ups inside the mod: the engine under it is mocked and
// the model call answered by the test. Advice on time, cards kept current,
// counts checked, and shell writes seen.

const HOME = 'C:\\Users\\me'
const WINDOWS = { USERPROFILE: HOME, OS: 'Windows_NT', AGENT_WATCH_BROWSER: 'none' } as const
const SESSION = { cwd: 'C:\\work\\shop', surface: 'terminal', isInteractive: true } as const
const LEAD = 'window.__AGENT_WATCH__ = '
const SPAWN = {
  tool_use_id: 'toolu_1',
  prompt: 'Read config.txt eight times, one at a time.',
  description: 'reread the config',
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
const STORY = { now: 'Reading config.txt', how: 'It reads the settings file.' }

type Rig = {
  asked: ModelCompleteInput[]
  reply: ModelCompleteResult
  written: { path: string; text: string }[]
  logged: string[]
  /** What the next tool call answers. */
  tool: { text: string; isError?: true }
}

function rig(on: On): Rig {
  const r: Rig = { asked: [], reply: { isAnswered: true, text: JSON.stringify(STORY), usage: USED }, written: [], logged: [], tool: { text: 'Line 1: debug = true' } }

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
  on('ui.log', (_, e) => {
    r.logged.push(e.text)

    return { value: undefined }
  })
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
  on('tool.call', () => ({ result: {}, ...r.tool }))

  return r
}

function dataOf(r: Rig): Payload {
  const text = r.written.filter(one => one.text.startsWith(LEAD)).at(-1)?.text ?? ''

  return JSON.parse(text.slice(LEAD.length, -2)) as Payload
}

const why = (input: ModelCompleteInput | undefined): string =>
  input?.prompt.split('\n').find(line => line.startsWith('Why you are asked now:')) ?? ''

test('an agent going in circles is asked about at once, before its 20 s are up', async ($, on) => {
  const r = rig(on)
  const clock = mock.clock(on)

  await $.session.start(SESSION)
  await $.agent.spawn(SPAWN)
  await clock.settle()
  await $.command.run(ASK_GUI)
  await $.tool.call({ tool: 'Read', file_path: 'C:\\work\\shop\\config.txt', agentId: 'a1' })
  await clock.advance(2000)
  expect(r.asked.length).toBe(1)

  // Two more reads of the same file: going in circles. The real clock has not moved, so this is inside 20 s.
  await $.tool.call({ tool: 'Read', file_path: 'C:\\work\\shop\\config.txt', agentId: 'a1' })
  await $.tool.call({ tool: 'Read', file_path: 'C:\\work\\shop\\config.txt', agentId: 'a1' })
  await clock.advance(2000)

  expect(r.asked.length).toBe(2)
  expect(why(r.asked[1])).toContain('found a trouble sign')
  expect(dataOf(r).cards?.agents.a1?.trouble?.[0]?.evidence).toBe('Read config.txt 3 times')

  // A second new sign at once: the skip is spent, it waits its turn.
  for (const _ of [1, 2, 3]) {
    await $.tool.call({ tool: 'Read', file_path: 'C:\\work\\shop\\gone.txt', agentId: 'a1' })
  }

  r.tool = { text: 'File does not exist.', isError: true }

  for (const _ of [1, 2, 3]) {
    await $.tool.call({ tool: 'Read', file_path: 'C:\\work\\shop\\missing.txt', agentId: 'a1' })
  }

  await clock.advance(2000)

  expect(dataOf(r).cards?.agents.a1?.trouble?.map(one => one.sign)).toContain('failing')
  expect(r.asked.length).toBe(2)
})

test('a narrator reply that miscounts reaches the page corrected, and the debug log says so', async ($, on) => {
  const r = rig(on)
  const clock = mock.clock(on)

  r.reply = {
    isAnswered: true,
    text: JSON.stringify({ ...STORY, progress: 'It has read config.txt 9 times of the 8 asked', percent: 100 }),
    usage: USED,
  }
  await $.session.start(SESSION)
  await $.agent.spawn(SPAWN)
  await clock.settle()
  await $.command.run(ASK_GUI)
  await $.tool.call({ tool: 'Read', file_path: 'C:\\work\\shop\\config.txt', agentId: 'a1' })
  await clock.advance(2000)

  const cards = dataOf(r).cards

  expect(cards?.agents.a1?.told?.progress).toBe('Counted from its steps: 1 read; 0 failed.')
  expect(cards?.agents.a1?.told?.percent).toBeUndefined()
  expect(cards?.narrator.corrected).toBe(1)
  expect(r.logged.some(line => line.includes('narrator count corrected (1 this session)') && line.includes('the tally has 1'))).toBe(true)
})

test('a command that writes outside the project shows as trouble, naming only the file', async ($, on) => {
  const r = rig(on)
  const clock = mock.clock(on)

  await $.session.start(SESSION)
  await $.agent.spawn(SPAWN)
  await clock.settle()
  await $.command.run(ASK_GUI)
  await $.tool.call({
    tool: 'PowerShell',
    command: "Set-Content -Path C:\\Users\\me\\elsewhere\\notes.txt -Value 'debug = true'",
    agentId: 'a1',
  })
  await clock.advance(2000)

  expect(dataOf(r).cards?.agents.a1?.trouble).toEqual([
    {
      sign: 'outside',
      evidence: 'Wrote outside this project with a command: notes.txt',
      advice: 'It wrote notes.txt outside this project with a command. Check that change before anything else.',
    },
  ])
  expect(r.asked[0]?.prompt).toContain('Trouble the rules found: Wrote outside this project with a command: notes.txt')
  // The full path is judged inside the mod and goes nowhere.
  expect(r.written.some(one => one.text.includes('elsewhere'))).toBe(false)
  expect(r.asked.some(one => one.prompt.includes('elsewhere'))).toBe(false)
})
