# Narrator follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the five gaps the narrator insight verification found: late advice, stale cards during long trouble,
counts the model gets wrong, the money guard unproven with the key set, and shell writes outside the project unseen.

**Architecture:** Items 1 and 2 are two rules in `planned()` (`hooks/narrator.ts`): an urgent moment may skip the
per-agent gap once, and a `refresh` moment comes every 30 s while an agent is in trouble or stuck. Item 3 moves the
arithmetic into the mod: one pure `tallyOf()` feeds both the prompt's exact counts and a pure check of the reply's
counts in `landed()`. Item 5 is a new pure parser, `hooks/shell.ts`, that `notesOf()` (`hooks/trouble.ts`) runs on
Bash and PowerShell commands. Item 4 is a live run, no code.

**Tech Stack:** Claude Code function-hooks plugin API 2.1.325 (TypeScript, `claude-code/testing`), plain HTML page
(unchanged unless a test shows a need), Python + Playwright gui-sim harness and the pywinpty screen harness (outside
the repo).

**Spec:** `docs/superpowers/specs/2026-11-16-narrator-followups-design.md` (authoritative), on top of
`docs/superpowers/specs/2026-11-16-narrator-insight-design.md` with its owner addenda and
`docs/superpowers/plans/2026-11-16-narrator-insight.md` (its 27 "Calls made" describe the code as it is).

## Global Constraints

- The 157 existing tests stay green; any that change are listed in the commit that changes them, with why.
- `tsc` clean, `claude plugin validate` passes, gui-sim four/ten/reduced 0 page errors and slow frames no worse than
  0.1%, axe 0 violations on cards, pinned, timeline.
- Budget: `AGENT_GAP_MS` 20 s, `IN_FLIGHT_MAX` 2, `CALLS_MAX` 400 all stay. A `trouble` or `stuck` moment may skip the
  20 s wait once; urgent moments still go first.
- Refresh: every 30 s (`REFRESH_MS = 30_000`), only while the agent is in trouble or stuck, never more often than the
  per-agent gap allows. Healthy agents keep today's moments.
- The mod does the arithmetic: exact counts per file and per step (reads of each file, searches, edits, failures), and
  the exact repeat count for trouble. System prompt: use the numbers given, never compute or estimate a count.
- The agent's own words ("all done", "finished") are a claim; when they disagree with the brief and the tally, trust
  the tally and say so (e.g. "It says it is done, but it read config.txt 6 of the 8 times asked").
- Count check: only counts of reads, searches, edits and failures, in `progress` and `found`; a contradicting field is
  replaced by the rules' wording and the mismatch counted in the debug log.
- Shell writes: Bash and PowerShell tools; redirects (`>`, `>>`), `Out-File`, `Set-Content`, `Add-Content`, `tee`,
  `cp`/`copy`/`Copy-Item`, `mv`/`move`/`Move-Item` destinations. Parsing only, never run. Not confident: no flag.
  Card: "Wrote outside this project with a command: <file>". The full path stays in the mod.
- Only already-masked text in prompts or the data file; narrator output via `textContent` only, capped, control
  characters stripped. No new runtime dependencies. Cap any probe or test input.
- Live run B: `ANTHROPIC_API_KEY` left as it is; the header must name the Max plan before any prompt is sent, else
  stop at once. The key is never printed, logged or stored.

## Review Focus

1. A narrator line quoting the brief's own number ("asked to read it 8 times; it has read it 6 times"): the 8 is not a
   count of the trail and must not be "corrected". Test in Task 3 (`numbers from the brief and differences are not
   counts`).
2. A shell command whose write target cannot be read for sure (`$HOME/x`, `"$OUT"`, a glob, a `cd` before a relative
   target, a heredoc's body, `2>&1`, `/dev/null`, `$null`): no flag. Test in Task 4 (`what it cannot read for sure, it
   does not flag`).
3. A heredoc or a quoted string that holds `>` (`echo "a > b"`, `cat <<EOF ... > /etc/x ... EOF`): text, not a write.
   Test in Task 4 (`quotes and heredoc bodies are text, not writes`).
4. A hung agent stuck for a long time: refreshes stay one per 30 s and stop when it ends or goes idle; the 400 cap
   still stops it. Test in Task 1 (`refresh comes every 30 s only while in trouble or stuck`).
5. A rushed call and the 2-in-flight limit: the skip never lets a third call out, and an agent never gets two skips in
   a row. Test in Task 1 (`trouble and stuck may skip the per-agent wait, once`).

---

### Task 1: Advice on time, and cards kept current while in trouble

**Files:**
- Modify: `hooks/narrator.ts` (`planned`, `momentWords`, `merged` unchanged), `types/index.d.ts` (`Moment` + `'refresh'`;
  `Story.rushed?: true`)
- Test: `tests/followups-logic.test.tsx`, wiring in `tests/followups-wiring.test.tsx`

**Interfaces:**
- Produces: `REFRESH_MS = 30_000`; `Moment` gains `'refresh'` (not urgent, not team news); `Story.rushed?: true` (set
  when the call that went out skipped the gap, cleared by the next call that did not).

- [ ] **Step 1: Failing tests** in `tests/followups-logic.test.tsx`:
  - `trouble and stuck may skip the per-agent wait, once`: an agent asked at T, circles found at T+3 s ->
    `planned` asks `a1:trouble` at T+3 s and the story has `rushed`; a second new sign at T+6 s waits until T+23 s; a
    `stage` at T+3 s still waits; with 2 already in flight nothing goes; stuck at T+5 s goes too.
  - `refresh comes every 30 s only while in trouble or stuck`: a looping agent asked at T -> no refresh at T+29 s,
    `refresh` at T+30 s; healthy agent -> none at T+60 s; stuck agent -> refresh; idle or finished agent with an outside
    sign -> none; a waiting moment is not replaced by refresh; refresh is not team news and not urgent.
  - `the refresh prompt says why it is asked`: prompt holds `It is still in trouble` / `It still looks stuck`.
- [ ] **Step 2: Run** `claude plugin test .`: the new tests fail.
- [ ] **Step 3: Implement** in `planned`: the gap filter lets a pending `stuck`/`trouble` through when
  `story.rushed !== true`; an ask within the gap sets `rushed`, one outside deletes it. After the moment, a live,
  non-idle agent with `seen.trouble` or `health === 'stuck'`, nothing pending or asking, and
  `now - askedAt >= REFRESH_MS` gets `pending = 'refresh'`.
- [ ] **Step 4: Wiring test** in `tests/followups-wiring.test.tsx`: `an agent going in circles is asked about at once,
  and again every 30 s while it loops` (mock clock; Reads of one file every 2 s; the model is asked at the trouble
  without a 20 s wait, then about every 30 s).
- [ ] **Step 5: Run** all tests and `tsc`: pass. **Commit** `Let trouble skip the per-agent wait once, and refresh a card
  in trouble every 30 s`.

### Task 2: The mod counts, the narrator quotes

**Files:**
- Modify: `hooks/narrator.ts` (`tallyLines` -> uses `tallyOf`; `AGENT_SYSTEM`), `hooks/trouble.ts` (evidence counts the
  step's total, not the 12-call window)
- Test: `tests/followups-logic.test.tsx`; changed: `tests/insight-logic.test.tsx` (file lines), `tests/insight-wiring.test.tsx`
  (file line)

**Interfaces:**
- Produces: `type Tally = { steps: number; failed: number; kinds: Partial<Record<Kind, number>>; reads: Count[];
  edits: Count[]; searches: Count[]; failures: Count[]; dropped: number }` with `Count = { name: string; count: number }`
  (newest first, masked); `tallyOf(trail: Trail | undefined): Tally`; counts in the prompt read `once` or `N times`.

- [ ] **Step 1: Failing tests:**
  - `the prompt gives exact counts per file and per step`: 22 reads of config.txt, 2 of notes.md, 3 searches for one
    pattern, 1 edit, 2 failed reads of gone.txt -> lines `Files it read, with how many times each (names only):
    notes.md 2 times, gone.txt 2 times, config.txt 22 times`, `Files it changed, with how many times each (names only):
    a.py once`, `Searches, with how many times each: Searched for login 3 times`, `Failed steps, with how many times
    each: Read gone.txt 2 times`; still the tally line and 8 step lines; nothing unmasked.
  - `the trouble evidence counts every repeat, not only the newest twelve`: 22 reads of config.txt in a row ->
    `Read config.txt 22 times`, advice says 22; detection unchanged (3 within 12).
  - `the narrator is told to use the numbers given and to weigh the agent's own words`: AGENT_SYSTEM holds `never
    count`, `estimate`, `is a claim`, `trust the tally`, the example sentence.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement** `tallyOf`, the new tally lines (keep the `Tally of its N steps: ...` line verbatim), the
  trouble counts, the system prompt lines (keep `Counts come from the tally of the whole trail`).
- [ ] **Step 4: Run** all tests and `tsc`; update the three changed expectations (file lines now carry counts).
- [ ] **Step 5: Commit** `Count in the mod: exact counts per file and step, and the agent's words weighed against them`.

### Task 3: A reply that miscounts is corrected

**Files:**
- Create: `hooks/counts.ts` (pure: the claim finder and the check)
- Modify: `hooks/narrator.ts` (`Ask` carries `tally` and `found`; `landed` checks), `hooks/register.tsx` (debug line),
  `types/index.d.ts` (`Ledger.miscounts?`, `Story.corrected?`, `Cards['narrator'].corrected?`)
- Test: `tests/counts.test.tsx`, wiring in `tests/followups-wiring.test.tsx`

**Interfaces:**
- Consumes: Task 2's `Tally`, `tallyOf`.
- Produces: `claimsIn(text: string, files: readonly string[]): Claim[]` with
  `Claim = { kind: 'read' | 'search' | 'edit' | 'failure'; count: number; file?: string; said: string }`;
  `miscounted(text: string, tally: Tally): Claim | undefined`; `rulesProgress(tally: Tally): string`;
  `Ask` (agent) gains `tally?: Tally; found?: string`.

- [ ] **Step 1: Failing tests** in `tests/counts.test.tsx`:
  - `counts of reads, searches, edits and failures are found`: `read config.txt 12 times`, `5 reads of notes.md`,
    `2 edits to auth.py`, `searched for login 4 times`, `The same test failed 3 times`, `six reads`, `read it twice`,
    `6 of the 8 times asked` (claims 6).
  - `numbers from the brief and differences are not counts`: `asked to read it 8 times`, `4 reads left`, `3 more
    reads`, `8 reads requested`, `3 of 3 parts done`, `ran the tests 4 times`, `read 3 files`, `62%` -> no claims.
  - `a claim naming a file must match that file; one naming none must match some count of its kind`.
  - `a reply that contradicts the tally has that field replaced by the rules' words`: `landed` with a tally of 3 reads
    and progress `read config.txt 6 times` -> progress = `rulesProgress`, no percent, `ledger.miscounts` 1,
    `story.corrected` says what; found likewise -> the ask's rules found; a right count is kept untouched.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement.** `planned` attaches `tallyOf(trail)` and `plainOf(...).found` to each agent ask; `landed`
  runs `miscounted` on `progress` and `found`; the mod writes
  `agent-watch: narrator count corrected (N this session): <field> said <claim>, the tally has <n>` to the debug log;
  `cardsOf` passes `ledger.miscounts` as `narrator.corrected`.
- [ ] **Step 4: Wiring test** `a narrator reply that miscounts reaches the page corrected, and the debug log says so`.
- [ ] **Step 5: Run** all tests, `tsc`. **Commit** `Check the narrator's counts against the tally and correct a
  reply that contradicts it`.

### Task 4: Shell writes outside the project

**Files:**
- Create: `hooks/shell.ts` (pure parser)
- Modify: `hooks/trouble.ts` (`notesOf` for `Bash`/`PowerShell`; `outsideOf` wording), `types/index.d.ts`
  (`Touch.shell?: true`)
- Test: `tests/shell.test.tsx`, wiring in `tests/followups-wiring.test.tsx`

**Interfaces:**
- Produces: `writtenBy(command: string, isPowerShell: boolean): Target[]` with
  `Target = { path: string; name: string; isFolderKnown: boolean }`; `Touch.shell?: true`; evidence
  `Wrote outside this project with a command: <file>` (secret: `Wrote a file that may hold secrets with a command:
  <file>`; both: `Wrote a file that may hold secrets, outside this project, with a command: <file>`); advice
  `It wrote <file> outside this project with a command. Check that change before anything else.` (and the two variants).

- [ ] **Step 1: Failing tests** in `tests/shell.test.tsx`:
  - `each listed form is read`: `echo x > /tmp/a.txt`, `>> C:\x\log.txt` (PowerShell), `2> /tmp/err.log`,
    `| tee -a /tmp/t.txt`, `Out-File -FilePath C:\x\o.txt`, `| Out-File C:\x\o.txt`, `Set-Content C:\x\s.txt 'v'`,
    `Add-Content -Path C:\x\a.txt -Value v`, `cp a.py /tmp/b.py`, `cp a.py b.py /tmp/` (two targets), `cp -t /tmp a.py`,
    `copy a.py C:\x\` (PowerShell), `Copy-Item a.py -Destination C:\x\b.py`, `mv a.py ../b.py`, `Move-Item a b`,
    `tee` in PowerShell.
  - `reads and targets inside are not writes outside` (via `notesOf`): `cat a > b.txt` in the folder, `cp x.py src/`,
    `Get-Content C:\x\a.txt`, `type C:\x\a`, `ls > files.txt`.
  - `what it cannot read for sure, it does not flag`: `$HOME/x`, `"$OUT"`, `${D}/a`, `` `pwd`/a ``, `*.log`,
    `cd /tmp && echo x > a.txt`, `2>&1`, `>&2`, `/dev/null`, `$null`, `NUL`, `bash -c "echo > /x"`, unknown
    PowerShell option before a positional, an unclosed quote.
  - `quotes and heredoc bodies are text, not writes`: `echo "a > /etc/b"`, `cat > /tmp/x <<'EOF'` with a body line
    `echo y > /etc/z` -> only `/tmp/x`.
  - `a name that may hold secrets is judged even when its folder is not sure`: `echo k > $HOME/.env` -> name `.env`,
    folder unknown.
  - `notesOf flags a shell write outside the folder, naming only the file` and the evidence wording via `troubleOf`.
  - Long input: a 100 000-letter command parses in bounded time (scan cap).
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement** the tokenizer (quotes, escapes, operators, redirects, heredoc stop), the per-command rules
  (bash `cp`/`mv`/`tee`; PowerShell parameter binding by unique prefix, known switches, positionals only while every
  option is known), the `cd` rule, and the notes.
- [ ] **Step 4: Wiring test** `a command that writes outside the project shows as trouble, naming only the file`
  (PowerShell `Set-Content C:\Users\me\elsewhere\notes.txt 'x'`; the data file and prompts never hold `elsewhere`).
- [ ] **Step 5: Run** all tests, `tsc`, `claude plugin validate .`. **Commit** `See shell commands that write outside
  the project or to a file that may hold secrets`.

### Task 5: Proof, docs and the two live runs

- [ ] `claude plugin validate .`, `claude plugin test .`, `tsc -p .`; `scan_secrets` on the worktree.
- [ ] gui-sim `cards.py four|ten|four --reduced` with `AW_GUI` on this worktree: 0 page errors, slow <= 0.1%; axe on
  `axe_prep.py`'s cards, pinned, timeline copies: 0 violations; server stopped.
- [ ] Live run A (recipe, key unset): one agent told to read the same file over and over, one at a time, for more than
  a minute, beside 1-2 normal agents. From the data file over time: refreshed counts, when the advice landed vs when the
  loop stopped, every narrator line checked against the calls. Screenshots to
  `mods-work/agent-watch-handoff/followups-send/`.
- [ ] Live run B (key left set): read the session header before any prompt; it must name the Max plan, else stop
  without a prompt. Footer must read "on your Max plan". Record header and footer text.
- [ ] README: refresh, exact counts and the correction, shell writes. Calls made below. Commit `Describe the
  follow-ups in the README; record the calls made`.

## Calls made

(Kept up to date while building; each is the conservative reading of an open point in the design.)
