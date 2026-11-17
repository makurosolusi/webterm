# Agent capabilities: one source of truth

## Problem

"What may agent X do" lived in at least five hand-written places that were never derived from what is enforced:
the Central author tool list (`MODE_TOOLS`), the Central author prompt, the client banner/tooltips, the chat author
tool lock plus its role prose, and the steward prompt. They drifted: the author could read web pages, yet its prompt and
banner told it (and the user) it could not browse. Patching one agent at a time left the next one stale.

## Decision

`src/shared/agentCapabilities.data.ts` declares capabilities (`skills.author`, `web.read`, `web.drive`, `canvas`,
`agents`, `memory`, `channels`) and profiles (`central.skill-author`, `chat.skill-author`, `central.steward`,
`chat.default`) as data. `agentCapabilities.ts` derives from it, with pure functions:

- enforcement: `MODE_TOOLS['skill-author']` (`grantedCentralTools`) and the chat tool lock's allowed command families
  (`grantedChatFamilies`; the strict parsers per family stay hand-written and are never loosened by the registry);
- prompts: `renderCapabilityBriefing` ("WHAT YOU CAN DO / CANNOT DO", with exact call forms and rules);
- UI text: `renderCapabilityLine` (banner, tooltips); `capabilityHash` changes exactly when the briefing changes.

`web.read` for the Central author is `browser_read` only. The server (`mcp/mcp.central.authorWeb.ts`) picks the board
the read runs on, keeps only `url`/`question` from the model, and refuses non-public URLs (`url_not_public`). The
result is tainted web data as before, and a skill draft still needs the human's typed approval.

## Guards

- `src/shared/agentCapabilities.parity.test.ts`: per profile, granted => enforcement allows a sample call and the
  briefing shows its call form; denied => enforcement refuses and the briefing lists it under CANNOT; prompts name no
  tool or command family outside the enforced set.
- `src/shared/capabilityProse.grep.test.ts`: the prompt/label files may not hand-write negative web/browser sentences.

## Adding or changing a capability

Edit `agentCapabilities.data.ts` only: add the capability (summary, denied sentence, short label, central tools and
usage, chat family and usage), then grant it in the profiles that get it. For a new chat command family also add its
strict parser to `FAMILY_DECISION` in `agentChat.toolLock.ts` (the compiler flags the missing entry). Prompts, banner
and tool lists follow; the parity test fails if enforcement does not.

## Coverage

| Profile | Consumer | What derives from the registry |
|---|---|---|
| `central.skill-author`, `chat.skill-author` | author prompts, tool lists, banner | everything (briefing, enforcement, UI line) |
| `chat.default` (plain Agent Chat node) | system prompt (`agentChat.options.ts`) | the briefing (<= 12 lines): `webterm browser ...` verbs (web.read + web.drive) and the untrusted-page rule; no CANNOT list (`listDenied: false`), because the node has a general shell and a denied list would claim more than is enforced. Attached skills stay the separate index of `agentChat.skills.ts`; the skill-author preset gets no `chat.default` text |
| `central.steward` | `CENTRAL_STEWARD_PROMPT` (`claudeOptions.ts`) | only the web sentences (`renderCapabilityProse`); the rest of the prompt stays hand-written. `capabilityMap.ts` stays the live source of access (auto/asks/blocked/off) |

Per-profile wording differences (the steward's `browser_act` is navigate/click/type only; a chat drives through CLI verbs) are
`override` entries on the profile, not edits of the shared capability.

Live switches: a granted ability can be switched off right now (browser feature or `WEBTERM_BROWSER_AGENT` off; a Central tool
`off` in the catalog). `renderCapabilityBriefing/Line/Prose(profile, off)` then say "not available right now" instead of
promising it. A chat prompt is rebuilt on every open, so it follows the switch; the steward prompt is cache-stable, so the
live state rides in the Capabilities line next to the state header.

## Sessions that already run

A resumed session keeps the system prompt it started with. `capabilityNote` (`src/server/capabilityNote.ts`) closes that gap
without polling: per scope (`central:<conversationId>`, `chat:<nodeId>`) the hash of the briefing last seen is kept as an audit
row of kind `agent.capabilities` in the ledger `event` table (no migration, the existing audit retention bounds it). On the
next turn, if the current hash differs, the turn text gets `[webterm] Capabilities updated: <line>` plus the full briefing once,
the transcript gets the same line as a system notice, and the new hash is recorded. First sight of a scope only records;
no change costs one indexed lookup. Central skips the check while no tool catalog is registered (not armed). A chat node needs
the booted Central for the ledger; without it no note is sent.

## Limits

- The first turn after this shipped only records: a session that started before it with an old prompt is not told about
  changes made before the first record. Scopes idle past the audit retention (90 days) record again silently.
- Hash = the rendered briefing, not the full prompt: editing hand-written steward prose outside the web sentences does not
  trigger a note.
- `central.steward` and `chat.default` list only what the registry models (web, plus the author's skills/canvas/agents/memory/
  channels for the steward); linked-context and other `webterm` CLI families are not in the chat briefing yet.
- Tests prove enforcement and wording match; they cannot prove the model obeys the briefing (needs a real-model smoke).
