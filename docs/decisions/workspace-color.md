# Workspace color

## Problem

Workspace tabs looked alike (a grey dot each), so the user could not tell which workspace they were in without reading the name.
The color has to be a marker the user recognises at a glance, available to the human (picker) and to Central (tool), and stable.

## Decision

- **Named palette, not free hex.** `src/shared/workspaceColor.ts` holds 12 hues (`red ... slate`) and 3 shades (`soft|default|vivid`).
  A workspace stores `color` (hue id) and `color_shade`. The server rejects anything else with 400, so every stored value is one
  whose contrast was checked: tokens live in one file, `src/client/workspaceColor.css`, per theme, and
  `workspaceColor.contrast.test.ts` fails when a token drops below 3:1 (WCAG 1.4.11) against the worst tab/status surface.
- **Random, but distinct.** A new workspace gets a random hue that no other workspace uses (all taken: random among the least
  used), `pickWorkspaceColor(used, rand)`. Picking happens in `Db.create`, the only INSERT, so the dialog, the API, Central's
  `workspace.create` and templates all behave the same.
- **Stable backfill.** The `color` column already existed as free text nothing wrote. Rows without a palette hue get one derived
  from the workspace id (`backfillWorkspaceHue`), so an old workspace keeps the same color on every boot instead of a new random one.
- **Color is not part of the board save.** It is written only by `Db.setColor` (`PUT /api/workspaces/:id/color`, Central's
  `workspace.color`). A window holding an older board copy therefore cannot revert a color another window just chose, and
  a color change does not bump `updated_at` (nobody's unsent board save turns into a 409). Windows follow through
  `t:'workspaceColor'`.
- **The tab dot keeps its meaning.** The dot is agent status ("neutral" = unknown). Identity is a separate marker: a bar on the
  tab's bottom edge (3px when active, plus the active tab's top border), a chip next to the name in the title bar and the status
  bar, and the sidebar monogram.
- **Central yields and announces.** `workspace.color` (R1) reads or changes the color, refuses while the user is moving the canvas
  (same rule as `workspace.switch`), and every change shows a notice with Undo and writes a bounded `central.act` record. Central's
  state header carries the color of the viewed workspace and of each listed project.

## Not done on purpose

- No color choice in the create dialog: a new workspace is already distinct, and the picker is one right-click away (Color...).
- No hex input: swatches, shades and a Random button only.
