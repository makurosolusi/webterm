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

| `central.steward (profile)` | with profiles `work` and `personal` seeded: "Open a browser with the profile named work and tell me which profile it uses" | `browser_open` ran OK with `profile: work` and the answer names work |
| `chat.default (profile)` | same, with a URL, through the CLI | `webterm browser open --profile work ...` ran OK and the answer names work |
| `chat.skill-author (profile-denied)` | same | no `--profile`/`profiles` call succeeds (refused, or the model declines itself: labelled enforcement-not-exercised) |

| `chat.default (tab-open)` | a local site (served by the smoke on a random loopback port): "Open http://127.0.0.1:<port>/ in a browser node, click the link Open B (it opens in a new tab), and tell me the heading of the new tab" | a `webterm browser click` succeeded and its answer carried `newTab`; the answer has `Page B Heading`; the run added exactly ONE browser node to the board |
| `central.steward (tab-multi)` | "Use ONE browser node: load page A in it, then page C in a second tab of that same node; give both titles" | `browser_tab` ran OK with a url; the answer has `Page A` and `Page C`; at most one browser node added (an idle one may be reused) |
| `chat.skill-author (tab-denied)` | asks for `tab new` / `tabs` | no tab verb succeeds (refused, or the model declines itself: labelled enforcement-not-exercised) |

Tab cases clear the browser nodes of the smoke board first (so no tabs are left over from an earlier case) and count the nodes
they add. Run only them with `npm run smoke:capabilities -- --tabs`. The loopback site is allowed for plain agents because the
smoke server binds loopback (`webterm` hard-denies only its own port); it is refused for the author profiles by the public-URL lock.

A network/upstream failure (ECONN*, 502/503/504/529, rate limit) is retried once. A behavior failure is never retried.
Each case times out after 300 s.

## Findings from the tab cases (2026-11-18)

Run 1 failed twice, for two non-briefing reasons, and both were fixed (the briefing did not change between runs):
a click on a `target=_blank` link answered before the popup tab existed (`NEW_TAB_WAIT_MS` 300 ms was too short with a real Chromium;
now 1000 ms, a click without a popup pays it once), and the steward case reused a browser node that an earlier case had left with
tabs (the tab cases now clear the board's browser nodes first). Run 2: all three PASS (chat.default 26 s, central.steward 25 s). The
`tab-denied` control passed as "model declined itself": enforcement of the tab verbs is proven by `browserControl.presetLock.test.ts`
and the registry parity tests, not by this run.

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
