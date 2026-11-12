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

`/agent-watch gui` opens the same agents in a window of their own: a timeline with a lane per agent and a bar for every tool call, so you can see where the time went.

- Each lane's faint band is how long the agent has been alive; the bars on it are its tool calls. A call in flight is outlined in emerald and grows with the clock, then settles on its true length when it ends. Calls that ran side by side are stacked.
- Click a lane for its calls, newest first, with how long each took, its tool and token counts, and its answer once it finishes.
- `Float on top` hands over to a small window that stays above everything, the fullscreen terminal included. Click it to list every agent; it says so for a moment when one finishes. Closing it brings the full window back.
- Turn on `Open the agents window by itself` in the plugin's options to have it open the first time two agents are working. It is off by default, since a window that opens while you type takes the keyboard.

How it works, and what it cannot do: the mod writes one small data file in `~/.claude/agent-watch` whenever something changes, and the page re-reads it four times a second. Nothing listens on a port and the page fetches nothing from the network, so it is local by construction, and it has no way to send anything back to Claude, so it can only watch. A session whose data stops arriving reads `not responding` instead of pretending to still run.

It opens as a Microsoft Edge app window on Windows and in the default browser elsewhere (untested there). Set `AGENT_WATCH_BROWSER=none` to have the command lay the page down and print its path without opening anything. The floating window uses the browser's Document Picture-in-Picture, which only opens on a click and only resizes on a click; a browser without it gets an ordinary small window instead. With `prefers-reduced-motion` set, nothing animates and every change lands at once. Each session that opens the window leaves two small files in that folder; nothing clears them yet.

What ships in `gui/` and under which license (the Motion animation library and two embedded fonts) is in `gui/NOTICE.md`.

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
