# Skills are written by agents, approved by a human with a typed phrase

Status: accepted (product owner), 2026-11. Supersedes the earlier "one click for your own drafts"
decision.

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
- Approval of every draft is the typed phrase, always. `POST .../approve` with `{version, phrase}`;
  `reviewed:true` is no longer honoured. Reject and rollback are one click. The on/off switch
  (`enabled`) stays separate from approval: approving makes a version the active one, the switch decides
  whether Central may see and load it.
- Agents and Central can never approve, enable or disable: those routes need a `human:*` actor.
- Built-in skills are read-only. "Ask the agent for a variant" opens the author with the built-in's name as
  a reference; the author may only propose a NEW user skill under another name.
- An edit conversation may only touch its target skill (a new version of the same name) and a skill keeps
  its kind: the store answers `audience_immutable` when a proposal tries to flip it.
- The `human` origin value stays in the enum because old rows may hold it; nothing writes it any more.

## Why

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
