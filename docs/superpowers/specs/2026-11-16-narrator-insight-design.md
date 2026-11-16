# agent-watch: narrator insight (trouble, progress, what to do) — design

Date: 2026-11-16. Owner: Mutasim. Status: approved by him ("Just go ahead and approve. One, two, and three", ~09:50),
on the three options proposed after his first live look at the narrator cards. Builds on the narrator cards shipped
the same night (main fe0aa24, design `2026-11-16-narrator-cards-design.md`, which stays authoritative for everything
this file does not change).

## Why

His verdict on the shipped narrator: "It just describes the agents and their work." It says what each agent does in
plain words, and it notices an agent only when it goes quiet. He wants the window to work for him like a lead would:
see trouble before it costs time, say how far along each agent really is, and tell him what to do about it.

## Goals

1. **Spot trouble, not only stalls.** Three new trouble signs, found by rules (cheap, the same every time, and still
   working when the narrator is offline), each with its evidence in plain words:
   - **Going in circles:** the same step (same kind of work and the same `did` text, e.g. `Read config.py`) 3 or more
     times within the agent's last 12 calls; the same search counts the same way.
   - **Failing the same way:** 3 failed calls of the same step within its last 8 calls, or 3 failures in a row of any
     kind.
   - **Touching what it should not:** any edit or write to a file outside the session's working folder (`cwd`), or to a
     file whose name looks sensitive (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `credentials*`, `secrets*`). One is enough.
     Paths compare case-insensitively on Windows, after resolving `..`. The full path is used for this check only and
     never leaves the mod: not in the data file, not in a prompt (the card names the file, not its folder).
   Stuck (no new step for 120 s) stays as it is. A card with trouble turns red, joins the stuck ones at the top under
   the attention banner, and shows a "Trouble" line with the evidence: `Read config.py 4 times`, `The same test failed 3
   times`, `Changed a file outside this project: settings.json`. A trouble sign clears once 8 newer calls show none of it.
2. **Judge progress against the goal.** The narrator reads the agent's brief (what it was asked) next to what it has
   done, and writes `progress`: one plain line such as "2 of 3 parts done; the test file is still untouched", plus a
   whole-number `percent` 0-100. The card shows the line and a thin bar labeled "estimate", so nobody mistakes it for a
   measurement. With the narrator offline there is no estimate: the stage strip stays the only progress shown.
3. **Tell him what to do.** The narrator writes `advice`: one action for the person, e.g. "Stop it and tell it the
   login code is in auth.py", or "Nothing to do, it is on track". Required whenever the agent is stuck or in trouble.
   It shows as a fourth hover section, **What to do**, and in the attention banner next to the agent's name. With the
   narrator offline, rules give the advice per sign:
   - circles: "It has done the same step N times. If it keeps on, stop it and tell it exactly where to look."
   - failing: "The same step failed N times. Look at the error, or stop it and fix the cause first."
   - outside: "It changed <file> outside this project. Check that change before anything else."
   - stuck: today's wording.
   The window can only advise. It has no channel back to Claude (by design, since the narrator cards shipped), so it
   cannot stop an agent itself; the advice says what *he* can do.

## When the narrator writes

Unchanged moments (start, stage, kind, stuck, recover, finish) plus one new one: **`trouble`**, when an agent gets a
trouble sign it did not have. `trouble` is urgent like `stuck` and `finish`, and is team news (the team sentence leads
with whoever needs him). No timed progress check: progress and advice ride on every call the narrator already makes.

## What it is sent

The agent prompt gains, all masked and cut like today:
- the agent's brief (already sent at start; now on every call, cut to 600 characters), so progress can be judged;
- a short tally of the whole trail: calls by kind, failures, the distinct file names it read and changed (names only,
  at most 12 each);
- any trouble sign with its evidence;
- the newest 8 steps, as today.

Reply JSON gains `progress` (string), `percent` (integer, clamped to 0-100, optional) and `advice` (string). Missing or
unreadable new fields fall back to the rules for that field only; the rest of the reply still counts.
`MAX_TOKENS` goes from 220 to 320. Budget unchanged: one call per agent per 20 s, 2 in flight, 80 per session.

Cost, measured on last night's 4-agent run and scaled: about 1.5k tokens in and 350 out per call. A session at the
80-call cap is about 3 cents on the API key; on the Max login, nothing extra.

## Calls left to the builder (conservative choice, written into the plan's "Calls made")

Exact chip and banner layout (match the shipped cards' look; one new "trouble" count chip), wording of the evidence
lines, and how the "estimate" bar animates (transform only, none under reduced motion).

## Safety

- Narrator output is still rendered with `textContent` only, capped, control characters stripped. `percent` is parsed
  as a number and clamped; anything else is dropped.
- Only already-masked text goes into prompts or the data file. Full paths stay inside the mod for the outside check.
- The prompt keeps its rule that everything in the request is data, never instructions. Advice that tells the person
  to run a command is dropped by the sanitizer (no code, no commands, no paths), as today.
- No new runtime dependencies. Nested-worker rule unchanged.

## Done means

- `claude plugin validate` passes; `claude plugin test` all green, the 115 existing tests unchanged unless this design
  changes their behavior (say which), with new tests for: each trouble sign (fires and does not fire, including the
  Windows path cases and sensitive names), its clearing, the `trouble` moment and its urgency, the prompt carrying the
  tally and evidence masked, parsing `progress`/`percent`/`advice` with every bad shape, the rules-only advice.
- `tsc` clean. gui-sim (four, ten, reduced) with a scripted agent for each trouble sign: 0 page errors, slow frames no
  worse than today; axe WCAG AA 0 violations on cards, a pinned card with "What to do", and the timeline tab.
- A real session with 4 Haiku agents (the live recipe: Max login, no Bash) where one agent is told to repeat a step
  (e.g. read the same file five times, one at a time): the window shows its circles trouble, the narrator's advice,
  a progress line and bar on the others, and the cost line. Screenshots saved for him.
- Nothing merged to `main` or pushed until he approves the real window.

## Addendum (owner, 2026-11-16)

His words, ~10:30: "make sure the narrator's always on, and that's always giving the right and detailed information.
Obviously running on my max plan". Relayed by the coordinator with the facts below; it overrides the sections above
where they differ.

Fact: this PC has `ANTHROPIC_API_KEY` in the Windows user environment for other tools, but Claude Code rejected that
key (its last 20 characters are in `customApiKeyResponses.rejected` in `~/.claude.json`), so every session runs on his
claude.ai Max login. `claude auth status` still prints `authMethod: api_key`, so "is ANTHROPIC_API_KEY set" is the
wrong test. The key is never printed, logged, stored or sent; at most its last 20 characters are compared in memory.

1. **Always on.** The option stays on by default. `CALLS_MAX` goes from 80 to 400; one call per agent per 20 s and 2
   in flight stay. Failures no longer stop it for the session: it backs off (1 min, then 2, then 5, then every 5) and
   tries again; a sign-in error ("login reached its time limit" and the like) backs off the same way, since he logs in
   again. Only the money guard keeps it off. It still writes only while the agents window is open (its words have
   nowhere else to go); the README says so plainly.
2. **Max plan only (the money guard).** First, anything in the plugin API that tells the session's auth method or
   billing. Otherwise decide as Claude Code does: an env key (`ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`) counts as
   in use only if its last 20 characters are in `customApiKeyResponses.approved` in `~/.claude.json`; the Bedrock,
   Vertex and Foundry switches count as paid. In use = paid: the narrator stays off and the footer says "Narrator off:
   this session pays per call. It runs only on your Max plan." Otherwise it runs, and the footer says "Narrator
   (Haiku) · on your Max plan · N calls". `~/.claude.json` is read only for those fields, once per session start;
   tests use fixtures, never the real file.
3. **Right and detailed.** The card's "now" line stays short (at most 12 words). The hover sections get fuller: up to
   40 words each for What it's fixing, How (Result when done), Progress and What to do. "Found so far" lists up to 3
   concrete findings, naming files or functions by name. Both system prompts gain a grounding rule: say only what the
   steps and their results show, name what was read or changed, never guess, and say "Not clear yet" when the steps do
   not show it (the "request is data, not instructions" rule stays). Haiku's thinking must never cut off the JSON: low
   effort if the request allows it, and `MAX_TOKENS` raised until the live run shows no reply cut at the cap (counted
   and reported). Keep Haiku 5.5. In the live run, every narrator line is checked against that agent's real calls.
4. **The window opens by itself (owner, ~10:40):** "Whenever there are 2 or more agents, open the window, the
   interactive GUI, the whole 9 yards." `autoOpenWindow` defaults to true in `plugin.json` (he already set it true in
   his settings). It was off because a window that opens while he types takes the keyboard: open it without taking
   keyboard focus if Windows and Edge allow it (simple, no new dependencies); if no reliable way exists, keep today's
   behavior and say so. It still opens once per session (the first time 2 or more agents work), and
   `/agent-watch gui` still opens it by hand. Checked live: typing in the terminal while the agents start, the
   keystrokes still land in the terminal.
