import { expect, test } from 'claude-code/testing'

import { accessOf, configFacts, PAID_WHY, planName, tail } from '../hooks/billing'
import type { Signals } from '../hooks/billing'

// The money guard, with no engine under it: the narrator runs only where the
// session does not pay per call. Fixtures only: no real config file is read.

const KEY = `sk-ant-api03-${'q'.repeat(40)}AbCdEfGhIjKlMnOpQrSt`
const TAIL = 'AbCdEfGhIjKlMnOpQrSt'
const MAX = { isPaid: false, plan: 'Max plan' } as const
const PAID = { isPaid: true, why: PAID_WHY } as const
const base: Signals = { thirdParty: false, envTails: [], approved: [], planType: 'claude_max', hasLogin: true }

test("the session's own credential decides: a claude.ai login runs, a key or a cloud provider pays", () => {
  expect(PAID_WHY).toBe('Narrator off: this session pays per call. It runs only on your Max plan.')
  expect(accessOf({ ...base, credential: 'bearer' })).toEqual(MAX)
  expect(accessOf({ ...base, credential: 'api-key' })).toEqual(PAID)
  // No first-party credential: a cloud provider, a gateway, or no login at all.
  expect(accessOf({ ...base, credential: 'none' })).toEqual(PAID)
  expect(accessOf({ ...base, credential: 'bearer', thirdParty: true })).toEqual(PAID)
  // A key the person approved for Claude Code is in use, whatever else is there.
  expect(accessOf({ ...base, credential: 'bearer', envTails: [TAIL], approved: [TAIL] })).toEqual(PAID)
  // The plan is named from the login.
  expect(accessOf({ ...base, credential: 'bearer', planType: 'claude_pro' })).toEqual({ isPaid: false, plan: 'Pro plan' })
  expect(planName('claude_max')).toBe('Max plan')
  expect(planName('claude_team')).toBe('Team plan')
  expect(planName(undefined)).toBe('Claude plan')
})

test('with no answer from the engine, the config file decides as Claude Code does', () => {
  // His setup: a key in the environment that Claude Code rejected, and a Max login.
  expect(accessOf({ ...base, envTails: [TAIL], approved: [] })).toEqual(MAX)
  expect(accessOf({ ...base, envTails: [TAIL], approved: [TAIL] })).toEqual(PAID)
  expect(accessOf({ ...base, envTails: [], approved: [TAIL] })).toEqual(MAX)
  // Neither a key in use nor a login: nothing says the plan pays, so it is treated as paid.
  expect(accessOf({ ...base, hasLogin: false })).toEqual(PAID)
  expect(accessOf({ ...base, thirdParty: true })).toEqual(PAID)
  expect(tail(KEY)).toBe(TAIL)
  expect(tail(`  ${KEY}\n`)).toBe(TAIL)
})

test('the config file is read for two fields only, and the key is never kept', () => {
  const fixture = JSON.stringify({
    numStartups: 12,
    primaryApiKey: KEY,
    customApiKeyResponses: { approved: ['ApprovedTailApproved', 7], rejected: [TAIL] },
    oauthAccount: { organizationType: 'claude_max', emailAddress: 'someone@example.com', accountUuid: 'u-1' },
    projects: { 'C:/work/shop': { allowedTools: [] } },
  })
  const facts = configFacts(fixture)

  expect(facts).toEqual({ approved: ['ApprovedTailApproved'], planType: 'claude_max', hasLogin: true })
  expect(JSON.stringify(facts)).not.toContain(TAIL)
  expect(JSON.stringify(facts)).not.toContain('someone@example.com')
  // A file that is missing, torn or of another shape gives nothing to go on.
  for (const text of ['', '{', '[]', 'null', '{"customApiKeyResponses": "x", "oauthAccount": 5}']) {
    expect(configFacts(text)).toEqual({ approved: [], hasLogin: false })
  }
})
