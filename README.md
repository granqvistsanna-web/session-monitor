# session-monitor

A Claude Code mod that shows, live in the chat:

- the model and effort level the session is running on
- the worker it is waiting on right now: `→ ● Kimi working…` while a foreground Kimi, Gemini or OpenRouter call runs, gone as soon as it returns or the turn ends
- quota: Kimi or OpenRouter at 70% or more of its quota shows with the percentage (amber, red from 90%); Gemini has no quota API so it never shows one
- agents: how many are running and on which model (click to list them)

It's one small line above the prompt; `hide` shrinks it to just the model, and clicking that brings it back. `/monitor` opens the same view as a pane.

At the right edge a small pie counts down the hour the prompt cache stays warm, restarting on every main-thread model call (green, then amber under 15 min, red under 5, an empty ring once cold). Clicking the minutes next to it asks Claude for a handover (the `handover` skill in `~/.claude/skills/handover`), a paste-ready summary for a fresh session.

Quota comes from `~/.claude/skills/usage/scripts/quota.py` (checked every 5 minutes and after each worker call).

## Install

In a terminal session:

```
/plugin install session-monitor --marketplace granqvistsanna-web/session-monitor
```

Or from a shell:

```
claude plugin marketplace add granqvistsanna-web/session-monitor
claude plugin install session-monitor@session-monitor
```
