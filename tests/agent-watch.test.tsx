import { expect, mock, test } from 'claude-code/testing'
import type { AgentInfo, On } from 'claude-code'

import {
  acted,
  arranged,
  born,
  clip,
  describeCall,
  doing,
  drawn,
  GONE_MS,
  heading,
  plain,
  redact,
  settled,
  span,
  spawned,
  summarized,
  SUMMARY_MS,
  synced,
  unpathed,
} from '../hooks/roster'
import type { Sight } from '../hooks/roster'
import type { AgentRow } from '../types'

const PLUGIN = 'agent-watch'
const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const SESSION = { cwd: '/', surface: 'terminal', isInteractive: true } as const

const PANE = {
  plugin: PLUGIN,
  component: 'Pane',
  requestId: 'agent-watch',
  props: {
    title: 'Agents',
    isFocused: false,
    bodyColumns: 76,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const SPAWN = {
  tool_use_id: 'toolu_1',
  prompt: 'Find where login is handled and report the files.',
  description: 'find the auth flow',
  subagentType: 'Explore',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-fable-5-2',
  background: true,
  fork: false,
} as const

const DONE = {
  answer: 'Login lives in auth/session.py.',
  durationMs: 4000,
  isAborted: false,
  turnId: 't1',
  agentId: 'a1',
  reason: 'answer',
  usage: {
    input_tokens: 1000,
    output_tokens: 300,
    cache_read_input_tokens: 9000,
    cache_creation_input_tokens: 200,
    model: 'claude-haiku-5-5',
  },
} as const

/** What the test's engine recorded, and what it answers the mod with. */
type World = {
  roster: AgentInfo[]
  nextId: string
  viewDeny: string | undefined
  status: (string | undefined)[]
  toasts: string[]
  viewed: string[]
  opened: number
  /** How many times a pane was closed, by anyone. */
  closed: number
  /** False stands for a terminal too narrow to draw a pane nobody asked for. */
  isPlaced: boolean
  polls: number
  redraws: number
  registered: string[]
}

// Nothing sits beneath the mod under test: each hook here stands for the
// engine. A call on `$` is answered `{ value }`; an event by its own result.
// `env` is the process's environment as the mod reads it at the start.
function world(on: On, env: Readonly<Record<string, string>> = {}): World {
  const w: World = {
    roster: [],
    nextId: 'a1',
    viewDeny: undefined,
    status: [],
    toasts: [],
    viewed: [],
    opened: 0,
    closed: 0,
    isPlaced: true,
    polls: 0,
    redraws: 0,
    registered: [],
  }

  mock.env(on, env)
  on('command.register', () => {
    w.registered.push('command')

    return { value: { command: PLUGIN } }
  })
  on('tool.register', () => {
    w.registered.push('tool')

    return { value: { tool: 'mcp__agent-watch__snapshot' } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: w.nextId }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('agent.list', () => {
    w.polls += 1

    return { value: w.roster }
  })
  on('ui.open', () => {
    w.opened += 1

    return {
      value: w.isPlaced
        ? { isPlaced: true }
        : { isPlaced: false, reason: 'the terminal is too narrow' },
    }
  })
  on('ui.close', () => {
    w.closed += 1

    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.invalidate', () => {
    w.redraws += 1

    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    w.status.push(e.text)

    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    w.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.view', (_, e) => {
    w.viewed.push(e.agentId ?? 'main')

    return { value: w.viewDeny === undefined ? {} : { deny: w.viewDeny } }
  })

  return w
}

// The mod folds an event into its rows after the event itself has settled,
// so the event never waits on the pane. A test lets that finish before it
// looks: `clock.settle()`.

test('an agent shows what it is doing, from its spawn to its answer', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  let midCall: string | undefined

  // The call is in flight while this hook runs: the pane must show it so.
  on('tool.call', async () => {
    await clock.settle()
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    midCall = (await ui.find({ type: 'Text', text: /Running/ }))?.text
    await ui.unmount()

    return { result: {} }
  })

  await $.session.start(SESSION)
  await $.agent.spawn(SPAWN)
  await $.turn.start({ text: SPAWN.prompt, turnId: 't1', agentId: 'a1' })
  await $.tool.call({ tool: 'Bash', command: 'pytest -x', agentId: 'a1' })
  await clock.settle()

  expect(midCall).toContain('Running pytest -x')
  expect(w.opened).toBe(1)
  // The open pane says who is working: the status line never repeats it.
  expect(w.status).not.toContain('1 agent working')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const row = await ui.find({ key: 'agent:a1' })

    expect(row?.text).toContain('Explore')
    expect(row?.text).toContain('find the auth flow')
    // The call is over: it is still named, in the past, where "thinking" was.
    expect(await ui.find({ type: 'Text', text: /Ran pytest -x/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /thinking/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /1 tool/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 running/ })).toBeDefined()
    await ui.unmount()
  }

  await $.turn.complete(DONE)
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const how = await ui.find({ type: 'Text', text: /Login lives/ })

  expect(how?.text).toContain('Login lives in auth/session.py.')
  expect((await ui.find({ key: 'agent:a1' }))?.text).toContain('✓')
  expect((await ui.find({ key: 'agent:a1' }))?.text).toContain('1 tool')
  expect(await ui.find({ type: 'Text', text: /1 done/ })).toBeDefined()
  expect(w.status.at(-1)).toBeUndefined()
  await ui.unmount()
})

test('a tool call is never made to wait on the pane', async ($, on) => {
  world(on)
  const clock = mock.clock(on)
  let rowsAtCall = -1

  // Reached before anything is folded: the mod passed the call straight on.
  on('tool.call', async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    rowsAtCall = (await ui.find({ type: 'Text', text: /Running ls/ })) ? 1 : 0
    await ui.unmount()

    return { result: {} }
  })

  await $.session.start(SESSION)
  await $.agent.spawn(SPAWN)
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' })

  expect(rowsAtCall).toBe(0)

  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /1 tool/ })).toBeDefined()
  await ui.unmount()
})

test("the main loop's calls and the engine's own forks get no row", async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  on('tool.call', () => ({ result: {} }))

  await $.session.start(SESSION)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'fork-9' })
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'fork-9' })
  await $.turn.complete({ ...DONE, agentId: 'fork-9' })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ type: 'Text', text: /No agents yet/ })).toBeDefined()
  expect(w.opened).toBe(0)
  // Once at the start, once to look the stranger up; it is remembered after.
  expect(w.polls).toBe(2)
  await ui.unmount()
})

test('an agent the mod never heard spawn is picked up from the roster', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  let midCall: string | undefined

  on('tool.call', async () => {
    await clock.settle()
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    midCall = (await ui.find({ type: 'Text', text: /Searching/ }))?.text
    await ui.unmount()

    return { result: {} }
  })

  await $.session.start(SESSION)
  await clock.settle()
  w.roster = [
    {
      id: 'b7',
      description: 'review the diff',
      type: 'general-purpose',
      status: 'running',
    },
  ]
  await $.tool.call({ tool: 'Grep', pattern: 'TODO', path: 'src', agentId: 'b7' })
  await clock.settle()

  expect(midCall).toContain('Searching for TODO')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const row = await ui.find({ key: 'agent:b7' })

  // The row says the type short; the roster the model reads keeps its name.
  expect(row?.text).toContain('General')
  expect(row?.text).not.toContain('general-purpose')
  expect(row?.text).toContain('review the diff')
  expect(w.opened).toBe(1)
  await ui.unmount()
})

test('a credential in a command never reaches the pane', async ($, on) => {
  world(on)
  const clock = mock.clock(on)
  let midCall = ''

  on('tool.call', async () => {
    await clock.settle()
    const ui = await $.ui.mount({
      ...PANE,
      props: { ...PANE.props, placement: 'inline', bodyColumns: 160 },
      surface: 'terminal',
    })
    midCall = (await ui.find({ type: 'Text', text: /curl/ }))?.text ?? ''
    await ui.unmount()

    return { result: {} }
  })

  await $.session.start(SESSION)
  await $.agent.spawn(SPAWN)
  await $.tool.call({
    tool: 'Bash',
    command: 'MY_TOKEN=hunter2 curl -H "Authorization: Bearer abc.def" x.test',
    agentId: 'a1',
  })

  expect(midCall).toContain('MY_TOKEN=***')
  expect(midCall).toContain('Authorization: ***')
  expect(midCall).not.toContain('hunter2')
  expect(midCall).not.toContain('abc.def')
})

test('the roster poll shows waiting and stopped, then the clock stops', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  const listed = {
    id: 'a1',
    description: 'find the auth flow',
    type: 'Explore',
  } as const

  await $.session.start(SESSION)
  await $.agent.spawn(SPAWN)
  await clock.settle()

  w.roster = [{ ...listed, status: 'waiting' }]
  await clock.advance(3000)

  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Waiting on background work/ })).toBeDefined()
  await ui.unmount()

  w.roster = [{ ...listed, status: 'killed' }]
  await clock.advance(3000)

  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'agent:a1' }))?.text).toContain('■')
  expect(await ui.find({ type: 'Text', text: /Stopped/ })).toBeDefined()
  expect(w.status.at(-1)).toBeUndefined()
  await ui.unmount()

  // Nothing works any more: the mod stops asking.
  const polls = w.polls
  await clock.advance(30_000)
  expect(w.polls).toBe(polls)
})

test('pressing an agent opens its transcript, and a refusal is said', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)

  await $.session.start(SESSION)
  await $.agent.spawn(SPAWN)
  await clock.settle()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'agent:a1' })
    await ui.unmount()
  }

  expect(w.viewed).toEqual(['a1', 'a1', 'a1', 'a1'])
  expect(w.toasts).toEqual([])

  w.viewDeny = 'the tasks list shows no row for it'
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'agent:a1' })
  await ui.unmount()

  expect(w.toasts).toEqual(['Explore: the tasks list shows no row for it'])
})

test('once dismissed, the pane stays closed until it is asked for', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  // The kit cannot raise a person's close of a pane, so what that close
  // stores is held here: the mod reads it dismissed from the start.
  let dismissed = { value: true, version: 1 }

  on('state.get', (_, e, next) =>
    e.key === 'isDismissed' ? { value: dismissed } : next(e),
  )
  on('state.set', (_, e, next) => {
    if (e.key !== 'isDismissed') {
      return next(e)
    }

    dismissed = { value: e.value === true, version: dismissed.version + 1 }

    return { value: { isSet: true, version: dismissed.version } }
  })

  await $.session.start(SESSION)
  await $.agent.spawn(SPAWN)
  w.nextId = 'a2'
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'toolu_2', description: 'write tests' })
  await clock.settle()
  expect(w.opened).toBe(0)
  // Closed, it still counts: the status line needs no pane.
  expect(w.status.at(-1)).toBe('2 agents working')

  const ran = await $.command.run({
    command: 'agent-watch',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

  expect(w.opened).toBe(1)
  expect(dismissed.value).toBe(false)
  expect(w.status.at(-1)).toBeUndefined()
  expect(ran.text).toContain('[running] Explore "find the auth flow"')
  expect(ran.text).toContain('[running] Explore "write tests"')

  w.nextId = 'a3'
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'toolu_3', description: 'read the docs' })
  await clock.settle()
  expect(w.opened).toBe(2)
})

test('in a nested worker the mod registers nothing and watches nothing', async ($, on) => {
  const w = world(on, { DELTAO_NESTED_CLI: '1' })
  const clock = mock.clock(on)
  let calls = 0

  on('tool.call', () => {
    calls += 1

    return { result: {} }
  })

  await $.session.start(SESSION)
  await $.agent.spawn(SPAWN)
  await $.turn.start({ text: SPAWN.prompt, turnId: 't1', agentId: 'a1' })
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' })
  await $.turn.complete(DONE)
  await clock.advance(10_000)

  // Every event still reached the engine; the mod added nothing of its own.
  expect(calls).toBe(1)
  expect(w.registered).toEqual([])
  expect(w.opened).toBe(0)
  expect(w.polls).toBe(0)
  expect(w.redraws).toBe(0)
  expect(w.status).toEqual([])
})

test('a nested worker told AGENT_WATCH=on is watched like any session', async ($, on) => {
  const w = world(on, { DELTAO_NESTED_CLI: '1', AGENT_WATCH: 'on' })
  const clock = mock.clock(on)

  await $.session.start(SESSION)
  await $.agent.spawn(SPAWN)
  await clock.settle()

  expect(w.registered).toEqual(['command', 'tool'])
  expect(w.opened).toBe(1)
  expect((await $.tool.call({ tool: 'mcp__agent-watch__snapshot' })).result).toContain(
    '1 working',
  )
})

test('with no screen the rows are kept, and no pane or clock is started', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await $.agent.spawn(SPAWN)
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' })
  await clock.settle()

  const polls = w.polls
  await clock.advance(30_000)

  expect(w.opened).toBe(0)
  expect(w.redraws).toBe(0)
  expect(w.polls).toBe(polls)
  expect(w.status.at(-1)).toBe('1 agent working')

  // The command and the model's tool still answer, and still open nothing.
  const ran = await $.command.run({
    command: 'agent-watch',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
  const seen = await $.tool.call({ tool: 'mcp__agent-watch__snapshot' })

  expect(ran.text).toContain('[running] Explore "find the auth flow"')
  expect(String(seen.result)).toContain('1 tool')
  expect(w.opened).toBe(0)
})

test('a long answer is one short line that never runs past the pane', async ($, on) => {
  world(on)
  const clock = mock.clock(on)

  await $.session.start(SESSION)
  await $.agent.spawn(SPAWN)
  await $.turn.complete({ ...DONE, answer: 'The login flow was traced. '.repeat(8) })
  await clock.settle()

  for (const placement of ['dock', 'inline'] as const) {
    for (const bodyColumns of [40, 76, 160]) {
      const ui = await $.ui.mount({
        ...PANE,
        props: { ...PANE.props, placement, bodyColumns },
        surface: 'terminal',
      })
      const how = await ui.find({ type: 'Text', text: /The login flow/ })

      expect(how?.text).toContain('…')
      expect(how?.text.trimEnd().length).toBeLessThanOrEqual(bodyColumns)
      await ui.unmount()
    }
  }
})

test('where the pane cannot be drawn, the status line says who is working', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)

  w.isPlaced = false
  await $.session.start(SESSION)
  await $.agent.spawn(SPAWN)
  await clock.settle()

  expect(w.opened).toBe(1)
  expect(w.status.at(-1)).toBe('1 agent working')

  await $.turn.complete(DONE)
  await clock.settle()
  expect(w.status.at(-1)).toBeUndefined()
})

test("the model's snapshot tool reads the same roster", async ($, on) => {
  world(on)
  mock.clock(on)
  on('tool.call', () => ({ result: {} }))

  await $.session.start(SESSION)
  await $.agent.spawn(SPAWN)
  await $.tool.call({ tool: 'Read', file_path: '/repo/auth/session.py', agentId: 'a1' })

  // No settling here: the tool itself waits for what was heard so far.
  const ran = await $.tool.call({ tool: 'mcp__agent-watch__snapshot' })

  expect(String(ran.result)).toContain('1 working')
  expect(String(ran.result)).toContain('[running] Explore "find the auth flow"')
  expect(String(ran.result)).toContain('1 tool')
})

test('a pane the mod opened closes itself once the work is done', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)

  await $.session.start(SESSION)
  await $.agent.spawn(SPAWN)
  await clock.settle()
  // An agent is at work: however long it takes, the pane stays.
  await clock.advance(60_000)
  expect(w.closed).toBe(0)

  await $.turn.complete(DONE)
  await clock.settle()

  // The result stays a moment to be read: there is no link to press.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'clear' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Login lives/ })).toBeDefined()
  await ui.unmount()
  await clock.advance(5000)
  expect(w.closed).toBe(0)

  await clock.advance(20_000)
  expect(w.closed).toBe(1)

  // Closed by the mod, not by the person: the next agent opens it again.
  const opened = w.opened
  w.nextId = 'a2'
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'toolu_2', description: 'write tests' })
  await clock.settle()
  expect(w.opened).toBe(opened + 1)
})

test('a pane the person asked for stays open when the work is done', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)

  await $.session.start(SESSION)
  await $.agent.spawn(SPAWN)
  await clock.settle()
  await $.command.run({
    command: 'agent-watch',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
  await $.turn.complete(DONE)
  await clock.settle()
  await clock.advance(120_000)

  expect(w.closed).toBe(0)

  // The finished agent is still listed, and the clock has stopped.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'agent:a1' }))?.text).toContain('✓')
  await ui.unmount()

  const redraws = w.redraws
  await clock.advance(30_000)
  expect(w.redraws).toBe(redraws)
})

test("the engine's own handback call is said in plain words and not counted", async ($, on) => {
  world(on)
  const clock = mock.clock(on)
  let midCall: string | undefined

  on('tool.call', async (_, e) => {
    // In no list of tools the types know: the engine's own, seen only live.
    if ((e.tool as string) === 'SubagentHandback') {
      await clock.settle()
      const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
      midCall = (await ui.find({ key: 'agent:a1' }))?.text
      await ui.unmount()
    }

    return { result: {} }
  })

  await $.session.start(SESSION)
  await $.agent.spawn(SPAWN)
  await $.tool.call({ tool: 'Read', file_path: '/repo/notes.txt', agentId: 'a1' })
  await $.tool.call({ tool: 'SubagentHandback', agentId: 'a1' } as never)
  await clock.settle()

  expect(midCall).toContain('Reporting back')
  expect(midCall).not.toContain('SubagentHandback')
  expect(midCall).toContain('1 tool')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'agent:a1' }))?.text).toContain('Reported back · 1 tool')
  await ui.unmount()
})

test('rows an earlier version stored are declined', async ($, on) => {
  // What the code before an edit wrote stays through the reload.
  on('state.get', () => ({
    value: { value: [{ tool: 'Bash' }], version: 1 },
  }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /No agents yet/ })).toBeDefined()
  await ui.unmount()
})

// --- The roster's own logic, with no engine under it -----------------------

test('what has the name or the shape of a credential is masked', () => {
  // Shaped strings are built here, never written out, so no scanner of this
  // file meets one.
  const blob = 'k7x2m9q4w8'.repeat(4)
  const mixed = 'aB3dE6gH9j'.repeat(4)
  const jwt = [`eyJ${'a'.repeat(12)}`, 'b'.repeat(12), 'c'.repeat(6)].join('.')
  const bot = `123456789:${'Ab1'.repeat(12)}`

  expect(redact('MY_TOKEN=abc123 make deploy')).toBe('MY_TOKEN=*** make deploy')
  expect(redact('password: "two words"')).toBe('password: ***')
  expect(redact('curl -d {"password":"hunter2"} x')).toBe(
    'curl -d {"password":***} x',
  )
  expect(redact('db --password hunter2 --port 5432')).toBe(
    'db --password *** --port 5432',
  )
  expect(redact('psql postgres://bob:hunter2@db.test/app')).toBe(
    'psql postgres://***@db.test/app',
  )
  expect(redact('-H "Authorization: Token abcd1234"')).toBe(
    '-H "Authorization: ***"',
  )
  expect(redact('send Bearer abcd.efgh.1234 now')).toBe('send Bearer *** now')
  expect(redact(`git show ${'0123456789abcdef'.repeat(2)}01234567`)).toBe(
    'git show ***',
  )
  expect(redact(`cat ${mixed}`)).toBe('cat ***')
  expect(redact(`use ${blob} here`)).toBe('use *** here')
  expect(redact(`curl -H "X: ${jwt}"`)).toBe('curl -H "X: ***"')
  expect(redact(`notify ${bot}`)).toBe('notify ***')
  expect(redact('-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc')).toBe(
    '-----BEGIN PRIVATE KEY----- ***',
  )
})

test('ordinary text is left as written', () => {
  for (const plain of [
    'fix the token refresh bug',
    'max_tokens=4096 tokens: 5',
    'run --max-tokens 4096 --verbose',
    'write basic tests; Basic idea',
    'Bearer token handling',
    'mkdir -p build/out',
    'notes-on-a-very-long-kebab-case-file-name-example.md',
    'release-checklist-and-rollback-plan-2026-10-30.md',
    'python -m pytest tests/test_infrastructure_contracts.py -x',
    'git clone https://github.com/owner/repo.git',
  ]) {
    expect(redact(plain)).toBe(plain)
  }
})

test('a short flag is masked after the commands that read a password there', () => {
  expect(redact('mysql -u root -p hunter2 shop')).toBe('mysql -u root -p *** shop')
  expect(redact('mysqldump -phunter2 shop > out.sql')).toBe(
    'mysqldump -p*** shop > out.sql',
  )
  expect(redact('docker login -u bob -p hunter2 reg.test')).toBe(
    'docker login -u bob -p *** reg.test',
  )
  expect(redact('curl -u bob:hunter2 https://x.test')).toBe(
    'curl -u bob:*** https://x.test',
  )
  expect(redact('curl --user "bob:hunter2" x.test')).toBe(
    'curl --user "bob:***" x.test',
  )
  expect(redact('zip -P hunter2 out.zip notes.txt')).toBe(
    'zip -P *** out.zip notes.txt',
  )
  expect(redact('7z a -phunter2 out.7z notes.txt')).toBe('7z a -p*** out.7z notes.txt')
  expect(redact('openssl rsa -passin pass:hunter2 -in k.pem')).toBe(
    'openssl rsa -passin pass:*** -in k.pem',
  )
  // A password of digits is still a password, and the next command's own
  // `-p` is still a port.
  expect(redact('sshpass -p 123456 ssh -p 2222 host')).toBe(
    'sshpass -p *** ssh -p 2222 host',
  )
  expect(redact('mysql -P 3306 -p 4096 shop')).toBe('mysql -P 3306 -p *** shop')
})

test('a short flag is left alone everywhere else', () => {
  for (const plain of [
    'mkdir -p build/out',
    'claude -p "say hi" --model haiku',
    'ssh -p 2222 host uptime',
    'mysql -h db.test -P 3306 shop',
    'docker run -p 8080:80 -u 1000:1000 nginx',
    'mysql -u root shop < dump.sql && mkdir -p out',
    'curl --url http://x.test:8080/a -o out.txt',
  ]) {
    expect(redact(plain)).toBe(plain)
  }
})

test('a key cut up by slashes, and base64 with its padding, are masked', () => {
  // Built here, never written out, so no scanner of this file meets one.
  const chunk = 'aB3dE6gH9j'
  const cloudKey = [chunk, chunk.slice(0, 9), chunk, chunk.slice(0, 8)].join('/')
  const padded = `${chunk}${chunk.slice(0, 8)}==`

  expect(cloudKey.length).toBe(40)
  expect(redact(`aws configure set x ${cloudKey}`)).toBe('aws configure set x ***')
  expect(redact(`echo ${padded} | base64 -d`)).toBe('echo *** | base64 -d')
  expect(redact(`-H "X-Auth: ${padded}"`)).toBe('-H "X-Auth: ***"')
})

test('paths, links and searches made of words are left as written', () => {
  for (const plain of [
    'cat src/components/v2/HeaderBar/HeaderBarContainer.tsx',
    'ls packages/core/src/Services/Auth/OAuth2TokenRefreshService',
    'open https://example.com/api/v2/Users/GetAccountDetails/12345678',
    'fetch https://x.test/search?q=Claude+Code+hooks+2026+plugin+docs',
    'if (someLongCamelCaseIdentifier2== other) return',
    'run --someLongCamelCaseOption2= now',
  ]) {
    expect(redact(plain)).toBe(plain)
  }
})

test('the shapes a review found still showing are masked', () => {
  // Built here, never written out, so no scanner of this file meets one.
  const restricted = ['rk', 'live', 'a1b2c3d4e5f6'].join('_')

  expect(redact('curl -sSu bob:hunter2 https://x.test')).toBe(
    'curl -sSu bob:*** https://x.test',
  )
  expect(redact("curl -u 'bob:hunter 2' x.test")).toBe("curl -u 'bob:***' x.test")
  expect(redact('curl -d "{\\"password\\":\\"hunter2\\"}" x.test')).toBe(
    'curl -d "{\\"password\\":***}" x.test',
  )
  expect(redact('export PW=hunter2')).toBe('export PW=***')
  expect(redact('DB_PASS=hunter2 ./run.sh')).toBe('DB_PASS=*** ./run.sh')
  expect(redact('get https://x.test/f?sig=abc123def')).toBe(
    'get https://x.test/f?sig=***',
  )
  expect(redact('keytool -storepass hunter2 -list')).toBe(
    'keytool -storepass *** -list',
  )
  expect(redact('curl -H "Cookie: sid=abc; theme=dark" x.test')).toBe(
    'curl -H "Cookie: ***" x.test',
  )
  expect(redact('gh secret set API -b hunter2')).toBe('gh secret set API -b ***')
  expect(redact('curl --oauth2-bearer abcdefgh x.test')).toBe(
    'curl --oauth2-bearer *** x.test',
  )
  expect(redact(`pay ${restricted} now`)).toBe('pay *** now')
  expect(redact('-----BEGIN PGP PRIVATE KEY BLOCK-----\nabc')).toBe(
    '-----BEGIN PRIVATE KEY----- ***',
  )
})

test('code and flags that only name a secret are left as written', () => {
  for (const plain of [
    'def login(password: str, token: string = None)',
    'secret: true, api_key: null',
    'read the Basic Authentication setup guide',
    'tokenizer=cl100k_base',
    'docker login -u bob --password-stdin ghcr.io',
    'run --token-file /home/u/.tok',
    'open ProjectHealthReportGenerator2Test.py',
    'run --bypass-cache=1 --design=dark',
  ]) {
    expect(redact(plain)).toBe(plain)
  }
})

test('a tool call reads as a person would say it', () => {
  expect(
    describeCall('Read', { file_path: 'C:\\repo\\app\\core\\config.py' }),
  ).toBe('Reading config.py')
  expect(describeCall('Edit', { file_path: '/repo/app/main.py' })).toBe('Editing main.py')
  expect(describeCall('Glob', { pattern: '**/*.txt' })).toBe('Searching **/*.txt')
  expect(describeCall('Grep', { pattern: 'TODO', path: 'src' })).toBe('Searching for TODO')
  expect(
    describeCall('Bash', { command: 'npm test\n  --watch', description: 'Run tests' }),
  ).toBe('Running npm test --watch')
  expect(describeCall('WebFetch', { url: 'https://docs.example.com/a/b?c=1' })).toBe(
    'Fetching docs.example.com',
  )
  expect(
    describeCall('mcp__firecrawl__firecrawl_search', { query: 'claude hooks' }),
  ).toBe('Searching: claude hooks')
  expect(describeCall('TaskList', {})).toBe('Checking the task list')
  expect(describeCall('Bash', { command: 'x'.repeat(200) }).length).toBe(72)
})

test('no internal tool name and no full folder path reaches a row', () => {
  expect(describeCall('SubagentHandback', {})).toBe('Reporting back')
  expect(describeCall('NotebookRead', { notebook_path: '/home/me/lab/run.ipynb' })).toBe(
    'Reading notebook: run.ipynb',
  )
  expect(
    describeCall('Bash', {
      command: 'pytest C:\\Users\\me\\AppData\\Local\\Temp\\job\\tests -x',
    }),
  ).toBe('Running pytest tests -x')
  expect(describeCall('Read', { file_path: '/var/lib/app/data/notes.txt' })).toBe(
    'Reading notes.txt',
  )
  expect(unpathed('see ~/.claude/mods/agent-watch/hooks/roster.ts for it')).toBe(
    'see roster.ts for it',
  )
  // A link, a glob and a path with no root are not folder paths.
  expect(unpathed('https://example.com/a/b/c src/**/*.ts core/config.py')).toBe(
    'https://example.com/a/b/c src/**/*.ts core/config.py',
  )
})

test('a connected tool is said in plain words, never by its raw name', () => {
  const said = [
    describeCall('mcp__claude-in-chrome__read_page', {}),
    describeCall('mcp__claude-in-chrome__javascript_tool', { text: 'document.title' }),
    describeCall('mcp__claude-in-chrome__tabs_context_mcp', {}),
    describeCall('mcp__claude_ai_Google_Calendar__list_events', {}),
    describeCall('mcp__telegram__telegram_send_message', { message: 'hello' }),
    describeCall('mcp__playwright__browser_take_screenshot', {}),
    describeCall('mcp__claude-in-chrome__navigate', { url: 'https://docs.example.com/a' }),
    describeCall('mcp__acme-crm__zzq', {}),
    describeCall('mcp__plugin_apollo_apollo__apollo_contacts_search', { query: 'vp sales' }),
  ]

  expect(said).toEqual([
    'Reading page',
    'Using the browser',
    'Using the browser',
    'Listing events',
    'Sending message',
    'Capturing in the browser',
    'Opening: docs.example.com',
    'Using Acme Crm',
    'Searching contacts: vp sales',
  ])
  // No server id, no snake case, no double underscore reaches the pane.
  expect(said.join(' ')).not.toMatch(/mcp|__|_|claude in chrome|javascript/)
  expect(settled('Reading page')).toBe('Read page')
  expect(settled('Listing events')).toBe('Listed events')
  expect(settled('Using the browser')).toBe('Used the browser')
})

test('the type is said short, so the task keeps the room', () => {
  const lines = plain(drawn(FOUR, NOW, DOCK))

  // Docked, the task has 30 letters (20 while the type read `general-purpose`):
  // a five-word task shows whole, a longer one is cut at a word's end.
  expect(lines[1]?.startsWith('● Explore  List words in each .txt file    Reading')).toBe(true)
  expect(lines[2]?.startsWith('● General  Count lines in each .txt file   Searched')).toBe(true)
  expect(lines[3]?.startsWith('✓ Explore  Find mango mentions in .txt…    11 tools')).toBe(true)
  // Beside the pane the engine's own list still says the full name.
  expect(lines.join('\n')).not.toContain('general-purpose')
  // A dock is at most 45% of the terminal: at 170 columns it has one column
  // less than asked for, and the 29-letter task still shows whole.
  const tight = plain(drawn(FOUR, NOW, { ...DOCK, columns: 73 }))

  expect(tight[2]?.startsWith('● General  Count lines in each .txt file  Searched')).toBe(true)
  // A plugin's agent drops its prefix, and a long name is cut at twelve
  // letters, so it costs the task five letters and no more.
  const long = plain(
    drawn([agent('x1', { type: 'ecc:security-reviewer' })], NOW, DOCK),
  )

  expect(long[1]?.startsWith('● security-re…  List words in each .txt…   Starting')).toBe(true)
})

test('the rows start right under the header, docked and inline alike', () => {
  for (const sight of [DOCK, INLINE]) {
    const lines = plain(drawn(FOUR, NOW, sight))

    expect(lines[0]?.startsWith('Agents')).toBe(true)
    expect(lines[1]?.startsWith('● Explore')).toBe(true)
    expect(lines.every(line => line.trim() !== '')).toBe(true)
  }
})

test('a call that is over is said in the past', () => {
  expect(settled('Reading notes.txt')).toBe('Read notes.txt')
  expect(settled('Searching for TODO')).toBe('Searched for TODO')
  expect(settled('Running pytest -x')).toBe('Ran pytest -x')
  expect(settled('Reporting back')).toBe('Reported back')
  expect(settled('Using firecrawl search: hooks')).toBe('Used firecrawl search: hooks')
})

test('time reads as a person says it', () => {
  expect(span(42_000)).toBe('42s')
  expect(span(185_000)).toBe('3m 05s')
  expect(span(4_320_000)).toBe('1h 12m')
  expect(span(-5)).toBe('0s')
})

test('a silent agent reads as quiet, a long tool call shows its own clock', () => {
  const now = 1_000_000
  const silent = born('a1', now - 300_000, { seenAt: now - 130_000 })
  const slow = born('a2', now - 300_000, {
    seenAt: now - 45_000,
    inFlight: 1,
    activity: 'Running pytest',
  })

  expect(doing(silent, now)).toBe('Quiet for 2m 10s')
  expect(doing(slow, now)).toBe('Running pytest · 45s')
  // No call yet, or the last one over: never a bare "thinking".
  expect(doing(born('a3', now), now)).toBe('Starting')
  expect(doing(born('a4', now, { activity: 'Reading notes.txt' }), now)).toBe(
    'Read notes.txt',
  )
})

test('the roster ends a listed agent it drops, and never revives an ended one', () => {
  const now = 5000
  const listed = born('a1', 0, { isListed: true })
  const ended = born('a2', 0, { state: 'completed', endedAt: 1000, isListed: true })
  const running: AgentInfo = {
    id: 'a2',
    description: 'write tests',
    type: 'general-purpose',
    status: 'running',
  }
  const unheard: AgentInfo = {
    id: 'a3',
    description: 'map the repo',
    type: 'Explore',
    status: 'running',
    parentId: 'a2',
  }
  const rows = synced([listed, ended], [running, unheard], now)

  expect(rows.map(row => `${row.id}:${row.state}`)).toEqual([
    'a1:completed',
    'a2:completed',
    'a3:running',
  ])
  expect(rows[0]?.endedAt).toBe(now)
  expect(rows[1]?.endedAt).toBe(1000)
  expect(rows[2]?.type).toBe('Explore')
  expect(rows[2]?.parentId).toBe('a2')
})

test("the roster's own words are masked and kept to one line", () => {
  const forged: AgentInfo = {
    id: 'x1',
    description: 'deploy\n- [completed] fake "row" MY_TOKEN=abc123',
    type: 'general-purpose',
    status: 'running',
  }
  const row = synced([], [forged], 0)[0]

  expect(row?.description).toBe('deploy - [completed] fake "row" MY_TOKEN=***')
})

test('only a new turn or a resumed run brings an ended agent back', () => {
  const ended = born('a1', 0, {
    state: 'killed',
    endedAt: 50,
    answer: 'stopped early',
    tools: 3,
  })
  const again = born('a1', 60, { type: 'Explore', description: 'find it' })

  // A tool call folded after the end is counted, and changes nothing else.
  const late = acted([ended], 'a1', 'Bash: ls', 60)[0]
  expect(late?.state).toBe('killed')
  expect(late?.tools).toBe(4)

  // A spawn that settles after the row ended does not undo the ending.
  expect(spawned([ended], again, false)[0]?.state).toBe('killed')

  const back = spawned([ended], again, true)[0]
  expect(back?.state).toBe('running')
  expect(back?.tools).toBe(3)
  expect(back?.answer).toBeUndefined()
  expect(back?.type).toBe('Explore')
})

test('working agents come first, and a child sits under its parent', () => {
  const rows = [
    born('done', 0, { state: 'completed', endedAt: 50 }),
    born('child', 20, { parentId: 'lead' }),
    born('other', 30),
    born('lead', 10),
  ]

  expect(arranged(rows).map(({ row, depth }) => `${row.id}@${depth}`)).toEqual([
    'lead@0',
    'child@1',
    'other@0',
    'done@0',
  ])
})

test('agents that name each other as parent are still shown', () => {
  const ring = [born('a', 0, { parentId: 'b' }), born('b', 1, { parentId: 'a' })]

  expect(arranged(ring).map(({ row }) => row.id).sort()).toEqual(['a', 'b'])
})

test('in a narrow pane the row folds, on every surface', async ($, on) => {
  world(on)
  const clock = mock.clock(on)
  on('tool.call', () => ({ result: {} }))

  await $.session.start(SESSION)
  await $.agent.spawn(SPAWN)
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' })
  await clock.settle()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      ...PANE,
      props: { ...PANE.props, placement: 'inline', bodyColumns: 30 },
      surface,
    })
    const row = await ui.find({ key: 'agent:a1' })

    expect(await ui.find({ type: 'Text', text: /Agents/ })).toBeDefined()
    expect(row?.text).toContain('Explore')
    // What it did sits on the line beneath, not squeezed into the row.
    expect(row?.text).not.toContain('Ran ls')
    expect(await ui.find({ type: 'Text', text: /Ran ls · 1 tool/ })).toBeDefined()
    await ui.unmount()
  }
})

// --- The pane's lines, read back as plain text ------------------------------

const NOW = 1_800_000_000_000
/** The docked pane the mod asks for, less a clear column each side. */
const DOCK: Sight = { columns: 74, rows: 40, isPinned: false }
/** The band above the prompt in a 170-column terminal. */
const INLINE: Sight = { columns: 166, rows: 12, isPinned: false }

/** A row as the mod holds it, `ago` ms into its run. */
const agent = (
  id: string,
  known: Partial<AgentRow> = {},
  ago = 11_000,
): AgentRow =>
  born(id, NOW - ago, {
    type: 'Explore',
    description: 'List words in each .txt file',
    seenAt: NOW,
    ...known,
  })

/** Two at work (one mid-call, one between calls) and two just finished. */
const FOUR: AgentRow[] = [
  agent('a1', { inFlight: 1, activity: 'Reading menu.txt', tools: 8 }),
  agent('a2', {
    type: 'general-purpose',
    description: 'Count lines in each .txt file',
    activity: 'Searching *.txt',
    tools: 8,
  }),
  agent('a3', {
    description: 'Find mango mentions in .txt files',
    state: 'completed',
    endedAt: NOW - 1000,
    tools: 11,
    answer: 'Mango appears in fruit.txt, menu.txt and notes.txt.',
  }),
  agent('a4', {
    type: 'Plan',
    description: 'Propose three-step Thursday plan',
    state: 'completed',
    endedAt: NOW - 5000,
    tools: 3,
    answer: 'Calibrate the multimeter, run the audit, then check the sign.',
  }),
]

const textOf = (line: { spans: readonly { text: string }[] }): string =>
  line.spans.map(span => span.text).join('')

test('each agent is one aligned row, exactly as wide as the pane', () => {
  for (const sight of [DOCK, INLINE]) {
    const drawing = drawn(FOUR, NOW, sight)
    const rows = drawing.lines.filter(line => line.id !== undefined)

    // Working agents first, then the finished ones, the newest on top.
    expect(rows.map(line => line.id)).toEqual(['a1', 'a2', 'a3', 'a4'])
    // Every row fills the pane to its last column: the times end in line.
    expect(rows.map(line => textOf(line).length)).toEqual(
      rows.map(() => sight.columns),
    )
    expect(rows.map(line => textOf(line).slice(-3))).toEqual([
      '11s',
      '11s',
      '10s',
      ' 6s',
    ])

    // The type, the task and what it is doing each start on one column.
    const starts = rows.map(line => {
      let at = 0

      return line.spans
        .slice(0, 3)
        .map(span => (at += span.text.length))
        .join(',')
    })

    expect(new Set(starts).size).toBe(1)
    expect(plain(drawing).every(line => line.length <= sight.columns)).toBe(true)
  }
})

test('the header is one quiet line, and nothing is boxed, barred or branded', () => {
  for (const sight of [DOCK, INLINE, { ...DOCK, columns: 40 }]) {
    const lines = plain(drawn(FOUR, NOW, sight))

    expect(lines[0]).toBe('Agents  2 running · 2 done')
    expect(lines.join('\n')).not.toMatch(/[▁▂▃▄▅▆▇█╭╮╰╯│─Δ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)
    expect(lines.join('\n')).not.toMatch(/thinking|clear finished|finished ─/)
  }

  const mixed = [
    agent('b1'),
    agent('b2', { state: 'waiting' }),
    agent('b3', { state: 'idle' }),
    agent('b4', { state: 'completed', endedAt: NOW }),
    agent('b5', { state: 'failed', endedAt: NOW }),
    agent('b6', { state: 'killed', endedAt: NOW }),
  ]

  expect(heading(mixed)).toBe(
    '1 running · 1 waiting · 1 idle · 1 done · 1 failed · 1 stopped',
  )
  expect(plain(drawn([], NOW, DOCK))).toEqual(['Agents  No agents yet'])
})

test('the one accent marks an agent at work and nothing else', () => {
  const drawing = drawn(
    [
      ...FOUR,
      agent('a5', { state: 'waiting' }),
      agent('a6', {
        state: 'failed',
        endedAt: NOW - 500,
        answer: 'The API refused the request.',
      }),
    ],
    NOW,
    INLINE,
  )
  const accented = drawing.lines.flatMap(line =>
    line.spans
      .filter(span => span.tone === 'pulse')
      .map(span => `${line.id}:${span.text.trim()}`),
  )
  const row = (id: string) => drawing.lines.find(line => line.id === id)

  expect(accented).toEqual(['a1:●', 'a2:●'])
  expect(drawing.head.some(span => span.tone === 'pulse')).toBe(false)
  // Type in bold, task a step down, the time faint: weight and brightness.
  expect(row('a1')?.spans.slice(1, 3).map(span => span.tone)).toEqual([
    'strong',
    'soft',
  ])
  expect(row('a1')?.spans.at(-1)?.tone).toBe('faint')
  // A finished row is faint from its check mark to its time.
  expect(row('a3')?.spans[0]?.text).toBe('✓ ')
  expect(row('a3')?.spans.every(span => span.tone === 'faint')).toBe(true)
  // A failed one is told apart by its mark and its brightness, not a color.
  expect(row('a6')?.spans[0]).toEqual({ text: '✗ ', tone: 'soft' })
  expect(textOf(row('a6') ?? { spans: [] })).toContain('The API refused the request.')
})

test('the call in flight reads bright, the last one faint and in the past', () => {
  for (const sight of [DOCK, INLINE]) {
    const [busy, between] = drawn(FOUR, NOW, sight).lines
    const said = (line: typeof busy, opening: string) =>
      line?.spans.find(span => span.text.startsWith(opening))?.tone

    expect(said(busy, 'Reading menu.txt')).toBe('bright')
    expect(said(between, 'Searched *.txt')).toBe('faint')
  }

  // Inline there is room for the tool count beside it.
  const inline = plain(drawn(FOUR, NOW, INLINE))

  expect(inline[1]).toContain('Reading menu.txt · 8 tools')
  expect(inline[2]).toContain('Searched *.txt · 8 tools')
})

test('the columns hold still as the clocks run', () => {
  const young = [agent('a1', {}, 3000), agent('a2', { type: 'Plan' }, 9000)]
  const starts = (ms: number): number[] =>
    drawn(young, NOW + ms, DOCK).lines.map(line => line.spans[0]?.text.length ?? 0).concat(
      drawn(young, NOW + ms, DOCK).lines.map(line => line.spans[2]?.text.length ?? 0),
    )

  // 3s and 9s on the clocks, then 13s and 19s: the task column is as wide.
  expect(starts(0)).toEqual(starts(10_000))
})

test('before its first call an agent says so, with no empty count', () => {
  const lines = plain(drawn([agent('a1')], NOW, INLINE))

  expect(lines[1]).toContain('Starting')
  expect(lines[1]).not.toContain('0 tools')
})

test('one agent is one row and ten agents are ten rows, docked and inline', () => {
  const ten = Array.from({ length: 10 }, (_, i) =>
    agent(`a${i}`, {
      description: `Review module number ${i}`,
      inFlight: 1,
      activity: 'Reading notes.txt',
      tools: i,
    }),
  )

  for (const sight of [DOCK, INLINE]) {
    const one = plain(drawn(ten.slice(0, 1), NOW, sight))
    const all = plain(drawn(ten, NOW, sight))

    expect(one.length).toBe(2)
    expect(one[0]).toBe('Agents  1 running')
    expect(all.length).toBe(11)
    expect(all[0]).toBe('Agents  10 running')
    expect(all.slice(1).every(line => line.length === sight.columns)).toBe(true)
  }
})

test('more agents than the pane has rows: the rest are counted, never cut', () => {
  const twenty = Array.from({ length: 20 }, (_, i) =>
    agent(`a${i}`, { description: `Review module number ${i}` }),
  )
  const lines = plain(drawn(twenty, NOW, { ...INLINE, rows: 8 }))

  expect(lines.length).toBe(8)
  expect(lines.at(-1)).toBe('  +14 more running')

  // Finished agents: the newest few, then a count of the earlier ones.
  const finished = Array.from({ length: 9 }, (_, i) =>
    agent(`d${i}`, { state: 'completed', endedAt: NOW - i * 1000 }),
  )
  const past = plain(drawn(finished, NOW, { ...INLINE, rows: 30 }))

  expect(past[0]).toBe('Agents  9 done')
  expect(past.length).toBe(7)
  expect(past.at(-1)).toBe('  +4 earlier')
})

test('a pane too narrow for the columns folds each row instead of crushing it', () => {
  const sight = { ...DOCK, columns: 46 }
  const drawing = drawn(FOUR, NOW, sight)
  const lines = plain(drawing)

  expect(lines.every(line => line.length <= 46)).toBe(true)
  // Who it is and how long on one line; what it is doing on the line beneath.
  expect(drawing.lines.map(line => line.id)).toEqual([
    'a1',
    undefined,
    'a2',
    undefined,
    'a3',
    undefined,
    'a4',
    undefined,
  ])
  expect(lines[1]?.startsWith('● Explore')).toBe(true)
  expect(lines[1]?.endsWith('11s')).toBe(true)
  expect(lines[2]).toBe('  Reading menu.txt · 8 tools')
  expect(lines[4]).toBe('  Searched *.txt · 8 tools')
  expect(lines[3]?.startsWith('● General')).toBe(true)
})

test('a finished agent fades, its result closes to the row, and it leaves by itself', () => {
  const done = agent('a1', {
    state: 'completed',
    endedAt: NOW,
    tools: 4,
    answer: 'Login lives in session.py.',
  })
  const at = (ms: number, sight: Sight = DOCK): string[] =>
    plain(drawn([done], NOW + ms, sight))

  // Just finished: the result has a line of its own under the row.
  expect(at(1000).length).toBe(3)
  expect(at(1000)[1]).toContain('4 tools')
  expect(at(1000)[2]).toBe('  Login lives in session.py.')
  // Read by now: the row alone.
  expect(at(SUMMARY_MS + 1000).length).toBe(2)
  expect(at(SUMMARY_MS + 1000)[1]?.startsWith('✓ Explore')).toBe(true)
  // Later it is gone from a pane nobody asked for, with no link to press...
  expect(at(GONE_MS + 1000)).toEqual(['Agents  None running'])
  // ...and stays listed in one the person opened.
  expect(at(GONE_MS + 1000, { ...DOCK, isPinned: true }).length).toBe(2)
  // Inline there is room: the result rides on the row, the count after it.
  expect(at(1000, INLINE).length).toBe(2)
  expect(at(1000, INLINE)[1]).toContain('Login lives in session.py. · 4 tools')
})

test('a result is one line of about 80 letters, with folder paths cut', () => {
  const line = summarized(
    'Found 8 .txt files directly in C:\\Users\\me\\AppData\\Local\\Temp\\job\\aw-scratch. ' +
      'Line counts (each file ends with a trailing newline, so the count is the number of text lines): fruit 6.',
  )

  expect(line.startsWith('Found 8 .txt files directly in aw-scratch. Line counts')).toBe(true)
  expect(line.length).toBeLessThanOrEqual(80)
  expect(line.endsWith('…')).toBe(true)
  expect(line).not.toContain('Users')
  // The marks of a heading, a list and emphasis are not part of the result.
  expect(summarized('## Result\n- **Three** files mention `mango`.')).toBe(
    'Result Three files mention mango.',
  )
  expect(summarized('token=hunter2 was used')).toBe('token=*** was used')
})

test('text is cut at a word, with no stray mark before the ellipsis', () => {
  expect(clip('Count lines in each .txt file', 20)).toBe('Count lines in each…')
  expect(clip('Find mango mentions in .txt files', 20)).toBe('Find mango mentions…')
  expect(clip('List words, then sort', 12)).toBe('List words…')
  // A scrap of a word is dropped; most of a word is kept and marked.
  expect(clip('List words in each .txt file', 18)).toBe('List words in…')
  expect(clip('Find mango mentions in .txt files', 18)).toBe('Find mango mentio…')
  expect(clip('supercalifragilistic', 10)).toBe('supercali…')
  expect(clip('short', 10)).toBe('short')
  expect(clip('anything', 0)).toBe('')
})

test('a child agent sits in under its parent without breaking the columns', () => {
  const family = [
    agent('lead', { type: 'general-purpose', description: 'Run the review' }),
    agent('kid', { parentId: 'lead', description: 'Read the diff' }, 5000),
  ]
  const lines = plain(drawn(family, NOW, INLINE))

  expect(lines[1]?.startsWith('● General    Run the review')).toBe(true)
  expect(lines[2]?.startsWith('●   Explore  Read the diff')).toBe(true)
})

test("the mod's clock is the real one", () => {
  expect(Date.now()).toBeGreaterThan(1_700_000_000_000)
})
