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

## Limits

- `central.steward` and `chat.default` are registered but their prompts (`claudeOptions.ts`, `capabilityMap.ts`,
  agent chat options) are still hand-written: a follow-up moves them onto the renderer.
- A resumed session keeps the system prompt it started with; a prompt change reaches old sessions only after a new
  session. `capabilityHash` is available to detect that, but nothing compares it yet.
- Tests prove enforcement and wording match; they cannot prove the model obeys the briefing (needs a real-model smoke).
