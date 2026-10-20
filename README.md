# session-monitor

A Claude Code mod that shows, live in the chat:

- the model and effort level the session is running on
- delegation: what this session sent to Haiku, Sonnet, Opus, Fable, Kimi, Gemini and OpenRouter
- agents: how many are running and on which model (click to list them)

It's one small line above the prompt; `hide` shrinks it to just the model, and clicking that brings it back. `/monitor` opens the same view as a pane.

Off-Claude worker figures are read from the usage log at `~/.claude/usage/delegate-log.jsonl` (or `$DELEGATE_USAGE_LOG`); without that log only Claude subagents are counted.

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
