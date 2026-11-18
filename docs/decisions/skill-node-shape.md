# Skill node shape

## Decision

A collapsed skill node (the default) is a **round token**, not a card. An expanded one is a **pill-radius card**
that carries the same glyph as a round avatar. Every other node is a square-ish card, so the silhouette alone says
"skill", at any zoom and in the mini-map.

## Why

- n8n draws its sub-nodes (tool, memory, model) as small round tokens with the label underneath. They are plugged
  into an agent, they are not workflow steps, so they look different from steps. A skill is exactly that kind of node.
- Node-RED and Dify use a distinct pill for lightweight nodes; Figma and Miro use a small chip for light objects.
  Shape carries the "light, attachable" meaning; colour alone does not survive zoom-out or colour blindness.

## Anatomy (collapsed)

- Circle 80x80 (`SKILL_NODE_SIZE`), 3px ring in `--skill-accent` (the theme's `--vscode-charts-purple`; no other node
  uses it), book glyph (`codicon-book`, used by no other node) 34px in the middle.
- Rim marks: status icon bottom-right (check / circle-slash / warning, never colour alone), `vN` badge top-right,
  a pulsing dot top-left while the active version changed ("Updated").
- Label under the circle: title, max 2 lines with ellipsis, full text in the tooltip; the slug (mono, smaller) shows
  on hover/selection when it differs from the title. Disabled / Unavailable keep their icon + text badge there.
- `skill-out` handle (diamond, 20px, id and type unchanged) sits at the top of the circle, on the rim, facing the
  agent whose `skills-in` is above. The cable and `skillPorts` are untouched.
- Hover/focus show Expand and Remove buttons beside the circle; double-click also expands.

## States

| State | Look |
| --- | --- |
| attached, active | full ring, check mark |
| not attached | dashed ring |
| disabled | dashed muted ring, dimmed, circle-slash, "Disabled" |
| unavailable | warning ring, dimmed, warning icon, "Unavailable", Remove |
| updated | pulse dot + "Updated vA -> vB" button |
| hover | ring 4px, label contrast up |
| selected / focus-visible | ring drawn on the circle (box-shadow on the round element); React Flow's square node box is transparent with no outline/shadow |
| dragging | slight scale + shadow |

The "port full" rule belongs to the agent's Skills port and is unchanged.

## Expanded

Card with a 20px radius (`.skill-card`), `SKILL_CARD_SIZE` 260x124, resizable as before. The avatar overlaps the
top-left corner. Expand/collapse swaps shapes with a 160ms scale/fade, disabled under `prefers-reduced-motion`.
Collapsing returns to `SKILL_NODE_SIZE`; the expanded size is remembered for the session.

## Persistence and layout

`toFlow` turns any collapsed skill (`collapsed !== false`) into the token size whatever width/height was saved, so
boards saved with the old 260x44 card load as tokens at the same top-left position. Expanded nodes keep their size.
`SKILL_NODE_SIZE` is shared, so Central/server-placed skills use the same size.

## Mini-map

Skill nodes get `--skill-accent` and a circle shape (`SkillAwareMiniMapNode`); other nodes are unchanged.

## Limits

- The token has no header, so Rename / Node color / Comments live in the expanded card.
- The label hangs below the 80x80 box; fit-view and the mini-map use the box, so a label can extend a little
  beyond the fitted area.
- Not verified without a browser: real rendering, ring on the rim, handle placement, mini-map circles.
