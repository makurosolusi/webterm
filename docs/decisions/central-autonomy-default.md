# Central autonomy default (2026-11-17)

## Decision (owner)

"Central agent: the only thing not allowed is WRITING CODE; everything else is allowed. Default permission is
bypass. No complicated permissions." Central acts on its own by default. Code is written by workers, which Central
starts and directs.

## What changed

The control ladder used to start at `propose` (and the env ceiling at `off`), so `agent.spawn` and its siblings
were refused with `level_denied` even under the Bypass approval default. Now:

- `DEFAULT_GLOBAL_LEVEL` (`central/guard/levelStore.ts`) is `act_envelope`, the top of the ladder.
- `WEBTERM_CENTRAL_AGENTS` unset means `auto` (`central/agentsMode.ts`, the one reader used by the ceiling, tool
  registration and the executor); the registry default is `auto`, and the Worker card writes `auto`.
  The worker executor is built by default; `propose` cards only exist if the owner chooses `propose`.
- Explicit owner choices are honoured: `WEBTERM_CENTRAL_AGENTS=propose|off` (Settings > Advanced, `.env`, shell),
  a stored global/project level, "Chat only" on the Central settings card, the approval level in Settings > Claude.

## Migration (once, idempotent, markers in the `app` table)

- `central_autonomy_env_v1`: a stored Settings override `propose` (what the old card sync wrote for every install)
  becomes `auto`. A shell/.env value is never touched.
- `central_autonomy_level_v1`: a global `central_control` row at `propose` with no reason and written by the server
  (`system:*`) rises to `act_envelope`, with a `central.control` audit event. Rows with a reason or any other
  actor id are the owner's choice and stay; per-project rows are never touched.
- Both announce one startup notice: "Central autonomy default raised: it may now spawn workers and act without
  approval, except writing code; change it in Settings".

## Fences that remain (automatic refusals, not permissions)

Halt / pause, the daily budget (`spawn_daily`, token and dollar caps), concurrency caps (`cap_project`,
`cap_global`), circuit breaker and doom-loop detection, SSRF and token checks, hard `deny` rules, R3 (irreversible)
actions still asking, and: no registered Central tool writes project code
(`central.freedom.policy.bun.test.ts`, `central.autonomy.default.policy.bun.test.ts`).

Known gap: `canvas.type` types text into a terminal or agent node, so Central could dictate a shell command that
writes a file. It is the same delegation path as `task.assign` (a human-visible terminal or a worker), so it is
not blocked; only reported.

## Lowering it

Settings > Central: "Chat only". Settings > Advanced: "Workers Central may start" = `propose` (a card per worker)
or `off`. Or `WEBTERM_CENTRAL_AGENTS=propose` in `.env`. A global or per-project level can be lowered through
`PUT /api/central/control`.

## Worker run approval default (2026-11-17)

Owner: "no complicated permissions; default bypass; Central is free except writing code." The last default-on
approval gate, `WEBTERM_RUN_REQUIRE_APPROVAL`, now defaults to `off` (registry, `orchestratorRunRequireApproval`,
the Worker card sub-option). A run with no `approvalId` is accepted unless the owner explicitly sets the flag to `on`;
then the digest-bound ledger gate applies exactly as before. Explicit stored values are honoured, so no migration is
needed. Budget, daily spawn cap, halt, breaker and SSRF guards are unchanged. The Central `agent.spawn` path is
governed separately by `WEBTERM_CENTRAL_AGENTS` (default `auto`), not by this flag.
