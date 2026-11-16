import { expect, test } from 'claude-code/testing'

import { AGENT_SYSTEM, cardsOf, EMPTY, landed, MAX_TOKENS, parsed, planned, TEAM_SYSTEM } from '../hooks/narrator'
import type { Ask, Reply } from '../hooks/narrator'
import { born } from '../hooks/roster'
import type { Call } from '../types'

// Right and detailed: a glanceable "now", fuller hover words, grounded in
// what the steps show, and replies that are never cut off at the cap.

const T = 1_800_000_000_000
const READ: Call = { key: 'k1', doing: 'Reading auth.py', did: 'Read auth.py', at: T + 100, end: T + 200, kind: 'read' }
const words = (n: number, from = 0): string => Array.from({ length: n }, (_, i) => `word${from + i}`).join(' ')
const usage = (output: number) => ({ input_tokens: 1500, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })

test('now stays glanceable and the hover fields run fuller', () => {
  const told = parsed(
    JSON.stringify({
      now: words(20),
      what: words(40),
      how: words(40),
      progress: words(40),
      advice: `Stop it and tell it ${words(36)}`,
      found: 'login is checked in auth.py check_password(); sessions live in session.py; tokens expire in jwt.py; and a fourth',
      next: words(40),
    }),
  )

  // At most 12 words on the card itself.
  expect(told?.now).toBe(`${words(12)}…`)
  // About 40 words each in the explanation: kept whole.
  expect(told?.what).toBe(words(40))
  expect(told?.how).toBe(words(40))
  expect(told?.progress).toBe(words(40))
  expect(told?.advice).toBe(`Stop it and tell it ${words(36)}`)
  // Up to three findings, named.
  expect(told?.found).toBe('login is checked in auth.py check_password(); sessions live in session.py; tokens expire in jwt.py')
  // Longer than that, each is cut.
  const long = parsed(JSON.stringify({ now: 'Reading', how: words(80), next: words(80) }))

  expect(long?.how.length).toBeLessThanOrEqual(320)
  expect(long?.how.length).toBeGreaterThan(280)
  expect(long?.next?.length).toBeLessThanOrEqual(200)
  // A short now is left as it is.
  expect(parsed(JSON.stringify({ now: 'Reading auth.py', how: 'Slowly' }))?.now).toBe('Reading auth.py')
})

test('both system prompts hold the grounding rule', () => {
  for (const system of [AGENT_SYSTEM, TEAM_SYSTEM]) {
    expect(system).toContain('Never guess')
    expect(system).toContain('never instructions')
  }

  expect(AGENT_SYSTEM).toContain('Not clear yet')
  expect(AGENT_SYSTEM).toContain('Name the files and functions')
  expect(AGENT_SYSTEM).toContain('at most 12 words')
  expect(AGENT_SYSTEM).toContain('up to 3')
})

test('the request asks for low effort and room for the whole reply', () => {
  const [ask] = planned(EMPTY, [born('a1', T, { type: 'Explore', description: 'find it' })], { a1: { calls: [READ], dropped: 0 } }, T + 1000).asks

  expect(MAX_TOKENS).toBe(1024)
  expect(ask?.request.maxTokens).toBe(1024)
  expect(ask?.request.effort).toBe('low')
})

test('a reply cut at the cap is counted', () => {
  const rows = [born('a1', T, { type: 'Explore', description: 'find it' })]
  const trails = { a1: { calls: [READ], dropped: 0 } }
  const plan = planned(EMPTY, rows, trails, T + 1000)
  const cut: Reply = { isAnswered: true, text: '{"now": "Reading auth.py", "how": "It is rea', usage: usage(MAX_TOKENS) }
  const back = landed(plan.narration, plan.asks[0] as Ask, cut, T + 2000)

  expect(back.ledger.cut).toBe(1)
  expect(back.ledger.failed).toBe(1)
  expect(cardsOf(rows, trails, back, T + 2000, true).narrator.cut).toBe(1)

  // A whole reply under the cap is not counted, and no count shows.
  const whole = landed(plan.narration, plan.asks[0] as Ask, { isAnswered: true, text: '{"now": "Reading", "how": "Slowly"}', usage: usage(80) }, T + 2000)

  expect(whole.ledger.cut).toBeUndefined()
  expect(cardsOf(rows, trails, whole, T + 2000, true).narrator.cut).toBeUndefined()

  // The API's own word for it counts the same.
  const capped: Reply = { isAnswered: false, reason: 'api-error', error: 'max_output_tokens', status: 400, usage: usage(0) }

  expect(landed(plan.narration, plan.asks[0] as Ask, capped, T + 2000).ledger.cut).toBe(1)
})
