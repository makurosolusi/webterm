---
name: webterm-project-status
description: "How to write a short, checkable project status report. Use when asked for status, progress or a daily summary."
metadata:
  webterm.version: "1"
  webterm.origin: "builtin"
  webterm.caps: "portfolio.read"
---
# Project status report

Use this layout. Keep the whole report under 15 lines.

1. **Goal**: the current goal statement and its success criteria, one line each.
2. **Done since last report**: tasks that finished, with their ids.
3. **In flight**: running or queued tasks, who or what runs them, and how long they have run.
4. **Blocked**: anything waiting on a human approval or a failed run. Name the approval or run id.
5. **Next**: at most two proposed next steps, each tied to a plan item.

## Rules
- Report only what the tools returned. Mark anything you inferred as "inferred".
- Use ids exactly as returned so a human can open them.
- If state is missing or stale, say so instead of filling the gap.
- Do not paste logs. Give the id and one sentence about the failure.
