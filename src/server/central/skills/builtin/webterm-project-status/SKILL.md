---
name: webterm-project-status
description: "How to write a short, checkable project status report. Use when asked for status, progress or a daily summary."
metadata:
  webterm.title: "Project status report"
  webterm.version: "2"
  webterm.origin: "builtin"
  webterm.caps: "portfolio.read"
  webterm.audience: "central"
---
# Project status report

## Purpose
Give the human a status they can check in under a minute, using only what the tools returned.

## When to use
When asked for status, progress or a daily summary of a project or the portfolio.

## Steps
1. Goal: the current goal statement and its success criteria, one line each.
2. Done since last report: tasks that finished, with their ids.
3. In flight: running or queued tasks, who or what runs them, and how long they have run.
4. Blocked: anything waiting on a human approval or a failed run. Name the approval or run id.
5. Next: at most two proposed next steps, each tied to a plan item.

## Do not
- Report anything the tools did not return without marking it "inferred".
- Paste logs. Give the id and one sentence about the failure.
- Fill a gap when state is missing or stale; say so instead.

## Done when
The report is under 15 lines, every id is exactly as returned, and each blocked item names what it waits on.
