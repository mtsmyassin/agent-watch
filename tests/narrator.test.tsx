import { expect, test } from 'claude-code/testing'

import {
  healthOf,
  kindNow,
  kindOf,
  outOf,
  plainOf,
  SLOW_MS,
  stageOf,
  steadyKind,
  STUCK_MS,
} from '../hooks/infer'
import { born } from '../hooks/roster'
import type { AgentRow, Call, Kind, Trail } from '../types'

const T = 1_800_000_000_000

/** A call of a kind, started at `at`; open unless it has an `end`. */
function c(kind: Kind | undefined, at: number, end?: number): Call {
  const call: Call = { key: `k${at}`, doing: 'Doing it', did: 'Did it', at }

  if (end !== undefined) {
    call.end = end
  }

  if (kind !== undefined) {
    call.kind = kind
  }

  return call
}

/** Calls of these kinds, a second apart, each over in half a second. */
const kinds = (...list: (Kind | undefined)[]): Call[] =>
  list.map((kind, i) => c(kind, T + i * 1000, T + i * 1000 + 500))

// --- Kind, stage and health: what the cards say without any model -----------

test('tool calls are sorted into kinds of work', () => {
  const k = (tool: string, input: Record<string, unknown> = {}) => kindOf(tool, input)

  expect(k('Read', { file_path: '/repo/notes.txt' })).toBe('read')
  expect(k('WebFetch', { url: 'https://example.com' })).toBe('read')
  expect(k('Grep', { pattern: 'TODO' })).toBe('search')
  expect(k('Glob', { pattern: '**/*.py' })).toBe('search')
  expect(k('WebSearch', { query: 'claude hooks' })).toBe('search')
  expect(k('LS', { path: '/repo' })).toBe('search')

  for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
    expect(k(tool, { file_path: '/repo/a.py' })).toBe('edit')
  }

  for (const command of [
    'pytest -x',
    'python -m pytest tests/',
    'npm test',
    'npm run lint',
    'ruff check .',
    'tsc -p .',
    'claude plugin test .',
    'cd app && go test ./...',
  ]) {
    expect(k('Bash', { command })).toBe('test')
  }

  expect(k('PowerShell', { command: 'npx vitest run' })).toBe('test')

  for (const command of ['ls', 'git status', 'echo testing', 'pip install requests']) {
    expect(k('Bash', { command })).toBe('run')
  }

  expect(k('SubagentHandback')).toBe('write')
  expect(k('StructuredOutput')).toBe('write')
  // Bookkeeping says nothing about the work: the kind it had holds.
  expect(k('TodoWrite')).toBeUndefined()
  expect(k('Agent', { description: 'look around' })).toBeUndefined()
  expect(k('ToolSearch', { query: 'browser' })).toBeUndefined()
  // A connected tool is sorted by the verb in its name.
  expect(k('mcp__claude-in-chrome__read_page')).toBe('read')
  expect(k('mcp__github__search_code')).toBe('search')
  expect(k('mcp__github__create_issue')).toBe('edit')
  expect(k('mcp__playwright__browser_click')).toBe('run')
  expect(k('constructor')).toBe('run')
})

test('the stage follows the work and can go back', () => {
  expect(stageOf([], false)).toBe('looking')
  expect(stageOf(kinds('read', 'search'), false)).toBe('looking')
  expect(stageOf(kinds('read', 'edit'), false)).toBe('changing')
  expect(stageOf(kinds('read', 'edit', 'test'), false)).toBe('checking')
  // Any other command keeps the stage it had.
  expect(stageOf(kinds('read', 'edit', 'test', 'run'), false)).toBe('checking')
  expect(stageOf(kinds('read', 'run'), false)).toBe('looking')
  // A failed check sends it back to making changes.
  expect(stageOf(kinds('read', 'edit', 'test', 'run', 'edit'), false)).toBe('changing')
  expect(stageOf(kinds('read', undefined), false)).toBe('looking')
  expect(stageOf(kinds('read', 'write'), false)).toBe('reporting')
  expect(stageOf(kinds('read'), true)).toBe('reporting')
})

test('a kind counts once it holds', () => {
  expect(steadyKind([], T)).toBeUndefined()
  expect(steadyKind(kinds('read'), T + 5000)).toBe('read')
  // Reading and searching side by side is no change of work yet.
  expect(steadyKind(kinds('read', 'search'), T + 5000)).toBeUndefined()
  expect(steadyKind(kinds('read', 'search', 'search'), T + 5000)).toBe('search')
  expect(steadyKind(kinds('read', 'search', undefined), T + 5000)).toBeUndefined()

  // One long search after a read: it holds once it has run 8 s.
  const long = [c('read', T, T + 100), c('search', T + 1000)]

  expect(steadyKind(long, T + 1000 + 7999)).toBeUndefined()
  expect(steadyKind(long, T + 1000 + 8000)).toBe('search')
})

test('the kind of work now is the call in flight, else the last one', () => {
  expect(kindNow([])).toBeUndefined()
  expect(kindNow([c('read', T, T + 1), c('search', T + 2)])).toBe('search')
  expect(kindNow([c('search', T), c('read', T + 1, T + 2)])).toBe('search')
  expect(kindNow([c('edit', T, T + 1), c(undefined, T + 2, T + 3)])).toBe('edit')
})

test('health turns amber at 60 s and red at 120 s, a call in flight included', () => {
  const row = born('a1', T)

  expect(SLOW_MS).toBe(60_000)
  expect(STUCK_MS).toBe(120_000)
  expect(healthOf(row, T + 59_999)).toBe('working')
  expect(healthOf(row, T + 60_000)).toBe('slow')
  expect(healthOf(row, T + 120_000)).toBe('stuck')

  // A call still in flight is no new step: the agent is quiet since it began.
  const flying: AgentRow = { ...row, inFlight: 1, activity: 'Searching for x' }

  expect(healthOf(flying, T + 130_000)).toBe('stuck')
  expect(healthOf({ ...row, state: 'waiting' }, T + 130_000)).toBe('stuck')
  expect(healthOf({ ...row, state: 'completed', endedAt: T }, T + 900_000)).toBe('done')
  expect(healthOf({ ...row, state: 'failed', endedAt: T }, T + 900_000)).toBe('done')
  // A teammate between turns is resting, not stuck.
  expect(healthOf({ ...row, state: 'idle', isTeammate: true }, T + 900_000)).toBe('idle')
})

test("the rules-only text is the pane's own wording", () => {
  const row = born('a1', T, { activity: 'Reading notes.txt', inFlight: 1, tools: 2 })
  const trail: Trail = {
    calls: [
      { key: 'k1', doing: 'Searching *.txt', did: 'Searched *.txt', at: T - 2000, end: T - 1000, kind: 'search' },
      { key: 'k2', doing: 'Reading notes.txt', did: 'Read notes.txt', at: T, kind: 'read' },
    ],
    dropped: 0,
  }

  expect(plainOf(row, trail, T + 1000)).toEqual({ now: 'Reading notes.txt', found: 'Searched *.txt' })

  // Once over, the agent's own answer stands.
  const over: AgentRow = {
    ...row,
    state: 'completed',
    inFlight: 0,
    endedAt: T + 5000,
    answer: 'Two files mention mango.',
  }

  expect(plainOf(over, { ...trail, result: 'Two files mention mango: a.txt and b.txt.' }, T + 6000)).toEqual({
    now: 'Two files mention mango.',
    found: 'Two files mention mango: a.txt and b.txt.',
  })
  expect(plainOf(born('a2', T), undefined, T)).toEqual({ now: 'Starting', found: '' })
})

test("a call's result is cut short and masked before anyone reads it", () => {
  const secret = ['hunter', '2'].join('')
  const out = outOf(`Found it in C:\\Users\\me\\repo\\auth.py with password=${secret} ${'and more '.repeat(200)}`)

  expect(out.startsWith('Found it in auth.py with password=***')).toBe(true)
  expect(out.length).toBeLessThanOrEqual(140)
  expect(out).not.toContain(secret)
  expect(out).not.toContain('Users')
  expect(outOf('')).toBe('')
})
