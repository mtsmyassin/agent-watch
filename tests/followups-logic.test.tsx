import { expect, test } from 'claude-code/testing'

import { tallyOf } from '../hooks/counts'
import { AGENT_SYSTEM, EMPTY, planned, REFRESH_MS } from '../hooks/narrator'
import type { Ask } from '../hooks/narrator'
import { born } from '../hooks/roster'
import { troubleOf } from '../hooks/trouble'
import type { AgentRow, Call, Kind, Narration, Seen, Story, Trail } from '../types'

// The narrator follow-ups, with no engine under them: advice on time (an
// urgent moment may skip the per-agent wait once) and a card kept current
// while its agent is in trouble or stuck (a refresh every 30 s).

const T = 1_800_000_000_000
const TOLD = { now: 'Reading config.txt', how: 'It reads the settings.', at: T }
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
  ({ ...born(id, T, { type: 'Explore', description: `task of ${id}` }), ...extra })
const trailOf = (...calls: Call[]): Trail => ({ calls, dropped: 0 })
const config = (): Call => c('read', 'Read config.txt', { name: 'config.txt' })
const loop = (n: number): Call[] => Array.from({ length: n }, config)
const holding = (stories: Record<string, Story>, ledger: Partial<Narration['ledger']> = {}): Narration => ({
  stories,
  ledger: { ...EMPTY.ledger, ...ledger },
})
const agentAsks = (asks: readonly Ask[]): string[] =>
  asks.flatMap(ask => (ask.to === 'agent' ? [`${ask.id}:${ask.moment}`] : []))
const READING: Seen = { stage: 'looking', kind: 'read', health: 'working' }
const LOOPING: Seen = { ...READING, trouble: ['circles'] }

test('trouble and stuck may skip the per-agent wait, once', () => {
  // Asked at T (its start); by T+3 s it has read the same file three times.
  const asked = holding({ a1: { seen: READING, askedAt: T, told: TOLD } })
  const first = planned(asked, [live('a1')], { a1: trailOf(...loop(3)) }, T + 3000)

  expect(agentAsks(first.asks)).toEqual(['a1:trouble'])
  expect(first.narration.stories.a1?.rushed).toBe(true)

  // A second new sign three seconds later: the skip is spent, so it waits out the 20 s.
  const failing = [1, 2, 3].map(() => c('read', 'Read gone.txt', { isFailed: true }))
  const landed: Story = { seen: LOOPING, askedAt: T + 3000, rushed: true, told: TOLD }
  const second = (now: number) =>
    planned(holding({ a1: landed }), [live('a1')], { a1: trailOf(...loop(3), ...failing) }, now)

  expect(agentAsks(second(T + 6000).asks)).toEqual([])
  expect(second(T + 6000).narration.stories.a1?.pending).toBe('trouble')
  expect(agentAsks(second(T + 23_000).asks)).toEqual(['a1:trouble'])
  // A call that waited out the gap gives the skip back.
  expect(second(T + 23_000).narration.stories.a1?.rushed).toBeUndefined()

  // A new stage is no hurry: it waits.
  const edited = planned(asked, [live('a1')], { a1: trailOf(c('read', 'Read a.py'), c('edit', 'Edited a.py')) }, T + 3000)

  expect(agentAsks(edited.asks)).toEqual([])
  expect(edited.narration.stories.a1?.pending).toBe('stage')

  // The skip never lets a third call out.
  const full = holding({ a1: { seen: READING, askedAt: T, told: TOLD } }, { inFlight: 2 })

  expect(planned(full, [live('a1')], { a1: trailOf(...loop(3)) }, T + 3000).asks).toEqual([])

  // Stuck may skip the wait too: quiet since T, last asked 6 s before it turned red.
  const quiet = holding({ a1: { seen: READING, askedAt: T + 115_000, told: TOLD } })
  const stuck = planned(quiet, [live('a1')], { a1: trailOf(c('read', 'Read a.py')) }, T + 121_000)

  expect(agentAsks(stuck.asks)).toEqual(['a1:stuck'])
})

test('refresh comes every 30 s only while in trouble or stuck', () => {
  expect(REFRESH_MS).toBe(30_000)

  // Going in circles, asked at T: nothing at T+29 s, a refresh at T+30 s.
  const looping = holding({ a1: { seen: LOOPING, askedAt: T, told: TOLD } })
  const trails = { a1: trailOf(...loop(6)) }

  expect(planned(looping, [live('a1')], trails, T + 29_000).narration.stories.a1?.pending).toBeUndefined()

  const due = planned(looping, [live('a1')], trails, T + REFRESH_MS)

  expect(agentAsks(due.asks)).toEqual(['a1:refresh'])
  // A refresh is no team news.
  expect(due.narration.ledger.teamPending).toBeUndefined()

  // A healthy agent keeps today's moments: no refresh.
  const reads = [1, 2, 3, 4].map(n => c('read', `Read f${n}.py`))
  const healthy = holding({ a1: { seen: READING, askedAt: T, told: TOLD } })

  expect(planned(healthy, [live('a1', { seenAt: T + 55_000 })], { a1: trailOf(...reads) }, T + 60_000).asks).toEqual([])

  // Stuck (already told): a refresh 30 s after the last call.
  const stuckSeen: Seen = { ...READING, health: 'stuck' }
  const stuck = holding({ a1: { seen: stuckSeen, askedAt: T + 120_000, told: TOLD } })

  expect(agentAsks(planned(stuck, [live('a1')], { a1: trailOf(c('read', 'Read a.py')) }, T + 150_000).asks)).toEqual([
    'a1:refresh',
  ])

  // Resting or over: no refresh, even with a sign that stays (a change outside the project).
  const outside = c('edit', 'Edited settings.json', { touch: { file: 'settings.json', outside: true } })
  const marked: Seen = { stage: 'changing', kind: 'edit', health: 'idle', trouble: ['outside'] }
  const idle = holding({ a1: { seen: marked, askedAt: T, told: TOLD } })

  expect(planned(idle, [live('a1', { state: 'idle' })], { a1: trailOf(outside) }, T + 60_000).asks).toEqual([])

  const over = holding({ a1: { seen: { ...marked, stage: 'reporting', health: 'done' }, askedAt: T, told: TOLD } })

  expect(
    planned(over, [live('a1', { state: 'completed', endedAt: T + 1000 })], { a1: trailOf(outside) }, T + 60_000).asks,
  ).toEqual([])

  // A moment already waiting is asked as itself, not as a refresh.
  const waiting = holding({ a1: { seen: LOOPING, askedAt: T, told: TOLD, pending: 'kind' } })

  expect(agentAsks(planned(waiting, [live('a1')], trails, T + 31_000).asks)).toEqual(['a1:kind'])

  // Not urgent: with one slot free, another agent's new trouble goes first.
  const two = holding({ a1: { seen: LOOPING, askedAt: T, told: TOLD }, a2: { seen: READING, askedAt: T, told: TOLD } }, { inFlight: 1 })
  const both = { a1: trailOf(...loop(6)), a2: trailOf(...[1, 2, 3].map(() => c('read', 'Read b.txt'))) }

  expect(agentAsks(planned(two, [live('a1'), live('a2')], both, T + 31_000).asks)).toEqual(['a2:trouble'])
})

test('the refresh prompt says why it is asked', () => {
  const looping = holding({ a1: { seen: LOOPING, askedAt: T, told: TOLD } })
  const [ask] = planned(looping, [live('a1')], { a1: trailOf(...loop(6)) }, T + REFRESH_MS).asks

  expect(ask?.request.prompt).toContain('Why you are asked now: It is still in trouble')

  const stuck = holding({ a1: { seen: { ...READING, health: 'stuck' }, askedAt: T + 120_000, told: TOLD } })
  const [again] = planned(stuck, [live('a1')], { a1: trailOf(c('read', 'Read a.py')) }, T + 150_000).asks

  expect(again?.request.prompt).toContain('Why you are asked now: It still looks stuck')
})

test('the prompt gives exact counts per file and per step', () => {
  const failed = { isFailed: true } as const
  const calls = [
    c('read', 'Read notes.md', { name: 'notes.md' }),
    c('read', 'Read notes.md', { name: 'notes.md', step: 'notes@2' }),
    c('read', 'Read gone.txt', { name: 'gone.txt', ...failed }),
    c('read', 'Read gone.txt', { name: 'gone.txt', ...failed, step: 'gone@2' }),
    ...[1, 2, 3].map(n => c('search', 'Searched for login', { step: `login@${n}` })),
    c('edit', 'Edited a.py', { name: 'a.py' }),
    c(undefined, 'Updated the task list'),
    ...loop(22),
  ]
  const trail = trailOf(...calls)

  expect(tallyOf(trail)).toEqual({
    steps: 30,
    failed: 2,
    dropped: 0,
    kinds: { read: 26, search: 3, edit: 1 },
    reads: [
      { name: 'config.txt', count: 22 },
      { name: 'gone.txt', count: 2 },
      { name: 'notes.md', count: 2 },
    ],
    edits: [{ name: 'a.py', count: 1 }],
    searches: [{ name: 'Searched for login', count: 3 }],
    failures: [{ name: 'Read gone.txt', count: 2 }],
  })

  const [ask] = planned(EMPTY, [live('a1')], { a1: trail }, T + 3000).asks
  const prompt = ask?.request.prompt ?? ''

  expect(prompt).toContain('Tally of its 30 steps: 26 reads, 3 searches, 1 edit. 2 failed.')
  expect(prompt).toContain(
    'Files it read, with how many times each (names only): notes.md 2 times, gone.txt 2 times, config.txt 22 times',
  )
  expect(prompt).toContain('Files it changed, with how many times each (names only): a.py once')
  expect(prompt).toContain('Searches, with how many times each: Searched for login 3 times')
  expect(prompt).toContain('Failed steps, with how many times each: Read gone.txt 2 times')
  // The trouble line gives the exact repeat count, all of it.
  expect(prompt).toContain('Read config.txt 22 times (going in circles)')
  // Still the newest 8 steps, one line each.
  expect(prompt.match(/^- /gm)?.length).toBe(8)
})

test('the trouble evidence counts every repeat, not only the newest twelve', () => {
  expect(troubleOf(loop(22), false)).toEqual([
    {
      sign: 'circles',
      evidence: 'Read config.txt 22 times',
      advice: 'It has done the same step 22 times. If it keeps on, stop it and tell it exactly where to look.',
    },
  ])

  const gone = Array.from({ length: 10 }, () => c('read', 'Read gone.txt', { isFailed: true }))

  expect(troubleOf(gone, false)[0]?.evidence).toBe('Read gone.txt failed 10 times')
  // Finding it is unchanged: three within the newest twelve.
  expect(troubleOf([config(), ...Array.from({ length: 10 }, (_, n) => c('read', `Read f${n}.py`)), config(), config()], false)).toEqual([])
})

test("the narrator is told to use the numbers given, and to weigh the agent's own words", () => {
  expect(AGENT_SYSTEM).toContain('Counts come from the tally of the whole trail')
  expect(AGENT_SYSTEM).toContain('Never count, add, subtract or estimate a number yourself')
  expect(AGENT_SYSTEM).toContain('are a claim, not proof')
  expect(AGENT_SYSTEM).toContain('trust the tally and say so')
  expect(AGENT_SYSTEM).toContain('"It says it is done, but it read config.txt 6 of the 8 times asked"')
})
