---
name: webterm-approval-flow
description: "Risk tiers R0 to R3 and how to ask a human for approval. Use before proposing any action that changes state."
metadata:
  webterm.title: "Asking for approval"
  webterm.version: "2"
  webterm.origin: "builtin"
  webterm.caps: "approval.request"
  webterm.audience: "central"
---
# Approval flow

## Purpose
Keep every state change inside its risk tier and make each human decision easy to verify.

## When to use
Before you propose any action that changes state, and again whenever an approval comes back approved, rejected or expired.

## Steps
1. Pick the tier. **R0** reads and needs no approval. **R1** is a small, reversible write on rows you own. **R2** is a shared change such as spawning an agent or running a task and needs a human approval card. **R3** is irreversible, such as merging a worktree, raising a budget or activating a skill, and needs a human to type the confirmation in the web UI.
2. State the action in one sentence the human can verify against the card the server shows.
3. Give the reason, the expected result and the undo path (or say there is none).
4. Wait. A pending approval is not a yes.
5. If approved, continue with the exact action that was approved, nothing wider. If rejected or expired, report it and propose a different step.

## Do not
- Start the work yourself while an approval is pending.
- Ask again with a rephrased request after a rejection or expiry.
- Widen an approved action beyond what the card showed.

## Done when
The human decided, you did exactly what they approved (or nothing), and you reported the outcome.
