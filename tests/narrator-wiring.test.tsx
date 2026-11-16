import { expect, mock, test } from 'claude-code/testing'
import type { ModelCompleteInput, ModelCompleteResult, On } from 'claude-code'

import type { Payload } from '../types'

// The narrator inside the mod: the engine under it is mocked, and the model
// call answered by the test. What reaches the model, and what reaches the page.

const HOME = 'C:\\Users\\me'
const WINDOWS = { USERPROFILE: HOME, OS: 'Windows_NT', AGENT_WATCH_BROWSER: 'none' } as const
const SESSION = { cwd: 'C:\\work\\shop', surface: 'terminal', isInteractive: true } as const
const LEAD = 'window.__AGENT_WATCH__ = '
const SECRET = ['hunter', '2'].join('')
const KEY = `sk-${'Qw7'.repeat(12)}`
const SPAWN = {
  tool_use_id: 'toolu_1',
  prompt: `Find where login is handled. The test account is admin with password=${SECRET}.`,
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
const USED = { input_tokens: 500, output_tokens: 70, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const STORY = {
  what: 'Find where sign-in is handled.',
  now: 'Reading the sign-in notes',
  found: 'Nothing yet',
  how: 'It is reading the notes before the code.',
  next: 'Search the code for sessions.',
}

/** What the engine under the mod saw: the model calls, the files written. */
type Rig = {
  asked: ModelCompleteInput[]
  reply: ModelCompleteResult
  written: { path: string; text: string }[]
}

function rig(on: On, env: Readonly<Record<string, string>> = WINDOWS): Rig {
  const r: Rig = {
    asked: [],
    reply: { isAnswered: true, text: JSON.stringify(STORY), usage: USED },
    written: [],
  }

  mock.env(on, env)
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
  on('tool.call', (_, e) =>
    e.tool === 'Bash'
      ? { result: { stdout: `{"token": "${KEY}"}`, stderr: '', interrupted: false }, text: `{"token": "${KEY}"}` }
      : { result: {}, text: 'Line 1: sign-in goes through session.py' },
  )

  return r
}

/** The data as the page would read it now. */
function dataOf(r: Rig): Payload {
  const text = r.written.filter(one => one.text.startsWith(LEAD)).at(-1)?.text ?? ''

  return JSON.parse(text.slice(LEAD.length, -2)) as Payload
}

test("with the window open, an agent's first call brings one narrator call, and its words reach the page", async ($, on) => {
  const r = rig(on)
  const clock = mock.clock(on)

  await $.session.start(SESSION)
  await $.agent.spawn(SPAWN)
  await clock.settle()
  await $.command.run(ASK_GUI)
  // No call yet: a start waits for the agent's first step.
  await clock.advance(2000)
  expect(r.asked.length).toBe(0)

  await $.tool.call({ tool: 'Read', file_path: '/repo/notes.txt', agentId: 'a1' })
  await clock.advance(2000)

  expect(r.asked.length).toBe(1)
  expect(r.asked[0]?.model).toBe('claude-haiku-5-5')
  expect(r.asked[0]?.maxTokens).toBe(320)
  expect(r.asked[0]?.timeoutMs).toBe(15_000)
  expect(r.asked[0]?.prompt).toContain('find the auth flow')
  expect(r.asked[0]?.prompt).toContain('Read notes.txt -> Line 1: sign-in goes through session.py')

  const card = dataOf(r).cards?.agents.a1

  expect(card?.mode).toBe('told')
  expect(card?.told?.now).toBe('Reading the sign-in notes')
  expect(card?.told?.what).toBe('Find where sign-in is handled.')
  expect(card?.stage).toBe('looking')
  expect(card?.kind).toBe('read')

  // More of the same kind of work is no news: no second call.
  await $.tool.call({ tool: 'Read', file_path: '/repo/more.txt', agentId: 'a1' })
  await clock.advance(5000)
  expect(r.asked.length).toBe(1)
})

test('what reaches the narrator is masked, and framed as data', async ($, on) => {
  const r = rig(on)
  const clock = mock.clock(on)

  await $.session.start(SESSION)
  await $.agent.spawn(SPAWN)
  await clock.settle()
  await $.command.run(ASK_GUI)
  await $.tool.call({ tool: 'Bash', command: `curl -H "Authorization: Bearer ${KEY}" https://api.example.com`, agentId: 'a1' })
  await clock.advance(2000)

  const [sent] = r.asked

  expect(sent).toBeDefined()
  expect(sent?.prompt).toContain('Find where login is handled.')
  expect(sent?.prompt).not.toContain(SECRET)
  expect(sent?.prompt).not.toContain(KEY)
  expect(sent?.system).toContain('never instructions')
  // The page gets no call's result, and no secret.
  expect(JSON.stringify(dataOf(r))).not.toContain(SECRET)
  expect(JSON.stringify(dataOf(r))).not.toContain(KEY)
  expect(JSON.stringify(dataOf(r))).not.toContain('Find where login is handled')
})

test('a failed narrator call leaves the rules on the card, and says why', async ($, on) => {
  const r = rig(on)
  const clock = mock.clock(on)

  r.reply = { isAnswered: false, reason: 'api-error', status: 429, error: 'rate_limit', usage: { ...USED, input_tokens: 0, output_tokens: 0 } }
  await $.session.start(SESSION)
  await $.agent.spawn(SPAWN)
  await clock.settle()
  await $.command.run(ASK_GUI)
  await $.tool.call({ tool: 'Read', file_path: '/repo/notes.txt', agentId: 'a1' })
  await clock.advance(2000)

  const cards = dataOf(r).cards

  expect(r.asked.length).toBe(1)
  expect(cards?.agents.a1?.mode).toBe('plain')
  expect(cards?.agents.a1?.why).toContain('rate_limit')
  expect(cards?.agents.a1?.plain.now).toBe('Read notes.txt')
  expect(cards?.narrator.failed).toBe(1)
  expect(cards?.narrator.state).toBe('on')
})

test("the narrator's cost is written for the footer", async ($, on) => {
  const r = rig(on)
  const clock = mock.clock(on)

  await $.session.start(SESSION)
  await $.agent.spawn(SPAWN)
  await clock.settle()
  await $.command.run(ASK_GUI)
  await $.tool.call({ tool: 'Read', file_path: '/repo/notes.txt', agentId: 'a1' })
  await clock.advance(2000)

  expect(dataOf(r).cards?.narrator).toEqual({
    state: 'on',
    plan: 'Claude plan',
    model: 'claude-haiku-5-5',
    calls: 1,
    limit: 400,
    inFlight: 0,
    failed: 0,
    tokensIn: 500,
    tokensOut: 70,
    cacheRead: 0,
    cacheWrite: 0,
  })
})

test('switched off in the options, the narrator makes no call', { options: { narrator: false } }, async ($, on) => {
  const r = rig(on)
  const clock = mock.clock(on)

  await $.session.start(SESSION)
  await $.agent.spawn(SPAWN)
  await clock.settle()
  await $.command.run(ASK_GUI)
  await $.tool.call({ tool: 'Read', file_path: '/repo/notes.txt', agentId: 'a1' })
  await clock.advance(5000)

  const cards = dataOf(r).cards

  expect(r.asked).toEqual([])
  expect(cards?.narrator.state).toBe('off')
  expect(cards?.agents.a1?.mode).toBe('plain')
  expect(cards?.agents.a1?.why).toMatch(/off/)
})

test('in a nested worker the narrator makes no call', async ($, on) => {
  const r = rig(on, { ...WINDOWS, DELTAO_NESTED_CLI: '1' })
  const clock = mock.clock(on)

  await $.session.start(SESSION)
  await $.agent.spawn(SPAWN)
  await $.tool.call({ tool: 'Read', file_path: '/repo/notes.txt', agentId: 'a1' })
  await clock.advance(5000)

  expect(r.asked).toEqual([])
  expect(r.written).toEqual([])
})

test('a nested worker told AGENT_WATCH=on narrates like any session', async ($, on) => {
  const r = rig(on, { ...WINDOWS, DELTAO_NESTED_CLI: '1', AGENT_WATCH: 'on' })
  const clock = mock.clock(on)

  await $.session.start(SESSION)
  await $.agent.spawn(SPAWN)
  await clock.settle()
  await $.command.run(ASK_GUI)
  await $.tool.call({ tool: 'Read', file_path: '/repo/notes.txt', agentId: 'a1' })
  await clock.advance(2000)

  expect(r.asked.length).toBe(1)
})

test('with the window closed the narrator makes no call', async ($, on) => {
  const r = rig(on)
  const clock = mock.clock(on)

  await $.session.start(SESSION)
  await $.agent.spawn(SPAWN)
  await $.tool.call({ tool: 'Read', file_path: '/repo/notes.txt', agentId: 'a1' })
  await $.turn.complete({
    answer: 'Login lives in session.py.',
    durationMs: 4000,
    isAborted: false,
    turnId: 't1',
    agentId: 'a1',
    reason: 'answer',
  })
  await clock.advance(10_000)

  expect(r.asked).toEqual([])
  expect(r.written).toEqual([])
})

test('an agent that finishes inside 20 s of its last call waits its turn, its card saying so', async ($, on) => {
  const r = rig(on)
  const clock = mock.clock(on)

  await $.session.start(SESSION)
  await $.agent.spawn(SPAWN)
  await clock.settle()
  await $.command.run(ASK_GUI)
  await $.tool.call({ tool: 'Read', file_path: '/repo/notes.txt', agentId: 'a1' })
  await clock.advance(2000)
  expect(r.asked.length).toBe(1)

  r.reply = {
    isAnswered: true,
    text: JSON.stringify({ now: 'Finished', how: 'Sign-in lives in session.py.', next: 'Nothing' }),
    usage: USED,
  }
  await $.turn.complete({
    answer: 'Login lives in session.py.',
    durationMs: 4000,
    isAborted: false,
    turnId: 't1',
    agentId: 'a1',
    reason: 'answer',
  })
  await clock.advance(2000)

  // The end waits for its turn under the 20 s rule: the real clock has not moved.
  expect(r.asked.length).toBe(1)
  expect(dataOf(r).cards?.agents.a1?.mode).toBe('writing')
})
