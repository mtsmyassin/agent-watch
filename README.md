# agent-watch

A live pane for Claude Code that shows what every subagent in the session is doing right now.

Each agent gets a row: its state, its type, the task it was given and how long it has run. Under that sits the tool call it is on (or `thinking`, or `quiet for 2m 10s`), how many tools it has used and how many tokens. Agents that finished move to a short list with the opening of their answer.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install agent-watch --marketplace mtsmyassin/agent-watch
```

Answer `y` to add the marketplace, then pick a scope. `user` installs it for every project.

This repository is private. Your GitHub account has to be invited to it, and GitHub has to be set up on your computer (`gh auth login`) before the line above can fetch it.

## Using it

The pane opens by itself when the first agent starts. In the fullscreen layout it docks beside the transcript and draws a card per working agent with an activity strip; in the normal layout it sits above the prompt with one bare row per agent.

- `ctrl+x tab` moves focus to the pane, and `ctrl+x x` closes it. A pane you closed stays closed until you ask for it.
- `/agent-watch` reopens the pane and prints the whole roster as text.
- Press an agent's row to jump to its transcript. `clear finished` drops the agents that are done.
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
