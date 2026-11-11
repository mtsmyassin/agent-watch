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
  /** The tool call it is on, or was last on, already redacted. */
  activity?: string
  /** How many of its tool calls are in flight; an agent may run several at once. */
  inFlight: number
  tools: number
  /** When its latest tool calls began, oldest first: the activity strip's data. */
  calls?: number[]
  /** Fresh tokens its finished turns read and wrote, cache re-reads left out. */
  tokens: number
  /** The opening of its final answer, already redacted. */
  answer?: string
}

declare module 'claude-code' {
  interface PluginState {
    'agent-watch': { agents: Shaped<AgentRow[]>; isDismissed: boolean }
  }
}
