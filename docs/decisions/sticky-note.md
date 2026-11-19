# Sticky note

## Decision

A sticky note (`kind: 'sticky'`) is a small pastel paper square on the canvas, FigJam style: handwriting, centered text,
a corner label, no node chrome. It is for human notes on the board ("Task", "Context", "P2"), not for sessions.

## Anatomy

- 180x180 by default (`STICKY_DEFAULT_SIZE`), minimum 120x120, resized through `NodeLayoutResizer` like every node.
- Paper = `stickyHex(color)` from the 10-color palette (`src/shared/sticky.palette.ts`, 5x2 grid); ink is always
  `STICKY_INK`, so the contrast is the same in light and dark themes (checked in `sticky.palette.test.ts`).
- Text in Caveat (`--sticky-font`), centered. The font size steps down with the amount of text and the box size
  (`stickyFontSize`, pure and estimated, no DOM measuring); below the minimum the note scrolls.
- Corner label (`stickyTag`, one line, ellipsis) top right.
- Double-click or Enter edits in place; Esc, Mod+Enter or blur saves. Typing is local to the field, so a keystroke never
  schedules a workspace save; the commit goes through `updateNodeData` and the normal debounced save.
- A floating toolbar over the selected note: color swatches (apply to every selected note) and the label field (only for
  a single note). The last color picked is kept in `localStorage` (a per-viewer convenience) and colors the next note.
- Created from the canvas menu "Add sticky note", a double-click on empty canvas (this replaces zoom-on-double-click),
  the command "Sticky: New Sticky Note" (default chord Mod+Alt+N; a modifier chord so it cannot fire while typing).
  A new note is born selected and open for typing.
- A locked view (Dock "View locked") makes notes read-only: no editor, no toolbar.

## Not a tab

A sticky is canvas-only. It is excluded from `isTabKind` (like Files, but with no panel either), so tab mode never lists
it, never activates it and the tab-mode "+" menu does not offer it. It still shows in Layers and on the mini-map (in its
paper color). It is registered without `withTabPortal`; there is no host to move between canvas and tab pane.

## Undo / redo

Creating and deleting a note follow the layout history (`pushLayout`, `recordClosed`) like any node. Editing the text,
color or label does not enter the history, the same as the data of every other node (`replace` changes only save).

## Decorative tilt

Each note leans a little (-2.5 to 2.5 degrees), derived from a hash of its id in a CSS `rotate`; never stored. It is
straight while selected, edited or dragged, and the transition is off under `prefers-reduced-motion`.

## Font

Caveat 5.3.0 (`@fontsource/caveat`), SIL OFL 1.1 (license kept next to the files), served locally from
`src/client/fonts/` and imported once in `main.tsx`. No CDN (see `canvas-containment.md`).

## Templates

Workspace templates do not carry notes (decision: a note is personal context of one board, not part of a reusable
layout); the server template path leaves the kind out.

## Secrets (v1)

There is NO secret masking in v1. A token pasted into a note is shown and saved as typed, in the workspace database like
all node data. Do not paste credentials into notes. Agents do not read or create sticky notes yet.

## Limits

- Paste (Cmd/Ctrl+V) with no field focused does not create a note (later).
- Font fitting is an estimate; unusual text (long words, emoji) may fit a step too large or small.
- Not verified without a browser: real rendering of the font, the tilt, the shadow and the toolbar placement.
