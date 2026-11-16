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

1. **"Skip the 20 s wait once"** = an agent may not skip twice in a row: a call that went out inside the gap marks the
   story `rushed`, and the next call that waited the gap out gives the skip back. So at most two calls per agent in any
   20 s, and the 2-in-flight limit and urgent-first order are untouched.
2. **Refresh** goes for a live agent that is not resting (`idle`) and shows a trouble sign or is stuck, 30 s after the
   last call for it went out, when nothing else waits for it. It is neither urgent nor team news, and a moment already
   waiting is asked as itself. A stuck agent is refreshed too (the design names it), though its trail does not move: a
   hung agent costs about 2 calls a minute of the 400, which still stops the narrator for the session if reached.
3. The refresh cannot be driven through the mod in the test kit: `Date.now` is read-only there and the kit's clock does
   not move it. It is tested on `planned()` and seen in live run A. The urgent skip is tested both ways.
4. **The trouble evidence's count** is every time the agent did that step in its kept trail (every failure of it, for
   failing), not the count inside the 12-call (8-call) window that found it: on a long loop the card read "12 times"
   while the agent was at 22. Finding a sign and clearing it are unchanged.
5. **The tally** lists per file how many times it was read and changed, per search how many times it ran, and per step
   how many times it failed (the newest 12 of each, `once` / `N times`). Searches and failed steps are named by their
   masked words. The `Tally of its N steps` line and `Counts come from the tally of the whole trail` are kept word for
   word, so the old tests of them hold.
6. **The count check reads only plain counts**: "read config.txt 6 times", "5 reads of notes.md", "2 edits to auth.py",
   "failed 3 times", "searched 4 times", number words, once/twice. A count naming a file must equal that file's count;
   one naming none must equal the kind's total or any one file's or step's count (lenient: a false correction is worse
   than a miss). Left alone: the brief's numbers ("asked to read it 8 times", "6 of the 8 asked" checks only the 6),
   limits ("up to 5"), differences ("3 more", "4 left"), parts ("3 reads in src", "2 reads failed"), "N failures" and
   "N failed tests" (as likely the project's own test results), "changes" (one edit may make many), decimals, and
   "once" as a conjunction. Missed on purpose: "searched for the word read 3 times" reads as a read.
7. **The rules' words** that replace a miscounted field: for `progress`, the tally in words ("Counted from its steps: 5
   reads, 1 edit; 0 failed.") with the estimate (`percent`) dropped, so no bar shows a number from a reply that
   miscounted; for `found`, the rules' own found (the last finished step) as it stood when the call went out. Each
   agent call carries the tally its prompt gave, so the check judges the reply against what the narrator saw, not
   against steps taken while it wrote. Corrections are counted in `cards.narrator.corrected` (the page does not show it
   yet) and each is a debug-log line naming the field, what it said and what the tally has.
8. **Shell writes** live in a new pure file, `hooks/shell.ts`; `notesOf` runs it for `Bash` and `PowerShell` whatever
   their kind (`run` or `test`). Of several targets the touch is the one both outside and secret, else outside, else
   secret. A command that failed or was refused is not counted, as with the edit tools (it may have written before it
   failed: a miss, not a false alarm). Writes to temp folders count as outside, as they do for the edit tools.
9. **What the shell reader trusts**: quotes (single literal, double with `$`/backtick making the rest unsure), escapes
   (a path written with one is unsure; a line continuation joins), comments (`#`, PowerShell `<# #>`), heredoc bodies
   (not read: the reader stops at the next line), `2>&1`/`>&2` (no file), `/dev/null`, `/dev/fd/N`, `$null`, `NUL`
   (no file). PowerShell parameters bind by unique prefix, `-Name:value` too; positionals bind only while every option
   before them is known (an unknown one may take a value). `cp`/`mv` read GNU option clusters (`-rt dir`, `-t/tmp`),
   `--target-directory`, `--`, and a folder destination (trailing slash, `.`, `..`, or several sources) takes each
   source's name. A relative target after a `cd` in the same command, or one that climbs with `..`, keeps its name
   only: the shell tools keep their folder between calls, so `..` cannot be placed. `bash -c "..."` and other nested
   shells are not read. Commands are read up to 20 000 letters.
10. **Shell wording** for a secret name: "Wrote a file that may hold secrets with a command: <file>"; both: "Wrote a
    file that may hold secrets, outside this project, with a command: <file>". Advice follows the edit tools' pattern.
11. **gui-sim**: the page is unchanged on this branch. The `ten` scenario's outside sign was switched to the shell
    wording (harness only, backup `cards.py.bak-followups`) so the longer evidence line is drawn and filmed.
12. **axe**: with the WCAG 2.0/2.1 A and AA tags, 0 violations on cards, pinned and timeline. A run with the tool's
    default rule set also lists two best-practice rules (`region`, `heading-order`) on the unchanged page; they are not
    WCAG failures and predate this branch.
13. **Live run A** ran with `AGENT_WATCH_BROWSER=none`: the mod lays and feeds the page as usual, a hidden browser films
    it, and no Edge window opens on the owner's desktop.
14. **An independent review** of the two parsers (before run A) found false-alarm inputs; all that could raise a wrong
    flag or a wrong correction were fixed with tests (commit "Close the review's false alarms"). Left as misses: a `<<`
    inside `$(( ))` stops the reader at that line's end; bash `>&file` is read as a stream copy.
15. **Live run A (12:04, key unset, three Haiku agents)**: the circles sign came at 40.6 s, the narrator's advice
    landed at 44.6 s, and the agent looped on until about 158 s (24 reads of config.txt and 23 of notes.txt against a
    brief of 20). Refreshes landed every 30 s while it looped. The evidence count tracked the trail every 2 s (`Read
    config.txt 23 times` at 23). Every count the narrator wrote matched the tally it was sent: 5 reads (3 + 2), 16 and
    18 config.txt reads (the tally counts one failed read of config.txt; the 19th read came 2 s after that ask), and
    24 / 23 at the end. 15 calls, 0 failed, 0 cut, 1 correction.
16. **Two fixes after run A** (commit "Check \"16 config.txt reads\"..."): the checker missed the form "16 config.txt
    reads", now read; and the one correction swapped a finished agent's finding for its own answer, which held the
    agent's wrong count ("I ran 20 sequential reads") uncapped. Now only the findings that miscount go, and the stand-in
    is the last finished step, capped. These run on the final code only in tests; run A ran the code before them.
17. **Live run B (12:13, key left set)**: first a header-only launch that typed nothing ("Haiku 5.5 · Claude Max"),
    then the real run, whose first step waits for `Haiku 5.5 · Claude Max` in the header and would have stopped the
    harness, typing nothing, had it not come. It came at 1.0 s. Footer: "Narrator (Haiku) · on your Max plan · 6 calls
    · 6.1k tokens in · 891 out". No file in the evidence, the runtime folder or the worktree holds the key or its tail
    (checked in memory, nothing printed).
18. Run A's terminal scenario waited for "Agents  3 done", which never showed: the pane had closed itself by then. The
    data file sampler and the filmed page cover the whole run; the terminal's last screen is `timeout-step9`.
