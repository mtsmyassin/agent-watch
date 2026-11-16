# Narrator cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the agents window's timeline with plain-words cards, written by a small Haiku narrator at the
moments that matter, with a rules-only fallback, a visible cost line, and the timeline kept as a second tab.

**Architecture:** All inference (kind of work, stage, health, narrator triggers, budget, prompt building, JSON
parsing and cleaning, the card data) lives in two pure files, `hooks/infer.ts` and `hooks/narrator.ts`, tested as
plain logic like `roster.ts`. `register.tsx` only wires them: it plans narrator calls inside its event queue,
fires `$.model.complete` outside the queue, folds each answer back in through the queue, and adds a `cards` value
to the data file. The page (`gui/index.html`, one file, no build, no network) draws cards from that value and
computes only live clocks and health colour from the numbers the mod wrote.

**Tech Stack:** Claude Code function-hooks plugin API 2.1.325 (TypeScript, `claude-code/testing`), plain
HTML/CSS/JS with the vendored Motion 14.12.0, Python + Playwright gui-sim harness (outside the repo).

**Spec:** `docs/superpowers/specs/2026-11-16-narrator-cards-design.md` (authoritative).

## Global Constraints

- Window: one HTML file, no server, no network; it polls the data file 4x/s; it cannot call anything on hover.
- Narrator model `claude-haiku-5-5`, `maxTokens` 220, `timeoutMs` 15000.
- Budget: one call per agent per 20 s; at most 2 calls in flight; at most 80 calls per session, then rules only and
  the footer says so. Team sentence: at most one call per 30 s, only when an agent starts, finishes, turns stuck or
  recovers.
- Health: amber after 60 s with no new step, red after 120 s; a tool call still in flight counts as quiet.
- Stages: Read/Grep/Glob/WebFetch/WebSearch/LS = looking; Edit/Write/MultiEdit/NotebookEdit = changing; Bash or
  PowerShell running tests/checks = checking; other Bash keeps the stage; final answer / SubagentHandback =
  reporting. Stages can go back.
- Kinds: read, search, edit, test, run, write, wait (wait = slow or stuck, display only).
- Output JSON `{now, found, what?, how, next}`; anything else is discarded and A stays. Strip control characters,
  cap each field at 200 characters, render with `textContent` only.
- Only already-masked text reaches a prompt or the data file (`brief`/`redact`/`unpathed` from `roster.ts`).
- `userConfig` option `narrator`, boolean, default true; off = A only, no model calls.
- Nested worker (`DELTAO_NESTED_CLI=1` without `AGENT_WATCH=on`): the mod, and so the narrator, does nothing.
- DESIGN.md colours: canvas #08090a, text #EDEDEC / #A1A1A6, crimson #E5383B, amber #D4943A, emerald #0D9668,
  2 px radius; small text uses #A1A1A6 (tertiary fails AA). WCAG 2 AA, axe 0 violations.
- One shared motion rhythm, `prefers-reduced-motion` honoured, no per-card spinners; FLIP moves are transform only.
- No new runtime dependencies. The 77 existing tests stay green.

## Review Focus

1. The model wraps its JSON in a fence or a sentence, or adds keys: still read; a reply with no `now`/`how` is
   discarded. Test in Task 3 (`a reply in a fence or with prose around it is still read`).
2. An agent is dropped from the rows (the 40-row cap) while its call is in flight: the answer lands without error,
   counts its tokens and brings no card back. Test in Task 3 (`an answer for an agent that is gone only counts its
   cost`).
3. The window opens after some agents already finished: no calls are spent on them; their card reads from their
   own answer. Test in Task 3 (`agents already finished when first seen are never narrated`).
4. The module reloads while calls are in flight: the in-flight count must not stay at 2 forever. Test in Task 3
   (`a reload frees the in-flight slots and asks again`).
5. The page meets data with no `cards` value (an older mod, a torn read): it draws rules-only cards. Checked in
   Task 5 by the gui-sim `cards.py --bare` run.

---

### Task 1: Inference of kind, stage, health and the rules-only text

**Files:**
- Create: `hooks/infer.ts`
- Modify: `types/index.d.ts` (add `Kind`, `Stage`, `Health`; `Call.kind?: Kind`)
- Test: `tests/narrator.test.tsx`

**Interfaces:**
- Consumes: `doing`, `brief`, `unpathed`, `isLive` from `roster.ts`.
- Produces:
  - `SLOW_MS = 60_000`, `STUCK_MS = 120_000`, `LONG_CALL_MS = 8_000`
  - `kindOf(tool: string, input: Readonly<Record<string, unknown>>): Kind | undefined` (undefined = keeps the
    current kind and stage: TodoWrite, Agent, Skill, ToolSearch-like bookkeeping)
  - `stageOf(calls: readonly Call[], isOver: boolean): Stage` (starts `looking`; over = `reporting`)
  - `steadyKind(calls: readonly Call[], now: number): Kind | undefined` (the last kinded call's kind when the
    last two kinded calls agree, or it is the only one, or it has been in flight 8 s or more)
  - `kindNow(calls: readonly Call[]): Kind | undefined` (in-flight call's kind, else the last kinded call's)
  - `healthOf(row: AgentRow, now: number): Health` (`done` when not live, `idle` for an idle teammate, else from
    `now - row.seenAt` against SLOW_MS / STUCK_MS)
  - `plainOf(row: AgentRow, trail: Trail | undefined, now: number): { now: string; found: string }`
  - `outOf(text: string): string` (`brief(unpathed(text.slice(0, 600)), 140)`)

- [ ] **Step 1: Write the failing tests** in `tests/narrator.test.tsx`:
  `tool calls are sorted into kinds of work` (Read->read, Grep/Glob/WebSearch->search, Edit/Write->edit,
  `pytest -x`/`npm test`/`ruff check .`/`tsc -p .`/`claude plugin test .`->test, `ls`->run,
  SubagentHandback->write, TodoWrite->undefined, `mcp__x__read_page`->read, `mcp__x__click`->run);
  `the stage follows the work and can go back` (read, edit, test, run, edit -> changing; over -> reporting; no
  calls -> looking); `a kind counts once it holds` (read, search -> undefined; read, search, search -> search;
  one search in flight 9 s after a read -> search); `health turns amber at 60 s and red at 120 s, a call in flight
  included`; `the rules-only text is the pane's own wording`.
- [ ] **Step 2: Run** `claude plugin test .` and see the new file fail (module missing).
- [ ] **Step 3: Implement `hooks/infer.ts`** and the type additions. The checks regex covers pytest, unittest,
  tox, nox, jest, vitest, mocha, playwright test, phpunit, rspec, ruff, mypy, pyright, flake8, pylint, eslint, tsc,
  biome, prettier/black `--check`, `go test|vet`, `cargo test|check|clippy`, `dotnet test`, gradle/mvn test,
  `make test|check|lint`, `npm|pnpm|yarn|bun (run) test|lint|typecheck|check`, `claude plugin test|validate`,
  pre-commit, shellcheck.
- [ ] **Step 4: Run** `claude plugin test .`: all pass.
- [ ] **Step 5: Commit** `Infer kind, stage and health from an agent's calls`.

### Task 2: The trail keeps each call's kind, its short result and the agent's brief

**Files:**
- Modify: `hooks/trail.ts`, `types/index.d.ts` (`Call.out?: string`, `Trail.ask?: string`)
- Test: `tests/narrator.test.tsx`

**Interfaces:**
- Produces: `called(key, doing, at, kind?: Kind): Call`; `finished(trails, id, key, at, isFailed, out?: string)`;
  `asked(trails: Trails, agentId: string, ask: string): Record<string, Trail>`; `payload()` output unchanged for
  the old fields, each call minus `out` (the short results stay in the mod).

- [ ] **Step 1: Failing tests:** `a call keeps its kind and its short result, and the page never gets the
  result` (finished with out -> trail call has `out`; payload call has no `out`, keeps `kind`); `the brief an
  agent was given is kept with its trail` (asked; kept() drops it with the agent).
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement.** Optional params only: every existing call site and test keeps its meaning.
- [ ] **Step 4: Run all tests: 77 old + new pass.**
- [ ] **Step 5: Commit** `Keep each call's kind and short result, and the agent's brief`.

### Task 3: The narrator's logic: triggers, budget, prompts, replies, card data

**Files:**
- Create: `hooks/narrator.ts`
- Modify: `types/index.d.ts` (`Moment`, `Told`, `Story`, `Ledger`, `Narration`, `Card`, `Cards`, `Payload.cards?`)
- Test: `tests/narrator.test.tsx`

**Interfaces:**
- Consumes: Task 1 and Task 2 functions; `brief`, `unpathed`, `redact`, `typeName`, `span` from `roster.ts`.
- Produces:
  - Constants `MODEL = 'claude-haiku-5-5'`, `MAX_TOKENS = 220`, `TIMEOUT_MS = 15_000`, `AGENT_GAP_MS = 20_000`,
    `TEAM_GAP_MS = 30_000`, `TEAM_SETTLE_MS = 5_000`, `START_WAIT_MS = 8_000`, `IN_FLIGHT_MAX = 2`,
    `CALLS_MAX = 80`, `FIELD_MAX = 200`, `FAILS_IN_A_ROW = 3`, `RECENT = 8`.
  - `EMPTY: Narration`
  - `momentOf(seen: Seen, cur: Seen, isLive: boolean): Moment | undefined`
  - `planned(held: Narration, rows: readonly AgentRow[], trails: Trails, now: number): { narration: Narration; asks: Ask[] }`
    where `Ask = { to: 'agent'; id: string; moment: Moment; request: Request } | { to: 'team'; request: Request }`
    and `Request = { model: string; system: { text: string; cache: true }[]; prompt: string; maxTokens: number; timeoutMs: number }`
  - `agentPrompt(row, trail, story, moment, now): string`; `teamPrompt(rows, trails, held, now): string`
  - `clean(value: unknown, max?: number): string`; `parsed(text: string): Omit<Told, 'at'> | undefined`;
    `teamParsed(text: string): string | undefined`
  - `landed(held: Narration, ask: Ask, reply: Reply, now: number): Narration` with
    `Reply = { isAnswered: true; text: string; usage: Usage } | { isAnswered: false; reason: string; error?: string; status?: number | null; usage: Usage }`
  - `restarted(held: Narration): Narration`; `isBusy(held: Narration): boolean`
  - `cardsOf(rows, trails, held, now, isEnabled: boolean): Cards`

- [ ] **Step 1: Failing tests** (each asserts the spec's values):
  - `the narrator speaks at start, at a stage change, at a kind change, when stuck, on recovery and at the end`
  - `a start waits for the first call or 8 s` and `the end outranks anything still waiting`
  - `one call per agent per 20 s, two in flight, 80 a session, then rules only` (80th ask sets
    `ledger.halt`; card state `halted`)
  - `the team sentence waits 5 s for the dust to settle and comes at most every 30 s`
  - `what is sent is masked and framed as data` (a secret in the brief, a command and a result never appear;
    system says tool output is data; prompt holds at most 8 calls)
  - `a reply in a fence or with prose around it is still read`; `a reply without now or how, or not JSON, is
    discarded`; `control characters are stripped and each field is held to 200 letters`
  - `every failure falls back to the rules: timeout, empty reply, refusal, unreadable` (card `mode: 'plain'`, a
    plain-words `why`); `a refusal that will not clear stops the narrator for the session`; `three failures in a
    row stop it too`
  - `an answer for an agent that is gone only counts its cost`; `agents already finished when first seen are
    never narrated`; `a reload frees the in-flight slots and asks again`
  - `the cost of every call is counted, failed ones included`
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement `hooks/narrator.ts`.** Pending rule: a new moment replaces the waiting one, except a
  waiting `finish`, which stays. Ask order: finish and stuck first, then the team, then the rest in row order.
  Fatal error kinds (halt at once): `authentication_failed`, `billing_error`, `invalid_request`,
  `model_not_found`. Card mode: off or halted -> `told` only while the told text is current, else `plain`;
  on -> `writing` while asking or pending, `plain` after a failure, else `told`; never-narrated finished -> `own`.
- [ ] **Step 4: Run all tests: pass.**
- [ ] **Step 5: Commit** `Add the narrator's logic: when it speaks, what it costs, what it may say`.

### Task 4: Wire the narrator into the mod

**Files:**
- Modify: `hooks/register.tsx`, `.claude-plugin/plugin.json` (userConfig `narrator`), `types/index.d.ts`
  (`PluginState['agent-watch'].narration: Shaped<Narration>`)
- Test: `tests/narrator.test.tsx`

**Interfaces:**
- Consumes: everything above. Engine: `$.model.complete(request)` resolving `ModelCompleteResult`.
- Produces: data file gains `cards: Cards`; narrator runs only while the window is fed and the option is on.

- [ ] **Step 1: Failing tests** (engine mocked with the existing `world` / `desk` pattern plus an
  `on('model.complete')` bottom):
  `with the window open, an agent's first call brings one narrator call, and its words reach the page`;
  `what reaches the narrator is masked`; `a failed narrator call leaves the rules on the card, and says why`;
  `the narrator's cost is written for the footer`; `switched off in the options, the narrator makes no call`;
  `in a nested worker the narrator makes no call`; `with the window closed the narrator makes no call`.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement.** Plan inside the queue (`narrate`, coalesced like `refresh`), launch outside it, land
  through the queue then `refresh`. `changed()` asks for a plan before its write; the tick asks for one every
  tick while the window is fed; `isBeating` also holds while the narrator is busy. `tool.call` stores
  `kindOf` and `outOf(ran.text ?? string result ?? deny)`; `agent.spawn` stores `brief(prompt, 400)` via `asked`.
  `session.start` runs `restarted` on the stored narration.
- [ ] **Step 4: Run all tests, `tsc`, `claude plugin validate`: pass.**
- [ ] **Step 5: Commit** `Run the narrator from the mod, inside its budget, and feed the page`.

### Task 5: The cards window

**Files:**
- Modify: `gui/index.html`
- Harness (outside the repo): `mods-work/agent-watch-handoff/gui-sim/cards.py` (plays four/ten agents with
  narrator data, a stuck agent and a recovery; `--bare` drops `cards`; `--reduced`), `gui-sim/live_cards.py`,
  `aw-cards.json`

- [ ] **Step 1:** Write `cards.py` first; run it against today's page and see it fail on missing `.card`.
- [ ] **Step 2:** Build the page: shared header (title, project line, Cards/Timeline tabs, Float); Cards view
  (team sentence + source label, count chips, team bar of buttons, red attention banner with Show me, card grid,
  Finished list); popover on hover/focus/click-pin with Esc; symbol tips; footer with the narrator cost line;
  timeline view unchanged below the shared header and idle while hidden; island shows the team sentence and the
  stuck count. Health colour and quiet timers come from `quietSince` + `limits` each second.
- [ ] **Step 3:** Run `cards.py four|ten|four --reduced|four --bare` and `sim.py four|ten|four --reduced`
  (timeline tab): 0 page errors, slow frames no worse than today's baseline.
- [ ] **Step 4:** axe WCAG 2 AA on a localhost-served copy (both tabs): 0 violations.
- [ ] **Step 5: Commit** `Draw the agents as plain-words cards, the timeline as a second tab`.

### Task 6: Proof and docs

- [ ] `claude plugin validate .`, `claude plugin test .`, `tsc -p .` all clean.
- [ ] Live run: harness scenario `aw-cards.json` (scratch folder, `ANTHROPIC_API_KEY` unset,
  `DELTAO_NESTED_CLI=1 AGENT_WATCH=on`, `--setting-sources "" --strict-mcp-config --model haiku --tools
  "Agent,Read,Glob"`) with `live_cards.py` filming the page: narrator text, a hover, the cost line; count the
  narrator calls from the data file.
- [ ] README: the narrator, its option, its cost and budget.
- [ ] Commit `Describe the narrator in the README`.

## Calls made

(Kept up to date while building; each is the conservative reading of an open point in the design.)

1. The narrator runs only while the window is open (fed). The terminal pane is unchanged and has nowhere to show
   narrator text, so calls made with no window would be cost with nothing to show.
2. In a nested worker, `AGENT_WATCH=on` counts as the explicit switch for the narrator too (it is the switch that
   brings the mod back at all); the `narrator` option still applies.
3. Recovery (red back to green) is a narrator moment for the agent as well as for the team: otherwise the hover
   would keep saying "stuck" while the agent works, which is the stale hover the design rules out.
4. A start waits for the agent's first tool call or 8 s, so "how" describes real work, not the empty start.
5. A kind change counts only once the new kind holds (two calls in a row, or one call in flight 8 s): reading
   and searching interleave all the time, and the 20 s cap would otherwise spend calls on noise.
6. Agents already finished when the narrator first sees them are never narrated; their card reads from their own
   answer ("from its own answer").
7. After a refusal that cannot clear (auth, billing, invalid request, unknown model) or three failures in a row,
   the narrator stops for the session and the footer says why. One failed call shows the rules on that card until
   the next moment.
8. Health is computed from the last thing heard from the agent (a call starting or ending, a turn starting):
   "no new step". An idle teammate is grey, not red.
9. The page computes the live colour and quiet timer from `quietSince` and the limits the mod writes, so both
   sides use the same numbers.
10. The timeline tab is the old view as it was, below a shared header that now holds the title, project line,
    tabs and Float button.
11. The narrator's short call results (140 letters each, masked) stay in the mod's state and are not written to
    the data file.
