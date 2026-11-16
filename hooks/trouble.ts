// Trouble, read from an agent's calls by rules, with no engine in it: going
// in circles, failing the same way, and touching what it should not. Rules,
// so the signs cost nothing, read the same every time, and still work when
// the narrator is offline. Every function here is pure.
//
// The outside check is the one place a call's full path is read. Only its
// verdict and the file's masked name are kept: the path itself goes nowhere.
import type { Call, Kind, Sign, Touch, Trouble } from '../types'
import { brief, lastFolder } from './roster'
import type { Notes } from './trail'

/** Going in circles: the same step this many times... */
export const LOOP_MIN = 3
/** ...within this many of the agent's newest calls. */
export const LOOP_WINDOW = 12
/** Failing the same way: this many failed calls of one step, or in a row... */
export const FAIL_MIN = 3
/** ...within this many of its newest calls. */
export const FAIL_WINDOW = 8
/** A sign clears once this many newer calls show none of it. */
export const CLEAR_AFTER = 8
/** How much of a call's arguments is read to tell one step from another. */
const STEP_SCAN = 50_000
/** How long a file's name may read. */
const NAME_MAX = 60

/** The keys the engine sets beside a tool's own arguments: not part of the step. */
const ENGINE_KEYS: ReadonlySet<string> = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta'])

/** The fields a call names its file in, in the order they are read. */
const PATH_FIELDS = ['file_path', 'notebook_path', 'path'] as const

// --- Paths --------------------------------------------------------------------

/** A file name that may hold secrets: `.env*`, `*.pem`, `*.key`, `id_rsa*`, `credentials*`, `secrets*`. */
export function isSecretName(name: string): boolean {
  const lower = name.trim().toLowerCase()

  return (
    lower.startsWith('.env') ||
    lower.endsWith('.pem') ||
    lower.endsWith('.key') ||
    lower.startsWith('id_rsa') ||
    lower.startsWith('credentials') ||
    lower.startsWith('secrets')
  )
}

/** A folder as Windows writes one: a drive, a share, or a backslash anywhere. */
const isWindowsPath = (path: string): boolean =>
  /^[A-Za-z]:(?:[\\/]|$)/.test(path) || /^[\\/]{2}/.test(path) || path.includes('\\')

/** A path's root and its names, `.` and `..` resolved; climbing past the root stays there. */
type Resolved = { root: string; names: string[] }

function resolved(path: string, cwd: string, isWindows: boolean): Resolved | undefined {
  let full = path.trim()

  if (isWindows) {
    full = full.replace(/^\\\\\?\\/, '').split('\\').join('/')
    // A shell's `/c/Users` is the drive's `C:/Users`.
    full = full.replace(/^\/([A-Za-z])(?=\/|$)/, '$1:')
  }

  const base = cwd.trim()
  const isRooted = isWindows ? /^[A-Za-z]:\//.test(full) || full.startsWith('//') : full.startsWith('/')

  if (!isRooted) {
    if (isWindows && full.startsWith('/')) {
      // `\x` is the root of the folder's own drive.
      full = `${resolved(base, '', true)?.root ?? ''}${full}`
    } else if (base === '') {
      return undefined
    } else {
      full = `${isWindows ? base.split('\\').join('/') : base}/${full}`
    }
  }

  let root: string
  let rest: string

  if (isWindows && full.startsWith('//')) {
    const [server = '', share = '', ...more] = full.slice(2).split('/')

    root = `//${server}/${share}`
    rest = more.join('/')
  } else if (isWindows) {
    root = full.slice(0, 2)
    rest = full.slice(2)
  } else {
    root = '/'
    rest = full
  }

  const names: string[] = []

  for (const name of rest.split('/')) {
    if (name === '..') {
      names.pop()
    } else if (name !== '' && name !== '.') {
      names.push(name)
    }
  }

  return isWindows ? { root: root.toLowerCase(), names: names.map(name => name.toLowerCase()) } : { root, names }
}

/**
 * True for a file inside the folder `cwd`, under it at any depth. Compared
 * after `.` and `..` are resolved, and on Windows without regard to case, as
 * Windows does. A relative path is read from `cwd`.
 */
export function isInside(path: string, cwd: string): boolean {
  if (path.trim() === '' || cwd.trim() === '') {
    return false
  }

  const isWindows = isWindowsPath(cwd)
  const folder = resolved(cwd, '', isWindows)
  const file = resolved(path, cwd, isWindows)

  if (folder === undefined || file === undefined || folder.root !== file.root) {
    return false
  }

  return file.names.length > folder.names.length && folder.names.every((name, index) => file.names[index] === name)
}

// --- What the mod notes as a call starts ----------------------------------------

/** Arguments with their keys in order at every depth, so the same call reads the same. */
function ordered(_key: string, value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value
  }

  const record = value as Record<string, unknown>

  return Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]]))
}

/**
 * The step a call is: a short hash of the tool and its arguments, the
 * engine's own keys left out. The same step again hashes the same; reading
 * another part of a file, or another search, does not. Nothing of the
 * arguments can be read back from it.
 */
export function stepOf(tool: string, input: Readonly<Record<string, unknown>>): string | undefined {
  try {
    const args = Object.keys(input)
      .filter(key => !ENGINE_KEYS.has(key))
      .sort()
      .map(key => [key, input[key]])
    const text = `${tool}\n${JSON.stringify(args, ordered)}`.slice(0, STEP_SCAN)
    let hash = 0x811c9dc5

    for (let index = 0; index < text.length; index += 1) {
      hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0
    }

    return `${text.length.toString(36)}.${hash.toString(36)}`
  } catch {
    return undefined
  }
}

/**
 * What the mod keeps about a call as it starts: the step it is, the name of
 * the file it reads or changes (never its folders, masked), and for a change,
 * whether it lands outside the session's folder or in a file that may hold
 * secrets. With the folder unknown (`''`) only the name is judged.
 */
export function notesOf(
  tool: string,
  input: Readonly<Record<string, unknown>>,
  kind: Kind | undefined,
  cwd: string,
): Notes {
  const notes: Notes = {}
  const step = stepOf(tool, input)

  if (step !== undefined) {
    notes.step = step
  }

  const path = PATH_FIELDS.map(field => input[field]).find(
    (value): value is string => typeof value === 'string' && value.trim() !== '',
  )

  if (path === undefined || (kind !== 'read' && kind !== 'edit')) {
    return notes
  }

  const last = lastFolder(path.trim())
  const name = brief(last, NAME_MAX)

  if (name !== '') {
    notes.name = name
  }

  if (kind === 'edit') {
    const isOutside = cwd.trim() !== '' && !isInside(path, cwd)
    const isSecret = isSecretName(last)

    if (isOutside || isSecret) {
      const touch: Touch = { file: name }

      if (isOutside) {
        touch.outside = true
      }

      if (isSecret) {
        touch.secret = true
      }

      notes.touch = touch
    }
  }

  return notes
}

// --- The signs -----------------------------------------------------------------

/** What makes two calls the same step: their hash, or for an older call, its kind and words. */
const stepKey = (call: Call): string => call.step ?? `${call.kind ?? ''}|${call.did}`
const isFailed = (call: Call): boolean => call.isFailed === true

const trouble = (sign: Sign, evidence: string, advice: string): Trouble => ({ sign, evidence, advice })

/** A change that needs checking, among the newest calls: the newest that went through. */
function outsideOf(kinded: readonly Call[], from: number): Trouble | undefined {
  for (let at = kinded.length - 1; at >= from; at -= 1) {
    const call = kinded[at] as Call
    const touch = call.touch

    if (touch === undefined || isFailed(call)) {
      continue
    }

    const file = touch.file

    if (touch.outside === true && touch.secret === true) {
      return trouble(
        'outside',
        `Changed a file that may hold secrets, outside this project: ${file}`,
        `It changed ${file} outside this project, and it may hold secrets. Check that change before anything else.`,
      )
    }

    return touch.secret === true
      ? trouble(
          'outside',
          `Changed a file that may hold secrets: ${file}`,
          `It changed ${file}, which may hold secrets. Check that change before anything else.`,
        )
      : trouble(
          'outside',
          `Changed a file outside this project: ${file}`,
          `It changed ${file} outside this project. Check that change before anything else.`,
        )
  }

  return undefined
}

/**
 * Failing the same way, as it stood when one of the newest calls came: the
 * same step failed 3 times within the 8 calls up to it, or it ended 3 or more
 * failures in a row. The same step outranks a run of different ones.
 */
function failingOf(kinded: readonly Call[], from: number): Trouble | undefined {
  let same: { count: number; call: Call } | undefined
  let run = 0

  for (let at = from; at < kinded.length; at += 1) {
    const last = kinded[at] as Call

    if (!isFailed(last)) {
      continue
    }

    const key = stepKey(last)
    const count = kinded
      .slice(Math.max(0, at - FAIL_WINDOW + 1), at + 1)
      .filter(call => isFailed(call) && stepKey(call) === key).length
    let streak = 0

    while (at - streak >= 0 && isFailed(kinded[at - streak] as Call)) {
      streak += 1
    }

    if (count >= FAIL_MIN && (same === undefined || count >= same.count)) {
      same = { count, call: last }
    }

    run = Math.max(run, streak)
  }

  if (same !== undefined) {
    const { count, call } = same

    return trouble(
      'failing',
      call.kind === 'test' ? `The same test failed ${count} times` : `${call.did} failed ${count} times`,
      `The same step failed ${count} times. Look at the error, or stop it and fix the cause first.`,
    )
  }

  return run >= FAIL_MIN
    ? trouble(
        'failing',
        `${run} steps failed in a row`,
        `${run} steps failed in a row. Look at the error, or stop it and fix the cause first.`,
      )
    : undefined
}

/**
 * Going in circles, as it stood when one of the newest calls came: that step
 * 3 or more times within the 12 calls up to it. A change to anything else in
 * between ends the run (testing after each change is work, not a circle), and
 * a failed repeat is the failing sign's to tell.
 */
function circlesOf(kinded: readonly Call[], from: number): Trouble | undefined {
  let best: { count: number; call: Call } | undefined

  for (let at = from; at < kinded.length; at += 1) {
    const last = kinded[at] as Call

    if (isFailed(last)) {
      continue
    }

    const key = stepKey(last)
    let count = 0

    for (let index = at; index >= Math.max(0, at - LOOP_WINDOW + 1); index -= 1) {
      const call = kinded[index] as Call

      if (stepKey(call) === key) {
        count += isFailed(call) ? 0 : 1
      } else if (call.kind === 'edit') {
        break
      }
    }

    if (count >= LOOP_MIN && (best === undefined || count >= best.count)) {
      best = { count, call: last }
    }
  }

  if (best === undefined) {
    return undefined
  }

  return trouble(
    'circles',
    `${best.call.did} ${best.count} times`,
    `It has done the same step ${best.count} times. If it keeps on, stop it and tell it exactly where to look.`,
  )
}

/**
 * The trouble signs in an agent's calls, each with its evidence and the
 * rules' advice: outside, failing, circles, in that order. Only calls with a
 * kind of work count (bookkeeping says nothing). A sign clears once 8 newer
 * calls show none of it. Once the agent is over, only a change that needs
 * checking is still trouble: how it worked no longer matters.
 */
export function troubleOf(calls: readonly Call[], isOver: boolean): Trouble[] {
  const kinded = calls.filter(call => call.kind !== undefined)
  const from = Math.max(0, kinded.length - CLEAR_AFTER)
  const found = [outsideOf(kinded, from)]

  if (!isOver) {
    found.push(failingOf(kinded, from), circlesOf(kinded, from))
  }

  return found.filter((sign): sign is Trouble => sign !== undefined)
}
