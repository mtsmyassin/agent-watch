# agent-watch: narrator follow-ups — design

Date: 2026-11-16. Owner: Mutasim. Status: approved by him (~11:25: "I agree with you on all accounts, and they should
be addressed, and your recommendations are actually spot on"). Fixes the five gaps found when the narrator insight
upgrade (main 8edbf24, `2026-11-16-narrator-insight-design.md` and its owner addenda) was verified. That design and
its addenda stay authoritative for everything this file does not change: always on, Max plan only, grounded words.

## 1. Advice arrives late

Today a fast-looping agent can finish before its trouble call is allowed, because each agent gets one call per 20 s.
Fix: a `trouble` moment (and `stuck`) may skip the per-agent 20 s wait once, so the narrator's advice lands while the
trouble is live. The 2-in-flight limit still holds; urgent moments already go first. The rules' advice keeps showing
until the narrator's arrives.

## 2. Cards go stale during long trouble

Today the narrator writes only at moments, so a card read "fifth read" while the agent was on read 22. Fix: while an
agent is in trouble or stuck, refresh its card every 30 s (a `refresh` moment, never more often than the per-agent gap
allows). Only for agents in trouble or stuck; healthy agents keep today's moments. On the Max plan this costs nothing
extra; the 400-call session cap still holds.

## 3. The narrator miscounts and believes the agent

Seen live: "about six rounds more than asked" (it was 3), and "All requested reads are done" when it had done 6 of 8.
Fixes:
- The mod does the arithmetic, not the model. The prompt's tally gives exact counts per file and per step (reads of
  each file, searches, edits, failures), and for trouble the exact repeat count. The system prompt says: use the numbers
  given, never compute or estimate a count yourself.
- Progress is judged from the trail, not from what the agent says. The prompt says: the agent's own words ("all done",
  "finished") are a claim; compare them with the brief and the tally, and when they disagree, trust the tally and say so
  (e.g. "It says it is done, but it read config.txt 6 of the 8 times asked").
- A pure check after each reply: any number in `progress` or `found` that names a count the tally has (e.g. "5 reads")
  must match it; a reply that contradicts the tally has that field replaced by the rules' wording, and the mismatch is
  counted in the debug log. Keep it simple: only counts of reads, searches, edits and failures.

## 4. The money guard, proven in his real setup

The live runs so far unset `ANTHROPIC_API_KEY`. His real terminals have it set, and Claude Code rejected it, so they run
on Max. Prove the guard there: one live run launched like his real terminal, with the key LEFT in the environment.
Before sending any prompt, check the session header says the Max plan (it showed "Claude Max" in earlier runs); if it
shows anything else, stop at once and report, without sending a prompt. The footer must read "on your Max plan".
Never print, log or store the key.

## 5. Shell writes outside the project go unseen

The outside-folder check sees only the edit and write tools. Add a best-effort check on shell commands (Bash and
PowerShell tools): flag a command whose obvious write target is outside the session folder or sensitive by name:
redirects (`>`, `>>`), `Out-File`, `Set-Content`, `Add-Content`, `tee`, `cp`/`copy`/`Copy-Item` and `mv`/`move`/
`Move-Item` destinations. Plain parsing only, no shell execution; when the target cannot be read with confidence, do
not flag. The card says "Wrote outside this project with a command: <file>". Same privacy rule: the full path stays in
the mod.

## Done means

- All existing 157 tests stay green (say which changed and why), with new tests for: the urgent skip of the 20 s wait,
  the 30 s refresh only while in trouble or stuck, the exact tally counts in the prompt, the count check replacing a
  contradicting field, the "agent says done" rule in the prompt, and the shell-write parsing (fires on each listed form,
  does not fire on reads, on targets inside the folder, or on anything it cannot parse).
- `tsc` clean; `claude plugin validate` passes; gui-sim four/ten/reduced 0 page errors and slow frames no worse than
  today (0.1%); axe 0 violations on cards, pinned, timeline.
- Live run A (recipe, key unset): an agent told to repeat a step for longer than a minute; the card's counts stay
  current (refreshed), the advice arrives while it is still looping, and every count the narrator writes matches the
  trail. Report each narrator line checked against the calls.
- Live run B (key left set, as his real terminals): header shows the Max plan, footer "on your Max plan".
- Nothing merged or pushed until he approves.
