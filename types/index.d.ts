/** Where an agent's loop stands, as the engine's roster spells it. */
export type AgentState =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'idle'
  | 'completed'
  | 'failed'
  | 'killed'

/** One agent of the session as the pane shows it. */
export type AgentRow = {
  id: string
  /** The agent type it was spawned as; `engine` for a loop no roster names. */
  type: string
  /** The few words the spawning call described the task in. */
  description: string
  state: AgentState
  /** True once the roster named it: only then does its absence there mean it ended. */
  isListed: boolean
  /** A teammate goes idle between turns where any other agent is finished. */
  isTeammate: boolean
  parentId?: string
  name?: string
  startedAt: number
  /** When the mod last heard anything from it. */
  seenAt: number
  endedAt?: number
  /** The tool call it is on, or was last on, as a person says it; already redacted. */
  activity?: string
  /** How many of its tool calls are in flight; an agent may run several at once. */
  inFlight: number
  /** Its tool calls so far, the engine's own bookkeeping calls left out. */
  tools: number
  /** Fresh tokens its finished turns read and wrote, cache re-reads left out. */
  tokens: number
  /** Its final answer as one line of about 80 letters: folder paths cut, already redacted. */
  answer?: string
}

/**
 * The kind of work a call is: what the card's icon shows. `wait` is the
 * page's own word for an agent gone slow or stuck, and no call is one.
 */
export type Kind = 'read' | 'search' | 'edit' | 'test' | 'run' | 'write'

/** Where an agent is in its job; it can go back a stage. */
export type Stage = 'looking' | 'changing' | 'checking' | 'reporting'

/** How an agent is doing: green, amber, red, resting, or over. */
export type Health = 'working' | 'slow' | 'stuck' | 'idle' | 'done'

/** One tool call of an agent, as its trail keeps it; the words are already redacted. */
export type Call = {
  /** The call's own id: what its end is matched to. */
  key: string
  /** The call while it runs, as a person says it: `Reading notes.txt`. */
  doing: string
  /** The same call once it is over: `Read notes.txt`. */
  did: string
  /** When it started. */
  at: number
  /** When it came back; absent while it is in flight. */
  end?: number
  /** Set when it threw, answered an error or was refused. */
  isFailed?: true
  /** The kind of work it is; absent for bookkeeping, which keeps the kind there was. */
  kind?: Kind
  /**
   * The opening of what it answered, cut and masked: for the narrator alone,
   * never written to the page's data.
   */
  out?: string
}

/** What one agent did, call by call, and the longer result it ended with. */
export type Trail = {
  /** Its newest calls, oldest first, at most 200. */
  calls: Call[]
  /** How many older calls were let go to hold that cap. */
  dropped: number
  /** Its answer in about 600 letters: folder paths cut, already redacted. */
  result?: string
  /** The brief it was started with, cut and masked: for the narrator alone. */
  ask?: string
}

/** A moment the narrator writes at. */
export type Moment = 'start' | 'stage' | 'kind' | 'stuck' | 'recover' | 'finish'

/** What the narrator wrote for one agent, cleaned and capped, and when it landed. */
export type Told = {
  /** What it is trying to fix or answer; written once, at the start. */
  what?: string
  /** What it is doing right now, in plain words. */
  now: string
  /** What it has found or changed so far. */
  found?: string
  /** How it is going about it; once it is over, its result. */
  how: string
  /** What it will most likely do next; once over, what is left for the person. */
  next?: string
  at: number
}

/** What the narrator last took note of for an agent: a change in it is a moment. */
export type Seen = { stage: Stage; kind?: Kind; health: Health }

/** One agent's narration: what was written, what was seen, what waits to be asked. */
export type Story = {
  seen: Seen
  told?: Told
  /** The moment waiting for its turn under the budget. */
  pending?: Moment
  /** The moment a call is out for now. */
  asking?: Moment
  /** When the last call for this agent went out. */
  askedAt?: number
  /** Why the last call gave nothing usable, in plain words; the rules show meanwhile. */
  failed?: string
  /** Set for an agent already over when first seen: it is never narrated. */
  isOwn?: true
}

/** The narrator's account for the session: its calls, its cost, and the team sentence. */
export type Ledger = {
  /** Calls started this session, failed ones included. */
  calls: number
  inFlight: number
  failed: number
  /** Failures since the last call that worked. */
  inARow: number
  tokensIn: number
  tokensOut: number
  cacheRead: number
  cacheWrite: number
  /** Why the narrator stopped for the session (its budget, or a refusal that will not clear). */
  halt?: string
  team?: { text: string; at: number }
  teamPending?: true
  /** When the last moment worth a team sentence came. */
  teamEventAt?: number
  /** When the last team call went out. */
  teamAt?: number
  isTeamAsking?: true
}

/** The narrator's whole state: a story per agent, and the ledger. */
export type Narration = { stories: Record<string, Story>; ledger: Ledger }

/** One agent's card as the page draws it. */
export type Card = {
  stage: Stage
  kind?: Kind
  /** When the agent last took a step: the page times its health light from here. */
  quietSince: number
  /** The rules-only words: what it does now, and its last step or its answer. */
  plain: { now: string; found: string }
  told?: Told
  /**
   * Which words the card shows: the narrator's (`told`), the narrator's last
   * while it writes an update (`writing`), the rules (`plain`, with `why`), or
   * for an agent over before the narrator saw it, its own answer (`own`).
   */
  mode: 'told' | 'writing' | 'plain' | 'own'
  why?: string
}

/** Everything the cards need beyond the rows: written beside `agents` in the data file. */
export type Cards = {
  narrator: {
    state: 'on' | 'off' | 'halted'
    why?: string
    model: string
    calls: number
    limit: number
    inFlight: number
    failed: number
    tokensIn: number
    tokensOut: number
    cacheRead: number
    cacheWrite: number
  }
  limits: { slowMs: number; stuckMs: number }
  team?: { text: string; at: number }
  agents: Record<string, Card>
}

/**
 * What the window's page reads: the data file's one value. The page is a
 * local file and cannot ask the mod anything, so all it shows is in here.
 */
export type Payload = {
  v: 1
  session: {
    /** The name the mod gave this session's page and data file. */
    id: string
    /** The last folder of the session's working directory. */
    project: string
    /** When the first agent started; when written, where there is none. */
    startedAt: number
  }
  /** When this was written: a page that sees it stand still has lost the session. */
  beatAt: number
  /** The agents in the order the pane lists them. */
  agents: Array<{
    id: string
    /** The agent's type said short: `General`, `Explore`. */
    type: string
    task: string
    state: AgentState
    /** How deep under its parents it sits; 0 for one the main loop started. */
    depth: number
    startedAt: number
    endedAt?: number
    seenAt: number
    tools: number
    tokens: number
    /** Its answer as one line of about 80 letters. */
    summary?: string
    /** Its answer in about 600 letters, while that answer stands. */
    result?: string
    dropped: number
    calls: Call[]
  }>
  /** The cards' words and the narrator's account; absent from an older mod. */
  cards?: Cards
}

declare module 'claude-code' {
  interface PluginState {
    'agent-watch': {
      agents: Shaped<AgentRow[]>
      isDismissed: boolean
      /** Each agent's trail, by the agent's id. */
      trail: Shaped<Record<string, Trail>>
      /** The window's page: the name its files go by, and whether it is fed. */
      gui: { sid: string; isOn: boolean }
      /** The narrator's stories and its account for the session. */
      narration: Shaped<Narration>
    }
  }
}
