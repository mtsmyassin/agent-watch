import { expect, test } from 'claude-code/testing'

import {
  AGENT_SYSTEM,
  CALLS_MAX,
  cardsOf,
  clean,
  EMPTY,
  landed,
  MAX_TOKENS,
  MODEL,
  momentOf,
  parsed,
  planned,
  restarted,
  teamParsed,
  TIMEOUT_MS,
} from '../hooks/narrator'
import type { Ask, Reply } from '../hooks/narrator'
import { born } from '../hooks/roster'
import type { AgentRow, Call, Kind, Narration, Seen, Story, Trail } from '../types'

// The narrator's own logic, with no engine under it: when it speaks, what it
// costs, what it may say, and what a card shows meanwhile.

const T = 1_800_000_000_000
const USED = { input_tokens: 400, output_tokens: 60, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }
const NONE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const STORY = {
  what: 'Find where sign-in is handled.',
  now: 'Reading how sign-in works',
  found: 'Nothing yet',
  how: 'It is reading the sign-in code first.',
  next: 'Search for where sessions are kept.',
}

/** A call of a kind, started at `at`; open unless it has an `end`. */
function c(kind: Kind | undefined, at: number, end?: number): Call {
  const call: Call = { key: `k${at}`, doing: 'Reading a.txt', did: 'Read a.txt', at }

  if (end !== undefined) {
    call.end = end
  }

  if (kind !== undefined) {
    call.kind = kind
  }

  return call
}

const answer = (fields: object): Reply => ({ isAnswered: true, text: JSON.stringify(fields), usage: USED })
const refused = (error: string, status: number | null = 429): Reply => ({
  isAnswered: false,
  reason: 'api-error',
  error,
  status,
  usage: NONE,
})
/** A live agent that started at T. */
const live = (id: string, extra: Partial<AgentRow> = {}): AgentRow =>
  born(id, T, { type: 'Explore', description: `task of ${id}`, ...extra })
const trailOf = (...calls: Call[]): Trail => ({ calls, dropped: 0 })
/** One finished read at T+100: an agent that has begun. */
const begun = (): Trail => trailOf(c('read', T + 100, T + 200))
const agentAsks = (asks: readonly Ask[]): string[] =>
  asks.flatMap(ask => (ask.to === 'agent' ? [`${ask.id}:${ask.moment}`] : []))
const teamAsks = (asks: readonly Ask[]): number => asks.filter(ask => ask.to === 'team').length
const seen = (stage: Seen['stage'], kind: Seen['kind'], health: Seen['health']): Seen =>
  kind === undefined ? { stage, health } : { stage, kind, health }
/** A narration holding these stories, the ledger as given. */
const holding = (stories: Record<string, Story>, ledger: Partial<Narration['ledger']> = {}): Narration => ({
  stories,
  ledger: { ...EMPTY.ledger, ...ledger },
})
const READING = seen('looking', 'read', 'working')

test('the narrator speaks at start, at a stage change, at a kind change, when stuck, on recovery and at the end', () => {
  const first = planned(EMPTY, [live('a1')], { a1: begun() }, T + 1000)

  expect(agentAsks(first.asks)).toEqual(['a1:start'])
  expect(momentOf(READING, seen('looking', 'read', 'slow'))).toBeUndefined()
  expect(momentOf(READING, seen('changing', 'edit', 'working'))).toBe('stage')
  expect(momentOf(READING, seen('looking', 'search', 'working'))).toBe('kind')
  // A first kind is no change of kind.
  expect(momentOf(seen('looking', undefined, 'working'), READING)).toBeUndefined()
  expect(momentOf(seen('looking', 'read', 'slow'), seen('looking', 'read', 'stuck'))).toBe('stuck')
  expect(momentOf(seen('looking', 'read', 'stuck'), READING)).toBe('recover')
  expect(momentOf(READING, seen('reporting', 'read', 'done'))).toBe('finish')
  expect(momentOf(seen('reporting', 'read', 'done'), seen('reporting', 'read', 'done'))).toBeUndefined()
  // A finished teammate woken again starts over.
  expect(momentOf(seen('reporting', 'read', 'done'), READING)).toBe('start')
})

test('a start waits for the first call or 8 s', () => {
  const bare = planned(EMPTY, [live('a1')], {}, T + 7999)

  expect(bare.asks).toEqual([])
  expect(bare.narration.stories.a1?.pending).toBe('start')
  expect(agentAsks(planned(bare.narration, [live('a1')], {}, T + 8000).asks)).toEqual(['a1:start'])
})

test('a finished or stuck agent is asked about first', () => {
  const rows = [live('a1'), live('a2', { state: 'completed', endedAt: T + 900 }), live('a3')]
  const trails = { a1: begun(), a2: begun(), a3: begun() }
  const waiting = holding(
    {
      a1: { seen: READING, pending: 'kind' },
      a2: { seen: READING },
      a3: { seen: READING, pending: 'stage' },
    },
    { inFlight: 1 },
  )

  // One slot is free: the agent that just finished takes it.
  expect(agentAsks(planned(waiting, rows, trails, T + 1000).asks)).toEqual(['a2:finish'])
})

test('one call per agent per 20 s, two in flight, 400 a session, then rules only', () => {
  const rows = [live('a1'), live('a2'), live('a3')]
  const trails = { a1: begun(), a2: begun(), a3: begun() }
  const first = planned(EMPTY, rows, trails, T + 1000)

  expect(agentAsks(first.asks)).toEqual(['a1:start', 'a2:start'])
  expect(first.narration.ledger.inFlight).toBe(2)
  expect(first.narration.ledger.calls).toBe(2)

  const back = landed(first.narration, first.asks[0] as Ask, answer(STORY), T + 2000)

  expect(agentAsks(planned(back, rows, trails, T + 2000).asks)).toEqual(['a3:start'])

  // The same agent again: not before 20 s have passed since its last call.
  const told = (askedAt: number): Narration => holding({ a1: { seen: READING, pending: 'stage', askedAt } })

  expect(planned(told(T + 1000 - 19_999), [live('a1')], { a1: begun() }, T + 1000).asks).toEqual([])
  expect(agentAsks(planned(told(T + 1000 - 20_000), [live('a1')], { a1: begun() }, T + 1000).asks)).toEqual([
    'a1:stage',
  ])

  // The 400th call is the last one: the narrator then stops, and says why.
  expect(CALLS_MAX).toBe(400)

  const pair = [live('a1'), live('a2')]
  const pairTrails = { a1: begun(), a2: begun() }
  const late = holding(
    { a1: { seen: READING, pending: 'stage' }, a2: { seen: READING, pending: 'stage' } },
    { calls: 399 },
  )
  const last = planned(late, pair, pairTrails, T + 1000)

  expect(last.asks.length).toBe(1)
  expect(last.narration.ledger.calls).toBe(400)
  expect(last.narration.ledger.halt).toContain('400')

  const after = landed(last.narration, last.asks[0] as Ask, answer(STORY), T + 2000)

  expect(planned(after, pair, pairTrails, T + 30_000).asks).toEqual([])

  const cards = cardsOf(pair, pairTrails, after, T + 30_000, true)

  expect(cards.narrator.state).toBe('halted')
  expect(cards.narrator.why).toContain('400')
  expect(cards.agents.a1?.mode).toBe('told')
  expect(cards.agents.a2?.mode).toBe('plain')
  expect(cards.agents.a2?.why).toContain('400')
})

test('the team sentence waits 5 s for the dust to settle and comes at most every 30 s', () => {
  const one = planned(EMPTY, [live('a1')], { a1: begun() }, T + 1000)

  expect(teamAsks(one.asks)).toBe(0)

  const started = landed(one.narration, one.asks[0] as Ask, answer(STORY), T + 1500)

  expect(teamAsks(planned(started, [live('a1')], { a1: begun() }, T + 5999).asks)).toBe(0)

  const due = planned(started, [live('a1')], { a1: begun() }, T + 6000)

  expect(teamAsks(due.asks)).toBe(1)

  const team = due.asks.find(ask => ask.to === 'team') as Ask
  const told = landed(due.narration, team, answer({ team: 'One agent is reading the sign-in code.' }), T + 7000)

  expect(told.ledger.team).toEqual({ text: 'One agent is reading the sign-in code.', at: T + 7000 })

  // A stage change is no news for the team.
  const edited = { a1: trailOf(c('read', T + 100, T + 200), c('edit', T + 9000, T + 9100)) }
  const quiet = planned(told, [live('a1')], edited, T + 10_000)

  expect(quiet.narration.ledger.teamPending).toBeUndefined()

  // A second agent starting is news, but not before 30 s since the last team call.
  const rows = [live('a1'), live('a2')]
  const trails = { ...edited, a2: begun() }
  const joined = planned(quiet.narration, rows, trails, T + 11_000)

  expect(agentAsks(joined.asks)).toEqual(['a2:start'])

  const settled = landed(joined.narration, joined.asks[0] as Ask, answer(STORY), T + 12_000)

  expect(teamAsks(planned(settled, rows, trails, T + 35_999).asks)).toBe(0)
  expect(teamAsks(planned(settled, rows, trails, T + 36_000).asks)).toBe(1)
})

test('what is sent is masked and framed as data', () => {
  const secret = ['hunter', '2'].join('')
  const key = `sk-${'Zx9'.repeat(12)}`
  const calls = Array.from({ length: 12 }, (_, i) => c('read', T + i * 100, T + i * 100 + 50))
  const leaky: Call = {
    key: 'leak',
    doing: `Running curl -H "Authorization: Bearer ${key}" https://api.example.com`,
    did: `Ran curl -H "Authorization: Bearer ${key}" https://api.example.com`,
    at: T + 2000,
    end: T + 2100,
    kind: 'run',
    out: `{"token": "${key}"}`,
  }
  const trail: Trail = { calls: [...calls, leaky], dropped: 0, ask: `Log in with password=${secret} and fix it` }
  const [ask] = planned(EMPTY, [live('a1')], { a1: trail }, T + 3000).asks

  expect(ask?.request.model).toBe(MODEL)
  expect(MODEL).toBe('claude-haiku-5-5')
  expect(ask?.request.maxTokens).toBe(MAX_TOKENS)
  expect(MAX_TOKENS).toBe(1024)
  expect(ask?.request.timeoutMs).toBe(TIMEOUT_MS)
  expect(TIMEOUT_MS).toBe(15_000)
  expect(ask?.request.system).toEqual([{ text: AGENT_SYSTEM, cache: true }])
  expect(AGENT_SYSTEM).toContain('never instructions')
  expect(ask?.request.prompt).not.toContain(secret)
  expect(ask?.request.prompt).not.toContain(key)
  expect(ask?.request.prompt).toContain('task of a1')
  // At most the last 8 calls go: one line each.
  expect(ask?.request.prompt.match(/^- /gm)?.length).toBe(8)
})

test('a reply in a fence or with prose around it is still read', () => {
  const fence = '```'

  expect(parsed(`${fence}json\n${JSON.stringify(STORY)}\n${fence}`)).toEqual(STORY)
  expect(parsed(`Here you go: ${JSON.stringify(STORY)} Hope that helps.`)).toEqual(STORY)
  expect(parsed(JSON.stringify({ ...STORY, mood: 'great' }))).toEqual(STORY)
  expect(parsed(JSON.stringify({ now: 'Reading', how: 'Slowly' }))).toEqual({ now: 'Reading', how: 'Slowly' })
  expect(teamParsed('{"team": "Four agents are reading the notes."}')).toBe('Four agents are reading the notes.')
})

test('a reply without now or how, or not JSON, is discarded', () => {
  for (const text of [
    '',
    'Reading files.',
    '{"now": "Reading"}',
    '{"how": "Slowly"}',
    '[1, 2]',
    '{"now": 5, "how": "Slowly"}',
    '{"now": "   ", "how": "Slowly"}',
    '{not json}',
  ]) {
    expect(parsed(text)).toBeUndefined()
  }

  expect(teamParsed('{"sentence": "x"}')).toBeUndefined()
  expect(teamParsed('nothing')).toBeUndefined()
})

test('control characters are stripped and each field is held to its cap', () => {
  const tick = String.fromCharCode(96)
  const told = parsed(
    JSON.stringify({
      now: 'Reading\u0007 the‮ notes\n\tnow',
      how: `${'word '.repeat(80)}end`,
      next: `Run ${tick}pytest${tick} **now**`,
    }),
  )

  expect(told?.now).toBe('Reading the notes now')
  expect(told?.how.length).toBeLessThanOrEqual(320)
  expect(told?.next).toBe('Run pytest now')
  expect(clean(42)).toBe('')
  // Markup stays text: the page sets it with textContent.
  expect(clean('<b>bold</b>')).toBe('<b>bold</b>')
})

test('every failure falls back to the rules: timeout, empty reply, refusal, unreadable', () => {
  const cases: [Reply, RegExp][] = [
    [{ isAnswered: false, reason: 'aborted', usage: NONE }, /15 s/],
    [{ isAnswered: false, reason: 'empty-reply', usage: NONE }, /no words/],
    [refused('rate_limit'), /rate_limit/],
    [{ isAnswered: true, text: 'Sure! The agent is reading.', usage: USED }, /shape/],
  ]

  for (const [reply, why] of cases) {
    const plan = planned(EMPTY, [live('a1')], { a1: begun() }, T + 1000)
    const back = landed(plan.narration, plan.asks[0] as Ask, reply, T + 2000)
    const card = cardsOf([live('a1')], { a1: begun() }, back, T + 2000, true).agents.a1

    expect(card?.mode).toBe('plain')
    expect(card?.why).toMatch(why)
    expect(card?.plain.now).toBe('Starting')
    expect(back.ledger.failed).toBe(1)
    expect(back.ledger.halt).toBeUndefined()
  }
})

test('a refusal that will not clear pauses the narrator, then it asks again', () => {
  const plan = planned(EMPTY, [live('a1')], { a1: begun() }, T + 1000)
  const back = landed(plan.narration, plan.asks[0] as Ask, refused('authentication_failed', 401), T + 2000)

  expect(back.ledger.halt).toBeUndefined()
  expect(back.ledger.pauseWhy).toMatch(/sign in/)
  expect(planned(back, [live('a1'), live('a2')], { a1: begun(), a2: begun() }, T + 61_999).asks).toEqual([])
  expect(planned(back, [live('a1'), live('a2')], { a1: begun(), a2: begun() }, T + 62_000).asks.length).toBe(1)
  expect(cardsOf([live('a1')], { a1: begun() }, back, T + 2000, true).narrator.state).toBe('paused')
})

test('a call the engine will not send pauses the narrator too', () => {
  const plan = planned(EMPTY, [live('a1')], { a1: begun() }, T + 1000)
  const back = landed(plan.narration, plan.asks[0] as Ask, { isAnswered: false, reason: 'refused', usage: NONE }, T + 1001)

  expect(back.ledger.halt).toBeUndefined()
  expect(back.ledger.pauseWhy).toMatch(/would not send/)
  expect(back.ledger.failed).toBe(1)
  expect(planned(back, [live('a1'), live('a2')], { a1: begun(), a2: begun() }, T + 60_000).asks).toEqual([])
})

test('a card the narrator has not planned for yet waits, or once over shows its own answer', () => {
  const over = live('a2', { state: 'completed', endedAt: T + 500, answer: 'Done.' })
  const cards = cardsOf([live('a1'), over], {}, EMPTY, T + 1000, true)

  expect(cards.agents.a1?.mode).toBe('writing')
  expect(cards.agents.a2?.mode).toBe('own')
})

test('three failures in a row pause it too', () => {
  const ids = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7']
  const rows = ids.map(id => live(id))
  const trails = Object.fromEntries(ids.map(id => [id, begun()]))
  let n = EMPTY
  // Each round asks about the next agents (two at a time) and lands every answer.
  const run = (reply: Reply, at: number): void => {
    const plan = planned(n, rows, trails, at)

    n = plan.narration

    for (const ask of plan.asks) {
      n = landed(n, ask, reply, at + 1)
    }
  }

  run(refused('overloaded', 529), T + 1000)
  run(answer(STORY), T + 1002)
  run(refused('overloaded', 529), T + 1004)
  expect(n.ledger.inARow).toBe(2)
  expect(n.ledger.halt).toBeUndefined()
  run(refused('overloaded', 529), T + 1006)
  expect(n.ledger.halt).toBeUndefined()
  expect(n.ledger.pauseWhy).toContain('three')
})

test('an answer for an agent that is gone only counts its cost', () => {
  const plan = planned(EMPTY, [live('a1')], { a1: begun() }, T + 1000)
  const gone = planned(plan.narration, [], {}, T + 1500).narration

  expect(gone.stories).toEqual({})

  const back = landed(gone, plan.asks[0] as Ask, answer(STORY), T + 2000)

  expect(back.stories).toEqual({})
  expect(back.ledger.inFlight).toBe(0)
  expect(back.ledger.tokensIn).toBe(400)
})

test('agents already finished when first seen are never narrated', () => {
  const over = live('a1', { state: 'completed', endedAt: T + 500, answer: 'Login lives in auth.py.' })
  const plan = planned(EMPTY, [over], { a1: begun() }, T + 60_000)

  expect(plan.asks).toEqual([])
  expect(plan.narration.stories.a1?.isOwn).toBe(true)
  expect(plan.narration.ledger.teamPending).toBeUndefined()
  expect(cardsOf([over], { a1: begun() }, plan.narration, T + 60_000, true).agents.a1?.mode).toBe('own')
})

test('a reload frees the in-flight slots and asks again', () => {
  const rows = [live('a1'), live('a2'), live('a3')]
  const trails = { a1: begun(), a2: begun(), a3: begun() }
  const plan = planned(EMPTY, rows, trails, T + 1000)
  const again = restarted(plan.narration)

  expect(plan.narration.ledger.inFlight).toBe(2)
  expect(again.ledger.inFlight).toBe(0)
  expect(again.stories.a1?.asking).toBeUndefined()
  expect(again.stories.a1?.pending).toBe('start')
  expect(agentAsks(planned(again, rows, trails, T + 1500).asks)).toEqual(['a1:start', 'a2:start'])

  // A team call out at the reload is asked for again too.
  const team = planned(plan.narration, rows, trails, T + 6000)
  const freed = restarted({ ...team.narration, ledger: { ...team.narration.ledger, isTeamAsking: true } })

  expect(freed.ledger.isTeamAsking).toBeUndefined()
  expect(freed.ledger.teamPending).toBe(true)
})

test('the cost of every call is counted, failed ones included', () => {
  const rows = [live('a1'), live('a2')]
  const trails = { a1: begun(), a2: begun() }
  const plan = planned(EMPTY, rows, trails, T + 1000)
  const [one, two] = plan.asks as [Ask, Ask]
  let n = landed(plan.narration, one, answer(STORY), T + 2000)

  n = landed(n, two, { isAnswered: false, reason: 'empty-reply', usage: { ...USED, output_tokens: 0 } }, T + 2000)

  expect(cardsOf(rows, trails, n, T + 2000, true).narrator).toEqual({
    state: 'on',
    model: 'claude-haiku-5-5',
    calls: 2,
    limit: 400,
    inFlight: 0,
    failed: 1,
    tokensIn: 800,
    tokensOut: 60,
    cacheRead: 200,
    cacheWrite: 40,
  })
})

test("a card shows the narrator's words once they land, and keeps what it is fixing", () => {
  const rows = [live('a1')]
  const first = planned(EMPTY, rows, { a1: begun() }, T + 1000)
  const told = landed(first.narration, first.asks[0] as Ask, answer(STORY), T + 3000)
  const card = cardsOf(rows, { a1: begun() }, told, T + 4000, true).agents.a1

  expect(card?.mode).toBe('told')
  expect(card?.told).toEqual({ ...STORY, at: T + 3000 })
  expect(card?.stage).toBe('looking')
  expect(card?.kind).toBe('read')
  expect(card?.quietSince).toBe(T)

  // A stage change: the card says an update is being written, its words kept.
  const edited = { a1: trailOf(c('read', T + 100, T + 200), c('edit', T + 5000, T + 5100)) }
  const next = planned(told, rows, edited, T + 6000)

  expect(cardsOf(rows, edited, next.narration, T + 6000, true).agents.a1?.mode).toBe('writing')

  const later = planned(next.narration, rows, edited, T + 21_000)
  const ask = later.asks.find(one => one.to === 'agent') as Ask
  const update = landed(later.narration, ask, answer({ now: 'Changing the code', how: 'Fixing it' }), T + 22_000)

  expect(cardsOf(rows, edited, update, T + 22_000, true).agents.a1?.told).toEqual({
    what: STORY.what,
    now: 'Changing the code',
    how: 'Fixing it',
    at: T + 22_000,
  })
})

test('with the narrator switched off, every card is the rules, and says so', () => {
  const cards = cardsOf([live('a1')], { a1: begun() }, EMPTY, T + 1000, false)

  expect(cards.narrator.state).toBe('off')
  expect(cards.narrator.why).toMatch(/off/)
  expect(cards.agents.a1?.mode).toBe('plain')
  expect(cards.limits).toEqual({ slowMs: 60_000, stuckMs: 120_000 })
  expect(cards.team).toBeUndefined()
})
