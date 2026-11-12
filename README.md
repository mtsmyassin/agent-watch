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

## What it touches

It only watches. It never blocks, changes or delays a tool call: the bookkeeping runs after the event has gone on its way, at a measured cost of about 2 ms per subagent tool call.

Text shown in the pane is masked first when it has the name or the shape of a credential (`TOKEN=...`, `curl -u user:pass`, `mysql -p ...`, bearer headers, cookies, private keys, long random strings). This is a best effort for a screen you may be sharing, not a guarantee: a password passed to a tool the mod does not know can still show.

## Switches

- In a session started with `DELTAO_NESTED_CLI=1` (a worker spawned by another Claude session) the mod registers nothing and every hook passes straight through. Set `AGENT_WATCH=on` to turn it back on there.
- In a headless run (`claude -p`, the SDK) it keeps the roster and answers the command and the tool, but opens no pane and runs no clock.

## Working on it

```
claude plugin validate .
claude plugin test .
```

The tests are in `tests/agent-watch.test.tsx`. Built and tested on Claude Code 2.1.322; the mods API is early access, so a later version may need changes.
