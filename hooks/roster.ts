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

const DETAIL = [
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
  'prompt',
] as const

const tail = (path: string): string =>
  path
    .split(/[\\/]/)
    .filter(part => part !== '')
    .slice(-2)
    .join('/')

/** A tool call in a few words: `Bash: pytest -x`, `Read: core/config.py`. */
export function describeCall(
  tool: string,
  input: Readonly<Record<string, unknown>>,
): string {
  const name = tool.startsWith('mcp__')
    ? tool.split('__').slice(1).join(':')
    : tool

  for (const field of DETAIL) {
    const value = input[field]

    if (typeof value === 'string' && value.trim() !== '') {
      const detail = field.endsWith('path') ? tail(value) : value

      return brief(`${name}: ${detail}`, 72)
    }
  }

  return brief(name, 72)
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

/** The agent started a tool call. */
export function acted(
  list: readonly AgentRow[],
  id: string,
  activity: string,
  now: number,
): AgentRow[] {
  return change(list, id, row => {
    const next: AgentRow = {
      ...row,
      seenAt: now,
      activity,
      inFlight: row.inFlight + 1,
      tools: row.tools + 1,
      calls: [...(row.calls ?? []), now].slice(-CALLS_KEPT),
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
    const answer = brief(ending.answer, 160)
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

/** How many tool calls' start times a row keeps for its activity strip. */
const CALLS_KEPT = 24
const BARS = '▁▂▃▄▅▆▇█'
const STRIP_BUCKETS = 12
const STRIP_BUCKET_MS = 10_000

/**
 * The agent's tool calls over its last two minutes as a strip of bars, the
 * newest at the right: a burst reads tall, a lull flat.
 */
export function spark(row: AgentRow, now: number): string {
  const counts = new Array<number>(STRIP_BUCKETS).fill(0)

  for (const at of row.calls ?? []) {
    const age = Math.floor((now - at) / STRIP_BUCKET_MS)

    if (age >= 0 && age < STRIP_BUCKETS) {
      const slot = STRIP_BUCKETS - 1 - age

      counts[slot] = (counts[slot] ?? 0) + 1
    }
  }

  return counts
    .map(n => BARS[Math.min(n, BARS.length - 1)] ?? '')
    .join('')
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

/** What the agent is doing now, or how it ended, in one line. */
export function doing(row: AgentRow, now: number): string {
  switch (row.state) {
    case 'pending':
      return 'not started yet'
    case 'waiting':
      return 'waiting on background work or approval'
    case 'idle':
      return 'idle until a message wakes it'
    case 'completed':
      return row.answer ?? 'finished'
    case 'failed':
      return row.answer ?? 'failed'
    case 'killed':
      return row.answer ?? 'stopped'
    case 'running':
      break
  }

  if (row.inFlight > 0 && row.activity !== undefined) {
    const held = now - row.seenAt

    return held >= SLOW_CALL_MS
      ? `${row.activity} · ${span(held)}`
      : row.activity
  }

  return isQuiet(row, now)
    ? `quiet for ${span(now - row.seenAt)}`
    : 'thinking'
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
