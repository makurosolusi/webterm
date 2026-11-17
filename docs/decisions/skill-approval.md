# Skill approval: one click for your own drafts, typed phrase for everything else

Status: accepted (product owner), 2026-11.

## Decision

- Activation (approve) and the on/off switch (`enabled`) are separate. Approving makes a version
  the active one; the switch decides whether Central may see and load it. A disabled skill is
  hidden from `skill.load` (`not_found`) and from the prompt index.
- An edit is always a new version through the same propose, lint, evaluate, pending_approval
  lifecycle. Never in place. Builtin skills cannot be edited; "Duplicate and edit" copies one
  into `webterm-<base>-copy[-n]` as a human draft.
- A draft whose recorded origin is `human` (the person saved it from the UI) is approved with one
  click after the diff is shown: `POST .../approve` with `{version, reviewed:true}`.
- Drafts with origin `central` or `agent` still need the typed phrase. `reviewed:true` on them
  answers 403 `forbidden`.
- Agents and Central can never approve, enable or disable: those routes need a `human:*` actor.

## Why the author-equals-approver case is one click

The typed phrase (R3) exists so a human does not activate text they did not read and did not
write. When the human wrote the draft, the review already happened while writing, and the UI
shows the diff against the active version right before the button. A second ritual adds friction
and no information. Everything else about approval is unchanged: the version must be
`pending_approval`, its folder hash must match the locked hash, and a clean re-lint must pass.

## Why agent origin is not one click

An agent (or Central) can be steered by content it reads, so its text is untrusted until a human
reads it. The typed phrase forces a deliberate act on exactly those drafts. `agent` is its own
origin (`agent:<nodeId>` proposers) with its own daily proposal cap, separate from Central's, so
one source cannot starve the other.

## Trust boundary

The origin is recorded server-side from the proposer actor at propose time and never taken from
the request body. The approve route trusts only that stored value.
