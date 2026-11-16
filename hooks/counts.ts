// The narrator's arithmetic, done by the mod: exact counts from an agent's
// trail, so the model quotes numbers instead of working them out. Seen live:
// "about six rounds more than asked" when it was 3, and "all requested reads
// are done" at 6 of 8. Every function here is pure.
import type { Call, Kind, Trail } from '../types'
import { brief, unpathed } from './roster'

/** How long a step's words may read as a tally's name. */
const STEP_NAME_MAX = 80

/** One file or step, and how many times. */
export type Count = { name: string; count: number }

/**
 * An agent's whole kept trail, counted: its steps (calls with a kind of work),
 * how many failed, how many of each kind, and per file or step how many times,
 * each list newest first. Names are file names or the step's own words, masked.
 */
export type Tally = {
  steps: number
  failed: number
  /** Older calls the trail let go: not counted here. */
  dropped: number
  kinds: Partial<Record<Kind, number>>
  /** Reads of each file, by name. */
  reads: Count[]
  /** Changes to each file, by name. */
  edits: Count[]
  /** Each search, by its words. */
  searches: Count[]
  /** Each step that failed, by its words. */
  failures: Count[]
}

/** A step's words as a tally names them: one line, folders cut, masked, short. */
const stepName = (call: Call): string => brief(unpathed(call.did), STEP_NAME_MAX)

/** How many times each name comes, newest first (by its newest call). */
function counted(calls: readonly Call[], nameOf: (call: Call) => string | undefined): Count[] {
  const counts = new Map<string, number>()

  for (let at = calls.length - 1; at >= 0; at -= 1) {
    const name = nameOf(calls[at] as Call)

    if (name !== undefined && name !== '') {
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
  }

  return [...counts].map(([name, count]) => ({ name, count }))
}

/** The exact counts of an agent's kept trail. Bookkeeping (no kind) is not a step. */
export function tallyOf(trail: Trail | undefined): Tally {
  const kinded = (trail?.calls ?? []).filter(call => call.kind !== undefined)
  const kinds: Partial<Record<Kind, number>> = {}

  for (const call of kinded) {
    const kind = call.kind as Kind

    kinds[kind] = (kinds[kind] ?? 0) + 1
  }

  const of = (kind: Kind): Call[] => kinded.filter(call => call.kind === kind)
  const failed = kinded.filter(call => call.isFailed === true)

  return {
    steps: kinded.length,
    failed: failed.length,
    dropped: trail?.dropped ?? 0,
    kinds,
    reads: counted(of('read'), call => call.name),
    edits: counted(of('edit'), call => call.name),
    searches: counted(of('search'), stepName),
    failures: counted(failed, stepName),
  }
}

/** A count as the prompt says it: `once`, `2 times`. */
export const times = (count: number): string => (count === 1 ? 'once' : `${count} times`)

/** Each kind of work as the tally counts it: one, and many. */
export const KIND_COUNTS: readonly (readonly [Kind, string, string])[] = [
  ['read', 'read', 'reads'],
  ['search', 'search', 'searches'],
  ['edit', 'edit', 'edits'],
  ['test', 'test or check run', 'test or check runs'],
  ['run', 'other command', 'other commands'],
  ['write', 'report', 'reports'],
]

/** The tally's kinds of work in words: `5 reads, 1 edit`. */
export const kindWords = (tally: Tally): string[] =>
  KIND_COUNTS.flatMap(([kind, one, many]) => {
    const count = tally.kinds[kind] ?? 0

    return count === 0 ? [] : [`${count} ${count === 1 ? one : many}`]
  })

/**
 * The rules' own progress line: the tally in words, exact where the
 * narrator's was not. What stands in for a progress line that miscounted.
 */
export function rulesProgress(tally: Tally): string {
  return tally.steps === 0
    ? 'No steps yet.'
    : `Counted from its steps: ${kindWords(tally).join(', ')}; ${tally.failed} failed.`
}

// --- Counts the narrator wrote ----------------------------------------------
//
// Only counts of reads, searches, edits and failures are checked, and only
// where the words say plainly that they are one: "read config.txt 6 times",
// "5 reads of notes.md", "failed 3 times". A number the brief gave ("asked to
// read it 8 times", "6 of the 8 asked"), a difference ("3 more", "4 left"),
// or any other number is left alone: a false correction is worse than none.

/** What a count is of. */
export type ClaimKind = 'read' | 'search' | 'edit' | 'failure'

/** A count the narrator wrote: what of, how many, the file it names if any, and its words. */
export type Claim = { kind: ClaimKind; count: number; file?: string; said: string }

/** How much of a field is read for counts. */
const CLAIM_SCAN = 2000

const NUMBER_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty',
] as const
const NUM = `(?:\\d{1,4}|${NUMBER_WORDS.join('|')})`
const OF_M = `(?:\\s+(?:of|out\\s+of)\\s+(?:the\\s+)?${NUM})`

/** `12 times`, `6 of the 8 times`; then what follows, to spot "more" and "asked". */
const TIMES = new RegExp(`(?<![\\d.,])\\b(${NUM})(${OF_M})?\\s+times\\b`, 'gi')
const ONCE = /\b(once|twice|thrice)\b/gi
/** After "once": a conjunction or "once more", not a count. */
const ONCE_NOT_COUNT =
  /^\s+(?:i|we|you|it|its|they|he|she|there|the|a|an|my|our|that|this|these|both|each|every|everything|all|done|finished|complete|ready|more|again|as|[a-z]+ed)\b/i
/** `5 reads`, `3 of 8 reads`, `2 failed tests`. */
const NOUNED = new RegExp(`(?<![\\d.,])\\b(${NUM})(${OF_M})?\\s+(failed\\s+)?([a-z-]+)\\b`, 'gi')

/**
 * The nouns a count may be of, by what they count. Failures are counted
 * only as "failed N times": "2 failed tests" and "4 failures" are as likely
 * the project's own test results as the agent's steps. "Changes" are left
 * out too: one edit may make many.
 */
const NOUNS: Readonly<Record<string, ClaimKind>> = {
  read: 'read', reads: 'read', reread: 'read', rereads: 'read',
  search: 'search', searches: 'search',
  edit: 'edit', edits: 'edit',
}
/** After a count with no file named, a word that makes it a part of the whole: "3 reads in src", "2 reads failed". */
const PART_AFTER = /^\s+(?:in(?!\s+(?:all|total)\b)|across|under|from|over|on|of|to|into|inside|within|failed|that|which|with|per)\b/i

/** The verbs a "N times" count is of; the nearest one before the number says which. */
const VERBS: readonly (readonly [RegExp, ClaimKind])[] = [
  [/\b(?:re-?)?read(?:s|ing)?\b/gi, 'read'],
  [/\bsearch(?:ed|es|ing)?\b/gi, 'search'],
  [/\b(?:edit(?:ed|s|ing)?|chang(?:ed|es|ing)|modified|updated)\b/gi, 'edit'],
  [/\bfail(?:ed|s|ing)?\b/gi, 'failure'],
]

/** Words shortly before the verb that make it the brief's ask, not what was done. */
const ASKED_BEFORE =
  /\b(?:to|asked|asks|ask|told|tells|wants?|wanted|needs?|needed|should|must|supposed|expected|meant|plans?|planned|requires?|required|instructed|allowed)\s+(?:\S+\s+){0,3}$/i
/** Words just after a count that make it a difference or the brief's number. */
const NOT_DONE_AFTER = /^\s+(?:more|extra|fewer|less|left|remaining|to\s+go|over|beyond|short|asked|requested|planned|needed|required|wanted|expected|allowed)\b/i
/** Words just before a count that make it the brief's number or a limit. */
const ASKED_COUNT_BEFORE =
  /\b(?:asked\s+for|asks\s+for|requested|requires|required|needs|needed|wants|wanted|expected|planned|allowed|of\s+the|out\s+of|up\s+to|at\s+most|at\s+least|max(?:imum)?|limit\s+of|budget\s+of|to\s+(?:do|make|run|perform|try))\s+$/i

const numberOf = (word: string): number => {
  const lower = word.toLowerCase()
  const index = (NUMBER_WORDS as readonly string[]).indexOf(lower)

  return index !== -1 ? index : lower === 'once' ? 1 : lower === 'twice' ? 2 : lower === 'thrice' ? 3 : Number.parseInt(lower, 10)
}

/** Where the clause holding `at` starts: after the last `;`, `!`, `?` or sentence-ending `.` before it. */
function clauseStart(text: string, at: number): number {
  const head = text.slice(0, at)
  let start = 0

  for (const match of head.matchAll(/[;!?]|\.(?=\s|$)/g)) {
    start = (match.index ?? 0) + 1
  }

  return start
}

/** The known file names in `text`, with where each starts, matched without regard to case. */
function filesIn(text: string, files: readonly string[]): { name: string; at: number }[] {
  const lower = text.toLowerCase()
  const found: { name: string; at: number }[] = []

  for (const name of files) {
    const key = name.toLowerCase()

    if (key === '') {
      continue
    }

    for (let at = lower.indexOf(key); at !== -1; at = lower.indexOf(key, at + 1)) {
      const before = lower.charAt(at - 1)
      const after = lower.charAt(at + key.length)

      if (!/[\w.-]/.test(before) && !/[\w-]/.test(after)) {
        found.push({ name, at })
      }
    }
  }

  return found
}

/** The nearest verb of a known kind before `at` in the clause, with where it starts. */
function verbBefore(text: string, from: number, at: number): { kind: ClaimKind; at: number } | undefined {
  const window = text.slice(from, at)
  let best: { kind: ClaimKind; at: number } | undefined

  for (const [pattern, kind] of VERBS) {
    for (const match of window.matchAll(pattern)) {
      const where = from + (match.index ?? 0)

      if (best === undefined || where > best.at) {
        best = { kind, at: where }
      }
    }
  }

  return best
}

/**
 * The counts of reads, searches, edits and failures a text plainly states,
 * in the order they come, each with the file it names when it names one of
 * `files`. Numbers the brief gave, differences and anything unsure are left out.
 */
export function claimsIn(text: string, files: readonly string[]): Claim[] {
  const head = text.slice(0, CLAIM_SCAN)
  const claims: (Claim & { at: number })[] = []

  // "read config.txt 6 times", "searched twice": the verb before says what.
  const timed = [
    ...[...head.matchAll(TIMES)].map(match => ({ match, number: match[1] as string, hasM: match[2] !== undefined })),
    ...[...head.matchAll(ONCE)]
      // "at once", "once more" and "once it has finished" are no counts.
      .filter(match => {
        const at = match.index ?? 0
        const end = at + match[0].length

        return !/\bat\s+$/i.test(head.slice(Math.max(0, at - 4), at)) && !ONCE_NOT_COUNT.test(head.slice(end, end + 30))
      })
      .map(match => ({ match, number: match[1] as string, hasM: false })),
  ]

  for (const { match, number, hasM } of timed) {
    const at = match.index ?? 0
    const end = at + match[0].length
    const verb = verbBefore(head, clauseStart(head, at), at)

    if (verb === undefined || ASKED_BEFORE.test(head.slice(Math.max(0, verb.at - 30), verb.at))) {
      continue
    }

    // "6 of the 8 times asked": the "asked" is the 8's; with no "of", it is this count's.
    if (!hasM && NOT_DONE_AFTER.test(head.slice(end, end + 30))) {
      continue
    }

    const near = filesIn(head.slice(verb.at, at), files).sort((a, b) => b.at - a.at)[0]
    // "read config.txt 6 of the 8 times" is said as "read config.txt 6 times".
    const words = hasM ? `${head.slice(verb.at, at + number.length)} times` : head.slice(verb.at, end)
    const claim: Claim & { at: number } = {
      kind: verb.kind,
      count: numberOf(number),
      said: words.replace(/\s+/g, ' ').trim(),
      at,
    }

    if (near !== undefined && verb.kind !== 'search' && verb.kind !== 'failure') {
      claim.file = near.name
    }

    claims.push(claim)
  }

  // "5 reads of notes.md", "3 of 8 reads", "2 failed tests": the noun says what.
  for (const match of head.matchAll(NOUNED)) {
    const at = match.index ?? 0
    const end = at + match[0].length
    const noun = (match[4] as string).toLowerCase()
    const kind: ClaimKind | undefined =
      match[3] === undefined && Object.prototype.hasOwnProperty.call(NOUNS, noun) ? NOUNS[noun] : undefined

    if (
      kind === undefined ||
      ASKED_COUNT_BEFORE.test(head.slice(Math.max(0, at - 20), at)) ||
      (match[2] === undefined && NOT_DONE_AFTER.test(head.slice(end, end + 30))) ||
      /^\s+(?:more|extra|fewer|less)\b/i.test(head.slice(at + (match[1] as string).length))
    ) {
      continue
    }

    const claim: Claim & { at: number } = { kind, count: numberOf(match[1] as string), said: match[0], at }
    const after = /^\s+(?:of|to|in|on)\s+(?:the\s+)?(?:file\s+)?(\S+)/i.exec(head.slice(end, end + 80))
    const named = after === null ? undefined : filesIn(after[1] as string, files)[0]
    const before = filesIn(head.slice(Math.max(0, at - 70), at), files)
      .filter(one => /^[\s:]*$/.test(head.slice(Math.max(0, at - 70) + one.at + one.name.length, at)))
      .pop()
    const file = named ?? before

    // "3 reads in src", "2 reads failed": a part of the whole, which the tally does not hold.
    if (file === undefined && PART_AFTER.test(head.slice(end, end + 30))) {
      continue
    }

    if (file !== undefined && (kind === 'read' || kind === 'edit')) {
      claim.file = file.name
      claim.said = named === undefined ? claim.said : `${match[0]}${(after as RegExpExecArray)[0]}`.trim()
    }

    claims.push(claim)
  }

  return claims
    .sort((a, b) => a.at - b.at)
    .map(({ at: _at, ...claim }) => claim)
}

/** The counts the tally has for a claim: that file's, or with no file, the kind's total and each one's. */
function truthOf(claim: Claim, tally: Tally): number[] {
  const lists: Readonly<Record<ClaimKind, readonly Count[]>> = {
    read: tally.reads,
    search: tally.searches,
    edit: tally.edits,
    failure: tally.failures,
  }
  const list = lists[claim.kind]

  if (claim.file !== undefined) {
    const file = claim.file.toLowerCase()

    return [list.find(one => one.name.toLowerCase() === file)?.count ?? 0]
  }

  const total = claim.kind === 'failure' ? tally.failed : (tally.kinds[claim.kind] ?? 0)

  return [...new Set([total, ...list.map(one => one.count)])]
}

/** The fields of a reply whose counts are checked. */
type Counted = { progress?: string; percent?: number; found?: string }

/**
 * A reply's `progress` and `found` checked against the tally the narrator
 * was given: a field that contradicts it is replaced by the rules' words
 * (the tally in words for progress, with no estimate; the last step for
 * found), and each mismatch said in `wrong`. Anything else is untouched.
 */
export function corrected<T extends Counted>(told: T, tally: Tally, found: string): { told: T; wrong: string[] } {
  const fixed: T = { ...told }
  const wrong: string[] = []
  const said = (field: string, miss: { claim: Claim; truth: number[] }): string =>
    `${field} said "${miss.claim.said}", the tally has ${miss.truth.join(' or ')}`

  const progress = told.progress === undefined ? undefined : miscounted(told.progress, tally)

  if (progress !== undefined) {
    fixed.progress = rulesProgress(tally)
    delete fixed.percent
    wrong.push(said('progress', progress))
  }

  const finding = told.found === undefined ? undefined : miscounted(told.found, tally)

  if (finding !== undefined) {
    if (found === '') {
      delete fixed.found
    } else {
      fixed.found = found
    }

    wrong.push(said('found', finding))
  }

  return { told: fixed, wrong }
}

/** The first count in `text` that the tally contradicts, with what the tally has; none when all hold. */
export function miscounted(text: string, tally: Tally): { claim: Claim; truth: number[] } | undefined {
  const files = [...tally.reads, ...tally.edits].map(one => one.name)

  for (const claim of claimsIn(text, files)) {
    const truth = truthOf(claim, tally)

    if (!truth.includes(claim.count)) {
      return { claim, truth }
    }
  }

  return undefined
}
