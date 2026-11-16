import { expect, test } from 'claude-code/testing'

import { born } from '../hooks/roster'
import { called, payload } from '../hooks/trail'
import { isInside, isSecretName, notesOf, stepOf, troubleOf } from '../hooks/trouble'
import type { Call, Kind, Touch } from '../types'

// The trouble rules, with no engine under them: going in circles, failing the
// same way, and touching what it should not, read from an agent's calls.

const T = 1_800_000_000_000
const SHOP = 'C:\\work\\shop'
const CIRCLES = (n: number): string =>
  `It has done the same step ${n} times. If it keeps on, stop it and tell it exactly where to look.`
const FAILING = (n: number): string =>
  `The same step failed ${n} times. Look at the error, or stop it and fix the cause first.`
let serial = 0

/** A finished call of a kind; the same words are the same step unless `step` says otherwise. */
function c(kind: Kind | undefined, did: string, extra: Partial<Call> = {}): Call {
  serial += 1

  const call: Call = { key: `k${serial}`, doing: did, did, at: T + serial * 100, end: T + serial * 100 + 50, step: did, ...extra }

  if (kind !== undefined) {
    call.kind = kind
  }

  return call
}

const touched = (file: string, how: Omit<Touch, 'file'>, extra: Partial<Call> = {}): Call =>
  c('edit', `Edited ${file}`, { touch: { file, ...how }, step: `edit ${file} ${serial}`, ...extra })
/** `k` other reads, each a step of its own. */
const others = (k: number): Call[] => Array.from({ length: k }, (_, i) => c('read', `Read other${i}.py`))
const signs = (calls: readonly Call[], isOver = false): string[] => troubleOf(calls, isOver).map(one => one.sign)

test('the same step three times is going in circles', () => {
  const config = (): Call => c('read', 'Read config.py')

  expect(troubleOf([config(), c('search', 'Searched for login'), config(), config()], false)).toEqual([
    { sign: 'circles', evidence: 'Read config.py 3 times', advice: CIRCLES(3) },
  ])
  expect(troubleOf([config(), c('search', 'Searched for login'), config()], false)).toEqual([])
  expect(troubleOf([config(), config(), config(), config()], false)[0]?.evidence).toBe('Read config.py 4 times')
  // The same search counts the same way.
  expect(troubleOf([1, 2, 3].map(() => c('search', 'Searched for login')), false)[0]?.evidence).toBe(
    'Searched for login 3 times',
  )
  // Bookkeeping says nothing: it neither counts nor stands between the repeats.
  expect(signs([config(), c(undefined, 'Updated the task list'), config(), c(undefined, 'Updated the task list'), config()])).toEqual([
    'circles',
  ])
  expect(signs([1, 2, 3].map(() => c(undefined, 'Updated the task list')))).toEqual([])
  // Only the last 12 calls count.
  expect(signs([config(), ...others(10), config(), config()])).toEqual([])
})

test('paging through a file or testing after each change is not going in circles', () => {
  const pages = [0, 2000, 4000].map(offset => c('read', 'Read big.py', { step: `big.py@${offset}` }))

  expect(troubleOf(pages, false)).toEqual([])

  const pytest = (): Call => c('test', 'Ran pytest -x')
  const edit = (n: number): Call => c('edit', 'Edited a.py', { step: `edit ${n}` })

  expect(troubleOf([pytest(), edit(1), pytest(), edit(2), pytest()], false)).toEqual([])

  // The step is the tool with its arguments: the engine's own keys and their order do not count.
  const file = 'C:\\repo\\big.py'

  expect(stepOf('Read', { file_path: file, offset: 0 })).not.toBe(stepOf('Read', { file_path: file, offset: 2000 }))
  expect(stepOf('Read', { tool: 'Read', file_path: file, tool_use_id: 't1', agentId: 'a1' })).toBe(
    stepOf('Read', { tool: 'Read', file_path: file, tool_use_id: 't2', agentId: 'a2' }),
  )
  expect(stepOf('Grep', { pattern: 'login', path: 'src' })).toBe(stepOf('Grep', { path: 'src', pattern: 'login' }))
  expect(stepOf('Grep', { pattern: 'login' })).not.toBe(stepOf('Glob', { pattern: 'login' }))
})

test('the same step failing three times, or three failures in a row, is failing', () => {
  const failed = { isFailed: true } as const
  const pytest = (): Call => c('test', 'Ran pytest -x', failed)
  const edit = (n: number): Call => c('edit', 'Edited a.py', { step: `edit ${n}` })

  expect(troubleOf([pytest(), edit(1), pytest(), edit(2), pytest()], false)).toEqual([
    { sign: 'failing', evidence: 'The same test failed 3 times', advice: FAILING(3) },
  ])
  // A step that fails is failing, not going in circles.
  expect(troubleOf([1, 2, 3].map(() => c('read', 'Read gone.txt', failed)), false)).toEqual([
    { sign: 'failing', evidence: 'Read gone.txt failed 3 times', advice: FAILING(3) },
  ])
  expect(troubleOf([c('read', 'Read a.txt', failed), c('search', 'Searched for x', failed), c('run', 'Ran ls', failed)], false)).toEqual([
    {
      sign: 'failing',
      evidence: '3 steps failed in a row',
      advice: '3 steps failed in a row. Look at the error, or stop it and fix the cause first.',
    },
  ])
  expect(signs([c('read', 'Read a.txt', failed), c('search', 'Searched for x', failed), c('run', 'Ran ls')])).toEqual([])
  // Spread wider than the last 8 calls: no sign.
  const gone = (): Call => c('read', 'Read gone.txt', failed)

  expect(signs([gone(), ...others(6), gone(), gone()])).toEqual([])
})

test('a change outside the project, or to a file that may hold secrets, is trouble at once', () => {
  expect(troubleOf([c('read', 'Read a.py'), touched('settings.json', { outside: true })], false)).toEqual([
    {
      sign: 'outside',
      evidence: 'Changed a file outside this project: settings.json',
      advice: 'It changed settings.json outside this project. Check that change before anything else.',
    },
  ])
  expect(troubleOf([touched('.env.local', { secret: true })], false)).toEqual([
    {
      sign: 'outside',
      evidence: 'Changed a file that may hold secrets: .env.local',
      advice: 'It changed .env.local, which may hold secrets. Check that change before anything else.',
    },
  ])
  expect(troubleOf([touched('id_rsa', { outside: true, secret: true })], false)[0]).toEqual({
    sign: 'outside',
    evidence: 'Changed a file that may hold secrets, outside this project: id_rsa',
    advice: 'It changed id_rsa outside this project, and it may hold secrets. Check that change before anything else.',
  })
  // A change that was refused or failed changed nothing.
  expect(troubleOf([touched('settings.json', { outside: true }, { isFailed: true })], false)).toEqual([])
  // One still in flight counts.
  expect(signs([touched('settings.json', { outside: true }, { end: undefined })])).toEqual(['outside'])

  for (const name of ['.env', '.ENV.local', 'server.pem', 'app.key', 'id_rsa', 'id_rsa.pub', 'credentials.json', 'Credentials', 'secrets.yaml', 'SECRETS.txt']) {
    expect(isSecretName(name)).toBe(true)
  }

  for (const name of ['env.py', 'keys.py', 'monkey.py', 'notes.md', 'secret.txt', 'my.pem.txt', 'keyboard.key.md']) {
    expect(isSecretName(name)).toBe(false)
  }

  const edit = (path: string, cwd = SHOP): Touch | undefined =>
    notesOf('Edit', { file_path: path, old_string: 'a', new_string: 'b' }, 'edit', cwd).touch

  expect(edit('C:\\Users\\me\\elsewhere\\settings.json')).toEqual({ file: 'settings.json', outside: true })
  expect(edit('C:\\work\\shop\\src\\a.py')).toBeUndefined()
  expect(edit('C:\\work\\shop\\.env')).toEqual({ file: '.env', secret: true })
  expect(edit('C:\\elsewhere\\.env')).toEqual({ file: '.env', outside: true, secret: true })
  // With the session's folder unknown, only the name is judged.
  expect(edit('C:\\elsewhere\\a.py', '')).toBeUndefined()
  expect(notesOf('Write', { file_path: 'C:\\Users\\me\\x.json', content: '{}' }, 'edit', SHOP).touch).toEqual({ file: 'x.json', outside: true })
  expect(notesOf('mcp__fs__write_file', { path: 'D:\\x\\a.txt', content: '' }, 'edit', SHOP).touch).toEqual({ file: 'a.txt', outside: true })
  expect(notesOf('NotebookEdit', { notebook_path: 'C:\\work\\shop\\n.ipynb', new_source: '' }, 'edit', SHOP).touch).toBeUndefined()
  // Reading is not touching.
  expect(notesOf('Read', { file_path: 'C:\\Users\\me\\elsewhere\\settings.json' }, 'read', SHOP).touch).toBeUndefined()
})

test('the outside check reads Windows paths as Windows does', () => {
  const shop = 'c:\\work\\shop'

  expect(isInside('C:\\Work\\Shop\\a.py', shop)).toBe(true)
  expect(isInside('C:/work/shop/src/a.py', shop)).toBe(true)
  expect(isInside('C:\\work\\shop\\src\\..\\a.py', shop)).toBe(true)
  expect(isInside('C:\\work\\shop\\.\\a.py', `${shop}\\`)).toBe(true)
  expect(isInside('C:\\work\\shop\\..\\other\\a.py', shop)).toBe(false)
  expect(isInside('C:\\work\\shopping\\a.py', shop)).toBe(false)
  expect(isInside('C:\\work\\shop', shop)).toBe(false)
  expect(isInside('src\\a.py', shop)).toBe(true)
  expect(isInside('..\\a.py', shop)).toBe(false)
  expect(isInside('\\\\?\\C:\\work\\shop\\a.py', shop)).toBe(true)
  expect(isInside('D:\\work\\shop\\a.py', shop)).toBe(false)
  expect(isInside('/c/work/shop/a.py', shop)).toBe(true)
  expect(isInside('\\\\server\\share\\a.py', shop)).toBe(false)
  // Climbing past the drive's root stays at the root, as Windows does.
  expect(isInside('C:\\..\\..\\work\\shop\\a.py', shop)).toBe(true)
  // Elsewhere letters keep their case.
  expect(isInside('/repo/src/a.py', '/repo')).toBe(true)
  expect(isInside('/Repo/src/a.py', '/repo')).toBe(false)
  expect(isInside('/repo/../etc/hosts', '/repo')).toBe(false)
})

test('the full path is kept nowhere: only the file name', () => {
  const key = `sk-${'Zx9'.repeat(12)}`
  const notes = notesOf(
    'Edit',
    { file_path: 'C:\\Users\\me\\secret-place\\settings.json', old_string: 'a', new_string: 'b' },
    'edit',
    SHOP,
  )

  expect(JSON.stringify(notes)).not.toContain('secret-place')
  expect(JSON.stringify(notes)).not.toContain('Users')
  expect(notes.name).toBe('settings.json')
  // A name shaped like a credential is masked like any other text.
  expect(JSON.stringify(notesOf('Read', { file_path: `C:\\x\\${key}.txt` }, 'read', SHOP))).not.toContain(key)
  // Searches and commands name no file.
  expect(notesOf('Grep', { pattern: 'x', path: 'C:\\work\\shop\\src' }, 'search', SHOP).name).toBeUndefined()

  const call = called('k1', 'Editing settings.json', T, 'edit', notes)

  expect(call.touch).toEqual({ file: 'settings.json', outside: true })
  expect(call.step).toBe(notes.step)

  const page = payload(
    { id: 'abcdef1', cwd: SHOP },
    [born('a1', T, { type: 'General', description: 'fix it' })],
    { a1: { calls: [{ ...call, end: T + 5, out: 'done' }], dropped: 0 } },
    T + 10,
  )

  expect(page.agents[0]?.calls).toEqual([
    { key: 'k1', doing: 'Editing settings.json', did: 'Edited settings.json', at: T, end: T + 5, kind: 'edit' },
  ])
})

test('a sign clears once eight newer calls show none of it', () => {
  const loop = (): Call[] => [1, 2, 3].map(() => c('read', 'Read config.py'))
  const fails = (): Call[] => [1, 2, 3].map(() => c('test', 'Ran pytest -x', { isFailed: true }))
  const outside = (): Call => touched('settings.json', { outside: true })

  expect(signs([...loop(), ...others(7)])).toEqual(['circles'])
  expect(signs([...loop(), ...others(8)])).toEqual([])
  expect(signs([...fails(), ...others(7)])).toEqual(['failing'])
  expect(signs([...fails(), ...others(8)])).toEqual([])
  expect(signs([outside(), ...others(7)])).toEqual(['outside'])
  expect(signs([outside(), ...others(8)])).toEqual([])
  // Each sign shows once, newest evidence first in importance: outside, failing, circles.
  expect(signs([...loop(), ...fails(), outside()])).toEqual(['outside', 'failing', 'circles'])
})

test('once over, only a change outside the project is still trouble', () => {
  const calls = [...[1, 2, 3].map(() => c('read', 'Read config.py')), touched('settings.json', { outside: true })]

  expect(signs(calls, false)).toEqual(['outside', 'circles'])
  expect(signs(calls, true)).toEqual(['outside'])
})
