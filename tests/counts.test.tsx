import { expect, test } from 'claude-code/testing'

import { claimsIn, miscounted, rulesProgress, tallyOf } from '../hooks/counts'
import type { Tally } from '../hooks/counts'
import { EMPTY, landed, planned } from '../hooks/narrator'
import type { Ask, Reply } from '../hooks/narrator'
import { born } from '../hooks/roster'
import type { Call, Kind, Trail } from '../types'

// The narrator's counts checked against the tally, with no engine under it:
// which numbers are counts, which must match, and what replaces a field that
// contradicts the trail.

const T = 1_800_000_000_000
const USED = { input_tokens: 900, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const FILES = ['config.txt', 'notes.md', 'auth.py']
let serial = 0

function c(kind: Kind | undefined, did: string, extra: Partial<Call> = {}): Call {
  serial += 1

  const call: Call = { key: `k${serial}`, doing: did, did, at: T + serial, end: T + serial + 1, step: did, ...extra }

  if (kind !== undefined) {
    call.kind = kind
  }

  return call
}

const said = (text: string): string[] =>
  claimsIn(text, FILES).map(one => `${one.kind}:${one.count}${one.file === undefined ? '' : `@${one.file}`}`)

/** 3 reads of config.txt, 2 of notes.md, 1 edit of auth.py, 4 searches for login, 2 failed tests. */
function sample(): Trail {
  return {
    calls: [
      ...[1, 2, 3].map(() => c('read', 'Read config.txt', { name: 'config.txt' })),
      ...[1, 2].map(() => c('read', 'Read notes.md', { name: 'notes.md' })),
      c('edit', 'Edited auth.py', { name: 'auth.py' }),
      ...[1, 2, 3, 4].map(n => c('search', 'Searched for login', { step: `s${n}` })),
      ...[1, 2].map(() => c('test', 'Ran pytest -x', { isFailed: true })),
    ],
    dropped: 0,
  }
}

test('counts of reads, searches, edits and failures are found', () => {
  expect(said('It has read config.txt 12 times so far')).toEqual(['read:12@config.txt'])
  expect(said('5 reads of notes.md, nothing else')).toEqual(['read:5@notes.md'])
  expect(said('2 edits to auth.py')).toEqual(['edit:2@auth.py'])
  expect(said('It searched for login 4 times')).toEqual(['search:4'])
  expect(said('The same test failed 3 times')).toEqual(['failure:3'])
  expect(said('six reads in all')).toEqual(['read:6'])
  expect(said('It read notes.md twice and config.txt 12 times')).toEqual(['read:2@notes.md', 'read:12@config.txt'])
  // "N of the M": N is what was done, M the brief's.
  expect(said('It says it is done, but it read config.txt 6 of the 8 times asked')).toEqual(['read:6@config.txt'])
  expect(said('3 of 8 reads done')).toEqual(['read:3'])
  expect(said('Changed auth.py once')).toEqual(['edit:1@auth.py'])
  expect(said('Read CONFIG.TXT 3 times.')).toEqual(['read:3@config.txt'])
})

test('numbers from the brief and differences are not counts', () => {
  for (const text of [
    'It was asked to read config.txt 8 times',
    'It needs to read it 8 times',
    '4 reads left',
    '3 more reads to go',
    'about six rounds more than asked',
    '8 reads requested',
    '3 of 3 parts done',
    'Ran the tests 4 times',
    'It read 3 files',
    'About 62% done',
    'All requested reads are done',
    'It did the same step 9 times more than asked',
    'It read config.txt and stopped at once',
    'Once it has read config.txt it will report',
    'It read config.txt, and once it finishes it reports',
    'It read config.txt once more',
  ]) {
    expect(said(text)).toEqual([])
  }
})

test('a claim naming a file must match that file; one naming none must match some count of its kind', () => {
  const tally: Tally = tallyOf(sample())

  expect(miscounted('It read config.txt 3 times', tally)).toBeUndefined()
  expect(miscounted('It read config.txt 6 times', tally)?.truth).toEqual([3])
  expect(miscounted('It read notes.md 3 times', tally)?.truth).toEqual([2])
  // No file named: the total or any one file's count will do.
  expect(miscounted('5 reads so far', tally)).toBeUndefined()
  expect(miscounted('3 reads so far', tally)).toBeUndefined()
  expect(miscounted('7 reads so far', tally)?.claim.count).toBe(7)
  expect(miscounted('Edited auth.py twice', tally)?.truth).toEqual([1])
  expect(miscounted('It edited config.txt once', tally)?.truth).toEqual([0])
  expect(miscounted('searched 4 times', tally)).toBeUndefined()
  expect(miscounted('The test failed 2 times', tally)).toBeUndefined()
  expect(miscounted('The test failed 5 times', tally)?.claim.kind).toBe('failure')
  expect(miscounted('Nothing counted here, 2 of 3 parts done', tally)).toBeUndefined()

  expect(rulesProgress(tally)).toBe('Counted from its steps: 5 reads, 4 searches, 1 edit, 2 test or check runs; 2 failed.')
  expect(rulesProgress(tallyOf(undefined))).toBe('No steps yet.')
})

test("a reply that contradicts the tally has that field replaced by the rules' words", () => {
  const row = born('a1', T, { type: 'Explore', description: 'reread the config' })
  const trail = sample()
  const plan = planned(EMPTY, [row], { a1: trail }, T + 2000)
  const ask = plan.asks[0] as Ask
  const answer = (fields: object): Reply => ({ isAnswered: true, text: JSON.stringify(fields), usage: USED })
  const story = { now: 'Reading config.txt', how: 'It rereads the settings file.' }

  expect(ask.to === 'agent' && ask.tally?.steps).toBe(12)

  const wrong = landed(
    plan.narration,
    ask,
    answer({ ...story, progress: 'It read config.txt 6 times of 8', percent: 75, found: 'debug is on in config.txt; read notes.md 9 times' }),
    T + 3000,
  )
  const told = wrong.stories.a1?.told

  expect(told?.progress).toBe(rulesProgress(tallyOf(trail)))
  expect(told?.percent).toBeUndefined()
  // The rules' found: the last finished step.
  expect(told?.found).toBe('Ran pytest -x')
  expect(told?.now).toBe('Reading config.txt')
  expect(wrong.ledger.miscounts).toBe(2)
  expect(wrong.stories.a1?.corrected).toContain('progress said "read config.txt 6 times"')
  expect(wrong.stories.a1?.corrected).toContain('the tally has 3')

  // A reply whose counts match is kept as it is.
  const right = landed(
    plan.narration,
    ask,
    answer({ ...story, progress: 'It read config.txt 3 of the 8 times asked', percent: 38, found: 'debug is on in config.txt' }),
    T + 3000,
  )

  expect(right.stories.a1?.told?.progress).toBe('It read config.txt 3 of the 8 times asked')
  expect(right.stories.a1?.told?.percent).toBe(38)
  expect(right.ledger.miscounts).toBeUndefined()
  expect(right.stories.a1?.corrected).toBeUndefined()
})
