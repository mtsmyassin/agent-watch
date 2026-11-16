import { expect, test } from 'claude-code/testing'

import {
  adviceOf,
  cardsOf,
  EMPTY,
  landed,
  MAX_TOKENS,
  momentOf,
  parsed,
  percentOf,
  planned,
  TEAM_SYSTEM,
  teamPrompt,
} from '../hooks/narrator'
import type { Ask, Reply } from '../hooks/narrator'
import { born } from '../hooks/roster'
import type { AgentRow, Call, Kind, Narration, Seen, Story, Trail } from '../types'

// What the narrator makes of trouble and progress, with no engine under it:
// the `trouble` moment, what it is sent, what it may answer, and the advice a
// card shows.

const T = 1_800_000_000_000
const USED = { input_tokens: 900, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const STORY = { now: 'Reading the sign-in code', how: 'It reads the code before it changes anything.' }
const CIRCLES = (n: number): string =>
  `It has done the same step ${n} times. If it keeps on, stop it and tell it exactly where to look.`
let serial = 0

/** A finished call of a kind; the same words are the same step unless `step` says otherwise. */
function c(kind: Kind | undefined, did: string, extra: Partial<Call> = {}): Call {
  serial += 1

  const call: Call = { key: `k${serial}`, doing: did, did, at: T + serial, end: T + serial + 1, step: did, ...extra }

  if (kind !== undefined) {
    call.kind = kind
  }

  return call
}

const live = (id: string, extra: Partial<AgentRow> = {}): AgentRow =>
  born(id, T, { type: 'Explore', description: `task of ${id}`, ...extra })
const trailOf = (...calls: Call[]): Trail => ({ calls, dropped: 0 })
const config = (): Call => c('read', 'Read config.py', { name: 'config.py' })
const others = (k: number): Call[] => Array.from({ length: k }, (_, i) => c('read', `Read other${i}.py`))
const answer = (fields: object): Reply => ({ isAnswered: true, text: JSON.stringify(fields), usage: USED })
const agentAsks = (asks: readonly Ask[]): string[] =>
  asks.flatMap(ask => (ask.to === 'agent' ? [`${ask.id}:${ask.moment}`] : []))
const firstAgentAsk = (asks: readonly Ask[]): Ask => asks.find(ask => ask.to === 'agent') as Ask
const holding = (stories: Record<string, Story>, ledger: Partial<Narration['ledger']> = {}): Narration => ({
  stories,
  ledger: { ...EMPTY.ledger, ...ledger },
})
const READING: Seen = { stage: 'looking', kind: 'read', health: 'working' }

test('a new trouble sign is a moment, urgent and team news', () => {
  expect(momentOf(READING, { ...READING, trouble: ['circles'] })).toBe('trouble')
  expect(momentOf({ ...READING, trouble: ['circles'] }, { ...READING, trouble: ['circles'] })).toBeUndefined()
  expect(momentOf({ ...READING, trouble: ['circles'] }, { ...READING, trouble: ['circles', 'outside'] })).toBe('trouble')
  // A sign clearing is no moment of its own.
  expect(momentOf({ ...READING, trouble: ['circles'] }, READING)).toBeUndefined()
  // Stuck outranks it; it outranks a new stage.
  expect(momentOf(READING, { ...READING, health: 'stuck', trouble: ['circles'] })).toBe('stuck')
  expect(momentOf(READING, { stage: 'changing', kind: 'edit', health: 'working', trouble: ['outside'] })).toBe('trouble')

  // One slot is free: the agent in trouble takes it before a stage change, and the team hears of it.
  const rows = [live('a1'), live('a2')]
  const trails = { a1: trailOf(c('read', 'Read a.py'), c('edit', 'Edited a.py')), a2: trailOf(config(), config(), config()) }
  const plan = planned(holding({ a1: { seen: READING }, a2: { seen: READING } }, { inFlight: 1 }), rows, trails, T + 1000)

  expect(agentAsks(plan.asks)).toEqual(['a2:trouble'])
  expect(plan.narration.stories.a1?.pending).toBe('stage')
  expect(plan.narration.ledger.teamPending).toBe(true)

  // A waiting trouble is not replaced by a stage change: its call covers what came since.
  const waiting = holding({ a2: { seen: { ...READING, trouble: ['circles'] }, pending: 'trouble', askedAt: T } })
  const edited = { a2: trailOf(...(trails.a2.calls), c('edit', 'Edited x.py')) }

  expect(planned(waiting, [live('a2')], edited, T + 5000).narration.stories.a2?.pending).toBe('trouble')
})

test('the prompt carries the brief, a tally and the evidence, masked', () => {
  const secret = ['hunter', '2'].join('')
  const brief = `Fix the login, see C:\\Users\\me\\secret-place\\notes.md. The test password=${secret}. ${'More detail here. '.repeat(60)}`
  const reads = Array.from({ length: 14 }, (_, i) => c('read', `Read f${i}.py`, { name: `f${i}.py` }))
  const calls = [
    ...reads,
    c('edit', 'Edited auth.py', { name: 'auth.py', step: 'e1' }),
    c('test', 'Ran pytest -x', { isFailed: true }),
    c(undefined, 'Updated the task list'),
    config(),
    config(),
    config(),
    config(),
    c('edit', 'Edited settings.json', { name: 'settings.json', step: 'e2', touch: { file: 'settings.json', outside: true } }),
  ]
  const [ask] = planned(EMPTY, [live('a1')], { a1: { calls, dropped: 0, ask: brief } }, T + 3000).asks
  const prompt = ask?.request.prompt ?? ''
  const lead = 'Brief it was given: '
  const briefLine = prompt.split('\n').find(line => line.startsWith(lead)) ?? ''

  expect(ask?.request.maxTokens).toBe(1024)
  expect(MAX_TOKENS).toBe(1024)
  expect(prompt).not.toContain(secret)
  expect(prompt).not.toContain('secret-place')
  expect(briefLine).toContain('Fix the login, see notes.md.')
  // The brief is cut to 600 letters, no longer to 400.
  expect(briefLine.length).toBeGreaterThan(lead.length + 400)
  expect(briefLine.length).toBeLessThanOrEqual(lead.length + 600)
  expect(prompt).toContain('Tally of its 21 steps: 18 reads, 2 edits, 1 test or check run. 1 failed.')
  expect(prompt).toContain('Files it read (names only, the newest 12 of 15): f3.py, f4.py,')
  expect(prompt).toContain('f13.py, config.py')
  expect(prompt).not.toContain(' f2.py')
  expect(prompt).toContain('Files it changed (names only): auth.py, settings.json')
  expect(prompt).toContain(
    'Trouble the rules found: Changed a file outside this project: settings.json (touching what it should not); Read config.py 4 times (going in circles).',
  )
  // Still the newest 8 steps, one line each.
  expect(prompt.match(/^- /gm)?.length).toBe(8)
})

test('progress, percent and advice are read, and every bad shape of them dropped alone', () => {
  const full = {
    ...STORY,
    progress: '2 of 3 parts done; the test file is still untouched',
    percent: 62,
    advice: 'Nothing to do, it is on track',
  }

  expect(parsed(JSON.stringify(full))).toEqual(full)

  const cases: [unknown, number | undefined][] = [
    [62, 62],
    ['62', 62],
    [' 62% ', 62],
    [62.6, 63],
    [-5, 0],
    [140, 100],
    [0, 0],
    [100, 100],
    ['lots', undefined],
    ['1e2', undefined],
    ['', undefined],
    [true, undefined],
    [null, undefined],
    [{}, undefined],
    [[50], undefined],
  ]

  for (const [value, want] of cases) {
    expect(percentOf(value)).toBe(want)
    expect(parsed(JSON.stringify({ ...STORY, percent: value }))).toEqual(want === undefined ? STORY : { ...STORY, percent: want })
  }

  expect(percentOf(Number.NaN)).toBeUndefined()
  expect(percentOf(Number.POSITIVE_INFINITY)).toBeUndefined()

  // Advice that has the person run something is dropped; the rest of the reply still counts.
  const tick = String.fromCharCode(96)

  for (const bad of [
    `Run ${tick}npm test${tick} again`,
    'Run git reset --hard to undo it',
    'run npm install first',
    'Type rm -rf build and retry',
    'Stop it && start it again',
    'Use pytest -x to see the error',
    'Paste $(whoami) into the prompt',
  ]) {
    expect(adviceOf(bad)).toBe('')
    expect(parsed(JSON.stringify({ ...STORY, advice: bad }))).toEqual(STORY)
  }

  expect(adviceOf('Stop it and tell it the login code is in auth.py')).toBe('Stop it and tell it the login code is in auth.py')
  // Folders are cut as everywhere else; the file name stays.
  expect(adviceOf('Tell it the code is in C:\\Users\\me\\proj\\auth.py')).toBe('Tell it the code is in auth.py')
  expect(adviceOf('Let it re-run the tests once more - it is close')).toBe('Let it re-run the tests once more - it is close')
  expect(adviceOf(42)).toBe('')
  expect(parsed(JSON.stringify({ ...STORY, progress: 'Half\u0007 done', advice: '' }))).toEqual({ ...STORY, progress: 'Half done' })
  // Without now and how the reply is still discarded, whatever else it holds.
  expect(parsed(JSON.stringify({ progress: 'Half done', percent: 50, advice: 'Wait' }))).toBeUndefined()
})

test('advice written before the trouble is not shown with it', () => {
  const rows = [live('a1')]
  const calm = { a1: trailOf(c('read', 'Read a.py')) }
  const first = planned(EMPTY, rows, calm, T + 1000)
  const told = landed(
    first.narration,
    firstAgentAsk(first.asks),
    answer({ ...STORY, advice: 'Nothing to do, it is on track', progress: 'Just started', percent: 5 }),
    T + 2000,
  )
  const calmCard = cardsOf(rows, calm, told, T + 2000, true).agents.a1

  expect(calmCard?.advice).toBe('Nothing to do, it is on track')
  expect(calmCard?.told?.progress).toBe('Just started')
  expect(calmCard?.told?.percent).toBe(5)
  expect(calmCard?.trouble).toBeUndefined()

  // It goes in circles inside its 20 s: the trouble waits its turn, the old advice is not shown with it.
  const loop = { a1: trailOf(...calm.a1.calls, config(), config(), config()) }
  const later = planned(told, rows, loop, T + 3000)
  const waiting = cardsOf(rows, loop, later.narration, T + 3000, true).agents.a1

  expect(later.asks).toEqual([])
  expect(waiting?.trouble).toEqual([{ sign: 'circles', evidence: 'Read config.py 3 times', advice: CIRCLES(3) }])
  expect(waiting?.advice).toBeUndefined()
  expect(waiting?.mode).toBe('writing')

  // The trouble's own call lands with advice for it: that shows.
  const due = planned(later.narration, rows, loop, T + 22_000)

  expect(agentAsks(due.asks)).toEqual(['a1:trouble'])

  const fixed = landed(
    due.narration,
    firstAgentAsk(due.asks),
    answer({ now: 'Reading config.py again', how: 'It keeps rereading one file.', advice: 'Stop it and tell it the setting is in app.py' }),
    T + 23_000,
  )

  expect(cardsOf(rows, loop, fixed, T + 23_000, true).agents.a1?.advice).toBe('Stop it and tell it the setting is in app.py')

  // Once 8 newer calls show none of it, the sign clears and its advice goes with it.
  const clear = { a1: trailOf(...loop.a1.calls, ...others(8)) }
  const after = cardsOf(rows, clear, fixed, T + 24_000, true).agents.a1

  expect(after?.trouble).toBeUndefined()
  expect(after?.advice).toBeUndefined()
})

test("offline, the card still names the trouble and the rules' advice", () => {
  const loop = { a1: trailOf(config(), config(), config()) }

  for (const [held, isEnabled] of [
    [EMPTY, false],
    [holding({}, { halt: 'The narrator used all 80 calls.' }), true],
  ] as const) {
    const card = cardsOf([live('a1')], loop, held, T + 1000, isEnabled).agents.a1

    expect(card?.mode).toBe('plain')
    expect(card?.trouble).toEqual([{ sign: 'circles', evidence: 'Read config.py 3 times', advice: CIRCLES(3) }])
    expect(card?.advice).toBeUndefined()
  }

  // A finished agent that changed a file outside the project still shows it.
  const over = live('a2', { state: 'completed', endedAt: T + 500, answer: 'Done.' })
  const outside = { a2: trailOf(c('edit', 'Edited settings.json', { touch: { file: 'settings.json', outside: true } })) }

  expect(cardsOf([over], outside, EMPTY, T + 1000, true).agents.a2?.trouble?.[0]?.sign).toBe('outside')
})

test('the team prompt leads with whoever needs the person', () => {
  const rows = [live('a1'), live('a2')]
  const trails = { a1: trailOf(config(), config(), config()), a2: trailOf(c('read', 'Read b.py')) }
  const prompt = teamPrompt(rows, trails, EMPTY, T + 1000)

  expect(prompt).toContain('trouble: Read config.py 3 times (going in circles)')
  expect(prompt.split('\n').find(line => line.includes('task of a2'))).not.toContain('trouble')
  expect(TEAM_SYSTEM).toContain('trouble')
})
