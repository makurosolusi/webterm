# Skills are written by agents, approved by a human with one click

Status: accepted (product owner), 2026-11. Amended 2026-11-17: the typed phrase is gone (see below).

## Decision

- No human types a skill. There is no "New skill" form, no edit form, no "Duplicate and edit" and no
  human create / new-version / fork route. Skills are created and revised only through the author
  agents: the Central panel author conversation (mode `skill-author`, either kind) and the canvas
  skill-author node (canvas kind only).
- Every skill is structured and complete. It has a human-readable title (`webterm.title`, 3 to 80
  characters, one line, no markdown), a kind (`central` or `canvas`), a description (what it does and
  when to use it) and a body that follows one template: `## Purpose`, `## When to use`, `## Steps`
  (a numbered list of at least 2 items), `## Do not`, `## Done when`, optional `## Notes`. The lint
  enforces this for every NEW proposal (issues `title` and `structure`, the latter listing the missing
  sections), so an agent cannot propose a thin skill. A skill approved before this rule stays valid and
  loadable until someone proposes a new version of it.
- Approval of every draft is ONE click on Approve (enabled when the lint passes). `POST .../approve` with
  `{version}`; `phrase` is optional and, if sent, must still be exact; `reviewed:true` is not honoured. Reject and rollback are one click. The on/off switch
  (`enabled`) stays separate from approval: approving makes a version the active one, the switch decides
  whether Central may see and load it.
- Agents and Central can never approve, enable or disable: those routes need a `human:*` actor (403
  `human_only` otherwise). This is the trust boundary and it did not change.
- Built-in skills are read-only. "Ask the agent for a variant" opens the author with the built-in's name as
  a reference; the author may only propose a NEW user skill under another name.
- An edit conversation may only touch its target skill (a new version of the same name) and a skill keeps
  its kind: the store answers `audience_immutable` when a proposal tries to flip it.
- The `human` origin value stays in the enum because old rows may hold it; nothing writes it any more.

## Amendment 2026-11-17 (owner decision)

The owner reversed the "no one-click path" rule: the typed phrase, together with the author agent's intake,
spec summary and "go", made a simple request ("make a skill called example") take four confirmations. The
owner called it too many approvals and too wordy. The author agents now write the draft in the first turn and
the human gate is one Approve button. The "only a human can approve" boundary is enforced server-side, so
removing the phrase weakens nothing an agent could reach: an agent or node token still cannot approve.

## Why (original reasoning, partly superseded)

The one-click path existed because a human who wrote the draft had already reviewed it. With no human
authoring, every draft is text produced by a model that may have been steered by content it read, so the
typed phrase is the right friction for all of them, and one rule is easier to reason about than two.
Hand-typed skills were also the main source of thin, ad hoc skills (a title-less one-liner as a body);
routing creation through an intake conversation plus a lint-enforced template gives skills a uniform,
checkable shape. The title exists so the library reads as names a person recognises, while the `name`
slug stays the stable identifier.

## Trust boundary

The origin is recorded server-side from the proposer actor at propose time and never taken from the request
body. Agent proposals are forced to `canvas`; Central's author chooses the kind explicitly (a missing or
unknown kind is denied before the store is reached). Agent origin has its own daily proposal cap, separate
from Central's, so one source cannot starve the other.
