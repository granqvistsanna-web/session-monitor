# session-monitor

A Claude Code mod that shows, live in the chat:

- the model and effort level of the session
- plan usage: 5-hour and 7-day limits, context fill, session cost
- agents: how many are running, with status, type and model
- delegation: what this session sent to Haiku, Sonnet, Kimi, Gemini and OpenRouter, plus each off-Claude worker's calls today, OpenRouter's free calls left and how useful its drafts have been

A one-line band sits above the prompt (click the agent count to expand it). `/monitor` opens a larger pane.

Off-Claude worker figures are read from the usage log at `~/.claude/usage/delegate-log.jsonl` (or `$DELEGATE_USAGE_LOG`); without that log those rows stay empty.

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
