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
