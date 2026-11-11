import { expect, mock, test } from 'claude-code/testing'
import type { AgentInfo, On } from 'claude-code'

import {
  acted,
  arranged,
  born,
  describeCall,
  doing,
  redact,
  span,
  spark,
  spawned,
  synced,
} from '../hooks/roster'

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
    bodyColumns: 60,
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
  on('ui.close', () => ({ value: undefined }))
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
    midCall = (await ui.find({ type: 'Text', text: /Bash/ }))?.text
    await ui.unmount()

    return { result: {} }
  })

  await $.session.start(SESSION)
  await $.agent.spawn(SPAWN)
  await $.turn.start({ text: SPAWN.prompt, turnId: 't1', agentId: 'a1' })
  await $.tool.call({ tool: 'Bash', command: 'pytest -x', agentId: 'a1' })
  await clock.settle()

  expect(midCall).toContain('Bash: pytest -x')
  expect(w.opened).toBe(1)
  // The open pane says who is working: the status line never repeats it.
  expect(w.status).not.toContain('1 agent working')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const row = await ui.find({ key: 'agent:a1' })

    expect(row?.text).toContain('Explore')
    expect(row?.text).toContain('find the auth flow')
    expect(await ui.find({ type: 'Text', text: /thinking/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 tool/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 working/ })).toBeDefined()
    await ui.unmount()
  }

  await $.turn.complete(DONE)
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const how = await ui.find({ type: 'Text', text: /Login lives/ })

  expect(how?.text).toContain('1 tool · 1.5k tok')
  expect((await ui.find({ key: 'agent:a1' }))?.text).toContain('✓')
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
    rowsAtCall = (await ui.find({ type: 'Text', text: /Bash: ls/ })) ? 1 : 0
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
    midCall = (await ui.find({ type: 'Text', text: /Grep/ }))?.text
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

  expect(midCall).toContain('Grep: TODO')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const row = await ui.find({ key: 'agent:b7' })

  expect(row?.text).toContain('general-purpose')
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
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
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
  expect(await ui.find({ type: 'Text', text: /waiting on background work/ })).toBeDefined()
  await ui.unmount()

  w.roster = [{ ...listed, status: 'killed' }]
  await clock.advance(3000)

  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'agent:a1' }))?.text).toContain('■')
  expect(await ui.find({ type: 'Text', text: /stopped/ })).toBeDefined()
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

test('a long answer is cut short so the counts after it stay on the row', async ($, on) => {
  world(on)
  const clock = mock.clock(on)

  await $.session.start(SESSION)
  await $.agent.spawn(SPAWN)
  await $.turn.complete({ ...DONE, answer: 'The login flow was traced. '.repeat(8) })
  await clock.settle()

  for (const placement of ['dock', 'inline'] as const) {
    const ui = await $.ui.mount({
      ...PANE,
      props: { ...PANE.props, placement },
      surface: 'terminal',
    })
    const how = await ui.find({ type: 'Text', text: /The login flow/ })

    expect(how?.text.endsWith('… · 0 tools · 1.5k tok')).toBe(true)
    expect(how?.text.length).toBeLessThanOrEqual(PANE.props.bodyColumns)
    await ui.unmount()
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

test('finished agents are cleared on a press, working ones stay', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)

  await $.session.start(SESSION)
  await $.agent.spawn(SPAWN)
  await $.turn.complete(DONE)
  w.nextId = 'a2'
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'toolu_2', description: 'write tests' })
  await clock.settle()

  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'clear' })
  await ui.unmount()
  await clock.settle()

  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'agent:a1' })).toBeUndefined()
  expect(await ui.find({ key: 'agent:a2' })).toBeDefined()
  expect(await ui.find({ key: 'clear' })).toBeUndefined()
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

test('a tool call reads in a few words', () => {
  expect(
    describeCall('Read', { file_path: 'C:\\repo\\app\\core\\config.py' }),
  ).toBe('Read: core/config.py')
  expect(
    describeCall('mcp__firecrawl__firecrawl_search', { query: 'claude hooks' }),
  ).toBe('firecrawl:firecrawl_search: claude hooks')
  expect(
    describeCall('Bash', { command: 'npm test\n  --watch', description: 'Run tests' }),
  ).toBe('Bash: npm test --watch')
  expect(describeCall('TaskList', {})).toBe('TaskList')
  expect(describeCall('Bash', { command: 'x'.repeat(200) }).length).toBe(72)
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
    activity: 'Bash: pytest',
  })

  expect(doing(silent, now)).toBe('quiet for 2m 10s')
  expect(doing(slow, now)).toBe('Bash: pytest · 45s')
  expect(doing(born('a3', now), now)).toBe('thinking')
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

test('inline above the prompt the rows stay bare, on every surface', async ($, on) => {
  world(on)
  const clock = mock.clock(on)
  on('tool.call', () => ({ result: {} }))

  await $.session.start(SESSION)
  await $.agent.spawn(SPAWN)
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' })
  await $.turn.complete(DONE)
  await clock.settle()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      ...PANE,
      props: { ...PANE.props, placement: 'inline', bodyColumns: 30 },
      surface,
    })

    expect(await ui.find({ type: 'Text', text: /AGENTS/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /finished/ })).toBeDefined()
    expect((await ui.find({ key: 'agent:a1' }))?.text).toContain('Explore')
    await ui.unmount()
  }
})

test('the activity strip stands tall where the calls were', () => {
  const now = 1_000_000
  const row = born('a1', 0, { calls: [now - 65_000, now - 6000, now - 5000] })

  // Twelve ten-second slots, newest at the right: one call a minute ago,
  // two in the last ten seconds.
  expect(spark(row, now)).toBe('▁▁▁▁▁▂▁▁▁▁▁▃')
  expect(spark(born('a2', 0), now)).toBe('▁'.repeat(12))
})

test("the mod's clock is the real one", () => {
  expect(Date.now()).toBeGreaterThan(1_700_000_000_000)
})
