import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// The window opens by itself the first time two agents are at work, through a
// launcher that hands the keyboard back; `/agent-watch gui` opens it as before.

const SESSION = { cwd: 'C:\\work\\shop', surface: 'terminal', isInteractive: true } as const
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

/** The engine under the mod; every command it runs is noted, and every one succeeds. */
function rig(on: On): string[][] {
  const runs: string[][] = []
  let next = 0

  mock.env(on, { USERPROFILE: 'C:\\Users\\me', OS: 'Windows_NT' })
  on('session.authorize', () => ({ value: { handle: 'h1', kind: 'bearer' } }))
  on('command.register', () => ({ value: { command: 'agent-watch' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__agent-watch__snapshot' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => {
    next += 1

    return { model: 'claude-haiku-5-5', agentId: `a${next}` }
  })
  on('agent.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.read', (_, e) => ({ value: e.path.endsWith('index.html') ? '<script src="__AW_SID__.js"></script>' : '' }))
  on('fs.write', () => ({ value: undefined }))
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'empty-reply', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }))
  on('process.run', (_, e) => {
    runs.push([...e.argv])

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  return runs
}

test('two agents at work open the window once, by itself, without taking the keyboard', async ($, on) => {
  const runs = rig(on)
  const clock = mock.clock(on)

  await $.session.start(SESSION)
  await $.agent.spawn(SPAWN)
  await clock.settle()
  expect(runs).toEqual([])

  await $.agent.spawn(SPAWN)
  await clock.settle()

  expect(runs.length).toBe(1)

  const [argv = []] = runs
  const at = (flag: string): string => argv[argv.indexOf(flag) + 1] ?? ''

  expect(argv[0]).toBe('powershell')
  expect(argv).toContain('-NoProfile')
  expect(at('-File').endsWith('/gui/open-window.ps1')).toBe(true)
  expect(at('-Url').startsWith('file:///C:/Users/me/.claude/agent-watch/')).toBe(true)
  expect(at('-Size')).toBe('1280,840')
  expect(at('-Title')).toBe('Agents')

  // Once a session: a third agent opens nothing more.
  await $.agent.spawn(SPAWN)
  await clock.settle()
  expect(runs.length).toBe(1)
})

test('asked for by hand, the window opens as before', async ($, on) => {
  const runs = rig(on)
  const clock = mock.clock(on)

  await $.session.start(SESSION)
  await clock.settle()
  await $.command.run({ command: 'agent-watch', args: 'gui', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

  expect(runs.length).toBe(1)
  expect(runs[0]?.slice(0, 5)).toEqual(['cmd', '/c', 'start', '', 'msedge'])
})

test('switched off in the options, two agents open nothing', { options: { autoOpenWindow: false } }, async ($, on) => {
  const runs = rig(on)
  const clock = mock.clock(on)

  await $.session.start(SESSION)
  await $.agent.spawn(SPAWN)
  await $.agent.spawn(SPAWN)
  await clock.settle()

  expect(runs).toEqual([])
})
