// What an agent's calls say about its work, with no engine in it: the kind of
// work (the card's icon), the stage it is at (the strip), and its health (the
// light). These are the rules the cards fall back on when no narrator writes.
// Every function here is pure.
import type { AgentRow, Call, Health, Kind, Stage, Trail } from '../types'
import { brief, doing, isLive, unpathed } from './roster'

/** No new step for this long: amber. */
export const SLOW_MS = 60_000
/** No new step for this long: red. */
export const STUCK_MS = 120_000
/** A call in flight this long is a kind of work of its own: a long search. */
export const LONG_CALL_MS = 8_000
/** How much of a call's result is kept for the narrator to read. */
const OUT_MAX = 140

/** The engine's own tools, by the work they do. */
const BY_TOOL: Readonly<Record<string, Kind>> = {
  Read: 'read',
  NotebookRead: 'read',
  WebFetch: 'read',
  Grep: 'search',
  Glob: 'search',
  LS: 'search',
  WebSearch: 'search',
  Edit: 'edit',
  Write: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  SubagentHandback: 'write',
  StructuredOutput: 'write',
}

/** Bookkeeping that says nothing about the work: the kind there was holds. */
const KEEPS = new Set([
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'TaskOutput',
  'TaskStop',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'SendMessage',
  'ToolSearch',
  'Agent',
  'Task',
  'Skill',
])

/**
 * A command that runs tests or checks: the agent is checking its work. Any
 * other command is `run`, and keeps the stage the agent was at.
 */
const CHECKS =
  /\b(?:py\.?test|unittest|tox|nox|jest|vitest|mocha|playwright\s+test|cypress\s+run|phpunit|rspec|ruff|mypy|pyright|flake8|pylint|eslint|tsc|biome|(?:prettier|black)\b[^|;&\n]*--check|go\s+(?:test|vet)|cargo\s+(?:test|check|clippy)|dotnet\s+test|(?:gradlew?|mvnw?)\b[^|;&\n]*\btest|make\s+(?:test|check|lint)|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|typecheck|check)|claude\s+plugin\s+(?:test|validate)|pre-commit|shellcheck)\b/i

/** The verbs in a connected tool's name, by the work they do; read in this order. */
const VERB_KINDS: readonly (readonly [Kind, ReadonlySet<string>])[] = [
  ['search', new Set(['search', 'find', 'query', 'crawl', 'lookup', 'grep', 'glob'])],
  [
    'read',
    new Set(['read', 'get', 'fetch', 'list', 'scrape', 'navigate', 'open', 'screenshot', 'snapshot', 'capture', 'extract', 'download', 'view', 'show', 'describe', 'inspect']),
  ],
  [
    'edit',
    new Set(['create', 'add', 'write', 'update', 'edit', 'delete', 'remove', 'move', 'copy', 'upload', 'set', 'insert', 'rename', 'patch', 'put', 'post', 'send', 'publish', 'merge', 'commit', 'push']),
  ],
]

/** The words of a tool's own name, past any server: `mcp__x__read_page` reads `read page`. */
function nameWords(tool: string): string[] {
  const name = tool.startsWith('mcp__') ? tool.split('__').slice(2).join(' ') : tool

  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[_:.\s-]+/)
    .map(word => word.toLowerCase())
    .filter(word => word !== '')
}

const own = <T>(table: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined

/**
 * The kind of work a tool call is. Undefined for bookkeeping, which keeps the
 * kind (and the stage) the agent was at.
 */
export function kindOf(
  tool: string,
  input: Readonly<Record<string, unknown>>,
): Kind | undefined {
  const known = own(BY_TOOL, tool)

  if (known !== undefined) {
    return known
  }

  if (KEEPS.has(tool)) {
    return undefined
  }

  if (tool === 'Bash' || tool === 'PowerShell') {
    const command = typeof input.command === 'string' ? input.command : ''

    return CHECKS.test(command) ? 'test' : 'run'
  }

  const words = nameWords(tool)

  for (const [kind, verbs] of VERB_KINDS) {
    if (words.some(word => verbs.has(word))) {
      return kind
    }
  }

  return 'run'
}

/** The stage each kind of work puts an agent at; `run` leaves it where it was. */
const STAGE_OF: Readonly<Record<Kind, Stage | undefined>> = {
  read: 'looking',
  search: 'looking',
  edit: 'changing',
  test: 'checking',
  write: 'reporting',
  run: undefined,
}

/** Where the agent is in its job, from its calls in order; an agent that is over is reporting. */
export function stageOf(calls: readonly Call[], isOver: boolean): Stage {
  if (isOver) {
    return 'reporting'
  }

  let stage: Stage = 'looking'

  for (const call of calls) {
    const next = call.kind === undefined ? undefined : STAGE_OF[call.kind]

    if (next !== undefined) {
      stage = next
    }
  }

  return stage
}

/**
 * The kind of work the agent has settled into: the last call's, once the two
 * last calls agree, or it is the only one, or it has run 8 s. Undefined while
 * the agent goes back and forth.
 */
export function steadyKind(calls: readonly Call[], now: number): Kind | undefined {
  const kinded = calls.filter(call => call.kind !== undefined)
  const last = kinded[kinded.length - 1]

  if (last === undefined) {
    return undefined
  }

  if (last.end === undefined && now - last.at >= LONG_CALL_MS) {
    return last.kind
  }

  if (kinded.length === 1) {
    return last.kind
  }

  return kinded[kinded.length - 2]?.kind === last.kind ? last.kind : undefined
}

/** The kind of work now: the newest call in flight, else the last call that had a kind. */
export function kindNow(calls: readonly Call[]): Kind | undefined {
  const kinded = calls.filter(call => call.kind !== undefined)
  const open = kinded.filter(call => call.end === undefined)

  return (open[open.length - 1] ?? kinded[kinded.length - 1])?.kind
}

/**
 * How the agent is doing: green while it takes steps, amber after a minute
 * with none, red after two. A call still in flight is no new step.
 */
export function healthOf(row: AgentRow, now: number): Health {
  if (!isLive(row)) {
    return 'done'
  }

  if (row.state === 'idle') {
    return 'idle'
  }

  const quiet = now - row.seenAt

  return quiet >= STUCK_MS ? 'stuck' : quiet >= SLOW_MS ? 'slow' : 'working'
}

/**
 * What a card says with no narrator: the pane's own words for what the agent
 * does now, and its last finished step, or once over, its answer.
 */
export function plainOf(
  row: AgentRow,
  trail: Trail | undefined,
  now: number,
): { now: string; found: string } {
  if (!isLive(row)) {
    return { now: doing(row, now), found: trail?.result ?? row.answer ?? '' }
  }

  const done = (trail?.calls ?? []).filter(call => call.end !== undefined)

  return { now: doing(row, now), found: done[done.length - 1]?.did ?? '' }
}

/** A call's result as the narrator may read it: its opening, folder paths cut, credentials masked. */
export function outOf(text: string): string {
  return brief(unpathed(text.slice(0, 600)), OUT_MAX)
}
