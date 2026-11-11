import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { AgentRow, AgentState } from '../types'
import {
  acted,
  arranged,
  born,
  brief,
  describeCall,
  doing,
  elapsed,
  ended,
  facts,
  isBusy,
  isLive,
  isQuiet,
  pruned,
  report,
  rested,
  spark,
  spawned,
  statusText,
  synced,
  tally,
  woke,
} from './roster'
import type { Seated } from './roster'

const NAME = 'agent-watch'
const PANE = 'agent-watch'
const TITLE = 'Agents'
const SNAPSHOT = 'mcp__agent-watch__snapshot'
/** One spinner frame: the pane redraws at this pace while an agent works. */
const FRAME_MS = 250
/** Every fourth frame is a tick: the rows are read, and the clocks may stop. */
const FRAMES_PER_TICK = 4
/** Every third tick also asks the engine's roster where each agent stands. */
const SYNC_EVERY = 3
const FINISHED_SHOWN = 6

// The DeltaO.ai palette (DESIGN.md): a near-void canvas, warm off-white text
// in three strengths, and three accents that each mean one thing. Emerald is
// work under way, amber asks for a look, crimson is the brand and a failure.
const INK = {
  canvas: '#08090a',
  text: '#EDEDEC',
  soft: '#A1A1A6',
  faint: '#6B6B73',
  line: '#48484A',
  crimson: '#E5383B',
  amber: '#D4943A',
  emerald: '#0D9668',
} as const
/** Each accent at 15% over the canvas: a badge's ground, as DESIGN.md mixes it. */
const TINT = {
  emerald: '#091E18',
  amber: '#271E11',
  crimson: '#291011',
  neutral: '#171819',
} as const
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
/** The pane is its own dark panel, so its colors hold on any terminal theme. */
const PANE_LOOK = { rows: 12, columns: 48, backgroundColor: INK.canvas } as const

// Change the tag when a row's fields change: it declines what an earlier
// version stored, which outlives a reload.
const agents = atom({ plugin: 'agent-watch', key: 'agents' } as const, [], {
  shape: 'agents-1',
})
const isDismissed = atom(
  { plugin: 'agent-watch', key: 'isDismissed' } as const,
  false,
)

/** A state's mark where no spinner turns: a finished row, a waiting one. */
const MARKS: Record<AgentState, { glyph: string; color: string }> = {
  pending: { glyph: '○', color: INK.faint },
  running: { glyph: '●', color: INK.emerald },
  waiting: { glyph: '▲', color: INK.amber },
  idle: { glyph: '○', color: INK.amber },
  completed: { glyph: '✓', color: INK.emerald },
  failed: { glyph: '✗', color: INK.crimson },
  killed: { glyph: '■', color: INK.crimson },
}

const clock = (): number => Date.now()

const fit = (text: string, room: number): string =>
  text.length > room ? `${text.slice(0, Math.max(1, room - 1))}…` : text

/** A loop found in no roster is looked up again after this long. */
const STRANGER_MS = 5000
/** Ticks the clocks keep going after the last event, whatever a read said. */
const GRACE = 2

// A reload starts these over; the rows themselves live in `$.state`.
/**
 * True in a nested worker (the orchestrator's, the council's): nobody watches
 * one, so the mod registers nothing there and every hook passes straight on.
 * `AGENT_WATCH=on` turns it back on, which is how the mod is tested.
 */
let isOff = false
/** False for a `-p` run or the SDK: no pane is opened and no clock runs. */
let hasScreen = true
/** True while a surface draws the pane; the status line speaks only when none does. */
let isPaneUp = false
let isOpening = false
let ticker: Timer | undefined
let isTicking = false
let grace = 0
/** `null` until this copy has posted, so a line an earlier copy left is replaced. */
let shownStatus: string | undefined | null = null
/** The folds, one at a time, in the order their events came. */
let queue: Promise<void> = Promise.resolve()
/** Loops with a row, and loops in no roster (the engine's own) with when asked. */
const heard = new Set<string>()
const strangers = new Map<string, number>()

function debug($: EngineInterface, what: string, error: unknown): void {
  $.ui.log(`${NAME}: ${what}: ${String(error)}`, { to: 'debug' })
}

/**
 * Runs `job` after the jobs before it, off the event's own path: the event
 * that raised it never waits on the pane's bookkeeping and never fails by it.
 */
function enqueue(
  $: EngineInterface,
  what: string,
  job: () => Promise<unknown>,
): Promise<void> {
  queue = queue.then(job).then(
    () => undefined,
    (error: unknown) => debug($, what, error),
  )

  return queue
}

function post($: EngineInterface, list: readonly AgentRow[]): void {
  // The pane's own header says it better: the status line stands in for a
  // pane that is closed, or that a narrow terminal has not drawn.
  const text = isPaneUp || isOpening ? undefined : statusText(list)

  if (text !== shownStatus) {
    shownStatus = text
    $.ui.status(text)
  }
}

/** Opens the pane, and notes whether a surface drew it. */
async function raise($: EngineInterface): Promise<void> {
  // Said before the engine answers, so the status line never flashes on
  // for the moment the pane takes to open.
  isOpening = true

  try {
    const opened = await $.ui.open({ id: PANE, title: TITLE, ...PANE_LOOK })

    isPaneUp = opened.isPlaced
  } finally {
    isOpening = false
  }

  post($, await read($, agents))
}

/** Brings the rows in line with the engine's roster; writes only a change. */
async function sync($: EngineInterface): Promise<AgentRow[]> {
  const [list, infos] = await Promise.all([read($, agents), $.agent.list()])
  const now = clock()
  const next = pruned(synced(list, infos, now))
  const settled =
    JSON.stringify(next) === JSON.stringify(list)
      ? list
      : await update($, agents, held => pruned(synced(held, infos, now)))

  for (const row of settled) {
    heard.add(row.id)
    strangers.delete(row.id)
  }

  post($, settled)

  return settled
}

async function tick($: EngineInterface, beat: number): Promise<void> {
  const list =
    beat % SYNC_EVERY === 0 ? await sync($) : await read($, agents)

  if (list.some(isBusy)) {
    $.ui.invalidate('ui.render')

    return
  }

  // An event may have landed after that read: give it its ticks first.
  if (grace > 0) {
    grace -= 1

    return
  }

  // Nothing works: stop asking until the next agent starts.
  ticker?.cancel()
  ticker = undefined
  post($, list)
}

function watch($: EngineInterface): void {
  // The clock only turns the spinner and re-reads the roster for the pane.
  if (!hasScreen || ticker !== undefined) {
    return
  }

  let frame = 0

  ticker = $.clock.every(FRAME_MS, () => {
    frame += 1

    // Between ticks only the spinner turns: a redraw, with nothing read.
    if (frame % FRAMES_PER_TICK !== 0) {
      $.ui.invalidate('ui.render')

      return
    }

    // A slow roster must not stack one tick on another.
    if (isTicking) {
      return
    }

    isTicking = true
    tick($, frame / FRAMES_PER_TICK)
      .catch((error: unknown) => debug($, 'tick failed', error))
      .finally(() => {
        isTicking = false
      })
  })
}

/** Starts the clocks and, unless the person closed the pane, opens it. */
async function show($: EngineInterface): Promise<void> {
  watch($)

  if (!hasScreen || (await read($, isDismissed))) {
    return
  }

  raise($).catch((error: unknown) => debug($, 'pane not opened', error))
}

/**
 * Whether the pane keeps a row for the loop. One it never heard spawn is
 * looked up in the roster; the engine's own forks are in neither, and are
 * asked about again only after a while.
 */
async function knows($: EngineInterface, id: string): Promise<boolean> {
  if (heard.has(id)) {
    return true
  }

  const since = strangers.get(id)

  if (since !== undefined && clock() - since < STRANGER_MS) {
    return false
  }

  const held = await read($, agents)
  const list = held.some(row => row.id === id) ? held : await sync($)

  if (!list.some(row => row.id === id)) {
    strangers.set(id, clock())

    return false
  }

  strangers.delete(id)
  heard.add(id)
  await show($)

  return true
}

/** Folds one event of a loop into its row, if the pane keeps one for it. */
async function fold(
  $: EngineInterface,
  id: string,
  change: (list: readonly AgentRow[]) => AgentRow[],
): Promise<void> {
  if (!(await knows($, id))) {
    return
  }

  post($, await update($, agents, change))
  watch($)
}

/** Takes in an agent whose spawn just settled. */
async function admit(
  $: EngineInterface,
  row: AgentRow,
  isResume: boolean,
): Promise<void> {
  strangers.delete(row.id)
  heard.add(row.id)

  const rows = await update($, agents, held =>
    pruned(spawned(held, row, isResume)),
  )

  // The pane first: the status line is posted only where no pane will show.
  await show($)
  post($, rows)
}

async function view($: EngineInterface, row: AgentRow): Promise<void> {
  const moved = await $.ui.view({ agentId: row.id })

  if (moved.deny !== undefined) {
    $.ui.toast(`${row.type}: ${moved.deny}`)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    isOff =
      (await $.env.get('DELTAO_NESTED_CLI')) === '1' &&
      (await $.env.get('AGENT_WATCH')) !== 'on'
    hasScreen = e.isInteractive

    if (isOff) {
      return next(e)
    }

    await $.command.register({
      name: 'agent-watch',
      description: 'Show what every agent in this session is working on',
    })
    await $.tool.register({
      name: 'snapshot',
      description:
        "Lists this session's agents and what each is doing right now: " +
        'state, the tool call it is on, time running, tool count, and how ' +
        'it ended. Read-only; use it to answer what the agents are doing.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      // A few dozen tokens in the tool list, so the model can look at its
      // agents without a tool search first.
      isDeferred: false,
    })

    // A reload, or a session already under way: pick the watch back up.
    enqueue($, 'start', async () => {
      const list = await sync($)

      if (list.some(isLive)) {
        await show($)
      }
    })

    return next(e)
  })

  on('command.run', { command: 'agent-watch' }, async ($, e, next) => {
    if (isOff) {
      return next(e)
    }

    await update($, isDismissed, () => false)
    // What was heard so far is folded before the roster is read out.
    await queue
    const list = await sync($)

    if (list.some(isBusy)) {
      watch($)
    }

    if (hasScreen) {
      await raise($)
    }

    return { text: report(list, clock()) }
  })

  on('tool.call', { tool: SNAPSHOT }, async ($, e, next) => {
    if (isOff) {
      return next(e)
    }

    await queue

    return { result: report(await sync($), clock()) }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (isOff) {
      return next(e)
    }

    // Closed by hand: stay closed until they ask for the pane again.
    if (e.origin.kind === 'person') {
      // A store that fails must not keep the pane from closing.
      await update($, isDismissed, () => true).catch((error: unknown) =>
        debug($, 'dismissal not kept', error),
      )
    }

    // The engine's own answer is handed back: a hook that returns nothing
    // is skipped, with a line in the transcript saying so.
    const closed = await next(e)

    // With the pane gone the status line takes over.
    isPaneUp = false
    enqueue($, 'status after close', async () =>
      post($, await read($, agents)),
    )

    return closed
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const id = started.agentId

    if (isOff || id === undefined) {
      return started
    }

    // The agent has started whatever happens here: a row that cannot be
    // written is logged, and the spawn's own answer still goes back.
    try {
      const known: Partial<AgentRow> = {
        type: brief(e.subagentType ?? '', 40) || 'agent',
        description:
          brief((e.description || e.prompt) ?? '', 60) || 'unnamed task',
        isTeammate: e.isTeammate === true,
      }

      if (e.parentAgentId !== undefined) {
        known.parentId = e.parentAgentId
      }

      if (e.name !== undefined) {
        known.name = brief(e.name, 40)
      }

      const row = born(id, clock(), known)
      const isResume = e.resume !== undefined

      grace = GRACE
      enqueue($, 'spawn', () => admit($, row, isResume))
    } catch (error) {
      debug($, 'spawn not noted', error)
    }

    return started
  })

  on('turn.start', ($, e, next) => {
    const id = e.agentId

    if (!isOff && id !== undefined) {
      const now = clock()

      grace = GRACE
      enqueue($, 'turn start', () =>
        fold($, id, held => woke(held, id, now)),
      )
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const id = e.agentId

    // The main loop's calls pass straight through: this watches agents.
    if (isOff || id === undefined) {
      return next(e)
    }

    const input = e as unknown as Readonly<Record<string, unknown>>
    const activity = describeCall(e.tool, input)
    const startedAt = clock()

    grace = GRACE
    enqueue($, 'tool call', () =>
      fold($, id, held => acted(held, id, activity, startedAt)),
    )

    try {
      return await next(e)
    } finally {
      // However the call ended, it is no longer in flight.
      const endedAt = clock()

      enqueue($, 'tool return', () =>
        fold($, id, held => rested(held, id, endedAt)),
      )
    }
  })

  on('turn.complete', ($, e, next) => {
    const id = e.agentId

    if (!isOff && id !== undefined) {
      const usage = e.usage
      const tokens =
        usage === undefined
          ? 0
          : usage.input_tokens +
            usage.cache_creation_input_tokens +
            usage.output_tokens
      const ending = { reason: e.reason, answer: e.answer, tokens }
      const now = clock()

      grace = GRACE
      enqueue($, 'turn end', () =>
        fold($, id, held => ended(held, id, ending, now)),
      )
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (isOff) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, agents)
    const now = clock()
    // Docked beside the transcript there is room for a card per working
    // agent; inline above the prompt every row counts, so rows stay bare.
    const isDocked = e.props.placement === 'dock'
    // Docked, the body runs edge to edge: a column is kept clear each side.
    const gutter = isDocked ? 1 : 0
    const columns = Math.max(24, e.props.bodyColumns - gutter * 2)
    const seated = arranged(list)
    const live = seated.filter(({ row }) => isLive(row))
    const done = seated.filter(({ row }) => !isLive(row))
    const shownDone = done.slice(0, FINISHED_SHOWN)
    const hidden = done.length - shownDone.length
    const counts = tally(list)
    const frame = SPINNER[Math.floor(now / FRAME_MS) % SPINNER.length] ?? '●'

    const open = (row: AgentRow) => (): void => {
      view($, row).catch((error: unknown) => debug($, 'view not moved', error))
    }

    const badge = (count: number, word: string, color: string, ground: string) =>
      count > 0 && (
        <Text color={color} backgroundColor={ground}>
          {` ${count} ${word} `}
        </Text>
      )

    /** How far a row sits in: under its parent, when the parent is in sight. */
    const indentOf = (section: readonly Seated[], seat: Seated): number => {
      const parentId = seat.row.parentId
      const isUnderParent =
        parentId !== undefined && section.some(one => one.row.id === parentId)

      return isUnderParent ? Math.min(seat.depth, 3) * 2 : 0
    }

    /**
     * What the agent is on, the tool's name standing out from its detail.
     * The text is cut to leave `tail` (the counts) whole at the row's end.
     */
    const activity = (row: AgentRow, tail: string, room: number) => {
      const text = fit(doing(row, now), Math.max(8, room - 2 - tail.length))

      if (isQuiet(row, now) || row.state === 'waiting') {
        return (
          <Text color={INK.amber} wrap="truncate-end">
            {'  '}
            {text}
            {tail}
          </Text>
        )
      }

      if (row.state !== 'running' || row.inFlight === 0) {
        return (
          <Text color={INK.faint} italic wrap="truncate-end">
            {'  '}
            {text}
            {tail}
          </Text>
        )
      }

      const cut = text.indexOf(': ')

      return (
        <Text wrap="truncate-end">
          {'  '}
          <Text color={INK.text}>{cut === -1 ? text : text.slice(0, cut)}</Text>
          <Text color={INK.soft}>{cut === -1 ? '' : text.slice(cut)}</Text>
          <Text color={INK.faint}>{tail}</Text>
        </Text>
      )
    }

    /** An agent still at work: a card when docked, two bare rows inline. */
    const card = (seat: Seated) => {
      const { row } = seat
      const indent = indentOf(live, seat)
      const wantsLook = isQuiet(row, now) || row.state === 'waiting'
      const accent = wantsLook
        ? INK.amber
        : row.state === 'running'
          ? INK.emerald
          : INK.line
      const isTurning = row.state === 'running'
      const mark = MARKS[row.state]
      const time = elapsed(row, now)
      const inner = columns - indent - (isDocked ? 4 : 0)
      const room = inner - row.type.length - time.length - 5
      const edge = isDocked
        ? ({ borderStyle: 'round', borderColor: accent, paddingX: 1 } as const)
        : {}

      return (
        <Box flexDirection="column" marginLeft={indent} {...edge}>
          <Box justifyContent="space-between">
            <Button key={`agent:${row.id}`} plain onPress={open(row)}>
              <Text color={isTurning ? accent : mark.color}>
                {isTurning ? frame : mark.glyph}
              </Text>{' '}
              <Text color={INK.text} weight="bold">
                {row.type}
              </Text>{' '}
              <Text color={INK.soft}>
                {fit(row.description, Math.max(8, room))}
              </Text>
            </Button>
            <Text color={INK.faint}> {time}</Text>
          </Box>
          {activity(row, isDocked ? '' : ` · ${facts(row)}`, inner)}
          {isDocked && (
            <Text wrap="truncate-end">
              {'  '}
              <Text color={accent}>{spark(row, now)}</Text>
              <Text color={INK.faint}>{`  ${facts(row)}`}</Text>
            </Text>
          )}
        </Box>
      )
    }

    /** An agent that ended: two quiet rows, its mark the only color. */
    const past = (seat: Seated) => {
      const { row } = seat
      const indent = indentOf(shownDone, seat)
      const mark = MARKS[row.state]
      const time = elapsed(row, now)
      const room = columns - indent - row.type.length - time.length - 5
      const counts = facts(row)
      // How it ended is cut short, so the counts after it are never lost.
      const said = fit(
        doing(row, now),
        Math.max(8, columns - indent - counts.length - 5),
      )

      return (
        <Box flexDirection="column" marginLeft={indent}>
          <Box justifyContent="space-between">
            <Button key={`agent:${row.id}`} plain onPress={open(row)}>
              <Text color={mark.color}>{mark.glyph}</Text>{' '}
              <Text color={INK.soft} weight="bold">
                {row.type}
              </Text>{' '}
              <Text color={INK.faint}>
                {fit(row.description, Math.max(8, room))}
              </Text>
            </Button>
            <Text color={INK.faint}> {time}</Text>
          </Box>
          <Text color={INK.faint} wrap="truncate-end">
            {'  '}
            {said} · {counts}
          </Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" paddingX={gutter}>
        <Box gap={1} flexWrap="wrap">
          <Text>
            <Text color={INK.crimson} weight="bold">
              Δ
            </Text>{' '}
            <Text color={INK.text} weight="bold">
              AGENTS
            </Text>
          </Text>
          {badge(counts.working, 'working', INK.emerald, TINT.emerald)}
          {badge(counts.idle, 'idle', INK.amber, TINT.amber)}
          {badge(counts.done, 'done', INK.soft, TINT.neutral)}
          {badge(counts.failed, 'failed', INK.crimson, TINT.crimson)}
        </Box>
        {list.length === 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text color={INK.soft}>No agents yet.</Text>
            <Text color={INK.faint}>
              Each one shows up here the moment it starts.
            </Text>
          </Box>
        )}
        {live.map(card)}
        {done.length > 0 && (
          <Text color={INK.line} wrap="truncate-end">
            {'── '}
            <Text color={INK.faint}>finished</Text>
            {` ${'─'.repeat(Math.max(0, columns - 12))}`}
          </Text>
        )}
        {shownDone.map(past)}
        {done.length > 0 && (
          <Box justifyContent="space-between">
            <Text color={INK.faint}>
              {hidden > 0 ? `+${hidden} more` : ' '}
            </Text>
            <Button
              key="clear"
              plain
              dimColor
              onPress={() => {
                heard.clear()
                strangers.clear()
                enqueue($, 'finished not cleared', () =>
                  update($, agents, held => held.filter(isLive)),
                )
              }}
            >
              clear finished
            </Button>
          </Box>
        )}
      </Box>
    )
  })
}
