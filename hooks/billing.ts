// The money guard, with no engine in it: the narrator runs only where the
// session does not pay per call (a claude.ai plan such as Max). Every function
// here is pure; the mod gathers the signals once per session start.
//
// A key is never kept: the mod hands in only the last 20 letters of each key
// in the environment, which is how Claude Code itself remembers which keys the
// person approved or rejected. Nothing here prints, stores or sends them.

/** How many of a key's last letters Claude Code keeps to know it again. */
export const KEY_TAIL = 20

/** The footer's words when the session pays per call. */
export const PAID_WHY = 'Narrator off: this session pays per call. It runs only on your Max plan.'

/** Whether the narrator may run: on a plan (named), or not, because the session pays per call. */
export type Access = { isPaid: false; plan: string } | { isPaid: true; why: string }

/** What the mod could find out about how the session is signed in. */
export type Signals = {
  /**
   * The engine's own answer for the credential the session uses: `bearer` (a
   * claude.ai login), `api-key`, or `none` (a cloud provider, a gateway, or
   * no login). Absent when the engine gave no answer.
   */
  credential?: 'bearer' | 'api-key' | 'none'
  /** True when a Bedrock, Vertex or Foundry switch is on: those bill per call. */
  thirdParty: boolean
  /** The last 20 letters of each API key or auth token in the environment. */
  envTails: readonly string[]
  /** The key tails the person approved for Claude Code (`customApiKeyResponses.approved`). */
  approved: readonly string[]
  /** The login's plan as the config file names it (`claude_max`), when it does. */
  planType?: string
  /** True when the config file holds a claude.ai login. */
  hasLogin: boolean
}

/** A key's last 20 letters, the way Claude Code keeps it. */
export const tail = (key: string): string => key.trim().slice(-KEY_TAIL)

const PLANS: Readonly<Record<string, string>> = {
  claude_max: 'Max plan',
  claude_pro: 'Pro plan',
  claude_team: 'Team plan',
  claude_enterprise: 'Enterprise plan',
}

/** A plan as a person names it: `claude_max` is `Max plan`. */
export const planName = (type: string | undefined): string =>
  type !== undefined && Object.prototype.hasOwnProperty.call(PLANS, type) ? (PLANS[type] as string) : 'Claude plan'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The two facts the guard needs from Claude Code's config file, and nothing
 * else of it: the key tails the person approved, and the login with its plan.
 * A file missing, torn or of another shape gives nothing to go on.
 */
export function configFacts(text: string): { approved: string[]; planType?: string; hasLogin: boolean } {
  let value: unknown

  try {
    value = JSON.parse(text)
  } catch {
    return { approved: [], hasLogin: false }
  }

  if (!isRecord(value)) {
    return { approved: [], hasLogin: false }
  }

  const responses = value.customApiKeyResponses
  const approved = isRecord(responses) && Array.isArray(responses.approved)
    ? responses.approved.filter((one): one is string => typeof one === 'string' && one !== '')
    : []
  const login = value.oauthAccount

  if (!isRecord(login)) {
    return { approved, hasLogin: false }
  }

  return typeof login.organizationType === 'string'
    ? { approved, planType: login.organizationType, hasLogin: true }
    : { approved, hasLogin: true }
}

/**
 * Whether the narrator may run, decided as Claude Code decides how it signs
 * in. A cloud provider pays per call. The engine's own answer comes next: a
 * claude.ai login runs, a key or no first-party credential pays. With no
 * answer, the config file decides: a key in the environment is in use only
 * when the person approved it (its tail is listed), and otherwise a claude.ai
 * login runs. Where nothing says the session is on a plan, it is treated as
 * paying: the narrator then stays off rather than cost money.
 */
export function accessOf(signals: Signals): Access {
  const paid: Access = { isPaid: true, why: PAID_WHY }
  const isKeyInUse = signals.envTails.some(one => one !== '' && signals.approved.includes(one))
  const plan: Access = { isPaid: false, plan: planName(signals.planType) }

  if (signals.thirdParty || isKeyInUse) {
    return paid
  }

  if (signals.credential !== undefined) {
    return signals.credential === 'bearer' ? plan : paid
  }

  return signals.hasLogin ? plan : paid
}
