import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { AgentRow } from '../types'
import { accessOf, configFacts, tail } from './billing'
import type { Access, Signals } from './billing'
import { kindOf, outOf } from './infer'
import { BRIEF_MAX, cardsOf, EMPTY, isBusy as isNarrating, landed, planned, restarted } from './narrator'
import type { Ask, Reply } from './narrator'
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
  summarized,
  synced,
  woke,
} from './roster'
import type { Span, Tone } from './roster'
import {
  asked,
  began,
  called,
  dataFile,
  filed,
  finished,
  isSid,
  kept,
  minted,
  pageUrl,
  payload,
  RESULT_MAX,
  resulted,
} from './trail'
import type { Trails } from './trail'
import { notesOf } from './trouble'

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
/**
 * Every second tick the window's data is rewritten while an agent lives,
 * whatever changed: the beat its page tells a slow session from a lost one by.
 */
const BEAT_TICKS = 2
/** Where the page's source says the session's own name goes. */
const SID_TOKEN = '__AW_SID__'
/** The page's other files, laid beside it under their own names. */
const ASSETS = ['fonts.css', 'motion.js'] as const
/** The window the page opens in, as Edge's app mode takes it. */
const WINDOW_SIZE = '1280,840'
/** How the page's title starts: how the quiet opener finds its window. */
const WINDOW_TITLE = 'Agents'

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
// Each agent's calls are kept whether or not a window shows them: a window
// opened late still has the whole run.
const trails = atom({ plugin: 'agent-watch', key: 'trail' } as const, {}, {
  shape: 'trail-1',
})
const gui = atom({ plugin: 'agent-watch', key: 'gui' } as const, {
  sid: '',
  isOn: false,
})
// What the narrator wrote and what it has spent, kept across a reload so the
// session's budget holds.
const narration = atom({ plugin: 'agent-watch', key: 'narration' } as const, EMPTY, {
  shape: 'narration-1',
})
/** A model call that cost nothing: what a call the engine refused to send is counted as. */
const NO_COST = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
} as const

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
/** Where the session runs; its last folder names the project on the window's page. */
let cwd = ''
/**
 * The `gui` value as this copy last read or wrote it. While `isGuiOn` the
 * window's data file is rewritten at every change; while it is not, nothing
 * is written at all. `sid` is the name the page and its data go by.
 */
let isGuiOn = false
let sid = ''
/** The folder the window's files go under, once asked for. */
let home: string | undefined
/** True unless the options say no: the window opens as soon as two agents are at work. */
let isAutoOpen = false
/** True once this copy opened the window by itself: it does that once. */
let hasAutoOpened = false
/** True while a rewrite of the data file waits its turn: a burst of changes shares it. */
let isWriteQueued = false
/** Numbers the calls that carry no id of their own. */
let serial = 0
/**
 * True where the options leave the narrator on (the default). It writes only
 * while the window is fed: the pane has nowhere to show its words.
 */
let isNarratorOn = true
/** True while a narrator plan waits its turn: a burst of changes shares it. */
let isPlanQueued = false
/**
 * The money guard's answer for this session, looked up once at its start:
 * the narrator runs only on a plan that does not pay per call. Undefined
 * until it has looked, and the narrator waits until then.
 */
let access: Access | undefined

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
  const isSame = JSON.stringify(next) === JSON.stringify(list)
  const settled = isSame
    ? list
    : await update($, agents, held => pruned(synced(held, infos, now)))

  for (const row of settled) {
    heard.add(row.id)
    strangers.delete(row.id)
  }

  post($, settled)

  if (!isSame) {
    // A row the cap let go takes its trail with it, in the queue's own order.
    enqueue($, 'trail tidy', () => tidy($))
    changed($, settled)
  }

  return settled
}

/** Closes a pane the mod opened itself; the next agent opens it again. */
async function lower($: EngineInterface): Promise<void> {
  try {
    await $.ui.close({ id: PANE })
    // The mod's own close does not come back through its `ui.close` hook, and
    // the clock may go on for a window's beat: the pane is lowered only once.
    isPaneUp = false
  } catch (error) {
    debug($, 'pane not closed', error)
  }
}

async function tick($: EngineInterface, beat: number): Promise<void> {
  // Once nothing works the roster is left alone: the rows only fade. A window
  // that is fed still asks, so a teammate that idles is seen to leave.
  const list =
    (idleTicks === 0 || isGuiOn) && beat % SYNC_EVERY === 0
      ? await sync($)
      : await read($, agents)
  // While an agent lives the window's page gets a fresh beat, however little
  // changes: a beat that stands still means the session is gone, not slow.
  // A narrator with a call out or a moment waiting keeps it going too.
  const isBeating =
    isGuiOn && (list.some(isLive) || (isNarratorOn && isNarrating(await read($, narration))))

  if (isBeating && beat % BEAT_TICKS === 0) {
    refresh($)
  }

  // Health turns amber and red by the clock alone, and a moment waits out its
  // 20 s: the narrator looks again every tick the window is fed.
  narrate($)

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

  // Nothing works: stop asking until the next agent starts. Only the beat of
  // a fed window keeps the clock going, for as long as a teammate idles.
  if (!isBeating) {
    ticker?.cancel()
    ticker = undefined
    idleTicks = 0
  }

  if (isPaneUp && !isPinned) {
    await lower($)
  }
}

function watch($: EngineInterface): void {
  // The clock only steps the pulse, re-reads the roster for the pane and
  // keeps the beat of a window's data.
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

/**
 * Folds one event of a loop into its row, if the pane keeps one for it, and
 * into its trail where the event leaves a `trace` there.
 */
async function fold(
  $: EngineInterface,
  id: string,
  change: (list: readonly AgentRow[]) => AgentRow[],
  trace?: (held: Trails) => Trails,
): Promise<void> {
  if (!(await knows($, id))) {
    return
  }

  if (trace !== undefined) {
    await update($, trails, trace)
  }

  const rows = await update($, agents, change)

  post($, rows)
  watch($)
  changed($, rows)
}

/** Takes in an agent whose spawn just settled. */
async function admit(
  $: EngineInterface,
  row: AgentRow,
  isResume: boolean,
  ask: string,
): Promise<void> {
  strangers.delete(row.id)
  heard.add(row.id)

  const rows = await update($, agents, held =>
    pruned(spawned(held, row, isResume)),
  )

  // The pane first: the status line is posted only where no pane will show.
  await show($)
  post($, rows)
  await tidy($)

  // The brief, already masked and cut, for the narrator to say what the agent is fixing.
  if (isNarratorOn && ask !== '' && rows.some(one => one.id === row.id)) {
    await update($, trails, held => asked(held, row.id, ask))
  }

  changed($, rows)
}

async function view($: EngineInterface, row: AgentRow): Promise<void> {
  const moved = await $.ui.view({ agentId: row.id })

  if (moved.deny !== undefined) {
    $.ui.toast(`${row.type}: ${moved.deny}`)
  }
}

/** The call's own id, which its end is matched by; one with none is numbered from its start. */
function keyOf(input: Readonly<Record<string, unknown>>, startedAt: number): string {
  const id = input.tool_use_id

  if (typeof id === 'string' && id !== '') {
    return id
  }

  serial += 1

  return `${startedAt}-${serial}`
}

/**
 * What a tool call answered, as text: the refusal, the text the model read,
 * or a result that is a string. Only its opening is ever read.
 */
function answered(ran: { deny?: string; text?: string; result?: unknown }): string {
  if (typeof ran.deny === 'string') {
    return ran.deny
  }

  if (typeof ran.text === 'string') {
    return ran.text
  }

  return typeof ran.result === 'string' ? ran.result : ''
}

/**
 * Lets go of the trails of agents the rows no longer hold; writes only a
 * change. Run as a job of the queue, where rows and trails are added in
 * turn: a trail just begun is never taken for a dropped agent's.
 */
async function tidy($: EngineInterface): Promise<void> {
  const [rows, held] = await Promise.all([read($, agents), read($, trails)])
  const ids = rows.map(row => row.id)

  if (kept(held, ids) !== held) {
    await update($, trails, now => kept(now, ids))
  }
}

// --- The window: a page in a browser, fed by a data file --------------------
//
// The page is a local file and cannot talk to the mod. The mod lays it in
// `<home>/.claude/agent-watch` under a name of the session's own, writes the
// rows and their trails beside it, and the page reads that file again and
// again. Local only, and it only watches.

/** The folder the window's files go under: the profile on Windows, HOME elsewhere. */
async function homeOf($: EngineInterface): Promise<string | undefined> {
  home ??=
    (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || undefined

  return home
}

/** Writes the data file the page reads again: the rows and their trails as they stand. */
async function writeData($: EngineInterface): Promise<void> {
  const under = await homeOf($)

  if (under === undefined || sid === '') {
    throw new Error('the window has no folder or no name to write under')
  }

  const [rows, held, story] = await Promise.all([
    read($, agents),
    read($, trails),
    read($, narration),
  ])
  const now = clock()
  const data = {
    ...payload({ id: sid, cwd }, rows, held, now),
    cards: cardsOf(rows, held, story, now, isNarratorOn, access),
  }

  await $.fs.write(filed(under, `${sid}.js`), dataFile(data))
}

// --- The money guard: the narrator runs only on a plan, never per call -------
//
// Asked once per session start. The engine's own answer for the credential
// the session uses comes first; the environment and Claude Code's config file
// stand in when it gives none. A key is never kept: only the last 20 letters
// of each are compared, in memory, the way Claude Code itself knows them.

/** True for a switch that is on: set, and not `0`, `false`, `no` or `off`. */
const isSwitchOn = (value: string | undefined): boolean =>
  value !== undefined && value.trim() !== '' && !/^(?:0|false|no|off)$/i.test(value.trim())

/** The tail of a key in the environment, or nothing; the key itself goes no further. */
const keyTail = (value: string | undefined): string[] =>
  value === undefined || value.trim() === '' ? [] : [tail(value)]

/** Claude Code's config file, read whole and handed on as text; '' when it cannot be read. */
async function configText($: EngineInterface): Promise<string> {
  const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) || (await homeOf($))

  if (dir === undefined || dir === '') {
    return ''
  }

  const slash = dir.includes('\\') ? '\\' : '/'

  try {
    const text = await $.fs.read(`${dir.replace(/[\\/]+$/, '')}${slash}.claude.json`)

    return typeof text === 'string' ? text : ''
  } catch (error) {
    debug($, 'config file not read', error)

    return ''
  }
}

/** Gathers what tells how the session is signed in, and asks the guard. */
async function guard($: EngineInterface): Promise<Access> {
  let credential: Signals['credential']

  try {
    const held = await $.session.authorize()

    // Only the kind is kept; the handle is let go here.
    credential = held === null ? 'none' : held.kind === 'bearer' ? 'bearer' : 'api-key'
  } catch (error) {
    debug($, 'credential kind not answered', error)
  }

  const thirdParty = [
    await $.env.get('CLAUDE_CODE_USE_BEDROCK'),
    await $.env.get('CLAUDE_CODE_USE_VERTEX'),
    await $.env.get('CLAUDE_CODE_USE_FOUNDRY'),
  ].some(isSwitchOn)
  const envTails = [
    ...keyTail(await $.env.get('ANTHROPIC_API_KEY')),
    ...keyTail(await $.env.get('ANTHROPIC_AUTH_TOKEN')),
  ]
  const facts = configFacts(await configText($))
  const signals: Signals = { thirdParty, envTails, approved: facts.approved, hasLogin: facts.hasLogin }

  if (credential !== undefined) {
    signals.credential = credential
  }

  if (facts.planType !== undefined) {
    signals.planType = facts.planType
  }

  return accessOf(signals)
}

// --- The narrator: plain words for the cards, at the moments that matter -----
//
// Planned in the queue, where rows, trails and the narration change in turn;
// fired outside it, so no fold waits on a model; each answer folded back in
// through the queue. The rules in `narrator.ts` hold its budget.

/**
 * Asks for the narrator to look at the agents again, in its turn of the
 * queue: a burst of changes shares one look. Only while the window is fed
 * and the options leave it on.
 */
function narrate($: EngineInterface): void {
  if (!isNarratorOn || !isGuiOn || isPlanQueued || access?.isPaid !== false) {
    return
  }

  isPlanQueued = true
  enqueue($, 'narrator plan', async () => {
    isPlanQueued = false

    const [rows, held, story] = await Promise.all([
      read($, agents),
      read($, trails),
      read($, narration),
    ])
    const now = clock()
    const { narration: next, asks } = planned(story, rows, held, now)
    // The page is written again only when what it shows moved.
    const isShown =
      asks.length > 0 ||
      JSON.stringify(cardsOf(rows, held, next, now, true)) !==
        JSON.stringify(cardsOf(rows, held, story, now, true))

    if (JSON.stringify(next) !== JSON.stringify(story)) {
      await update($, narration, () => next)
    }

    for (const ask of asks) {
      speak($, ask)
    }

    if (isShown) {
      refresh($)
    }
  })
}

/** The engine's answer as the narrator reads it: a call it would not send is `refused`. */
function replyOf(result: unknown): Reply {
  const value = result as Partial<Reply> | undefined

  if (value?.isAnswered === true && typeof value.text === 'string') {
    return { isAnswered: true, text: value.text, usage: value.usage ?? NO_COST }
  }

  if (value?.isAnswered === false && typeof value.reason === 'string') {
    const reply: Reply = { isAnswered: false, reason: value.reason, usage: value.usage ?? NO_COST }

    if (typeof value.error === 'string') {
      reply.error = value.error
    }

    if (typeof value.status === 'number' || value.status === null) {
      reply.status = value.status
    }

    return reply
  }

  return { isAnswered: false, reason: 'empty-reply', usage: NO_COST }
}

/**
 * Makes one narrator call outside the queue, and folds its answer back in
 * through it: the cost counted, the card's words taken or the failure noted,
 * the page rewritten, and a freed slot offered to what waits.
 */
function speak($: EngineInterface, ask: Ask): void {
  $.model
    .complete(ask.request)
    .then(replyOf, (error: unknown): Reply => {
      debug($, 'narrator call not sent', error)

      return { isAnswered: false, reason: 'refused', usage: NO_COST }
    })
    .then(reply =>
      enqueue($, 'narrator answer', async () => {
        if (!reply.isAnswered) {
          debug($, 'narrator gave no words', `${reply.reason}${reply.error === undefined ? '' : ` ${reply.error}`}`)
        }

        await update($, narration, held => landed(held, ask, reply, clock()))
        refresh($)
        narrate($)
      }),
    )
    .catch((error: unknown) => debug($, 'narrator answer lost', error))
}

/**
 * Asks for the data file to be rewritten, in its turn of the queue: a burst
 * of changes shares one write, and no two writes overlap. With the window
 * off it does nothing.
 */
function refresh($: EngineInterface): void {
  if (!isGuiOn || isWriteQueued) {
    return
  }

  isWriteQueued = true
  enqueue($, 'window data', () => {
    // Cleared before the rows are read: a change from here on asks again.
    isWriteQueued = false

    return writeData($)
  })
}

/**
 * Copies one of the page's files out of the mod's own folder; `stamp`, the
 * session's name, is written into the page's source on the way. Says what
 * failed, or nothing.
 */
async function copy(
  $: EngineInterface,
  name: string,
  to: string,
  stamp?: string,
): Promise<string | undefined> {
  let text: string

  try {
    text = await $.fs.read(`${$.plugin.root}/gui/${name}`)
  } catch (error) {
    debug($, `gui/${name} not read`, error)

    return `the mod's gui/${name} could not be read`
  }

  try {
    // Split and joined, never `replace` with a string: a page may hold `$&`.
    await $.fs.write(
      to,
      stamp === undefined ? text : text.split(SID_TOKEN).join(stamp),
    )
  } catch (error) {
    debug($, `${to} not written`, error)

    return `${to} could not be written`
  }

  return undefined
}

/** How a launch went: a browser took the page, none was asked for, or why none did. */
type Launch = { isLaunched: boolean; problem?: string }

/**
 * Opens the page in a window of its own: Edge's app mode on Windows, the
 * desktop's own opener elsewhere, as far as that goes. A session with no
 * screen and `AGENT_WATCH_BROWSER=none` open nothing.
 *
 * `isQuiet` (the window opening by itself) goes through the mod's
 * `gui/open-window.ps1` on Windows: it opens the same window, hands the
 * keyboard back to whatever window had it, and lifts the new one into sight.
 * Should that fail, the window opens the plain way.
 */
async function launch($: EngineInterface, url: string, isQuiet: boolean): Promise<Launch> {
  if (!hasScreen || (await $.env.get('AGENT_WATCH_BROWSER')) === 'none') {
    return { isLaunched: false }
  }

  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const plain = ['cmd', '/c', 'start', '', 'msedge', `--app=${url}`, `--window-size=${WINDOW_SIZE}`]
  const quiet = [
    'powershell',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-WindowStyle',
    'Hidden',
    '-File',
    `${$.plugin.root}/gui/open-window.ps1`,
    '-Url',
    url,
    '-Size',
    WINDOW_SIZE,
    '-Title',
    WINDOW_TITLE,
  ]
  const openers: readonly (readonly string[])[] = isWindows
    ? isQuiet
      ? [quiet, plain]
      : [plain]
    : [
        ['xdg-open', url],
        ['open', url],
      ]

  for (const argv of openers) {
    const [opener = 'opener'] = argv

    try {
      const ran = await $.process.run(argv)

      if (ran.exitCode === 0) {
        return { isLaunched: true }
      }

      debug(
        $,
        `${opener} opened no window`,
        `exit code ${ran.exitCode}: ${brief(ran.stderr, 160)}`,
      )
    } catch (error) {
      debug($, `${opener} not started`, error)
    }
  }

  return {
    isLaunched: false,
    problem: 'no browser could be started, so open the page by hand',
  }
}

/** What opening the window came to. */
type Opened = {
  /** The command's answer: how it went, where the page is, what failed. */
  text: string
  /** What failed, each in a few words; empty when all went well. */
  problems: string[]
}

const unopened = (why: string): Opened => ({
  text: `Agents window not opened: ${why}.`,
  problems: [why],
})

/** A problem as a line of the answer: `its data…` reads `Its data….` */
const sentence = (words: string): string =>
  `${words.charAt(0).toUpperCase()}${words.slice(1)}.`

/** Lays the page's other files beside it; says which could not be laid. */
async function layAssets($: EngineInterface, under: string): Promise<string[]> {
  const problems: string[] = []

  for (const asset of ASSETS) {
    const problem = await copy($, asset, filed(under, asset))

    if (problem !== undefined) {
      problems.push(problem)
    }
  }

  return problems
}

/**
 * The page's first data, written in its turn of the queue like every write
 * after it. False when it could not be written; the debug log says why.
 */
async function writeFirst($: EngineInterface): Promise<boolean> {
  let isWritten = false as boolean

  await enqueue($, 'window data', async () => {
    await writeData($)
    isWritten = true
  })

  return isWritten
}

/**
 * Lays the page and its data in `<home>/.claude/agent-watch` and opens the
 * page in a window; from then on every change is written for it. Nothing
 * here throws: what failed is logged, and said in the answer.
 *
 * Never awaited from a job of the queue: its first write waits its turn there.
 */
async function openWindow($: EngineInterface, isQuiet = false): Promise<Opened> {
  const under = await homeOf($)

  if (under === undefined) {
    debug($, 'window not opened', 'neither USERPROFILE nor HOME is set')

    return unopened('no home folder is set (USERPROFILE or HOME)')
  }

  // Made once, and before the first wait: a window asked for again, or twice
  // at the same moment, reads the same files.
  if (sid === '') {
    sid = minted(clock(), Math.random)
  }

  const name = sid
  const page = filed(under, `${name}.html`)
  const unlaid = await copy($, 'index.html', page, name)

  // With no page there is nothing to feed: the window stays off.
  if (unlaid !== undefined) {
    return unopened(unlaid)
  }

  const problems = await layAssets($, under)

  isGuiOn = true
  // Kept, so a reload feeds the same page; a store that fails costs only that.
  await update($, gui, () => ({ sid: name, isOn: true })).catch((error: unknown) =>
    debug($, 'window not kept', error),
  )

  if (!(await writeFirst($))) {
    problems.push('its data file could not be written')
  }

  const { isLaunched, problem } = await launch($, pageUrl(page), isQuiet)

  if (problem !== undefined) {
    problems.push(problem)
  }

  const lines = [
    isLaunched ? 'Agents window opened.' : 'Agents window ready.',
    // Said with forward slashes: the answer is drawn as markdown, where a
    // backslash before `.claude` is an escape and would vanish from the path.
    page.split('\\').join('/'),
    ...problems.map(sentence),
  ]

  return { text: lines.join('\n'), problems }
}

/**
 * Opens the window by itself the first time two agents are at work, where
 * the options ask for it. Not waited on: this is called from the queue.
 */
function autoOpen($: EngineInterface, rows: readonly AgentRow[]): void {
  if (
    !isAutoOpen ||
    hasAutoOpened ||
    isGuiOn ||
    rows.filter(isLive).length < 2
  ) {
    return
  }

  hasAutoOpened = true
  // Nobody asked for it at this moment: it must not take the keyboard.
  openWindow($, true)
    .then(opened => {
      // Nobody asked, so nobody reads an answer: what failed is said in a toast.
      const [problem] = opened.problems

      if (problem !== undefined) {
        $.ui.toast(`Agents window: ${problem}`)
      }
    })
    .catch((error: unknown) => debug($, 'window not opened', error))
}

/** After the rows or the trails changed: the window opens if it is time, and its data is rewritten. */
function changed($: EngineInterface, rows: readonly AgentRow[]): void {
  autoOpen($, rows)
  // The narrator looks before the write, so a moment it takes is in it.
  narrate($)
  refresh($)
}

export const register: Register = (on, options) => {
  // On unless the options switch it off (the owner's call, 2026-11-16).
  isAutoOpen = options.autoOpenWindow !== false
  isNarratorOn = options.narrator !== false

  on('session.start', async ($, e, next) => {
    isOff =
      (await $.env.get('DELTAO_NESTED_CLI')) === '1' &&
      (await $.env.get('AGENT_WATCH')) !== 'on'
    hasScreen = e.isInteractive
    cwd = e.cwd

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
      // Once per session start: may the narrator run here, at no cost per call?
      access = await guard($)

      // A window opened before the reload is still fed, under the same name.
      const stored = await read($, gui)

      sid = isSid(stored.sid) ? stored.sid : ''
      isGuiOn = stored.isOn === true && sid !== ''
      // Calls out before a reload are gone with it: their slots are freed and
      // their moments asked again. A store that fails costs only that.
      await update($, narration, restarted).catch((error: unknown) =>
        debug($, 'narration not restarted', error),
      )

      const list = await sync($)

      if (list.some(isLive)) {
        await show($)
      }

      changed($, list)
    })

    return next(e)
  })

  on('command.run', { command: 'agent-watch' }, async ($, e, next) => {
    if (isOff) {
      return next(e)
    }

    // `/agent-watch gui` opens the window in a browser; the pane is left alone.
    if (e.args.trim().startsWith('gui')) {
      // What was heard so far is folded before the page's first data is written.
      await queue
      await sync($)

      return { text: (await openWindow($)).text }
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
      // Masked and cut here: only that ever reaches the narrator.
      const ask = isNarratorOn ? brief(e.prompt ?? '', BRIEF_MAX) : ''

      grace = GRACE
      enqueue($, 'spawn', () => admit($, row, isResume, ask))
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
    const kind = kindOf(e.tool, input)
    // The step it is and any risky change, judged here: the full path stays in this hook.
    const call = called(keyOf(input, startedAt), activity, startedAt, kind, notesOf(e.tool, input, kind, cwd))
    // Failed, until the call comes back with an answer that is no error and no refusal.
    let isFailed = true
    // The opening of what it answered, masked: for the narrator alone.
    let out = ''

    grace = GRACE
    enqueue($, 'tool call', () =>
      fold(
        $,
        id,
        held => acted(held, id, activity, startedAt, isCounted),
        held => began(held, id, call),
      ),
    )

    try {
      const ran = await next(e)

      isFailed = ran.deny !== undefined || ran.isError === true
      out = isNarratorOn ? outOf(answered(ran)) : ''

      return ran
    } finally {
      // However the call ended, it is no longer in flight.
      const endedAt = clock()

      enqueue($, 'tool return', () =>
        fold(
          $,
          id,
          held => rested(held, id, endedAt),
          held => finished(held, id, call.key, endedAt, isFailed, out),
        ),
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
      enqueue($, 'turn end', () => {
        // The window has room for more of the answer than a row does.
        const result = summarized(ending.answer, RESULT_MAX)

        return fold(
          $,
          id,
          held => ended(held, id, ending, now),
          held => resulted(held, id, result),
        )
      })
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
        <Box flexDirection="column">
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
