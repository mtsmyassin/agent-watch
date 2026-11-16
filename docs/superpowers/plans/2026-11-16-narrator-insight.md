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
- Addendum (owner, 2026-11-16), overriding the above where they differ: `CALLS_MAX` 400; failures back off 1, 2, 5,
  then every 5 minutes instead of stopping the session (sign-in errors too); the narrator runs only when the session
  does not pay per call (footer: "Narrator off: this session pays per call. It runs only on your Max plan." /
  "Narrator (Haiku) · on your Max plan · N calls"); an env key counts as in use only when its last 20 characters are
  in `customApiKeyResponses.approved`; the key is never printed, logged, stored or sent. "now" at most 12 words; what,
  how, progress, advice up to 40 words; found up to 3 findings; grounding rule ("Not clear yet"); low effort; no reply
  cut at the cap. `autoOpenWindow` default true, opened without taking the keyboard where possible.

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

### Task 4: Always on, on the Max plan only (addendum 1, 2)

**Files:**
- Create: `hooks/billing.ts` (pure: the money guard)
- Modify: `hooks/narrator.ts` (`CALLS_MAX` 400; back-off in place of the session stop), `hooks/register.tsx`
  (the guard once per session start; the narrator plans only when it says the plan pays), `types/index.d.ts`
  (`Ledger.pauses?`, `Ledger.pausedUntil?`, `Ledger.pauseWhy?`, `Ledger.cut?`; `Cards['narrator']` `state` gains
  `'paused'`, optional `plan?`, `until?`, `cut?`)
- Modify (design-driven): the existing tests that pin 80 calls or the session stop.
- Test: `tests/billing.test.tsx`, `tests/always-on.test.tsx`

**Interfaces:**
- Produces: `Access = { isPaid: false; plan: string } | { isPaid: true; why: string }`;
  `accessOf(signals: Signals): Access` with `Signals = { credential?: 'bearer' | 'api-key' | 'none'; thirdParty:
  boolean; envTails: string[]; approved: string[]; planType?: string; hasLogin: boolean }`; `tail(key: string):
  string` (last 20); `configFacts(text: string): { approved: string[]; planType?: string; hasLogin: boolean }`
  (reads only `customApiKeyResponses.approved` and `oauthAccount`); `PAID_WHY` = "Narrator off: this session pays per
  call. It runs only on your Max plan."; `BACKOFF_MS = [60_000, 120_000, 300_000]` then every 300 000;
  `cardsOf(rows, trails, held, now, isEnabled, access?)`.

- [ ] **Step 1: Failing tests:** `the session's own credential decides: a claude.ai login runs, a key or a cloud
  provider pays` (bearer -> runs, plan from `oauthAccount.organizationType`; api-key, none, Bedrock/Vertex/Foundry ->
  paid); `with no answer from the engine, the config file decides as Claude Code does` (env key whose tail is
  approved -> paid; rejected or unknown tail with a login -> runs; neither -> paid); `the config file is read for two
  fields only, and the key is never kept` (fixture with other fields and a full key: `configFacts` returns only the
  tails list and the plan type); `failures back off 1, 2, 5, then every 5 minutes, and never stop the session`
  (fatal refusal, sign-in error, engine refusal, three in a row; asks resume after the pause; a success resets);
  `400 calls a session` (the 400th sets halt); wiring: `on a paid session the narrator makes no call and the footer
  says why`, `on the Max login it runs and names the plan`, `the key reaches no file, prompt or log`.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement.** `$.session.authorize()` first (its `kind` only; the handle is dropped at once), then the
  env switches, the env keys' tails and the config file, once per session start; any read that fails counts as
  unknown, and unknown with no login is paid. Until the guard has answered, the narrator makes no call.
- [ ] **Step 4: Run all tests and `tsc`: pass. List every existing test changed.**
- [ ] **Step 5: Commit** `Keep the narrator on, on the Max plan only: back off instead of stopping`.

### Task 5: Right and detailed (addendum 3)

**Files:** `hooks/narrator.ts`, `hooks/register.tsx` (request `effort`), `types/index.d.ts`; test
`tests/detail.test.tsx`.

- [ ] **Step 1: Failing tests:** `now stays glanceable and the hover fields run fuller` (now cut to 12 words; what,
  how, progress, advice kept to about 40 words, cut at 320 letters; found keeps up to 3 findings);
  `both system prompts hold the grounding rule` ("Not clear yet", never guess, name what was read or changed, the
  data rule kept); `the request asks for low effort and room for the whole reply` (`effort: 'low'`,
  `MAX_TOKENS` 1024); `a reply cut at the cap is counted` (`output_tokens` >= cap -> `ledger.cut` + 1, shown in
  `cards.narrator.cut`).
- [ ] **Step 2-4:** fail, implement, pass (`tsc` too).
- [ ] **Step 5: Commit** `Ask for grounded, fuller words, at low effort, with room to finish`.

### Task 6: The window opens by itself, without taking the keyboard (addendum 4)

**Files:** `.claude-plugin/plugin.json` (`autoOpenWindow` default true), `hooks/register.tsx` (`launch`), tests in
`tests/insight-wiring.test.tsx`.

- [ ] **Step 1:** Find a launch that opens the Edge app window without activating it (no new dependency); try it by
  hand on this PC with a scratch page.
- [ ] **Step 2: Failing test:** `two agents at work open the window once, by itself, in the background` (the
  `process.run` argv the mod sends; once per session).
- [ ] **Step 3-4:** implement, pass.
- [ ] **Step 5: Commit** `Open the window by itself at two agents, without taking the keyboard`.

### Task 7: The window shows trouble, progress and what to do

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

### Task 8: Proof and docs

- [ ] `claude plugin validate .`, `claude plugin test .`, `tsc -p .` clean.
- [ ] In the live run: the window opens by itself at 2 agents while the harness types in the terminal; the typed
  text lands in the terminal. Every narrator line checked against that agent's real calls; replies cut at the cap
  counted from the data file.
- [ ] Live run (`aw-insight.json`, the memory file's recipe, `--tools "Agent,Read,Glob,Grep"`), one agent told to read
  the same file five times one at a time; `live_insight.py` films the page: circles trouble, narrator advice,
  progress line and bar, cost line; count the narrator calls from the data file. Screenshots to
  `mods-work/agent-watch-handoff/insight-send/`.
- [ ] README: trouble signs, progress estimate, what to do, the new cost figures.
- [ ] Commit `Describe trouble, progress and advice in the README`.

## Calls made

(Kept up to date while building; each is the conservative reading of an open point in the design.)

1. **Same step = the same tool with the same arguments** (a short hash of the tool and its input, the engine's own
   keys left out), not only the same `did` words: the words name a file but not which part was read or which pattern
   was searched, so paging a long file, or two searches that read alike, would count as circles. A call stored before
   this version falls back to its kind and words.
2. A change to anything else between repeats ends a run (testing after each fix is work, not a circle), and a step
   that fails is the failing sign's, not the circles' (one problem, one sign).
3. Only calls with a kind of work count in the windows: bookkeeping (TodoWrite, Agent, ...) neither counts nor stands
   between repeats.
4. "Clears once 8 newer calls show none of it": a sign holds while its newest evidence call is among the agent's last
   8 calls with a kind, judged as it stood when that call came. That keeps the 12-call circles window and the 8-call
   clearing from contradicting each other.
5. The outside check runs when the call starts, in the `tool.call` hook, on the full path; only the verdict and the
   masked file name are kept (the full path is not stored even in the mod's state). It covers Edit, Write, MultiEdit,
   NotebookEdit and any connected tool whose kind is edit and that names a file (`file_path`, `notebook_path`,
   `path`). Relative paths resolve from the session folder; `\?\C:\...` and `/c/...` read as the drive; climbing past
   a drive's root stays there; a share's `\server\share` is its root. With the folder unknown only the name is
   judged. A change that came back failed or refused touched nothing; one still in flight counts. Shell commands that
   write files are not seen (outside the design's "edit or write").
6. `.env.example` counts as a secret name (the design's `.env*`, literally).
7. Outside and secret names are one sign, `outside` ("touching what it should not"), with three wordings (outside,
   may hold secrets, both); the newest such change is the evidence.
8. Once an agent is over only `outside` stays (circles and failing describe how it works); its finished row keeps a
   `Needs a check` mark and its banner line.
9. Rules advice for failures in a row of different steps: "N steps failed in a row. Look at the error, or stop it and
   fix the cause first." (the design's wording speaks of "the same step").
10. The `trouble` moment ranks after `stuck` and before `recover`, stage and kind. A waiting `stuck` or `trouble` is
    not pushed back by a stage or kind change (nor `trouble` by a recovery); its call covers those. A sign that clears
    is no moment.
11. Narrator advice shows only while it was written for the signs the agent shows now (trouble signs and `stuck`);
    advice from before a sign, or for one that cleared, gives way to the rules' advice. The mod decides this
    (`card.advice`), so the page has no stale-advice logic of its own.
12. A reply without `progress` shows no estimate (no older one carried over): the rules have none. `percent` takes a
    number or a text that is only a number (with an optional %), rounded and held to 0-100.
13. The advice sanitizer drops advice holding a backtick, `$(`, `&&`, `||`, ` | `, a command-line flag, or a known
    command after run/type/execute/enter/paste/use (git, npm, pip, python3, rm, ...). "No paths" is read as today's
    cutting of folders to the file name, not dropping.
14. On the page the trouble words are primary grey beside a crimson diamond, not crimson text: crimson on the card
    surface is about 4.4:1, under AA for small text. The diamond (stuck keeps its round dot) lets the two read apart;
    the chip reads "N in trouble". The banner lists at most 3 agents, then "N more need you".
15. The explanation also gains `Progress (an estimate)` and `Trouble` sections beside `What to do` (the addendum
    lists Progress among the fuller hover sections).
16. Addendum, money guard: `$.session.authorize()` gives the credential kind the session really uses (bearer = a
    claude.ai login; api-key, or none = pays); its handle is dropped at once. `$.session.identity()` answers only mods
    that managed settings install, so it is not used. Then the cloud switches, the env keys' tails against
    `customApiKeyResponses.approved`, and the config file's login. With nothing to go on it counts as paid (narrator
    off) rather than spend money. The plan's name comes from `oauthAccount.organizationType` (`claude_max` -> "Max
    plan"; unknown -> "Claude plan"); `CLAUDE_CONFIG_DIR` is honoured for the config file.
17. Addendum, pauses: a pause is not "busy". With agents at work the beat goes on and the narrator asks again when
    the pause ends; with none at work the waiting moments are told at the next activity, rather than beat for up to 5
    minutes after everything ended. A failure landing during a pause does not stretch it; a success resets the steps.
    The 400-call cap still stops it for the session (the addendum raised the cap, it did not remove it).
18. Addendum, detail: "now" over 12 words is cut at 12 with "…"; what, how, progress, advice and found are held to
    320 letters (about 40 words), next to 200, found to 3 findings split on ";".
19. Addendum, truncation: requests ask for `effort: 'low'` and `MAX_TOKENS` 1024 (only what is used counts). A reply
    whose `output_tokens` reach the cap, or the API's `max_output_tokens` error, is counted (`cut`) and shown in the
    footer.
20. Addendum, window: `autoOpenWindow` defaults to on and is read as on unless the option is false. Opened by itself
    on Windows it goes through `gui/open-window.ps1` (PowerShell and Windows' own user32 calls): it hands the keyboard
    back with AttachThreadInput + SetForegroundWindow and lifts the new window with SetWindowPos (topmost, then not)
    without activating it; if that cannot run, the plain launch does. `/agent-watch gui` keeps the plain launch, since
    the person asked to see the window. A script file, not an encoded command line: readable, and not the pattern
    antivirus tools distrust. Residual: keystrokes in the few tens of milliseconds between Edge activating and the
    hand-back can still land in the window.
21. Keep Haiku 5.5 (the owner's call: fast and light on his Max limits).
22. Live run: the repeating agent reads config.txt eight times, not five: with one narrator call per agent per 20 s, a
    five-read agent finishes before its trouble call may go.
23. Tests: new files per area (`trouble`, `insight-logic`, `insight-wiring`, `billing`, `always-on`, `detail`,
    `auto-open`); each existing test changed by the design or the addendum is listed in its commit.
24. gui-sim: "Unexpected string" joins the torn-read filter (one appeared on today's unchanged page under reduced
    motion: a read of the data file mid-write).
25. From the live runs' check of every narrator line against the real calls: a call's result now keeps its line
    breaks as ` | ` for the narrator (a Grep's matches had run together: "fruit.txt line 1 has 'mango notes'"), and
    the system prompt says counts come from the tally (it had said "eight steps" when ten were done, counting the
    newest steps shown). One more unsupported line, "about six rounds more than asked" for 22 reads of 16, is the
    model's arithmetic and has no code fix.
26. The opener hands the keyboard back from any new Edge window that takes the foreground, not only once the page's
    title has loaded (run 1 measured about 0.2 s on the new window). Run 2, with that change, still measured about
    0.1-0.2 s at the watcher's ~120 ms resolution: the PowerShell loop's own cost is the floor. Left as is and said.
27. A third live run repeats the second on the final code, to see the two grounding fixes and the narrator's advice
    on a card in trouble live.
