# Maintainer agent: let an agent operate webterm instead of telling the user to

Status: owner decisions applied (separate profile; reversible `config.write` without a card; Codemode deferred; profile lock auto-unlocked when its owner is dead; maintainer in Central panel and chat nodes through the same registry ids). Wave 1 built (section 8); waves 2-3 not started. Legend: **[V]** verified in code or docs (path given), **[I]** inferred.

## Problem

An agent that maintains a webterm instance keeps handing work back to the human. Real instances from one session:
"run `git config --global user.name`", "send a screenshot of the console error", "`docker exec ... cat SETUP_CODE`",
"open Settings and change X", "delete the `Singleton*` files". Each is something the agent could do itself, or must ask a
human to *approve* (a card), never to *type*. Goal: a `maintainer` profile that drives the instance through the same
gateway as every other agent, plus one briefing rule derived from the registry.

## 1. Inventory

### 1a. What an agent can reach today

Credentials [V `src/server/auth.ts:119-128`]: node token reaches only `/api/agent-status`, `/api/context-link`,
`/api/control/*`, `/api/tools[/*]`; capability token (`wcap_*`) only `/api/control/*`; everything else is root token or
the UI session cookie. Tiers [V `src/server/central/contracts/level.types.ts:14`]: R0 read, R1 bounded write, R2 shared
mutation, R3 irreversible; the per-tier minimum level is stored in `src/server/policy/policy.store.ts:10`.

| Domain | Capability / CLI / MCP / API | Who | Tier / approval |
|---|---|---|---|
| Discovery | `webterm agent-context` (`src/server/cli/cli.registry.ts`: sorted, `allowed` per caller, content version); Central `cap.search`/`cap.describe` (`central/tools/defs/cap.defs.ts:1`) | CLI sessions; Central | R0 |
| Registry sources | `TOOL_INDEX` = control + git + custom commands + secrets + report + skills capabilities (`cli.registry.ts:15`) | node token via `/api/tools/:name` | per capability |
| Nodes / agents | `node.spawn` R2, `node.prompt` R1, `node.wait` R0, `node.close` R2, `node.read` R0 (`capability/control.capabilities.ts:51-75`) | capability token | tier-gated |
| Approvals | `approval.request` R1, `approval.decide`/`consume` R2, `approval.read` R0 (`control.capabilities.ts:85-103`); human decision is UI-only (`approvalAuth.ts`, `docs/decisions/ui-session-cookie.md`) | agent may request, never decide | R1-R2 |
| Browser | `webterm browser ...`, `browser.read` R0 / `browser.act` R1 (`control.capabilities.ts:109-115`); Central `browser_*` tools; registry `web.*` (`shared/agentCapabilities.data.ts`) | `chat.default`, `central.steward` | R0-R1 |
| Git | `git.diff` (`capability/git.capabilities.ts:10`) read only | node token | R0 |
| Custom commands / PATH | `command.list|detect|paths|rescan` open; `add|remove|path_add|path_remove` "Human UI only" (`customCommands.capabilities.ts:11-49`) | agent reads and rescans only | R0-R1 |
| Secrets | `secret.run` (output masked), `secret.list` names only (`secrets/secret.capabilities.ts:17,28`) | node token | gated |
| Skills | `skills list|get|propose|edit`; draft needs human approval | author profiles | R1 |
| Central tools | ~76 armed tools (task statement; 86 distinct `name:` literals under `central/tools/defs/*.ts` incl. test fakes, so exact count [I]): agent, canvas, workspace (`create|rename|color|switch`), `memory.*`, `kb.*`, `health.scan|findings|analyze`, `node.inspect`, `permission.decide`, `reminder.*`, `task.*`, `project.*` | Central only (MCP, `src/server/mcp/mcp.central.ts`) | per tool; autonomy default `docs/decisions/central-autonomy-default.md` |
| Receipts | `webterm <cap> --json '{..}' --operation-id <id>`: same id + same call = same receipt (`cli/cli.launcher.ts:72,101-107`); Central `toolExec.ts` + `toolExec.receipt.test.ts` | all CLI/Central | audit row |
| Health | Central `health.*`; Doctor `src/server/doctor.ts` (`DOCTOR_IDS`: claude, tools, skills, telegram, ripgrep, tmux, sandbox, dataDir, ledger) with safe fixes only for `skills`, `sandbox`, `dataDir` (`doctor.ts:148-152`) | **UI/root only** (`/api/control/doctor` refuses node and capability tokens: `envSettings.control.ts:123`) | n/a |

### 1b. Gap table: needed by a maintainer, not reachable by an agent

| # | Incident | Gap | Source [V unless noted] | Proposed answer |
|---|---|---|---|---|
| G1 | "send a screenshot of the console error" | No agent-readable log/console path | `src/server/logs/**` exists (`logApi.ts`, `logBus.ts`, `logClientApi.ts`); no capability. `wkr-logs-217` is adding `logs.query`/`logs.summary` and the page-console bridge | Reuse theirs; grant to `maintainer` (do not duplicate) |
| G2 | "docker exec ... cat SETUP_CODE" | Setup code was a human-only secret an agent was told to fetch | removed in commit `b4fbe2f` (setup code removal); account/auth stays human | Not a gap to open: human-only by design; the agent files a card, never reads credentials |
| G3 | "open Settings and change X" | Agent cannot read effective config or change a setting. `/api/control/effective` rejects node/capability tokens | `envSettings.control.ts:123`; `/api/settings*` is root/UI only (`settingsApi.ts`, `envSettings.api.ts:15`) | `config.read` (R0, masked) and `config.set` (R1/R2, allowlisted non-secret keys) as registry capabilities |
| G4 | Doctor results | Agent cannot run Doctor or its safe fixes | `envSettings.control.ts:23,123` | `doctor.run` R0, `doctor.fix` R1 for the three safe ids |
| G5 | "delete the `Singleton*` files" | Stale Chromium profile lock needs a human `rm` | profile lock code in `src/server/browser/browser.profiles.ops.ts`, `chromium.profileLock.*` tests (`wkr-profilelock-215` active); whether a safe release verb is exposed is [I] | `browser.profile.unlock` R1: only when lock owner pid is dead, inside data dir |
| G6 | "run `git config --global ...`" | Agent should not need to; if truly needed it is outside the data dir | [I] | Agent runs repo-local config in its own terminal; global config = approval card (section 4) |
| G7 | Version / image info | No capability returns version, image tag, uptime | [I] (grep found none for agents) | `instance.info` R0 |
| G8 | Install a tool | Custom commands add/PATH are "Human UI only" | `customCommands.capabilities.ts:21-44` | Agent installs in its own terminal under a recipe dir, then `command.rescan` (already allowed) |
| G9 | Restart browser node/session | Central has `agent.*`, `canvas.reopen`, `browser_open`; no node-restart verb for CLI sessions | `central/tools/defs/canvas.reopen.def.ts`; CLI side [I] | `node.restart` R1 (close + spawn, same cwd) |
| G10 | Audio/video media faults | Under `wkr-audio-216`/browser workers | n/a | Only through G1 logs; no new surface |

## 2. Mapping to Cloudflare Codemode

Sources read: Codemode index, runtime, approvals, connectors, snippets pages (cloudflare/agents `docs/codemode/*.md`).

| Codemode concept | webterm equivalent | Verdict |
|---|---|---|
| One tool `codemode({code})`, typed integration objects | CLI `webterm <cap> --json` and Central MCP tools, one call each | Not equal: no multi-step composition in one turn |
| `codemode.search/describe` (results return into running code, not prompt) | `agent-context` (CLI) and `cap.search/describe` (Central, `cap.defs.ts`, SEARCH_MAX 25) | Equal for Central; CLI `agent-context` prints the whole list |
| Runtime decides replay/execute/pause per call; durable log; `executions()` audit | `--operation-id` receipts (same id + call = same receipt) and the ledger `event` table audit rows | Partial: idempotent retry yes; replaying a *whole script* no |
| `requiresApproval` pauses the run; `approve()` replays the log | approval cards (`approval.request` then human `decide` in UI, agent never decides: `ui-session-cookie.md`) and tier minimums (`policy.store.ts:10`) | Equal in intent; webterm is stricter (human-only decide) |
| Credentials live in connector, sandbox has no network | node token injected via env into the PTY; secrets via `secret.run` with masking; credential proxy (`docs/decisions/credential-proxy.md`) | Equal for secrets; but agents hold a general shell today, so there is no sandbox |
| `codemode.step()` for nondeterminism | none | Only needed if scripts exist |
| Saved snippets, developer-curated | skills (`skills propose`, human-approved) | Equivalent curation model already; skills are prose, not runnable |

Prompt cost, measured from the registry (renderCapabilityBriefing length / 4 as a rough token estimate, [V by running it]):
`central.skill-author` ~370, `chat.skill-author` ~375, `chat.default` ~890, `central.steward` ~975 tokens. Central has
~76 tools whose schemas the model sees [I: provider-dependent; `cap.search` exists to avoid hiding any]. Adding a
`maintainer` profile with ~12 capabilities adds roughly 600-900 tokens of briefing; that is small.

**Is a Codemode-style script tool worth it?** Not now. Token cost is not the problem (briefing under 1k tokens); the
failures in the incidents are *missing capabilities and missing rule*, not too many tool round-trips. A script tool is
a second execution path to secure (section 3). Revisit only when measured evidence appears: a maintenance task that
needs >8 sequential capability calls per turn and fails or is slow for that reason. Until then, wave 4 stays optional.

## 3. Sandbox options (only if wave 4 is ever built)

Runtime today: Bun 1.4.2 [V `bun --version`]. Findings from web search (not exhaustively verified):

| Option | Verdict |
|---|---|
| Bun `Worker` | Not a security sandbox: same process, shares the OS user, filesystem, network and env; `fetch`/`Bun.file`/`process` are all available unless every global is removed, and escape by prototype or import is a language-level hole. Fine for isolation of CPU hangs only. |
| `isolated-vm` | V8 native addon; Bun runs JavaScriptCore. Reports say install succeeds, import fails with an undefined V8 symbol; the project is in maintenance mode. **Does not run in Bun.** (WebSearch, unverified by running) |
| `quickjs-emscripten` (0.32.0 per Socket listing) | WASM QuickJS; README lists Bun support; `setMemoryLimit`, `setMaxStackSize`, `shouldInterruptAfterDeadline` give memory, stack and wall-clock caps; no ambient network or fs (host exposes only explicit functions). MIT [I: license not re-checked]. |
| Separate OS process / container | Strongest, heaviest; webterm already has `agentSandbox.ts`, but per-script spawn cost and a bridge are extra moving parts. |

**Recommendation (if built): `quickjs-emscripten`**, because it is the only option that is a real boundary, runs under
Bun, and has hard limits. Parameters: 5 s wall-clock (interrupt handler), 32 MB heap, 512 KB stack, no globals except a
frozen `webterm` object, max 20 capability calls per run, 64 KB result cap. Every call out is a host function that calls
the **same** `execTool`/`POST /api/tools/:name` path the CLI uses (`cli.registry.ts` `TOOL_INDEX`), so the tier, policy,
approval, redaction and receipt logic is enforced once. Approval-needing calls abort the run with a "pending card" result
(Codemode's pause), and the script is re-run after the human decides, using `--operation-id = hash(scriptId, callIndex)` so
already-applied calls return their stored receipt. No new route may be reachable from the sandbox that the node token cannot reach.

## 4. `maintainer` profile design

New profile id `central.maintainer` and `chat.maintainer` in `src/shared/agentCapabilities.data.ts` (same registry,
so enforcement, briefing and UI derive from it; parity test already exists). Capability ids (proposed):

| Capability | Brings | Tier | Approval |
|---|---|---|---|
| `ops.logs` | `logs.query`, `logs.summary` (from wkr-logs-217), page-console bridge | R0 | none; output redacted (`docs/decisions/secret-masking.md`) |
| `ops.health` | `doctor.run`, `health.scan|findings`, `instance.info` (version, image, uptime, data-dir path) | R0 | none |
| `ops.config.read` | effective config, secrets masked, flags/settings non-secret | R0 | none |
| `ops.doctor.fix` | the safe fixes only (`skills`, `sandbox`, `dataDir`) | R1 | none (idempotent by Doctor's own contract, `doctor.ts:2`) |
| `ops.config.write` | allowlisted non-secret settings (UI toggles, defaults) | R1 reversible keys, R2 others | R2 asks a card |
| `ops.browser` | existing `web.*`, plus `browser.profile.unlock` (dead-owner only) and `node.restart` | R1 | none for unlock when owner is dead; else card |
| `ops.workspace` | `workspace.create|rename`, project/agent spawn (already Central) | R1-R2 | existing tiers |
| `ops.tools` | install into the agent's own terminal, then `command.rescan` | R1 | none; PATH registration stays human (card) |
| `ops.artifacts` | clean runtime artifacts under the data dir: stale locks, tmp, expired downloads | R1 | none for allowlisted patterns; anything else a card |

**Stays human-only on purpose** (agent files a card, never types or asks the user to type): provider/gateway credentials
(`/api/claude-provider` is UI-only), token enable/rotate (`tokenAccess.api.ts`), auth and accounts, release tags and
GHCR, deleting user data or workspaces with content, anything outside the data dir (git global config, system packages,
docker host), Chrome cookies. Mechanism: capability `approval.request {title, why, exact action, risk}` already exists
(R1); the card shows what will run, the human clicks, the agent continues with `approval.consume`. The incident phrases
map as: "run git config" becomes a card "Set git identity (name, email) for webterm terminals"; "send a screenshot"
becomes `ops.logs`; "delete Singleton*" becomes `browser.profile.unlock`; "open Settings and change X" becomes
`ops.config.write` or a card.

**Briefing rule** (one registry-derived line, rendered by `renderCapabilityBriefing` for every profile that has any
`ops.*` capability, not hand-copied into prompts; add to `docs/decisions/agent-capabilities.md`):
"If a capability can do it, do it; if only a human can, file an approval request; never tell the user to run a shell
command or send a screenshot." `capabilityProse.grep.test.ts` style guard should fail if a prompt hand-writes it.

## 5. Security matrix

| Threat | Controls | Residual risk (honest) |
|---|---|---|
| Prompt injection from web pages or logs | page/log content marked untrusted (existing `WEB_RULES`); log output redacted; tiers R1+ need policy; `taint` tests exist (`mcp.central.taint.bun.test.ts`) | A tricked agent can still do any R0-R1 action it is granted; limit by keeping R1 verbs narrow and reversible |
| Escalation via script | single enforcement path (section 3); sandbox has no fs/net; call count and size caps | Exists only if wave 4 ships; a bug in the host bridge is a policy bypass, so keep it a thin adapter with a policy lock test |
| Secret leakage via logs/output | `ops.logs` runs through the existing masking; `config.read` returns masked values; `secret.list` shows names only | Masking is pattern based; a secret in an unusual shape can pass. Same limit as today |
| Destructive actions | R2/R3 cards; `unlock` only if owner pid dead and path inside data dir; artifact cleanup by allowlist | Allowlist mistakes; mitigated by dry-run result in the card |
| Self-approval | decide stays UI-only (`ui-session-cookie.md`); node token cannot reach it | Same-uid local process can mimic a browser (accepted risk, `approval-ui-origin.md`) |
| Rate/abuse | operation-id replay safety; per-capability rate limit [I: not found in code, to add] | Not present yet |
| Root token | maintainer holds node/capability token only, never the root token | A shell agent can read its own environment; scope is per node |

## 6. Phased plan

| Wave | Content | Files (est.) | Owner / dependency | Budget |
|---|---|---|---|---|
| 1 | Profile `central.maintainer` + `chat.maintainer`, read/diagnosis capabilities (`doctor.run`, `instance.info`, `config.read`, `logs.*` grant), briefing rule + prose guard + parity test | `agentCapabilities.data.ts`, `agentCapabilities.ts` (rule), 3 capability files under `src/server/capability/`, tests | Depends on `wkr-logs-217` for `logs.*` (wire last, can land the rest first). Does not touch audio files, so `wkr-audio-216` does not conflict | 30 min |
| 2 | Act capabilities, reversible: `doctor.fix`, `node.restart`, `browser.profile.unlock`, artifact cleanup | `browser.profiles.ops.ts` neighbours, capability file, tests | Must wait for `wkr-profilelock-215` (same lock code); parallel with 3 | 30 min |
| 3 | `config.write` allowlist + approval-card flow ("file a card instead of asking the user") | `settingsApi` adapter, allowlist data, approval request helper | Parallel with 2; may touch settings files owned by sign-in/setup workers: check first | 30 min |
| 4 (optional) | Codemode-style `webterm run` over quickjs | new dep, bridge, policy lock test | Only if evidence in section 2; Rule 10 dependency review before install | 30 min |
| 5 | CHANGELOG and docs (one worker, after 1-3) | `CHANGELOG.md`, `docs/decisions/agent-capabilities.md` | last | 15 min |

Waves 2 and 3 can run in parallel after 1 (disjoint files). Wave 1 gives immediate value: the agent can diagnose and
the rule stops "tell the user to run X".

## 7. Open questions for the owner

1. Profile scope: `maintainer` as a separate profile (recommended) or grant `ops.*` to `central.steward`? Recommend separate, so enabling it is a visible switch.
2. Should `config.write` be allowed at R1 for UI-only toggles without a card? Recommend yes for reversible toggles, card for the rest.
3. Add the Codemode-style script tool at all? Recommend no until a measured need; if yes, quickjs-emscripten only.
4. `browser.profile.unlock` fully automatic when lock owner is dead? Recommend yes (audit row + notification, per the transparent-automation preference).
5. Where does the maintainer run: Central panel agent, a chat node, or both? Recommend both through the same registry profile ids.

## Unverified

Exact Central tool count (76); whether a CLI-side node restart exists; whether `isolated-vm` fails under Bun 1.4.2 when
actually run; quickjs-emscripten licence and the 0.32.0 pin; a per-capability rate limit (not found); token estimates are
chars/4 heuristics, not tokenizer output.

## 8. Wave 1 as built (read-only diagnosis)

- Registry (`src/shared/agentCapabilities.data.ts`): one ability `ops.diagnose`, profiles `chat.maintainer` (the browser verbs of `chat.default` plus `ops.diagnose`) and `central.maintainer`. The single briefing rule `MAINTAINER_RULE` is a `rules` entry of that ability, so it renders in every profile that grants it and nowhere else; `central.steward` is deliberately not granted (`STEWARD`).
- Capabilities (`src/server/capability/maintainer.capabilities.ts`, handlers `maintainer.run.ts`, live wiring `maintainer.facts.ts`), all R0, global, idempotent, in `TOOL_INDEX`, dispatched from `cli.exec` (`runMaintainer`) like `logs.*`: `doctor.run {id?}` (reuses `runDoctor`, findings through `scrubText`), `config.read {q?, limit?}` (reuses `buildEffectiveConfig`; a secret or bootstrap key returns only `set`), `instance.info {}` (version, mode, platform, uptime, `dataDirPresent`, session and node counts, browser enabled/agent control). Answers are capped at 32 KB (`truncated` says so). `logs.query` / `logs.summary` stay as shipped (every node already has them).
- Selection: a chat node born with `preset: "maintainer"` (`AgentChatPreset`, not tool-locked). The gate reads the STORED node (`isMaintainerNode`), and presets are fixed at birth (`lockNodePresets`), so an agent cannot claim it. A node without it gets `not_maintainer` (403) and sees the three as not allowed in `agent-context`; `agent-context` carries the rule (`rule` field, and a line in the text form) for maintainer callers only.
- Not built yet: a Central tool or mode for `central.maintainer` (its briefing says so; Central tool defs are outside this wave's files), a client control to create a maintainer node (a node saved with `preset: "maintainer"` through the workspace API works), `image` / commit in `instance.info` (no source exists in the server), browser live-session detail, `doctor.run` against the live probes in a test (it needs `claude`/Telegram; the handler is tested with fakes).
