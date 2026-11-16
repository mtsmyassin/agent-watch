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
    }
  }
}
