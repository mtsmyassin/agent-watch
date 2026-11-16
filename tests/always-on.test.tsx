import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { ModelCompleteInput, ModelCompleteResult, On } from 'claude-code'

import { PAID_WHY } from '../hooks/billing'
import { BACKOFF_MS, cardsOf, EMPTY, landed, planned } from '../hooks/narrator'
import type { Ask, Reply } from '../hooks/narrator'
import { born } from '../hooks/roster'
import type { AgentRow, Call, Narration, Payload, Story } from '../types'

// The narrator stays on: failures pause it for a while instead of stopping it
// for the session, and it runs only where the session does not pay per call.

const T = 1_800_000_000_000
const NONE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const USED = { input_tokens: 1500, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const STORY = { now: 'Reading the sign-in code', how: 'It reads the code before it changes anything.' }
const READ: Call = { key: 'k1', doing: 'Reading a.py', did: 'Read a.py', at: T + 100, end: T + 200, kind: 'read' }
const live = (id: string): AgentRow => born(id, T, { type: 'Explore', description: `task of ${id}` })
const refused = (error: string, status: number | null = 529): Reply => ({ isAnswered: false, reason: 'api-error', error, status, usage: NONE })
const answer: Reply = { isAnswered: true, text: JSON.stringify(STORY), usage: USED }

/** One round: a moment waits for a1, the narrator asks at `at`, and the reply lands a moment later. */
function round(n: Narration, at: number, reply: Reply): Narration {
  const ready: Narration = {
    stories: { a1: { ...((n.stories.a1 ?? { seen: { stage: 'looking', kind: 'read', health: 'working' } }) as Story), pending: 'stage' } },
    ledger: n.ledger,
  }
  // The agent took a step just now: only the narrator's own failures are in play.
  const plan = planned(ready, [{ ...live('a1'), seenAt: at }], { a1: { calls: [READ], dropped: 0 } }, at)

  expect(plan.asks.length).toBe(1)

  return landed(plan.narration, plan.asks[0] as Ask, reply, at + 1)
}

const waiting = (n: Narration, at: number): number =>
  planned(
    { stories: { a1: { ...(n.stories.a1 as Story), pending: 'stage' } }, ledger: n.ledger },
    [{ ...live('a1'), seenAt: at }],
    { a1: { calls: [READ], dropped: 0 } },
    at,
  ).asks.length

test('failures back off 1, 2, 5, then every 5 minutes, and never stop the session', () => {
  expect(BACKOFF_MS).toEqual([60_000, 120_000, 300_000])

  // A sign-in that ran out: it pauses a minute, says why, then tries again.
  let n = round(EMPTY, T + 1000, refused('authentication_failed', 401))

  expect(n.ledger.halt).toBeUndefined()
  expect(n.ledger.pausedUntil).toBe(T + 1001 + 60_000)
  expect(waiting(n, T + 61_000)).toBe(0)

  const card = cardsOf([live('a1')], { a1: { calls: [READ], dropped: 0 } }, n, T + 2000, true)

  expect(card.narrator.state).toBe('paused')
  expect(card.narrator.until).toBe(T + 61_001)
  expect(card.narrator.why).toMatch(/sign in/i)
  expect(card.agents.a1?.mode).toBe('plain')

  // Each pause in a row is longer: 2 minutes, then 5, then 5 again.
  n = round(n, T + 61_001, refused('authentication_failed', 401))
  expect(n.ledger.pausedUntil).toBe(T + 61_002 + 120_000)
  n = round(n, T + 181_002, refused('billing_error', 400))
  expect(n.ledger.pausedUntil).toBe(T + 181_003 + 300_000)
  n = round(n, T + 481_003, { isAnswered: false, reason: 'refused', usage: NONE })
  expect(n.ledger.pausedUntil).toBe(T + 481_004 + 300_000)
  expect(n.ledger.halt).toBeUndefined()

  // One that works ends the streak.
  n = round(n, T + 781_004, answer)
  expect(n.ledger.pausedUntil).toBeUndefined()
  expect(n.ledger.pauses).toBeUndefined()
  expect(n.ledger.inARow).toBe(0)
  expect(cardsOf([live('a1')], { a1: { calls: [READ], dropped: 0 } }, n, T + 781_006, true).narrator.state).toBe('on')

  // Three ordinary failures in a row pause it too, from the first step again.
  for (const at of [T + 900_000, T + 930_000]) {
    n = round(n, at, refused('overloaded'))
    expect(n.ledger.pausedUntil).toBeUndefined()
  }

  n = round(n, T + 960_000, refused('overloaded'))
  expect(n.ledger.pausedUntil).toBe(T + 960_001 + 60_000)
})

test('a second failure landing during a pause does not stretch it', () => {
  const two = [live('a1'), live('a2')]
  const trails = { a1: { calls: [READ], dropped: 0 }, a2: { calls: [READ], dropped: 0 } }
  const plan = planned(EMPTY, two, trails, T + 1000)

  expect(plan.asks.length).toBe(2)

  const first = landed(plan.narration, plan.asks[0] as Ask, refused('authentication_failed', 401), T + 2000)
  const second = landed(first, plan.asks[1] as Ask, refused('authentication_failed', 401), T + 2500)

  expect(second.ledger.pausedUntil).toBe(T + 2000 + 60_000)
  expect(second.ledger.pauses).toBe(1)
})

test('on a paid session the cards say why, and on the Max plan they name it', () => {
  const trails = { a1: { calls: [READ], dropped: 0 } }
  const paid = cardsOf([live('a1')], trails, EMPTY, T + 1000, true, { isPaid: true, why: PAID_WHY })

  expect(paid.narrator.state).toBe('off')
  expect(paid.narrator.why).toBe(PAID_WHY)
  expect(paid.agents.a1?.mode).toBe('plain')
  expect(paid.agents.a1?.why).toBe(PAID_WHY)

  const max = cardsOf([live('a1')], trails, EMPTY, T + 1000, true, { isPaid: false, plan: 'Max plan' })

  expect(max.narrator.state).toBe('on')
  expect(max.narrator.plan).toBe('Max plan')
})

// --- In the mod --------------------------------------------------------------

const HOME = 'C:\\Users\\me'
const CONFIG = 'C:\\Users\\me\\.claude.json'
const SESSION = { cwd: 'C:\\work\\shop', surface: 'terminal', isInteractive: true } as const
const LEAD = 'window.__AGENT_WATCH__ = '
const KEY = `sk-ant-api03-${'q'.repeat(40)}AbCdEfGhIjKlMnOpQrSt`
const TAIL = 'AbCdEfGhIjKlMnOpQrSt'
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
/** His config file as Claude Code keeps it: the env key rejected, a Max login. */
const HIS_CONFIG = JSON.stringify({
  customApiKeyResponses: { approved: [], rejected: [TAIL] },
  oauthAccount: { organizationType: 'claude_max', emailAddress: 'someone@example.com' },
})

type Credential = { handle: string; kind: 'bearer' | 'api-key' } | null | 'denied'
type Rig = { asked: ModelCompleteInput[]; written: { path: string; text: string }[]; logged: string[]; configReads: number }

function rig(on: On, credential: Credential, config: string, env: Readonly<Record<string, string>> = {}): Rig {
  const r: Rig = { asked: [], written: [], logged: [], configReads: 0 }
  const reply: ModelCompleteResult = { isAnswered: true, text: JSON.stringify(STORY), usage: USED }

  mock.env(on, { USERPROFILE: HOME, OS: 'Windows_NT', AGENT_WATCH_BROWSER: 'none', ...env })
  on('session.authorize', () => {
    if (credential === 'denied') {
      throw new Error('not answered here')
    }

    return { value: credential }
  })
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
    r.logged.push(JSON.stringify(e))

    return { value: undefined }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.read', (_, e) => {
    if (e.path === CONFIG) {
      r.configReads += 1

      return { value: config }
    }

    return { value: e.path.endsWith('index.html') ? '<script src="__AW_SID__.js"></script>' : '' }
  })
  on('fs.write', (_, e) => {
    r.written.push({ path: e.path, text: e.text })

    return { value: undefined }
  })
  on('model.complete', (_, e) => {
    r.asked.push(e)

    return { value: reply }
  })
  on('tool.call', () => ({ result: {}, text: 'Line 1: done' }))

  return r
}

function dataOf(r: Rig): Payload {
  const text = r.written.filter(one => one.text.startsWith(LEAD)).at(-1)?.text ?? ''

  return JSON.parse(text.slice(LEAD.length, -2)) as Payload
}

/** A session with the window open and one agent that read one file. */
async function play($: Engine, clock: MockClock): Promise<void> {
  await $.session.start(SESSION)
  await $.agent.spawn(SPAWN)
  await clock.settle()
  await $.command.run(ASK_GUI)
  await $.tool.call({ tool: 'Read', file_path: 'C:\\work\\shop\\auth.py', agentId: 'a1' })
  await clock.advance(2000)
}

test('his setup: a key Claude Code rejected and a Max login run on the Max plan', async ($, on) => {
  const r = rig(on, { handle: 'h1', kind: 'bearer' }, HIS_CONFIG, { ANTHROPIC_API_KEY: KEY })
  const clock = mock.clock(on)

  await play($, clock)

  expect(r.asked.length).toBe(1)
  expect(dataOf(r).cards?.narrator.state).toBe('on')
  expect(dataOf(r).cards?.narrator.plan).toBe('Max plan')
  expect(r.configReads).toBe(1)
})

test('with no answer from the engine, the config file still finds the Max plan', async ($, on) => {
  const r = rig(on, 'denied', HIS_CONFIG, { ANTHROPIC_API_KEY: KEY })
  const clock = mock.clock(on)

  await play($, clock)

  expect(r.asked.length).toBe(1)
  expect(dataOf(r).cards?.narrator.plan).toBe('Max plan')
})

/** A paid session: the narrator makes no call, and the footer and the card say why. */
async function paid($: Engine, on: On, credential: Credential, config: string, env: Readonly<Record<string, string>> = {}): Promise<void> {
  const r = rig(on, credential, config, env)
  const clock = mock.clock(on)

  await play($, clock)

  expect(r.asked).toEqual([])
  expect(dataOf(r).cards?.narrator.state).toBe('off')
  expect(dataOf(r).cards?.narrator.why).toBe(PAID_WHY)
  expect(dataOf(r).cards?.agents.a1?.why).toBe(PAID_WHY)
}

test('a session on an API key pays: no narrator call, and the footer says why', ($, on) =>
  paid($, on, { handle: 'h1', kind: 'api-key' }, HIS_CONFIG))

test('a session with no first-party credential pays: no narrator call', ($, on) => paid($, on, null, HIS_CONFIG))

test('a session on Bedrock pays: no narrator call', ($, on) =>
  paid($, on, { handle: 'h1', kind: 'bearer' }, HIS_CONFIG, { CLAUDE_CODE_USE_BEDROCK: '1' }))

test('with no answer from the engine, an env key Claude Code approved means the session pays', ($, on) =>
  paid($, on, 'denied', JSON.stringify({ customApiKeyResponses: { approved: [TAIL] }, oauthAccount: {} }), {
    ANTHROPIC_API_KEY: KEY,
  }))

test('with no answer from the engine and no config file, nothing says it is free: no narrator call', ($, on) =>
  paid($, on, 'denied', ''))

test('the key reaches no file, prompt or log', async ($, on) => {
  const r = rig(on, 'denied', HIS_CONFIG, { ANTHROPIC_API_KEY: KEY, ANTHROPIC_AUTH_TOKEN: KEY })
  const clock = mock.clock(on)

  await play($, clock)

  const seen = [...r.written.map(one => one.text), ...r.asked.map(one => `${one.system ?? ''}${one.prompt}`), ...r.logged]

  expect(seen.length).toBeGreaterThan(0)
  expect(seen.some(text => text.includes(KEY) || text.includes(TAIL))).toBe(false)
})
