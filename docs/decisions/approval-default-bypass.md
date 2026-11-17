# Default permission level: Bypass

Status: owner decision 2026-11-17, replacing the 2026-11-12 default (Auto).

Agents asked for approval too often and slowed development down. The default level of
Settings > Claude > Permissions ("How much may agents do on their own?") is now **Bypass**
(`never`) for every agent: Claude terminals, Agent Chat nodes and Central.

## What changed

- `DEFAULT_APPROVAL_LEVEL = 'never'` (`src/shared/settings.approvalLevel.ts`). New launches use
  `bypassPermissions`; a new Agent Chat node shows the "Bypass" chip.
- One-time boot migration (`src/server/approvalDefaultMigration.ts`): a stored global Ask or Auto moves
  to Bypass once and Central posts "Default permission changed to Bypass; change it in Settings > Claude >
  Permissions". The marker `approval_default_bypass_v1` in the `app` table makes it final: a later explicit
  choice is never overwritten. Per-project overrides are never touched. Running sessions keep their old
  level until restart (the existing "N sessions still use the old level" line).
- The Central composer always shows the permission control; the skill-author "Limited tools" chip is
  only a role label next to it. Central and Agent Chat use the same name, "Bypass".

## Central

Central is free except for writing code: every registered tool runs without an approval card under
Bypass, and no registered tool writes project code (workers do, via `agent.spawn` / `task.assign`).
Both facts are locked by `central.freedom.policy.bun.test.ts`. Taint no longer asks under Bypass
(`taint.bun.test.ts`).

## Hard limits that stay (automatic refusals, never a card)

Halt and pause, spend and spawn caps, doom-loop breaker, user Deny rules and secret access, policy deny,
SSRF checks, node tokens, and the role lock of a preset chat (skill-author: `dontAsk` plus a tool lock is
the role's definition, not a prompt). The Central control level (`WEBTERM_CENTRAL_AGENTS` ceiling) is a
separate dial and is unchanged.

## Going back to Ask

Settings > Claude > Permissions, or the mode button in the Central composer: pick Ask or Auto, for all
projects or one project. Switching to Bypass keeps its one confirmation (a server-side `confirmDanger`).
