// The roster's own logic, with no engine in it: how events fold into rows,
// and how a row reads on screen. Every function here is pure.
import type { AgentInfo } from 'claude-code'

import type { AgentRow, AgentState } from '../types'

const LIVE: readonly AgentState[] = ['pending', 'running', 'waiting', 'idle']
const BUSY: readonly AgentState[] = ['pending', 'running', 'waiting']
/** The rows kept; past it the oldest finished ones go. */
const CAP = 40
/** How long a running agent may say nothing before the pane calls it quiet. */
export const QUIET_MS = 120_000
/** How long a tool call runs before the pane shows its own clock. */
const SLOW_CALL_MS = 10_000

export const isLive = (row: AgentRow): boolean => LIVE.includes(row.state)
export const isBusy = (row: AgentRow): boolean => BUSY.includes(row.state)

// --- Text that is safe and short enough to show ---------------------------

/** How much of a text the patterns read; nothing past it is ever shown. */
const SCANNED = 600

/** Any private key block: RSA, EC, OPENSSH, and PGP's `PRIVATE KEY BLOCK`. */
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY[A-Z ]*-----[\s\S]*/g
/** `scheme://user:password@host`. */
const URL_LOGIN = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi
/** An Authorization header's whole value, scheme word included. */
const AUTH_HEADER =
  /\b((?:proxy-)?authorization["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s"']+(?:\s+[^\s"']+)?)/gi
/** A Cookie header's whole value, up to the quote that closes the header. */
const COOKIE = /\b((?:set-)?cookie:\s*)[^"'\n]+/gi
/**
 * A scheme word before something token-shaped: a digit, a symbol, or a
 * capital inside the word. `Basic idea` and `Basic Authentication` are prose.
 */
const SCHEME =
  /\b(Bearer|Basic|Token)\s+(?=[^\s"']*(?:[\d._~+/=-]|[a-z][A-Z]))[^\s"']{8,}/g
/** `tokenizer` is not a token; every other word around these names is. */
const SECRET_NAME =
  '[\\w-]*(?:token(?!iz)|secret|password|passwd|passphrase|pwd|credential|bearer|api[_-]?key|access[_-]?key|private[_-]?key)[\\w-]*'
/** A value, quoted or bare; the quotes may be escaped, as inside a JSON body. */
const VALUE = '(\\\\?"[^"]*"|\\\\?\'[^\']*\'|[^\\s"\']+)'
/** `NAME=value`, `name: value`, `"name":"value"`, `\"name\":\"value\"`. */
const NAMED = new RegExp(
  `\\b(${SECRET_NAME}(?:\\\\?["'])?\\s*[=:]\\s*)${VALUE}`,
  'gi',
)
/**
 * `--name value`. `--password-stdin` and `--token-file` name where the secret
 * comes from, so what follows them is left alone. A short flag such as `-p`
 * is AFTER_COMMAND's to judge.
 */
const FLAGGED = new RegExp(
  `(--(?![\\w-]*(?:stdin|file|path)\\b)${SECRET_NAME}\\s+)(?!-)${VALUE}`,
  'gi',
)
/**
 * Names too short to trust anywhere but in an assignment or a flag:
 * `DB_PASS=x`, `PW=x`, `?sig=x`, `-storepass x`. `bypass=1` is not one.
 */
const SHORT_NAMED = new RegExp(
  `\\b((?:[\\w-]*[_-])?(?:pass|pw|sig|signature|accountkey|sharedaccesskey)=)${VALUE}`,
  'gi',
)
const SHORT_FLAGGED = new RegExp(
  `(\\s-{1,2}[\\w-]*(?:pass|pw)\\s+)(?!-)${VALUE}`,
  'gi',
)
const PREFIXED =
  /\b(?:sk-[\w-]{8,}|[sr]k_(?:live|test)_\w{8,}|gh[pousr]_\w{8,}|github_pat_\w{20,}|glpat-[\w-]{16,}|xox[abprs]-[\w-]{8,}|hf_\w{20,}|npm_\w{20,}|AIza[\w-]{20,}|A[KS]IA[0-9A-Z]{16}|eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*|\d{6,12}:[\w-]{30,})/g
const LONG_RUN = /[A-Za-z0-9_-]{32,}/g
/** Base64 that ends in its padding: the padding alone gives it away. */
const PADDED = /[A-Za-z0-9+/]{16,}={1,2}(?![\w/+=-])/g
/** Base64 that holds `+` or `/`, which cut it into pieces LONG_RUN passes by. */
const ENCODED_RUN = /[A-Za-z0-9+/]{32,}/g

/** A quoted value or a bare one; `EXCEPT_FLAG` never takes the next flag for it. */
const ANY = `("[^"]*"|'[^']*'|[^\\s"']+)`
const EXCEPT_FLAG = `("[^"]*"|'[^']*'|[^\\s"'-][^\\s"']*)`
/** The rest of one command: it ends at a pipe, a `;`, a `&` or the line. */
const REST = '\\b[^|;&\\n]*?\\s'
const LOGIN =
  '(?:docker|podman|nerdctl|buildah|skopeo|az|oc|helm(?:\\s+registry)?)\\s+login'
/** curl's user flag: alone, at the end of a bundle (`-sSu`), or spelled out. */
const USER_FLAG = '(?:-[A-Za-z]*u\\s*|--(?:proxy-)?user(?:=|\\s+))'

/**
 * A short flag is a password only after the commands that read one there:
 * `mysql -p secret` is masked, `mkdir -p build` is not. Case counts, since
 * `mysql -P 3306` is a port. Each pattern keeps its first group and masks
 * the value after it, a number included.
 */
const AFTER_COMMAND: readonly RegExp[] = [
  new RegExp(
    `\\b((?:mysql\\w*|mariadb\\w*|mongo\\w*|sshpass|psexec\\w*|${LOGIN})${REST}-p\\s*)${EXCEPT_FLAG}`,
    'g',
  ),
  // `curl -u bob:pw`, bundled (`-sSu`), and quoted, where a password may
  // hold a space: that one is masked up to the closing quote.
  new RegExp(`\\b((?:curl|wget)${REST}${USER_FLAG}["'][^\\s:"']+:)[^"']*`, 'g'),
  new RegExp(`\\b((?:curl|wget)${REST}${USER_FLAG}[^\\s:"']+:)([^\\s"']+)`, 'g'),
  new RegExp(`\\b(curl${REST}(?:-b\\s*|--cookie(?:=|\\s+)))${ANY}`, 'g'),
  new RegExp(`\\b(gh\\s+secret\\s+set${REST}(?:-b|--body)(?:=|\\s+))${ANY}`, 'g'),
  new RegExp(`\\b(ssh-keygen${REST}-[NP]\\s+)${ANY}`, 'g'),
  new RegExp(`\\b(openssl${REST}-k\\s+)${ANY}`, 'g'),
  new RegExp(`\\b(redis-cli${REST}(?:-a|--pass)\\s+)${ANY}`, 'g'),
  new RegExp(`\\b((?:sqlcmd|bcp|osql|zip|unzip)${REST}-P\\s*)${EXCEPT_FLAG}`, 'g'),
  new RegExp(`\\b(ldap\\w+${REST}-w\\s+)${ANY}`, 'g'),
  new RegExp(`\\b((?:plink|pscp|psftp|putty)\\w*${REST}-pw\\s+)${ANY}`, 'g'),
  new RegExp(`\\b(7z\\w*${REST}-p)${ANY}`, 'g'),
  /\b(pass:)([^\s"']+)/g,
]

const isMixed = (run: string): boolean =>
  /\d/.test(run) && /[a-z]/.test(run) && /[A-Z]/.test(run)

/** A capital with its lowercase tail, a run of capitals, or a run of digits. */
const WORD = /[A-Z]?[a-z]+|[A-Z]+|\d+/g

/** Letters per word: `src/HeaderBar/index` reads 4.3, a key under 2. */
function wordLength(run: string): number {
  const words = run.match(WORD) ?? []

  return words.length === 0 ? 0 : words.join('').length / words.length
}

/**
 * A path is made of words and a key is not: it changes case and kind at
 * nearly every letter. Measured on this PC: of 2,376 real paths that mix
 * cases and digits, 99% read 3.3 letters a word or more; of 50,000 random
 * keys of each length, 99.7% read under 3. Entropy was tried first and
 * could not tell the two apart (a long path with an id in it reads 4.5
 * bits a letter, the same as a 40-letter key).
 */
const looksEncoded = (run: string): boolean => wordLength(run) < 3

/** A small number is a count (`max_tokens=4096`), not a credential. */
const isCount = (value: string): boolean => /^\d{1,7}[,;)}\]]?$/.test(value)

/** A type or a flag's setting, as code spells it: `password: str`, `token: null`. */
const isTypeWord = (value: string): boolean =>
  /^(?:str|string|bool|boolean|int|number|none|null|nil|true|false|undefined|required|optional)[,;)}\]]?$/i.test(
    value,
  )

/**
 * A long run reads as a key when it is all hex, or when it does not read as
 * words: either the whole run mixing cases with digits, or one unbroken piece
 * of letters and digits. `ProjectHealthReportGenerator2Test` and a
 * long-kebab-file-name are words.
 */
function looksSecret(run: string): boolean {
  if (/^[0-9a-f]+$/i.test(run)) {
    return true
  }

  if (isMixed(run) && looksEncoded(run)) {
    return true
  }

  return run
    .split(/[-_]/)
    .some(piece => piece.length >= 24 && /\d/.test(piece) && looksEncoded(piece))
}

/** A named value is masked unless it is a count or a type: `max_tokens=4096` stays. */
const masked = (whole: string, lead: string, value: string): string =>
  isCount(value) || isTypeWord(value) ? whole : `${lead}***`

/** What follows a password flag is masked whatever it is: a PIN is a number. */
const hidden = (_whole: string, lead: string): string => `${lead}***`

/** Masks what has the name or the shape of a credential. */
export function redact(text: string): string {
  const named = text
    .replace(PEM, '-----BEGIN PRIVATE KEY----- ***')
    .replace(URL_LOGIN, '$1***@')
    .replace(AUTH_HEADER, '$1***')
    .replace(COOKIE, '$1***')
    .replace(SCHEME, '$1 ***')
    .replace(NAMED, masked)
    .replace(FLAGGED, masked)
    .replace(SHORT_NAMED, masked)
    .replace(SHORT_FLAGGED, hidden)

  return AFTER_COMMAND.reduce(
    (line, pattern) => line.replace(pattern, hidden),
    named,
  )
    .replace(PREFIXED, '***')
    .replace(PADDED, run => (looksEncoded(run) ? '***' : run))
    .replace(ENCODED_RUN, run =>
      isMixed(run) && looksEncoded(run) ? '***' : run,
    )
    .replace(LONG_RUN, run => (looksSecret(run) ? '***' : run))
}

/** One line of at most `max` characters, redacted before it is cut. */
export function brief(text: string, max: number): string {
  const flat = redact(text.slice(0, SCANNED).replace(/\s+/g, ' ').trim())

  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * A text cut to `room` letters for a cell: at a word's end where that keeps
 * most of the room, with no stray space or comma left before the mark.
 */
export function clip(text: string, room: number): string {
  if (room <= 0) {
    return ''
  }

  if (text.length <= room) {
    return text
  }

  const head = text.slice(0, room - 1)
  // A cut that leaves only a scrap of a word (`in eac…`) drops the scrap.
  const isMidWord = /\S/.test(text.charAt(room - 1)) && /\S$/.test(head)
  const space = head.lastIndexOf(' ')
  const scrap = head.length - space - 1
  const kept = isMidWord && space > 0 && scrap <= 3 ? head.slice(0, space) : head

  return `${kept.replace(/[\s.,;:·(–-]+$/, '')}…`
}

/** A folder path with a drive or a share in front: `C:\a\b\c.txt`, `\\pc\share\x`. */
const DRIVE_PATH =
  /(?:\b[A-Za-z]:|\\\\[\w.$-]+)[\\/]+(?:[^\\/\s"'`<>|*?]+[\\/]+)*([^\\/\s"'`<>|*?]*)/g
/** A rooted path of two folders or more; a link's own slashes are left alone. */
const ROOT_PATH = /(?<![\w:/.~-])~?\/(?:[\w.@%+-]+\/)+([\w.@%+-]*)/g

const lastFolder = (path: string): string =>
  path.split(/[\\/]+/).filter(part => part !== '').pop() ?? path

/** Every full folder path in a text, down to its last name: `C:\a\b\c.txt` reads `c.txt`. */
export function unpathed(text: string): string {
  const named = (whole: string, last: string): string =>
    last === '' ? lastFolder(whole) : last

  return text.replace(DRIVE_PATH, named).replace(ROOT_PATH, named)
}

/** A file as a person names it: the name alone, never its folders. */
const fileName = (path: string): string => lastFolder(path.trim())

/** `https://docs.example.com/a/b?c` reads `docs.example.com`. */
const host = (url: string): string =>
  url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0] ?? url

/** `NotebookRead` and `firecrawl_search` as words: `notebook read`, `firecrawl search`. */
const worded = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase()

/** What a tool call is about, for a tool this file has no sentence for. */
const SUBJECT = [
  'command',
  'file_path',
  'notebook_path',
  'pattern',
  'query',
  'url',
  'path',
  'description',
  'skill',
  'subject',
] as const

/**
 * The engine's own bookkeeping calls: an agent handing its answer back is
 * not work it did, so it is named in plain words and left out of the count.
 */
const BOOKKEEPING: Readonly<Record<string, string>> = {
  SubagentHandback: 'Reporting back',
  StructuredOutput: 'Writing the result',
}

export const isBookkeeping = (tool: string): boolean => tool in BOOKKEEPING

/** Calls that need no detail to be understood. */
const PLAIN: Readonly<Record<string, string>> = {
  ...BOOKKEEPING,
  ToolSearch: 'Looking up tools',
  TodoWrite: 'Updating the task list',
  TaskCreate: 'Updating the task list',
  TaskUpdate: 'Updating the task list',
  TaskList: 'Checking the task list',
  TaskGet: 'Checking the task list',
  AskUserQuestion: 'Asking a question',
  EnterPlanMode: 'Planning',
  ExitPlanMode: 'Presenting the plan',
  SendMessage: 'Sending a message',
}

/**
 * A tool call as a person would say it: `Reading notes.txt`, `Searching
 * *.txt`, `Running pytest -x`. Never the tool's internal name, never a full
 * folder path.
 */
export function describeCall(
  tool: string,
  input: Readonly<Record<string, unknown>>,
): string {
  const text = (field: string): string => {
    const value = input[field]

    return typeof value === 'string' ? value.trim() : ''
  }
  const say = (verb: string, what: string): string =>
    brief(what === '' ? verb : `${verb} ${what}`, 72)
  const file = fileName(
    text('file_path') || text('notebook_path') || text('path'),
  )
  const plain = PLAIN[tool]

  if (plain !== undefined) {
    return plain
  }

  switch (tool) {
    case 'Read':
      return say('Reading', file)
    case 'Write':
      return say('Writing', file)
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return say('Editing', file)
    case 'Glob':
      return say('Searching', unpathed(text('pattern')))
    case 'Grep':
      return say('Searching for', unpathed(text('pattern')))
    case 'Bash':
    case 'PowerShell':
      return say('Running', unpathed(text('command')))
    case 'WebFetch':
      return say('Fetching', host(text('url')))
    case 'WebSearch':
      return say('Searching the web for', text('query'))
    case 'Agent':
    case 'Task':
      return say('Starting an agent:', text('description'))
    case 'Skill':
      return say('Using the skill', text('skill'))
  }

  const [server = '', ...rest] = tool.startsWith('mcp__')
    ? tool.split('__').slice(1)
    : []
  // `mcp__firecrawl__firecrawl_search` is `firecrawl search`, said once.
  const action = worded(rest.join(' '))
  const name =
    server === ''
      ? worded(tool)
      : action.startsWith(worded(server))
        ? action
        : `${worded(server)} ${action}`.trim()

  for (const field of SUBJECT) {
    const value = text(field)

    if (value !== '') {
      const subject = field.endsWith('path')
        ? fileName(value)
        : field === 'url'
          ? host(value)
          : unpathed(value)

      return say(`Using ${name}:`, subject)
    }
  }

  return say('Using', name)
}

/** Each sentence's opening as it reads once the call is over. */
const SETTLED: readonly (readonly [string, string])[] = [
  ['Searching the web for', 'Searched the web for'],
  ['Searching for', 'Searched for'],
  ['Searching', 'Searched'],
  ['Reading', 'Read'],
  ['Writing', 'Wrote'],
  ['Editing', 'Edited'],
  ['Running', 'Ran'],
  ['Fetching', 'Fetched'],
  ['Starting', 'Started'],
  ['Using', 'Used'],
  ['Looking up', 'Looked up'],
  ['Updating', 'Updated'],
  ['Checking', 'Checked'],
  ['Asking', 'Asked'],
  ['Planning', 'Planned'],
  ['Presenting', 'Presented'],
  ['Sending', 'Sent'],
  ['Reporting back', 'Reported back'],
]

/** A call that is over, in the past: `Reading notes.txt` reads `Read notes.txt`. */
export function settled(activity: string): string {
  for (const [now, then] of SETTLED) {
    if (activity.startsWith(now)) {
      return `${then}${activity.slice(now.length)}`
    }
  }

  return activity
}

/** How long an agent's result reads in the pane. */
const SUMMARY_MAX = 80

/**
 * An agent's answer as one line of about 80 letters: its opening, with the
 * marks of a list or a heading dropped, folder paths cut to their last name,
 * and anything shaped like a credential masked.
 */
export function summarized(answer: string): string {
  const flat = answer
    .slice(0, SCANNED)
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/^\s*(?:[-*+]|\d+[.)]|#{1,6})\s+/gm, '')
    .replace(/[*`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  return clip(redact(unpathed(flat)), SUMMARY_MAX)
}

/** A length of time as a person reads it: `42s`, `3m 05s`, `1h 12m`. */
export function span(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))

  if (seconds < 60) {
    return `${seconds}s`
  }

  const minutes = Math.floor(seconds / 60)

  if (minutes < 60) {
    return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  }

  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** A count as a person reads it: `812`, `12.3k`, `1.2M`. */
export function amount(count: number): string {
  if (count < 1000) {
    return String(count)
  }

  return count < 1_000_000
    ? `${(count / 1000).toFixed(1)}k`
    : `${(count / 1_000_000).toFixed(1)}M`
}

// --- Events folded into rows -----------------------------------------------

/** A new row; what the caller knows of the agent goes in `known`. */
export function born(
  id: string,
  now: number,
  known: Partial<AgentRow> = {},
): AgentRow {
  return {
    id,
    type: 'engine',
    description: 'internal task',
    state: 'running',
    isListed: false,
    isTeammate: false,
    startedAt: now,
    seenAt: now,
    inFlight: 0,
    tools: 0,
    tokens: 0,
    ...known,
  }
}

const change = (
  list: readonly AgentRow[],
  id: string,
  fn: (row: AgentRow) => AgentRow,
): AgentRow[] => list.map(row => (row.id === id ? fn(row) : row))

/** A row back at work: what it ended with is cleared, what it did is kept. */
function revived(row: AgentRow, now: number): AgentRow {
  const { endedAt: _endedAt, answer: _answer, ...kept } = row

  return { ...kept, state: 'running', seenAt: now }
}

/**
 * An agent started. A row already under its id keeps its counts and takes
 * the spawn's word for who it is. Only a resumed run comes back to life: a
 * row heard before its own spawn settled stays where its events left it.
 */
export function spawned(
  list: readonly AgentRow[],
  row: AgentRow,
  isResume: boolean,
): AgentRow[] {
  if (!list.some(one => one.id === row.id)) {
    return [...list, row]
  }

  return change(list, row.id, old => {
    const next: AgentRow = {
      ...(isResume ? revived(old, row.seenAt) : old),
      type: row.type,
      description: row.description,
      isTeammate: row.isTeammate,
    }

    if (row.parentId !== undefined) {
      next.parentId = row.parentId
    }

    if (row.name !== undefined) {
      next.name = row.name
    }

    return next
  })
}

/** A turn of the agent's loop began. */
export function woke(
  list: readonly AgentRow[],
  id: string,
  now: number,
): AgentRow[] {
  return change(list, id, row => ({ ...revived(row, now), inFlight: 0 }))
}

/**
 * The agent started a tool call. The engine's bookkeeping calls are shown
 * while they run and left out of the count: `isCounted` false.
 */
export function acted(
  list: readonly AgentRow[],
  id: string,
  activity: string,
  now: number,
  isCounted = true,
): AgentRow[] {
  return change(list, id, row => {
    const next: AgentRow = {
      ...row,
      seenAt: now,
      activity,
      inFlight: row.inFlight + 1,
      tools: row.tools + (isCounted ? 1 : 0),
    }

    // A call folded after the agent's end is counted; it brings nothing back.
    if (isLive(row)) {
      next.state = 'running'
    }

    return next
  })
}

/** One of the agent's tool calls came back. */
export function rested(
  list: readonly AgentRow[],
  id: string,
  now: number,
): AgentRow[] {
  return change(list, id, row => ({
    ...row,
    inFlight: Math.max(0, row.inFlight - 1),
    seenAt: now,
  }))
}

export type Ending = {
  reason: 'answer' | 'aborted' | 'refusal' | 'error'
  answer: string
  tokens: number
}

function stateAfter(reason: Ending['reason'], isTeammate: boolean): AgentState {
  if (reason === 'aborted') {
    return 'killed'
  }

  if (reason !== 'answer') {
    return 'failed'
  }

  return isTeammate ? 'idle' : 'completed'
}

/** A turn of the agent's loop ended: for all but a teammate, the agent did. */
export function ended(
  list: readonly AgentRow[],
  id: string,
  ending: Ending,
  now: number,
): AgentRow[] {
  return change(list, id, row => {
    const state = stateAfter(ending.reason, row.isTeammate)
    const answer = summarized(ending.answer)
    const next: AgentRow = {
      ...row,
      state,
      inFlight: 0,
      seenAt: now,
      tokens: row.tokens + ending.tokens,
    }

    if (answer !== '') {
      next.answer = answer
    }

    if (!LIVE.includes(state)) {
      next.endedAt = now
    }

    return next
  })
}

/** One row brought in line with what the roster says of it, if it says. */
function reconciled(
  row: AgentRow,
  info: AgentInfo | undefined,
  now: number,
): AgentRow {
  if (info === undefined) {
    // The engine drops an agent from its roster only after the agent ended.
    return row.isListed && isLive(row)
      ? { ...row, state: 'completed', inFlight: 0, endedAt: now }
      : row
  }

  // The roster's words are as free as a prompt's: masked and cut like one.
  const named: AgentRow = {
    ...row,
    isListed: true,
    type: brief(info.type, 40) || row.type,
    description: brief(info.description, 60) || row.description,
    isTeammate: row.isTeammate || info.teammateId !== undefined,
  }

  if (info.parentId !== undefined) {
    named.parentId = info.parentId
  }

  if (info.name !== undefined) {
    named.name = brief(info.name, 40)
  }

  // A row this mod heard end stays ended: only a new turn brings it back.
  if (!isLive(row) || info.status === row.state) {
    return named
  }

  return LIVE.includes(info.status)
    ? { ...named, state: info.status }
    : { ...named, state: info.status, inFlight: 0, endedAt: now }
}

/**
 * The rows after a look at the engine's roster: states it knows better
 * (waiting, idle, killed), and agents that were running before the mod heard.
 */
export function synced(
  list: readonly AgentRow[],
  infos: readonly AgentInfo[],
  now: number,
): AgentRow[] {
  const byId = new Map(infos.map(info => [info.id, info]))
  const known = new Set(list.map(row => row.id))
  const rows = list.map(row => reconciled(row, byId.get(row.id), now))
  const unheard = infos
    .filter(info => !known.has(info.id) && LIVE.includes(info.status))
    .map(info => reconciled(born(info.id, now, { state: info.status }), info, now))

  return [...rows, ...unheard]
}

/** The rows held to the cap, the oldest finished ones dropped first. */
export function pruned(list: readonly AgentRow[]): AgentRow[] {
  if (list.length <= CAP) {
    return [...list]
  }

  const finished = list
    .filter(row => !isLive(row))
    .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
  const dropped = new Set(
    finished.slice(0, list.length - CAP).map(row => row.id),
  )

  return list.filter(row => !dropped.has(row.id))
}

// --- Rows as the pane shows them -------------------------------------------

export type Seated = { row: AgentRow; depth: number }

/**
 * The rows in the order drawn: live ones first, oldest first, then finished
 * ones, newest first, each agent's children right beneath it.
 */
export function arranged(list: readonly AgentRow[]): Seated[] {
  const ids = new Set(list.map(row => row.id))
  const sorted = [...list].sort((a, b) => {
    const rank = Number(!isLive(a)) - Number(!isLive(b))

    if (rank !== 0) {
      return rank
    }

    return isLive(a)
      ? a.startedAt - b.startedAt
      : (b.endedAt ?? 0) - (a.endedAt ?? 0)
  })
  const isRoot = (row: AgentRow): boolean =>
    row.parentId === undefined ||
    row.parentId === row.id ||
    !ids.has(row.parentId)
  const seated: Seated[] = []
  const placed = new Set<string>()

  const seat = (parentId: string | undefined, depth: number): void => {
    for (const row of sorted) {
      const isHere =
        parentId === undefined ? isRoot(row) : row.parentId === parentId

      if (isHere && !placed.has(row.id)) {
        placed.add(row.id)
        seated.push({ row, depth })
        seat(row.id, depth + 1)
      }
    }
  }

  seat(undefined, 0)

  // A ring of parents has no root: seat what is left rather than lose it.
  for (const row of sorted) {
    if (!placed.has(row.id)) {
      placed.add(row.id)
      seated.push({ row, depth: 0 })
      seat(row.id, 1)
    }
  }

  return seated
}

export type Tally = {
  working: number
  idle: number
  done: number
  failed: number
}

/** How many agents stand where. */
export function tally(list: readonly AgentRow[]): Tally {
  const count = (states: readonly AgentState[]): number =>
    list.filter(row => states.includes(row.state)).length

  return {
    working: count(BUSY),
    idle: count(['idle']),
    done: count(['completed']),
    failed: count(['failed', 'killed']),
  }
}

/** The tally in words: `2 working · 1 idle · 3 done · 1 failed`. */
export function headline(list: readonly AgentRow[]): string {
  return Object.entries(tally(list))
    .filter(([, n]) => n > 0)
    .map(([word, n]) => `${n} ${word}`)
    .join(' · ')
}

/** The status line's text while any agent works; undefined clears it. */
export function statusText(list: readonly AgentRow[]): string | undefined {
  const working = list.filter(isBusy).length

  if (working === 0) {
    return undefined
  }

  return `${working} ${working === 1 ? 'agent' : 'agents'} working`
}

/** True for a running agent that has said nothing for a while. */
export const isQuiet = (row: AgentRow, now: number): boolean =>
  row.state === 'running' && row.inFlight === 0 && now - row.seenAt >= QUIET_MS

/**
 * How bright a piece of a row is drawn. `pulse` is the one accent, kept for
 * an agent at work; everything else is weight and brightness.
 */
export type Tone = 'strong' | 'bright' | 'soft' | 'faint' | 'pulse'

type Said = { text: string; tone: Tone }

/**
 * What the agent is doing now, or how it ended, and how loud that is said:
 * the call in flight reads bright, the last call (in the past) reads faint.
 */
function said(row: AgentRow, now: number): Said {
  switch (row.state) {
    case 'pending':
      return { text: 'Not started yet', tone: 'faint' }
    case 'waiting':
      return { text: 'Waiting on background work or approval', tone: 'bright' }
    case 'idle':
      return { text: 'Idle until a message wakes it', tone: 'faint' }
    case 'completed':
      return { text: row.answer ?? 'Finished', tone: 'faint' }
    case 'failed':
      return { text: row.answer ?? 'Failed', tone: 'soft' }
    case 'killed':
      return { text: row.answer ?? 'Stopped', tone: 'soft' }
    case 'running':
      break
  }

  if (row.inFlight > 0 && row.activity !== undefined) {
    const held = now - row.seenAt

    return {
      text:
        held >= SLOW_CALL_MS
          ? `${row.activity} · ${span(held)}`
          : row.activity,
      tone: 'bright',
    }
  }

  if (isQuiet(row, now)) {
    return { text: `Quiet for ${span(now - row.seenAt)}`, tone: 'soft' }
  }

  return {
    text: row.activity === undefined ? 'Starting' : settled(row.activity),
    tone: 'faint',
  }
}

/** What the agent is doing now, or how it ended, in one line. */
export function doing(row: AgentRow, now: number): string {
  return said(row, now).text
}

/** The row's clock: how long it has run, or how long it ran. */
export function elapsed(row: AgentRow, now: number): string {
  return span((row.endedAt ?? now) - row.startedAt)
}

/** The row's counts: `7 tools · 12.3k tok`. */
export function facts(row: AgentRow): string {
  const parts = [`${row.tools} ${row.tools === 1 ? 'tool' : 'tools'}`]

  if (row.tokens > 0) {
    parts.push(`${amount(row.tokens)} tok`)
  }

  return parts.join(' · ')
}

/** The whole roster as plain text, for the command and the model's tool. */
export function report(list: readonly AgentRow[], now: number): string {
  if (list.length === 0) {
    return 'No agents have run in this session yet.'
  }

  const lines = arranged(list).map(({ row, depth }) => {
    const who = `${row.type} "${row.description}"`
    const stats = `${elapsed(row, now)}, ${facts(row)}`

    return `${'  '.repeat(depth)}- [${row.state}] ${who} (${stats}): ${doing(row, now)}`
  })

  return [headline(list), ...lines].join('\n')
}

// --- The pane, line by line -------------------------------------------------
//
// One aligned row per agent: a mark, its type, its task, what it is doing and
// how long it has run. Weight and brightness carry the order of things; the
// only color is the mark of an agent at work. Nothing here knows the engine,
// so every line can be read back as plain text in a test.

/** A piece of one line and how bright it is drawn. */
export type Span = { text: string; tone: Tone }
/** One line of the pane: an agent's row, pressed by its `id`, or a note. */
export type Line = { id?: string; spans: Span[] }
/** What the pane has to draw in: its room, where it sits, who opened it. */
export type Sight = {
  columns: number
  rows: number
  isDocked: boolean
  /** True when the person asked for the pane: finished agents stay listed. */
  isPinned: boolean
}
export type Drawing = { head: Span[]; lines: Line[] }

/** How long a finished agent's result stays on a line of its own. */
export const SUMMARY_MS = 30_000
/** How long a finished agent stays in a pane nobody asked for. */
export const GONE_MS = 120_000
/** The finished agents listed at once; the rest are a count. */
const FINISHED_KEPT = 5
const GAP = '  '
const TYPE_MAX = 15
const TASK_MIN = 16
const DETAIL_MIN = 18
/** What the activity column takes before the task gets more: `Reading notes.txt · 7 tools`. */
const DETAIL_WANT = 28
/** From this width a finished agent's result rides on its own row. */
const RESULT_MIN = 44

const MARK: Record<AgentState, string> = {
  pending: '○',
  running: '●',
  waiting: '○',
  idle: '○',
  completed: '✓',
  failed: '✗',
  killed: '■',
}

/** The header's count of what is in sight: `2 running · 2 done`. */
export function heading(rows: readonly AgentRow[]): string {
  const count = (states: readonly AgentState[]): number =>
    rows.filter(row => states.includes(row.state)).length
  const counts: readonly (readonly [number, string])[] = [
    [count(['pending', 'running']), 'running'],
    [count(['waiting']), 'waiting'],
    [count(['idle']), 'idle'],
    [count(['completed']), 'done'],
    [count(['failed']), 'failed'],
    [count(['killed']), 'stopped'],
  ]

  return counts
    .filter(([n]) => n > 0)
    .map(([n, word]) => `${n} ${word}`)
    .join(' · ')
}

type Shape = {
  type: number
  task: number
  detail: number
  time: number
  isFolded: boolean
}

/**
 * The widths of a row's columns, from the widest type, task and time in
 * sight. Where the pane is too narrow to hold them all the row folds: who it
 * is and how long on one line, what it is doing on the line beneath.
 */
export function shaped(
  columns: number,
  type: number,
  task: number,
  time: number,
): Shape {
  const flexible = columns - 2 - type - time - GAP.length * 3

  if (flexible >= TASK_MIN + DETAIL_MIN) {
    // What the agent is doing is the news, so its column is served first;
    // the task, which the engine's own list also names, takes the rest.
    const kept = Math.max(TASK_MIN, Math.min(task, flexible - DETAIL_WANT))

    return { type, task: kept, detail: flexible - kept, time, isFolded: false }
  }

  const room = Math.max(8, columns - 2 - time - GAP.length * 2)
  const narrow = Math.min(type, Math.max(4, Math.floor(room * 0.45)))

  return {
    type: narrow,
    task: Math.max(4, room - narrow),
    detail: Math.max(8, columns - 2),
    time,
    isFolded: true,
  }
}

/** The agent's type as its row names it: a plugin's prefix dropped. */
const typeName = (row: AgentRow): string =>
  row.type.slice(row.type.lastIndexOf(':') + 1) || row.type

/** `7 tools`; nothing at all before the first call, where a zero says nothing. */
const counted = (row: AgentRow): string =>
  row.tools === 0 ? '' : `${row.tools} ${row.tools === 1 ? 'tool' : 'tools'}`

const cell = (text: string, width: number): string =>
  clip(text, width).padEnd(width)

/**
 * A cell's words with the tool count after them. Where both do not fit, a
 * result gives way to keep the count (`isCountKept`); live activity is kept
 * whole and the count waits for room.
 */
function withCount(
  words: Said,
  count: string,
  width: number,
  isCountKept: boolean,
): Span[] {
  const tail = ` · ${count}`
  const room = width - tail.length

  if (count === '' || (words.text.length > room && (!isCountKept || room < 8))) {
    return [{ text: cell(words.text, width), tone: words.tone }]
  }

  const text = clip(words.text, room)

  return [
    { text, tone: words.tone },
    { text: tail.padEnd(width - text.length), tone: 'faint' },
  ]
}

/** How loud a row is: bold and bright while live, faint once done. */
function look(row: AgentRow, now: number): { mark: Tone; type: Tone; task: Tone } {
  if (row.state === 'running') {
    return {
      mark: isQuiet(row, now) ? 'faint' : 'pulse',
      type: 'strong',
      task: 'soft',
    }
  }

  if (isLive(row)) {
    return { mark: 'soft', type: 'strong', task: 'soft' }
  }

  return row.state === 'completed'
    ? { mark: 'faint', type: 'faint', task: 'faint' }
    : { mark: 'soft', type: 'soft', task: 'faint' }
}

type Placed = { seat: Seated; indent: number }

/** One agent's line, and the line under it where the row folds or just ended. */
function rowLines(
  { seat, indent }: Placed,
  shape: Shape,
  columns: number,
  time: string,
  now: number,
): Line[] {
  const { row } = seat
  const tones = look(row, now)
  const words = said(row, now)
  const count = counted(row)
  const isOver = !isLive(row)
  const isFresh = isOver && now - (row.endedAt ?? now) < SUMMARY_MS
  const lead: Span[] = [
    { text: `${MARK[row.state]} `, tone: tones.mark },
    {
      text: `${cell(`${'  '.repeat(indent)}${typeName(row)}`, shape.type)}${GAP}`,
      tone: tones.type,
    },
    { text: `${cell(row.description, shape.task)}${GAP}`, tone: tones.task },
  ]
  const clock: Span = { text: time.padStart(shape.time), tone: 'faint' }
  const gap: Span = { text: GAP, tone: 'faint' }
  // A line under a row sits in under the type and ends where its words do.
  const under = (spans: Span[]): Line => ({
    spans: [
      { text: '  ', tone: 'faint' },
      ...spans.map((span, at) =>
        at === spans.length - 1 ? { ...span, text: span.text.trimEnd() } : span,
      ),
    ],
  })

  if (shape.isFolded) {
    const first: Line = { id: row.id, spans: [...lead, clock] }

    // A finished agent's result is read, then its row closes to one line.
    return row.state === 'completed' && !isFresh
      ? [first]
      : [first, under(withCount(words, count, columns - 2, true))]
  }

  if (!isOver || shape.detail >= RESULT_MIN) {
    return [
      {
        id: row.id,
        spans: [...lead, ...withCount(words, count, shape.detail, isOver), gap, clock],
      },
    ]
  }

  if (row.state !== 'completed') {
    return [
      {
        id: row.id,
        spans: [
          ...lead,
          { text: cell(words.text, shape.detail), tone: words.tone },
          gap,
          clock,
        ],
      },
    ]
  }

  const line: Line = {
    id: row.id,
    spans: [...lead, { text: cell(count, shape.detail), tone: 'faint' }, gap, clock],
  }

  return isFresh && row.answer !== undefined
    ? [line, under([{ text: clip(row.answer, columns - 2), tone: 'faint' }])]
    : [line]
}

/**
 * The pane as lines of text: the header, a row per agent at work, then the
 * agents that just finished, newest first. A finished agent leaves by itself
 * after a while unless the person asked for the pane.
 */
export function drawn(
  list: readonly AgentRow[],
  now: number,
  sight: Sight,
): Drawing {
  const columns = Math.max(24, sight.columns)
  const seated = arranged(list)
  const live = seated.filter(({ row }) => isLive(row))
  const over = seated.filter(
    ({ row }) =>
      !isLive(row) &&
      (sight.isPinned || now - (row.endedAt ?? now) < GONE_MS),
  )
  const head: Span[] = [{ text: 'Agents', tone: 'strong' }]

  if (live.length + over.length === 0) {
    head.push({
      text: list.length === 0 ? '  No agents yet' : '  None running',
      tone: 'faint',
    })

    return { head, lines: [] }
  }

  head.push({
    text: `  ${heading([...live, ...over].map(({ row }) => row))}`,
    tone: 'faint',
  })

  /** A child sits in under its parent, when the parent is in sight. */
  const placed = (section: readonly Seated[]): Placed[] =>
    section.map(seat => {
      const parentId = seat.row.parentId
      const isUnderParent =
        parentId !== undefined && section.some(one => one.row.id === parentId)

      return { seat, indent: isUnderParent ? Math.min(seat.depth, 3) : 0 }
    })
  const working = placed(live)
  const ended = placed(over)
  const everyone = [...working, ...ended]
  const times = new Map(
    everyone.map(({ seat }) => [seat.row.id, elapsed(seat.row, now)]),
  )
  const widest = (lengths: readonly number[]): number => Math.max(1, ...lengths)
  const shape = shaped(
    columns,
    Math.min(
      TYPE_MAX,
      widest(everyone.map(one => typeName(one.seat.row).length + one.indent * 2)),
    ),
    widest(everyone.map(one => one.seat.row.description.length)),
    // Three wide from the start, so nothing shifts when a clock reaches 10s.
    Math.max(3, widest([...times.values()].map(time => time.length))),
  )
  const lines: Line[] = []
  const note = (text: string): Line => ({
    spans: [{ text: `  ${text}`, tone: 'faint' }],
  })
  const draw = (one: Placed): Line[] =>
    rowLines(one, shape, columns, times.get(one.seat.row.id) ?? '', now)
  // The header takes a row, and docked a clear row follows it.
  let room = Math.max(3, sight.rows - 1 - (sight.isDocked ? 1 : 0))
  const perRow = shape.isFolded ? 2 : 1
  const fitting =
    working.length * perRow <= room
      ? working.length
      : Math.max(1, Math.floor((room - 1) / perRow))

  for (const one of working.slice(0, fitting)) {
    lines.push(...draw(one))
  }

  if (fitting < working.length) {
    lines.push(note(`+${working.length - fitting} more running`))

    return { head, lines }
  }

  room -= fitting * perRow

  let shown = 0

  for (const one of ended.slice(0, FINISHED_KEPT)) {
    const rows = draw(one)
    // A row is kept for the count of what is left out, unless nothing is.
    const spare = room - (shown === ended.length - 1 ? 0 : 1)
    const kept = rows.length <= spare ? rows : spare >= 1 ? rows.slice(0, 1) : []

    if (kept.length === 0) {
      break
    }

    lines.push(...kept)
    room -= kept.length
    shown += 1
  }

  if (shown < ended.length && room >= 1) {
    lines.push(note(`+${ended.length - shown} earlier`))
  }

  return { head, lines }
}

/** A drawing as the plain text a screen shows, one string a line. */
export function plain(drawing: Drawing): string[] {
  const text = (spans: readonly Span[]): string =>
    spans.map(span => span.text).join('')

  return [text(drawing.head), ...drawing.lines.map(line => text(line.spans))]
}
