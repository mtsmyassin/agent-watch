# Narrator insight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The agents window spots trouble (going in circles, failing the same way, touching what it should not),
shows each agent's progress against its brief as an estimate, and says what the person can do about it.

**Architecture:** The three trouble signs are rules in a new pure file, `hooks/trouble.ts`, read from the calls an
agent's trail already keeps plus three small notes per call (`step`, `touch`, `name`) that `register.tsx` works out
when the call starts. The outside-folder check runs there, on the full path, and only its verdict and the file's
masked name are kept. `narrator.ts` gains the `trouble` moment, a richer prompt, three new reply fields and the
card's trouble and advice; `gui/index.html` draws them.

**Tech Stack:** Claude Code function-hooks plugin API 2.1.325 (TypeScript, `claude-code/testing`), plain HTML/CSS/JS
with the vendored Motion 14.12.0, Python + Playwright gui-sim harness (outside the repo).

**Spec:** `docs/superpowers/specs/2026-11-16-narrator-insight-design.md` (authoritative), on top of
`docs/superpowers/specs/2026-11-16-narrator-cards-design.md` and `docs/superpowers/plans/2026-11-16-narrator-cards.md`.

## Global Constraints

- Circles: the same step 3 or more times within the agent's last 12 calls. Failing: 3 failed calls of the same step
  within its last 8 calls, or 3 failures in a row. Outside: any edit or write outside the session's `cwd`, or to a
  file named `.env*`, `*.pem`, `*.key`, `id_rsa*`, `credentials*`, `secrets*`; one is enough.
- Paths compare case-insensitively on Windows, after resolving `..`. The full path never leaves the mod: not in the
  data file, not in a prompt; the card names the file, not its folder.
- A trouble sign clears once 8 newer calls show none of it. Stuck (120 s) is unchanged.
- Rules advice, verbatim: circles "It has done the same step N times. If it keeps on, stop it and tell it exactly
  where to look." failing "The same step failed N times. Look at the error, or stop it and fix the cause first."
  outside "It changed <file> outside this project. Check that change before anything else." stuck: today's wording.
- New moment `trouble`: urgent like `stuck` and `finish`, and team news.
- Prompt: brief on every call cut to 600 characters; a tally (calls by kind, failures, distinct file names read and
  changed, at most 12 each); trouble signs with evidence; the newest 8 steps. All masked.
- Reply gains `progress` (string), `percent` (integer, clamped 0-100, optional), `advice` (string); a missing or bad
  new field falls back to the rules for that field only. `MAX_TOKENS` 220 -> 320. Budget unchanged (20 s, 2 in
  flight, 80 a session).
- Output: `textContent` only, capped, control characters stripped; advice that tells the person to run a command is
  dropped. No new runtime dependencies. Nested-worker rule unchanged.
- The page: a red card for trouble, at the top with the stuck ones, under the attention banner; a "Trouble" line with
  the evidence; a progress line and a thin bar labeled "estimate" (transform only, still under reduced motion); a
  fourth hover section "What to do"; advice in the banner next to the name; one new "trouble" count chip.
- WCAG 2 AA, axe 0 violations; DESIGN.md colours (crimson #E5383B for trouble, small text #A1A1A6).

## Review Focus

1. A Windows path written with forward slashes, a different drive-letter case, `..` segments or a relative path:
   judged as inside/outside the way Windows would. Test in Task 1 (`the outside check reads Windows paths as Windows
   does`).
2. An agent that pages through one long file (Read with offsets) or runs the tests after each edit: not "going in
   circles". Test in Task 1 (`paging through a file or testing after each change is not going in circles`).
3. A narrator reply with `percent` as text, a fraction, a negative, over 100, NaN-like, or advice holding a command:
   the rest of the reply still counts. Test in Task 2 (`progress, percent and advice are read, and every bad shape
   of them dropped alone`).
4. Advice written before trouble began, still on the card after it began (or after it cleared): the rules stand in.
   Test in Task 2 (`advice written before the trouble is not shown with it`).
5. A file outside the project changed by an agent that has since finished: still shown. Test in Task 1 (`once over,
   only a change outside the project is still trouble`).

---

### Task 1: The trouble rules

**Files:**
- Create: `hooks/trouble.ts`
- Modify: `types/index.d.ts` (`Sign`, `Touch`, `Trouble`; `Call.step?`, `Call.touch?`, `Call.name?`),
  `hooks/trail.ts` (`called(..., notes?)`, `payload` strips the three notes)
- Test: `tests/trouble.test.tsx`

**Interfaces:**
- Produces:
  - `type Sign = 'circles' | 'failing' | 'outside'`; `type Touch = { file: string; outside?: true; secret?: true }`;
    `type Trouble = { sign: Sign; evidence: string; advice: string }`
  - `LOOP_WINDOW = 12`, `LOOP_MIN = 3`, `FAIL_WINDOW = 8`, `FAIL_MIN = 3`, `CLEAR_AFTER = 8`
  - `isInside(path: string, cwd: string): boolean`; `isSecretName(name: string): boolean`
  - `stepOf(tool: string, input: Readonly<Record<string, unknown>>): string | undefined` (a short hash of the tool
    and its arguments, the engine's own keys `tool`, `tool_use_id`, `agentId`, `requestMeta` left out)
  - `notesOf(tool, input, kind: Kind | undefined, cwd: string): { step?: string; touch?: Touch; name?: string }`
    (`name` for read and edit calls with a path; `touch` for edit calls only, `outside` only when `cwd` is known)
  - `troubleOf(calls: readonly Call[], isOver: boolean): Trouble[]` (order: outside, failing, circles)
  - `called(key, doing, at, kind?, notes?)` keeps the notes; `payload()` calls carry none of `out`, `step`, `touch`,
    `name`.

- [ ] **Step 1: Failing tests** in `tests/trouble.test.tsx`:
  - `the same step three times is going in circles` (Read x 3 -> `Read config.py 3 times`, advice with "3 times";
    2 times -> none; 4 times inside 12 -> count 4; a search counts the same way)
  - `paging through a file or testing after each change is not going in circles` (same did text, different step;
    test, edit, test, edit, test -> none)
  - `the same step failing three times, or three failures in a row, is failing` (same-step evidence `The same test
    failed 3 times` for a test; three different failed steps -> `3 steps failed in a row`; spread over more than 8
    -> none)
  - `a change outside the project, or to a file that may hold secrets, is trouble at once` (evidence `Changed a file
    outside this project: settings.json`; `.env.local`, `server.pem`, `id_rsa.pub`, `credentials.json`,
    `secrets.yaml`, `app.key`; a failed edit is none)
  - `the outside check reads Windows paths as Windows does` (`C:\Work\Shop\a.py` vs cwd `c:\work\shop` inside;
    `C:/work/shop/../other/a.py` outside; `C:\work\shopping\a.py` outside; relative `src\a.py` inside; `\\?\C:\work\shop\a.py`
    inside; POSIX `/repo/x` vs `/repo` inside, `/Repo/x` outside)
  - `the full path is kept nowhere: only the file's name` (notesOf on `C:\Users\me\secret-place\settings.json` ->
    nothing in the notes holds `secret-place`; payload of a trail with notes has no `step`, `touch`, `name`)
  - `a sign clears once eight newer calls show none of it` (circles with 7 newer -> still; 8 -> gone; outside likewise)
  - `once over, only a change outside the project is still trouble`
- [ ] **Step 2: Run** `claude plugin test .`: the new file fails (module missing).
- [ ] **Step 3: Implement** `hooks/trouble.ts`, the types and the trail changes. Only calls with a kind count; a
  change (an edit of another step) ends every other step's run; failed calls are the failing sign's, not the circles'.
- [ ] **Step 4: Run** `claude plugin test .` and `tsc`: all pass.
- [ ] **Step 5: Commit** `Find trouble by rules: going in circles, failing the same way, touching what it should not`.

### Task 2: The narrator reads trouble and progress, and says what to do

**Files:**
- Modify: `hooks/narrator.ts`, `types/index.d.ts` (`Moment` + `'trouble'`; `Seen.trouble?: Sign[]`;
  `Told.progress?`, `Told.percent?`, `Told.advice?`; `Story.askedFor?`, `Story.toldFor?`; `Card.trouble?`,
  `Card.advice?`)
- Modify: `tests/narrator-logic.test.tsx` (MAX_TOKENS 220 -> 320 only)
- Test: `tests/insight-logic.test.tsx`

**Interfaces:**
- Consumes: Task 1's `troubleOf`, `Trouble`, `Sign`.
- Produces: `MAX_TOKENS = 320`; `BRIEF_MAX = 600`; `percentOf(value: unknown): number | undefined`;
  `adviceOf(value: unknown): string` (`''` when dropped); `parsed()` returning the new fields;
  `momentOf` returning `'trouble'`; `cardsOf` cards with `trouble` and a current narrator `advice`.

- [ ] **Step 1: Failing tests** in `tests/insight-logic.test.tsx`:
  - `a new trouble sign is a moment, urgent and team news` (momentOf -> `trouble`; one already there -> none; stuck
    outranks it; a waiting trouble is not replaced by a stage or kind; planned asks about it before a stage change
    and marks team news)
  - `the prompt carries the brief, a tally and the evidence, masked` (brief cut to 600; `Tally` line with kinds and
    failures; distinct names read and changed, at most 12 each; `Read config.py 4 times`; a secret in the brief and a
    path's folder never appear; still exactly 8 `- ` step lines; maxTokens 320)
  - `progress, percent and advice are read, and every bad shape of them dropped alone` (`"62"` -> 62, 62.6 -> 63,
    -5 -> 0, 140 -> 100, `"lots"`, `true`, `null`, `{}` -> absent; advice with a backtick, `git reset --hard`,
    `run npm install`, `rm -rf build` -> dropped; now/how kept every time)
  - `advice written before the trouble is not shown with it` (told while healthy, then circles -> card has the
    trouble and no narrator advice; told at the trouble moment -> its advice shows; trouble cleared -> that advice
    goes)
  - `offline, the card still names the trouble and the rules' advice` (narrator off and halted: card.trouble with
    the verbatim rules advice)
  - `the team prompt leads with whoever needs the person` (trouble evidence on the agent's line; system names trouble)
- [ ] **Step 2: Run** and see them fail.
- [ ] **Step 3: Implement.** `seenOf` adds the live signs; `merged` keeps a waiting `stuck`/`trouble` over a
  non-urgent moment; `URGENT` and `TEAM_NEWS` gain `trouble`; `planned` notes `askedFor` (the signs and `stuck`,
  joined) and `landed` moves it to `toldFor`; `cardOf` shows narrator advice only while `toldFor` matches the signs
  now; `restarted` drops `askedFor` with `asking`. AGENT_SYSTEM asks for the three fields; TEAM_SYSTEM leads with
  stuck or in trouble.
- [ ] **Step 4: Run** all tests and `tsc`: pass. Say in the commit which old test changed (MAX_TOKENS).
- [ ] **Step 5: Commit** `Let the narrator judge progress, see trouble and say what to do`.

### Task 3: Wire the notes and the longer brief into the mod

**Files:**
- Modify: `hooks/register.tsx` (`ASK_MAX` 400 -> 600; `tool.call` passes `notesOf(e.tool, input, kind, cwd)`)
- Modify: `tests/narrator-wiring.test.tsx` (maxTokens 220 -> 320 only)
- Test: `tests/insight-wiring.test.tsx`

- [ ] **Step 1: Failing tests:** `an edit outside the project shows as trouble, naming only the file`
  (Edit `C:\Users\me\elsewhere\settings.json` with cwd `C:\work\shop` -> card trouble outside; neither the data file
  nor any prompt holds `elsewhere`); `an agent reading the same file three times shows going in circles, and the
  narrator is told`; `the narrator's progress and advice reach the page`.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all tests, `tsc`, `claude plugin validate .`: pass.**
- [ ] **Step 5: Commit** `Note each call's step and any risky change, and hand the narrator the longer brief`.

### Task 4: The window shows trouble, progress and what to do

**Files:**
- Modify: `gui/index.html`
- Harness (outside the repo): `gui-sim/cards.py` (one scripted agent per sign in `four` and `ten`, progress and
  advice in the told words), `gui-sim/axe_prep.py` (pin a card with "What to do")

- [ ] **Step 1:** Extend `cards.py` and run it against today's page: it reports no `.c-trouble` line.
- [ ] **Step 2:** Build: trouble class (crimson), rank with stuck, Trouble line, progress line + estimate bar,
  "What to do" hover section (narrator advice, else the sign's rules advice, else today's stuck wording), banner
  lines with name, problem and advice, the trouble chip, team-bar segment, finished row mark for an outside change,
  island "N need you".
- [ ] **Step 3:** `cards.py four|ten|four --reduced` and `sim.py four`: 0 page errors, slow frames no worse than 0.1%.
- [ ] **Step 4:** `axe_prep.py`, then axe on `cards.html`, `cards-pinned.html`, `timeline.html`: 0 violations.
- [ ] **Step 5: Commit** `Draw trouble, progress and what to do on the cards`.

### Task 5: Proof and docs

- [ ] `claude plugin validate .`, `claude plugin test .`, `tsc -p .` clean.
- [ ] Live run (`aw-insight.json`, the memory file's recipe, `--tools "Agent,Read,Glob,Grep"`), one agent told to read
  the same file five times one at a time; `live_insight.py` films the page: circles trouble, narrator advice,
  progress line and bar, cost line; count the narrator calls from the data file. Screenshots to
  `mods-work/agent-watch-handoff/insight-send/`.
- [ ] README: trouble signs, progress estimate, what to do, the new cost figures.
- [ ] Commit `Describe trouble, progress and advice in the README`.

## Calls made

(Kept up to date while building; each is the conservative reading of an open point in the design.)
