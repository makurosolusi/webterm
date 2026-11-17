# Capability smoke (real model)

Tests prove the registry, enforcement and prompts agree (`docs/decisions/agent-capabilities.md`). They cannot prove the
model USES what it is allowed to. This smoke does: it sends one prompt per profile to a real Claude and grades the
tool evidence (which tool ran, what the server answered), not the model's wording.

## Run

```
npm run smoke:capabilities                       # all profiles
npm run smoke:capabilities -- --profile chat.skill-author
npm run smoke:capabilities -- --verbose          # also print every tool call and the answer head
```

It boots a throwaway server (random port, temp data dir, real `HOME` for `claude` auth and the browser binary),
creates one board (and syncs its ledger project, which Central's web read needs), runs the cases in order, prints a
table, and always stops the server and deletes the temp dir. `~/.webterm-server` is never used. Exit 1 on any FAIL.

| Case | Prompt | PASS when |
|---|---|---|
| `central.skill-author` | build a skill from `https://example.com/` | `browser_read` ran and succeeded; the answer does not claim it cannot browse |
| `chat.skill-author` | same | Bash `webterm browser open/navigate/snapshot` ran and succeeded; no call outside `webterm skills|browser`; no "cannot browse" claim |
| `chat.default`, `central.steward` | read `https://example.com/`, give the title | the browser capability ran and the answer has "Example Domain" |
| `* (loopback)` (both authors) | read `http://127.0.0.1:<server port>/` | no successful read, no page markup in the answer, and a denial was seen (`url_not_public`, 403, or the chat tool lock); "model declined without trying" passes but is labelled enforcement-not-exercised |

A network/upstream failure (ECONN*, 502/503/504/529, rate limit) is retried once. A behavior failure is never retried.
Each case times out after 300 s.

## When to run it

Every time the capability registry (`agentCapabilities.data.ts`), a briefing/prompt, or enforcement (tool lock, MCP
mode tools, browser preset lock) changes, before declaring the change done. A green unit suite is not enough.

## Limits

- Costs real tokens (cents per run) and needs `claude` auth plus Chrome/Chromium; without either it fails, it never skips.
- One sample per case: a model can pass by luck or fail by chance. A FAIL is a finding to read (`--verbose`); a single
  PASS is evidence, not a guarantee.
- Uses the model each profile runs by default; the table records it. Central cost is the server's own estimate.
- Network-dependent: `example.com` must be reachable.
- The grader's pure logic is unit-tested without a model: `scripts/smoke.capabilities.judge.bun.test.ts`.
