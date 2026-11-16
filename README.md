# agent-watch

A live pane for Claude Code that shows what every subagent in the session is doing right now.

Each agent gets one aligned row: a mark, its type, the task it was given, what it is doing and how long it has run. What it is doing is said the way a person would say it: `Reading notes.txt`, `Searching *.txt`, `Running pytest -x`, then `Read notes.txt` once the call is over, with the number of tools used so far. A connected tool is said the same way (`Reading page`, `Listing events`, `Using the browser`), never by its internal name, and a long type is said short (`general-purpose` reads `General`). An agent that finishes fades to a dim row with a check mark and a one-line summary of its answer.

The look is deliberately quiet: no boxes and no bars, order shown by weight and brightness, and one accent color that marks an agent at work. Every working agent's mark breathes in the same slow pulse.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install agent-watch --marketplace mtsmyassin/agent-watch
```

Answer `y` to add the marketplace, then pick a scope. `user` installs it for every project.

This repository is private. Your GitHub account has to be invited to it, and GitHub has to be set up on your computer (`gh auth login`) before the line above can fetch it.

## Using it

The pane opens by itself when the first agent starts, and closes by itself about 15 seconds after the last one finishes. In the fullscreen layout it docks beside the transcript; in the normal layout it sits above the prompt and is only as tall as its rows. Where the pane is too narrow for every column, each row folds: who and how long on one line, what it is doing on the line beneath.

- `ctrl+x tab` moves focus to the pane, and `ctrl+x x` closes it. A pane you closed stays closed until you ask for it.
- `/agent-watch` reopens the pane and prints the whole roster as text. A pane you asked for stays open until you close it, with the agents that finished still listed.
- Press an agent's row to jump to its transcript.
- A finished agent's summary closes to its row after 30 seconds, and the row leaves a pane you did not ask for after two minutes. Nothing needs clearing by hand.
- While no pane is drawn (you closed it, or the terminal is too narrow) the status line under the prompt says how many agents are working.
- The model can read the same roster through the tool `mcp__agent-watch__snapshot`.

## The window

The window opens by itself the first time two or more agents are working in a session, and `/agent-watch gui` opens it by hand at any time. It has two tabs: **Cards** (the main view) and **Timeline**.

Opened by itself, it does not take the keyboard: Windows lets a window that just opened take the foreground, so a window that opened while you type would catch your keystrokes. The mod opens it through `gui/open-window.ps1`, which hands the keyboard straight back to the window you were in and lifts the new window above the others without activating it (Windows' own calls, nothing installed). Opened with `/agent-watch gui`, it comes to the front as any window you ask for. Turn the automatic opening off with the plugin option `Open the agents window by itself`.

### Cards

One card per working agent, in plain words, so you can tell at a glance who is fine, who needs you, and what each one is doing:

- A line at the top sums up the whole team, with counts (working, slow, stuck, in trouble, finished) and a bar with one segment per agent. Click a segment to jump to its card.
- Each card says what the agent is doing now (in at most 12 words), which of four stages it is at (looking, changing, checking, reporting), what it has found so far, and a health light: green while it takes steps, amber after a minute with no new step, red after two. A tool call still running counts as quiet, which is how a search that hangs shows up. The numbers (tools, tokens, time) are behind `Numbers`.
- **Progress**: a line on how far along the agent is against what it was asked, with a thin bar labeled `estimate`. It is the narrator's judgment from what the agent has done, not a measurement; with the narrator offline there is no estimate and the stage strip is the only progress shown.
- **Trouble**: rules (cheap, the same every time, and working with the narrator offline) watch for three signs, and a card that shows one turns red and moves to the top with the stuck ones:
  - going in circles: the same step (the same tool with the same arguments) 3 or more times within the agent's last 12 steps; testing again after a change is not counted;
  - failing the same way: the same step failing 3 times within its last 8 steps, or 3 failures in a row;
  - touching what it should not: any change to a file outside the session's folder, or to a file whose name looks like it holds secrets (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `credentials*`, `secrets*`). Paths are compared after resolving `..`, without regard to case on Windows. The full path is judged inside the mod and goes nowhere else; the card names only the file.

  The card's `Trouble` line gives the evidence (`Read config.py 4 times`, `The same test failed 3 times`, `Changed a file outside this project: settings.json`). A sign clears once 8 newer steps show none of it. A finished agent keeps only a change outside the project, marked `Needs a check`.
- **What to do**: hover a card, or focus it with the keyboard, for what it is fixing, how, what comes next, its progress, any trouble, and what you can do about it, with how long ago that was written. Click to keep it open; Esc closes it. The red banner at the top names every agent that is stuck or in trouble, what is wrong, and what to do, with a `Show me` button. The window can only advise: it has no way to stop an agent itself, so the advice says what you can do in Claude Code.
- A finished agent folds into one line under `Finished`. Every symbol explains itself on hover.

The words on the cards come from a small narrator: Claude Haiku (`claude-haiku-5-5`), called by the mod on the session's own login. **It runs only on a plan that does not pay per call**, such as your Max plan, and it runs only while the window is open, since its words have nowhere else to go. The mod asks Claude Code which credential the session uses; where it gets no answer it decides as Claude Code does, from the environment and two fields of `~/.claude.json` (the API keys you approved, and your login). A key in the environment counts as in use only if you approved it for Claude Code; only its last 20 characters are compared, in memory, and the key is never printed, logged, stored or sent. A session that pays per call (an approved API key, Bedrock, Vertex, Foundry) keeps the narrator off, and the footer says `Narrator off: this session pays per call. It runs only on your Max plan.` Otherwise the footer reads `Narrator (Haiku) · on your Max plan · N calls`, with the tokens used.

It writes at the moments that matter: when an agent starts, moves to a new stage, settles into a different kind of work, goes stuck, shows a new trouble sign, recovers, and finishes. Its budget: at most one call per agent every 20 seconds, two calls at a time, 400 calls a session. Each call asks for low effort, with room for 1024 tokens of reply (only what is used counts), and 15 seconds. A failure leaves the plain rules on that card; a refusal (a sign-in that ran out, billing) or three failures in a row pause it for 1 minute, then 2, then 5, then every 5, and it tries again by itself; the footer says it paused and when it tries again. On a Max plan this costs no money; the footer shows the usage anyway.

What it is sent is masked first, the same way as everything else this mod shows: the agent's type and task, the brief it was given (600 letters), its stage, a tally of its whole trail (steps by kind, failures, the names of the files it read and changed, at most 12 each), any trouble the rules found with its evidence, and its last eight tool calls with the opening of what each returned. It is told to say only what those steps show, to name the files and functions, never to guess, and to write `Not clear yet` when the steps do not show something. What it writes back is checked before it is shown: it must be the expected small JSON; control characters are stripped; "now" is held to 12 words and the explanation's fields to about 40 words; "found so far" to 3 findings; the estimate must be a number, held to 0-100; advice that would have you run a command or paste code is dropped (the rules' advice stands in); and the page sets it all as plain text.

Whenever the narrator has nothing (not written yet, a call failed, it paused, its budget is spent, or it is switched off) the card shows the plain rules instead, the same wording the pane uses (`Reading notes.txt`, `Ran pytest -x`), and says so. Turn it off with the plugin option `Plain-words narrator in the agents window` (on by default): the cards then use the plain rules and no model is ever called. In a nested worker (`DELTAO_NESTED_CLI=1`) the whole mod is off unless `AGENT_WATCH=on`.

### Timeline

A lane per agent and a bar for every tool call, so you can see where the time went.

- Each lane's faint band is how long the agent has been alive; the bars on it are its tool calls. A call in flight is outlined in emerald and grows with the clock, then settles on its true length when it ends. Calls that ran side by side are stacked.
- Click a lane for its calls, newest first, with how long each took, its tool and token counts, and its answer once it finishes.
- `Float on top` hands over to a small window that stays above everything, the fullscreen terminal included. Click it to list every agent; it says how many need you, and says so for a moment when one finishes. Closing it brings the full window back.

How it works, and what it cannot do: the mod writes one small data file in `~/.claude/agent-watch` whenever something changes, and the page re-reads it four times a second. Nothing listens on a port and the page fetches nothing from the network, so it is local by construction, and it has no way to send anything back to Claude, so it can only watch. A session whose data stops arriving reads `not responding` instead of pretending to still run.

It opens as a Microsoft Edge app window on Windows and in the default browser elsewhere (untested there). Set `AGENT_WATCH_BROWSER=none` to have the command lay the page down and print its path without opening anything. The floating window uses the browser's Document Picture-in-Picture, which only opens on a click and only resizes on a click; a browser without it gets an ordinary small window instead. With `prefers-reduced-motion` set, nothing animates and every change lands at once. Each session that opens the window leaves two small files in that folder; nothing clears them yet.

What ships in `gui/` and under which license (the Motion animation library and two embedded fonts) is in `gui/NOTICE.md`.

## What it touches

It only watches. It never blocks, changes or delays a tool call: the bookkeeping runs after the event has gone on its way, at a measured cost of about 2 ms per subagent tool call. What it does on its own: the narrator's model calls described above (only while the window is open, only on a plan, within that budget; they show in `/cost` like any other call), opening the window the first time two agents work (through `gui/open-window.ps1` on Windows), and, once per session start, reading which credential the session uses as described above.

Text shown in the pane is masked first when it has the name or the shape of a credential (`TOKEN=...`, `curl -u user:pass`, `mysql -p ...`, bearer headers, cookies, private keys, long random strings). This is a best effort for a screen you may be sharing, not a guarantee: a password passed to a tool the mod does not know can still show.

## Switches

- In a session started with `DELTAO_NESTED_CLI=1` (a worker spawned by another Claude session) the mod registers nothing and every hook passes straight through. Set `AGENT_WATCH=on` to turn it back on there.
- In a headless run (`claude -p`, the SDK) it keeps the roster and answers the command and the tool, but opens no pane and runs no clock.

## Working on it

```
claude plugin validate .
claude plugin test .
```

The tests are in `tests/`: `agent-watch.test.tsx` for the pane and the window's data, `narrator.test.tsx` for the kind, stage and health rules, `narrator-logic.test.tsx` for when the narrator speaks and what it may say, `narrator-wiring.test.tsx` for the narrator inside the mod, `trouble.test.tsx` for the trouble rules, `insight-logic.test.tsx` and `insight-wiring.test.tsx` for trouble, progress and advice in the narrator and the mod, `billing.test.tsx` and `always-on.test.tsx` for the plan guard and the pauses, `detail.test.tsx` for the narrator's lengths and grounding, and `auto-open.test.tsx` for the window opening by itself. The rules themselves are pure functions in `hooks/infer.ts`, `hooks/trouble.ts`, `hooks/billing.ts` and `hooks/narrator.ts`. Built and tested on Claude Code 2.1.322 and 2.1.325; the mods API is early access, so a later version may need changes.
