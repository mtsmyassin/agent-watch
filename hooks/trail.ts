// An agent's trail, with no engine in it: the tool calls it made, the longer
// result it ended with, and the data file a page reads them from. Every
// function here is pure.
import type { AgentRow, Call, Payload, Trail } from '../types'
import { arranged, lastFolder, settled, typeName } from './roster'

/** The calls kept for one agent; past it the oldest go, and are counted. */
export const CALL_CAP = 200
/** How long an agent's result reads in the window. */
export const RESULT_MAX = 600

/** Every agent's trail, by the agent's id. */
export type Trails = Readonly<Record<string, Trail>>

/**
 * An agent's own trail. A plain lookup also answers for the names every
 * object carries (`constructor`), and an id may be just that.
 */
const trailOf = (trails: Trails, agentId: string): Trail | undefined =>
  Object.prototype.hasOwnProperty.call(trails, agentId)
    ? trails[agentId]
    : undefined

// --- Events folded into trails ---------------------------------------------

/** A call as it starts: said as it runs, and as it will read once over. */
export function called(key: string, doing: string, at: number): Call {
  return { key, doing, did: settled(doing), at }
}

/** The agent started a tool call: it joins the trail, the oldest past the cap goes. */
export function began(
  trails: Trails,
  agentId: string,
  call: Call,
): Record<string, Trail> {
  const trail = trailOf(trails, agentId) ?? { calls: [], dropped: 0 }
  const calls = [...trail.calls, call]
  const over = Math.max(0, calls.length - CALL_CAP)

  return {
    ...trails,
    [agentId]: {
      ...trail,
      calls: calls.slice(over),
      dropped: trail.dropped + over,
    },
  }
}

/**
 * One of the agent's tool calls came back: when is noted, and whether it
 * failed. A call the cap already let go changes nothing.
 */
export function finished(
  trails: Trails,
  agentId: string,
  key: string,
  at: number,
  isFailed: boolean,
): Record<string, Trail> {
  const trail = trailOf(trails, agentId)
  // The newest call under the key that is still open.
  const open =
    trail?.calls.findLastIndex(
      call => call.key === key && call.end === undefined,
    ) ?? -1

  if (trail === undefined || open === -1) {
    return trails
  }

  const calls = trail.calls.map((call, index): Call => {
    if (index !== open) {
      return call
    }

    return isFailed ? { ...call, end: at, isFailed: true } : { ...call, end: at }
  })

  return { ...trails, [agentId]: { ...trail, calls } }
}

/**
 * A turn of the agent ended with this answer, already cut and redacted. An
 * empty one clears what an earlier turn left.
 */
export function resulted(
  trails: Trails,
  agentId: string,
  text: string,
): Record<string, Trail> {
  const held = trailOf(trails, agentId)

  if (text === '' && held?.result === undefined) {
    return trails
  }

  const { result: _result, ...trail }: Trail = held ?? { calls: [], dropped: 0 }

  return {
    ...trails,
    [agentId]: text === '' ? trail : { ...trail, result: text },
  }
}

/** The trails of the agents still held; the same object back when none goes. */
export function kept(
  trails: Trails,
  ids: readonly string[],
): Record<string, Trail> {
  const held = new Set(ids)
  const entries = Object.entries(trails).filter(([id]) => held.has(id))

  return entries.length === Object.keys(trails).length
    ? trails
    : Object.fromEntries(entries)
}

// --- The window's page and its data ----------------------------------------

/** The session as the mod knows it: the name its page goes by, and where it runs. */
export type Session = { id: string; cwd: string }

/** A name for one session's page: the time in base 36, then four letters of chance. */
export function minted(now: number, chance: () => number): string {
  const letters = Array.from({ length: 4 }, () =>
    Math.floor(chance() * 36).toString(36),
  )

  return `${now.toString(36)}${letters.join('')}`
}

/** True for a name `minted` could have made: nothing in it can leave its folder. */
export const isSid = (name: unknown): name is string =>
  typeof name === 'string' && /^[0-9a-z]{6,24}$/.test(name)

/** One agent as the page reads it: its row, and its trail beside it. */
function shown(
  row: AgentRow,
  depth: number,
  trail: Trail | undefined,
): Payload['agents'][number] {
  const agent: Payload['agents'][number] = {
    id: row.id,
    type: typeName(row),
    task: row.description,
    state: row.state,
    depth,
    startedAt: row.startedAt,
    seenAt: row.seenAt,
    tools: row.tools,
    tokens: row.tokens,
    dropped: trail?.dropped ?? 0,
    calls: trail?.calls ?? [],
  }

  if (row.endedAt !== undefined) {
    agent.endedAt = row.endedAt
  }

  if (row.answer !== undefined) {
    agent.summary = row.answer

    // The longer result stands only while the answer does: an agent back at
    // work shows neither.
    if (trail?.result !== undefined) {
      agent.result = trail.result
    }
  }

  return agent
}

/**
 * Everything the page shows, as one value: the agents in the order the pane
 * lists them, each with its calls. The page cannot ask for more.
 */
export function payload(
  session: Session,
  rows: readonly AgentRow[],
  trails: Trails,
  now: number,
): Payload {
  return {
    v: 1,
    session: {
      id: session.id,
      project: lastFolder(session.cwd),
      startedAt:
        rows.length === 0 ? now : Math.min(...rows.map(row => row.startedAt)),
    },
    beatAt: now,
    agents: arranged(rows).map(({ row, depth }) =>
      shown(row, depth, trailOf(trails, row.id)),
    ),
  }
}

/**
 * The data file's text: one assignment, which the page runs as a script.
 * Every `<` is written as its escape, so nothing an agent said can close the
 * script it sits in.
 */
export function dataFile(data: Payload): string {
  const json = JSON.stringify(data).split('<').join('\\u003c')

  return `window.__AGENT_WATCH__ = ${json};\n`
}

/**
 * One of the window's files in `<home>/.claude/agent-watch`, written with the
 * home folder's own slashes so the path reads as the system says it.
 */
export function filed(home: string, name: string): string {
  const slash = home.includes('\\') ? '\\' : '/'

  return [home.replace(/[\\/]+$/, ''), '.claude', 'agent-watch', name].join(slash)
}

/**
 * A file's path as a link a browser opens: forward slashes, and every letter
 * a link or a command line would read as its own (`#`, `?`, `&`) escaped.
 */
export function pageUrl(path: string): string {
  const slashed = path.split('\\').join('/')
  const link = encodeURI(`file://${slashed.startsWith('/') ? '' : '/'}${slashed}`)

  return link.replace(/[#?&]/g, mark => `%${mark.charCodeAt(0).toString(16)}`)
}
