---
name: webterm-approval-flow
description: "Risk tiers R0 to R3 and how to ask a human for approval. Use before proposing any action that changes state."
metadata:
  webterm.version: "1"
  webterm.origin: "builtin"
  webterm.caps: "approval.request"
---
# Approval flow

## Tiers
- **R0** reads. No approval needed.
- **R1** small writes on rows you own, reversible. Allowed at the propose level.
- **R2** shared changes such as spawning an agent or running a task. Needs a human approval card.
- **R3** irreversible changes such as merging a worktree, raising a budget or activating a skill. Needs a human to type the confirmation in the web UI.

## Asking
1. State the action in one sentence the human can verify against the card the server shows.
2. Give the reason and the expected result.
3. Give the undo path, or say there is none.
4. Then wait. A pending approval is not a yes, and you must not start the work yourself.

## After a decision
- Approved: continue with the exact action that was approved, nothing wider.
- Rejected or expired: do not ask again with a rephrased request. Report it and propose a different step.
