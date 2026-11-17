# Canvas skills as cabled skill nodes

Status: accepted (owner decision). Scope: skills with audience `canvas`.

## Context

The skill store holds two kinds that never mix:

- `central` skills: rules Central loads for itself. Only Central and the human see them.
- `canvas` skills: procedures for Claude agents running on the board. Agents read them with
  `webterm skills list|get` and propose new ones with `propose|edit` (a human approves).

Until now every enabled canvas skill was readable by every agent. That is global and unscoped: the
user cannot say "this agent follows the release playbook, that one does not".

## Decision

A canvas skill becomes visible on the board as a SKILL NODE. A cable from a skill node to an agent's
`Skills` port ATTACHES the skill to that agent; removing the cable DETACHES it. Central skills are
never nodes and never cabled.

Typed ports (the same idea as n8n's AI Agent sub-nodes and Node-RED's typed wires): the agent has
extra bottom ports that only accept a matching node type, and a connection that does not match is
refused while dragging. We ship one port type, `skill`:

- skill node: one source handle `skill-out` (type `skill`).
- agent node (Claude terminal agent) and agent chat node: one bottom target handle `skills-in`
  (type `skill`, diamond shaped, label "Skills").
- valid: `skill-out -> skills-in`. Invalid: skill to `link-in`, agent/browser/diff/plan to
  `skills-in`, skill to a non-Claude agent, skill to skill. Existing `link-in`/`link-out` context
  cables are untouched.

The rule lives once in `src/shared/skillPorts.ts` and is used by the client (`isValidConnection`,
`canLink`, `onConnect`), the handle menu and the server (`canvas.edit`, `canvas.open`).

## What a skill node is

A REFERENCE to a library skill by name (`data.skill`), not a copy. It always follows the ACTIVE
version: the card shows the current version, and a badge "Updated" appears when the active version
differs from the one seen when the node was added (`data.seenVersion`; clicking it acknowledges).
Nothing is frozen, so a human approving v3 reaches every attached agent without touching the board.

State, computed from the live library:

| state    | meaning                                               | effect on attachment                  |
|----------|-------------------------------------------------------|---------------------------------------|
| active   | active and switched on, audience canvas               | attached: listed and readable         |
| disabled | switched off, or disabled (hash mismatch)             | shown "Unavailable"; no effect        |
| missing  | no canvas skill of that name (renamed, central, gone) | shown "Unavailable"; no effect        |

Nothing is silently deleted: the node and the cable stay, so re-enabling the skill restores the
attachment with no rewiring.

## Enforcement is server side

The agent is identified by its node token. The attached set of node N is computed from the STORED
workspace: skill nodes (`data.skill`) whose bridge of kind `skill` targets N, N hosting skills, in
bridge order, capped. `skills.list` and `skills.get` for a canvas agent return ONLY attached,
active, enabled canvas skills. Any other canvas skill answers 404 `not_attached` (a central skill
is never reachable: 404 `not_found`). Detach is immediate because every call re-reads the stored
board; nothing is cached. The agent's own open drafts stay visible to their proposer.

## Awareness (progressive disclosure)

Like Claude skills, the agent is told the NAME and DESCRIPTION of each attached, available skill and
fetches the body on demand with `webterm skills get <name>`. Delivery reuses the existing hook
channel next to the wired-browser notice (`linkAwareness.ts`): `SessionStart` lists the index,
`UserPromptSubmit` announces only the net change since the last announcement (attach, detach,
unavailable), so cable changes reach a running agent without restart. It is a statement of fact, not
an instruction, and descriptions are quoted as data. There is no parallel channel. The cable never
appears in the context-link roster (`linkedPeerIds` ignores `skill` bridges).

Caps so awareness cannot bloat tokens: at most `MAX_ATTACHED_SKILLS` (8) per agent (the UI, `canvas.edit`
and `canvas.open` refuse the 9th, and the server ignores extras), descriptions cut to
`SKILL_DESCRIPTION_MAX` (160) characters on one line, and the whole block stays under the 10k hook cap.

## Who may attach

The human (drawing or deleting the cable, the "Add to canvas" button, the handle menu) and Central
(`canvas.open` kind `skill` with `connectTo`, `canvas.edit` link/unlink). A canvas agent has no tool
or CLI path to attach or detach itself; `webterm skills` only reads attached skills and proposes
drafts. The workspace save route is not reachable with a node token.

## Lifecycle

- Agent node removed: React Flow removes its cables, so nothing remains attached. The server also
  requires both ends of a skill cable to exist.
- Skill node removed: its cable goes with it, so the agent detaches at the next call.
- Library skill disabled or deleted: the node stays and shows Unavailable.

## Why not copy SKILL.md into `~/.claude/skills`

That folder is global to the user and unscoped (every Claude session sees it, attached or not), lives
outside the webterm data dir (no ownership, no cleanup, no hash check), would go stale against the
active version, and cannot express attach/detach per agent. A reference plus a server check keeps the
store the single source of truth.

## Rejected alternatives

- Per-agent checkbox list in a settings panel: invisible on the board, not how people already wire
  context and browsers, and no typed-port affordance.
- Copying the skill body into the node: stale after approval, a second place to edit, token bloat.
- Announcing only (no server check): a model could still `skills get` anything. Announced is not enforced.
- Reusing `link-in/link-out`: would make a skill a context-link peer and leak it into the peer roster.
- Letting the agent attach through a tool: breaks "the human decides what an agent may follow".

## Two surfaces, one per kind of skill

Control > Skills lists and writes Central skills only (rules Central follows); the Skills panel in the canvas
sidebar is the whole home of canvas skills (list, search, filter, switch, detail, drafts with the typed
approval, "Write with an agent"). Each surface has one job, and each points to the other (one muted line plus a
link). Why: the two kinds have different readers (Central vs agents on the canvas), different authors (a Central
chat vs a chat node on the board) and different next actions (a canvas skill is dragged onto the board, a Central
skill never is); one mixed library made people pick a kind in every dialog. Server side the split is enforced, not
just drawn: Central's skill-author mode refuses a `canvas` proposal (`audience_not_allowed_in_mode`), a canvas agent
is forced to the `canvas` audience (`audience_forbidden` for `central`), and approval stays a typed phrase by a human.
