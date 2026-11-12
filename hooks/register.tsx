import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { AgentRow } from '../types'
import {
  acted,
  born,
  brief,
  describeCall,
  drawn,
  ended,
  isBookkeeping,
  isBusy,
  isLive,
  pruned,
  report,
  rested,
  spawned,
  statusText,
  synced,
  woke,
} from './roster'
import type { Span, Tone } from './roster'

const NAME = 'agent-watch'
const PANE = 'agent-watch'
const TITLE = 'Agents'
const SNAPSHOT = 'mcp__agent-watch__snapshot'
/** One step of the pulse: the pane redraws at this pace while an agent works. */
const FRAME_MS = 500
/** Every second frame is a tick: the rows are read, and the clocks may stop. */
const FRAMES_PER_TICK = 2
/** Every third tick also asks the engine's roster where each agent stands. */
const SYNC_EVERY = 3
/**
 * Ticks (seconds) a pane nobody asked for stays once nothing works, so the
 * results can be read; then it closes by itself.
 */
const LINGER_TICKS = 15
/** Ticks a pane the person asked for keeps redrawing, until each result line has closed. */
const SETTLE_TICKS = 34

// The DeltaO.ai palette (DESIGN.md): a near-void canvas and warm off-white
// text in three strengths. Order is weight and brightness; the one accent,
// emerald, marks an agent at work and nothing else.
const INK = {
  canvas: '#08090a',
  text: '#EDEDEC',
  soft: '#A1A1A6',
  faint: '#6B6B73',
  emerald: '#0D9668',
} as const
/**
 * One calm breath, shared by every working agent's mark: emerald at full,
 * 65% and 40% over the canvas and back, a step each frame.
 */
const PULSE = [INK.emerald, '#0B6547', '#0A4130', '#0B6547'] as const
const TONES: Record<Exclude<Tone, 'pulse'>, { color: string; isBold: boolean }> = {
  strong: { color: INK.text, isBold: true },
  bright: { color: INK.text, isBold: false },
  soft: { color: INK.soft, isBold: false },
  faint: { color: INK.faint, isBold: false },
}
/**
 * The pane is its own dark panel, so its colors hold on any terminal theme.
 * Docked it asks for the width one aligned row needs; inline, for the rows of
 * ten agents and a header, and the frame fits what is drawn.
 */
const PANE_LOOK = { rows: 12, columns: 76, backgroundColor: INK.canvas } as const

// Change the tag when a row's fields change: it declines what an earlier
// version stored, which outlives a reload.
const agents = atom({ plugin: 'agent-watch', key: 'agents' } as const, [], {
  shape: 'agents-2',
})
const isDismissed = atom(
  { plugin: 'agent-watch', key: 'isDismissed' } as const,
  false,
)

const clock = (): number => Date.now()

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
/**
 * True once the person asked for the pane (`/agent-watch`): it then stays
 * until they close it. One the mod opened on its own closes itself when the
 * work is done.
 */
let isPinned = false
let ticker: Timer | undefined
let isTicking = false
let grace = 0
/** Ticks in a row with nothing at work; the pane steps aside at LINGER_TICKS. */
let idleTicks = 0
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

/** Closes a pane the mod opened itself; the next agent opens it again. */
async function lower($: EngineInterface): Promise<void> {
  try {
    await $.ui.close({ id: PANE })
  } catch (error) {
    debug($, 'pane not closed', error)
  }
}

async function tick($: EngineInterface, beat: number): Promise<void> {
  // Once nothing works the roster is left alone: the rows only fade.
  const list =
    idleTicks === 0 && beat % SYNC_EVERY === 0
      ? await sync($)
      : await read($, agents)

  if (list.some(isBusy)) {
    idleTicks = 0
    $.ui.invalidate('ui.render')

    return
  }

  // An event may have landed after that read: give it its ticks first.
  if (grace > 0) {
    grace -= 1

    return
  }

  idleTicks += 1

  if (idleTicks === 1) {
    post($, list)
  }

  // The results stay a moment to be read, each closing to one line; a pane
  // the person asked for stays after that, one the mod opened steps aside.
  if (isPaneUp && idleTicks < (isPinned ? SETTLE_TICKS : LINGER_TICKS)) {
    $.ui.invalidate('ui.render')

    return
  }

  // Nothing works: stop asking until the next agent starts.
  ticker?.cancel()
  ticker = undefined
  idleTicks = 0

  if (isPaneUp && !isPinned) {
    await lower($)
  }
}

function watch($: EngineInterface): void {
  // The clock only steps the pulse and re-reads the roster for the pane.
  if (!hasScreen || ticker !== undefined) {
    return
  }

  let frame = 0

  ticker = $.clock.every(FRAME_MS, () => {
    frame += 1

    // Between ticks only the pulse steps: a redraw, with nothing read.
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

    if (hasScreen) {
      // Asked for, the pane stays until the person closes it.
      isPinned = true
      idleTicks = 0
      await raise($)
      // The clock runs on a little even with nothing at work, so a result
      // line that has been read closes on time.
      watch($)
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
      isPinned = false

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
    const isCounted = !isBookkeeping(e.tool)
    const startedAt = clock()

    grace = GRACE
    enqueue($, 'tool call', () =>
      fold($, id, held => acted(held, id, activity, startedAt, isCounted)),
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
    const isDocked = e.props.placement === 'dock'
    // Docked, the body runs edge to edge: a column is kept clear each side.
    const gutter = isDocked ? 1 : 0
    const drawing = drawn(list, now, {
      columns: e.props.bodyColumns - gutter * 2,
      rows: e.props.scroll.bodyRows,
      isDocked,
      isPinned,
    })
    // Every working agent's mark takes the same step of the same breath.
    const breath = PULSE[Math.floor(now / FRAME_MS) % PULSE.length] ?? INK.emerald

    const paint = (span: Span) =>
      span.tone === 'pulse' ? (
        <Text color={breath}>{span.text}</Text>
      ) : TONES[span.tone].isBold ? (
        <Text color={TONES[span.tone].color} weight="bold">
          {span.text}
        </Text>
      ) : (
        <Text color={TONES[span.tone].color}>{span.text}</Text>
      )

    const open = (id: string) => (): void => {
      const row = list.find(one => one.id === id)

      if (row !== undefined) {
        view($, row).catch((error: unknown) => debug($, 'view not moved', error))
      }
    }

    return (
      <Box flexDirection="column" paddingX={gutter}>
        <Text wrap="truncate-end">{drawing.head.map(paint)}</Text>
        <Box flexDirection="column" marginTop={isDocked ? 1 : 0}>
          {drawing.lines.map(line =>
            line.id === undefined ? (
              <Text wrap="truncate-end">{line.spans.map(paint)}</Text>
            ) : (
              <Button key={`agent:${line.id}`} plain onPress={open(line.id)}>
                {line.spans.map(paint)}
              </Button>
            ),
          )}
        </Box>
      </Box>
    )
  })
}
