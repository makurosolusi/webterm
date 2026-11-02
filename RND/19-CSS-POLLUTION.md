# CSS pollution audit after the shadcn migration

> ARSIP: digantikan oleh 17-SHADCN-CSS-DEBT.md; dipertahankan untuk riwayat.

**Snapshot:** 2026-11-02, branch `feature/shadcn-ui`, HEAD `20a0ab3`. The working tree changed concurrently while this audit was being written (19 modified files by 06:26 UTC, including `styles.css`). CSS line counts below were re-measured at that point; the class inventory and dead-rule findings were re-checked against the same tree.
**Scope:** the 12 presentation sheets plus `index.css`, cross-checked against every `src/client/**/*.ts(x)`, including template literals, test files, and the `components/ui` primitives.
**Status:** analysis only. No source file was edited, deleted, or committed. This document is the only artifact.

## 1. Method

1. Parsed every rule and selector in the 13 sheets.
2. Extracted every class token, then searched it in all `.ts/.tsx` files, including tests.
3. Separated static class names from names produced by template literals (`tab__dot--${x}`) and from third-party runtime classes (React Flow).
4. Enumerated every enum that feeds a dynamic class (`StatusGroup`, `StatusKind`, `InboxState`, `ChatRole`, `ChatToolState`, `editorFileKind`) to prove each variant reachable.
5. Counted `!important`, literal colors, `var()` fallbacks, `@keyframes`, `@media`, duplicate selectors, and selectors at specificity `(0,3,0)` or higher.
6. Compared each custom rule against the primitive it decorates (`Button`, `Input`, `Textarea`, `Badge`, `Card`, `Tabs`, `Separator`, `Dialog`).

## 2. Headline counts

| Metric | Value |
|---|---:|
| Presentation CSS (12 sheets) | 2,720 lines |
| Plus `index.css` | 2,764 lines |
| Rules (all 13 sheets) | 426 |
| Rule preludes that contain a class selector | 407 |
| Unique class names | 295 |
| Whole selectors proven dead | **1** |
| Dead declarations inside live rules | **3** |
| Orphan class hooks in TSX (no CSS anywhere) | **8** |
| `!important` | 2 (1 load-bearing, 1 unnecessary) |
| Only unused `@keyframes` | **0** (5 defined, 5 referenced) |
| Non-token color declarations | 8 (plus 3 mask endpoints, see §6) |
| Literal `var()` fallbacks | 83 (dock 1, inbox 32, chat 50) |
| Invalid `rgba(var(--token, #hex), alpha)` fallbacks | **18** |
| Full surface blocks (`background` + `border` + `border-radius`) | 40 |
| Overlay surfaces that duplicate each other or a primitive | 6 |
| `:focus-visible` overrides that duplicate a primitive ring | 3 |
| Selectors at specificity `(0,3,0)` or higher | 21 |

The prior ledger in `RND/17-SHADCN-CSS-DEBT.md` is broadly correct: **almost no whole selector is dead**. What remains is not dead code but *duplicated intent*: custom declarations re-implement what `Button`, `Input`, `Textarea`, `Badge`, `Card`, `Tabs`, and `Separator` already provide. That duplication is the pollution, and it is why later JSX utilities cannot win (see §7).

## 3. Per-sheet table

`Class rules` counts rule preludes containing at least one class. `Colors` counts declarations whose color is not a token (mask endpoints excluded). `Fallbacks` counts literal `var(--token, literal)` values. `Reclaim` is the estimated CSS line saving from §9.

| Sheet | Lines | Rules | Class rules | Classes | `!important` | Colors | Fallbacks | Reclaim | Verdict |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `styles.css` | 413 | 39 | 35 | 25 | 0 | 0 | 0 | 4 | Tokens + shell + tab strip. Healthy. Only the `TabsList` reset is utility-shaped. |
| `node-chrome.css` | 308 | 58 | 51 | 38 | 1 (!) | 0 | 0 | 19 | Node geometry and status. One redundant `textarea` block, two Badge/utility duplications. |
| `dock.css` | 173 | 23 | 22 | 19 | 0 | 2 | 1 | 7 | 38px rail is bespoke by design. `#fff`/`#1a1206` literals, one Separator duplication. |
| `canvas-ui.css` | 163 | 22 | 22 | 13 | 1 (!) | 0 | 0 | 12 | Highest concentration of data-slot overrides. One no-op `!important`; one removable aria-disabled override. |
| `agent.css` | 56 | 7 | 7 | 5 | 0 | 1 | 0 | 8 | Small, but its menu surface duplicates `files-menu` and `node-menu`. |
| `files.css` | 115 | 24 | 24 | 17 | 0 | 0 | 0 | 31 | Clean colors, but the menu button block repeats `Button ghost sm` verbatim. |
| `editor.css` | 215 | 30 | 30 | 13 | 0 | 0 | 0 | 0 | Monaco wrapper and markdown typography. Do not touch. |
| `cleanView.css` | 64 | 4 | 2 | 7 | 0 | 0 | 0 | 10 | The hide list is minimal. The hint duplicates the dock plate surface. |
| `settings.css` | 140 | 32 | 32 | 29 | 0 | 2 | 0 | 27 | Highest ratio of reclaimable lines (19%). Full-screen Dialog reset is utility-shaped. |
| `sessions-panel.css` | 418 | 56 | 54 | 43 | 0 | 0 | 0 | 20 | Best-behaved large sheet: zero literal colors, geometry only. Three Button duplications. |
| `inbox.css` | 306 | 59 | 59 | 43 | 0 | 0 | 32 | 11 | Contains the only proven-dead rule, 6 invalid fallbacks, and 2 dead declarations. |
| `chat/chat.css` | 349 | 69 | 69 | 51 | 0 | 2 | 50 | 10 | Top offender by fallback count (12 invalid) and theme-blind black surfaces. |
| `index.css` | 44 | 2 | 0 | 1 | 0 | 1 | 0 | 0 | Tailwind imports, `@theme` mapping, scoped reset. Keep as-is. |
| **Total** | **2,764** | **426** | **407** | **295 unique** | **2** | **8** | **83** | **159** | 5.8% of all CSS is reclaimable without changing design. |

## 4. Proven dead (strict)

A whole selector is listed only if no TSX element can produce it. All other classes in the 13 sheets were found in production code, in a dynamic family, or in React Flow.

### 4.1 Dead rule

| Item | Evidence | Why dead |
|---|---|---|
| `.inbox-consent input[type='checkbox']` (`inbox.css:271`, 5 declarations) | `rg -n "input\\[type='checkbox'\\]" src/client --glob '*.css'` returns only this rule. In the approval dialog the consent control is `<Checkbox>` (`inboxApprovalDialog.tsx:144`), which renders a Radix `button[data-slot=checkbox]`, not a native input. `shadcnPolicy.test.ts` forbids raw `<input>` outside `components/ui`, so no native checkbox can ever appear. | Selector can never match. Delete the block. |

### 4.2 Dead declarations inside live rules

| Item | Evidence | Why dead |
|---|---|---|
| `.inbox-check { accent-color: var(--accent, #0a84ff) }` (`inbox.css:118`) | `.inbox-check` is passed to the Radix `Checkbox`, which renders `<button role="checkbox" data-slot="checkbox">`. `accent-color` only affects native form controls. | One no-op declaration. Width, height, margin, and cursor in the same block do apply and must stay. |
| `.cluster-search { width: auto !important }` (`canvas-ui.css:46`) | `buttonVariants` in `components/ui/button.tsx` contains no width utility at any size. `Button` is `inline-flex`, so its width is already content-sized. The rule overrides nothing. | Delete the declaration. `!important` is not needed anywhere in this sheet. |
| `.st-dialog-content { inset: 0; left: 0; ...; top: 0 }` (`settings.css:9-14`) | `left:0` and `top:0` restate values already set by `inset:0` in the same block. | Remove the two restatements. Zero visual change. |

### 4.3 Orphan class hooks in TSX (inverse pollution)

These class names are applied but have no rule in any CSS sheet, so they are inert strings. They are not CSS lines, but they mislead future audits and make selectors look like they exist.

| Class | Location | Evidence |
|---|---|---|
| `field` | `FilesNode.tsx:233` | `rg -n "^\\.field\\b" src/client --glob '*.css'` returns nothing. Removed legacy contract from `RND/17`. |
| `sessions-sidebar__filter-input` | `SessionsPanel.tsx:217` | CSS styles `.sessions-sidebar__search input`, not this class. The class is a no-op. |
| `dock-workspace-dialog` | `Dock.tsx:194` | `dock.css` defines `-add-dialog` and `-zoom-dialog`, never `-workspace-dialog`. |
| `palette` | `HelpOverlay.tsx:36` | No `.palette` rule exists. |
| `palette__list` | `HelpOverlay.tsx:42` | No rule. |
| `palette__section` | `HelpOverlay.tsx:43` | No rule. |
| `palette__item` | `HelpOverlay.tsx:45` | No rule. |
| `palette__hint` | `HelpOverlay.tsx:47` | The only rule is scoped `.canvas-command-content .palette__hint` (`canvas-ui.css:94`), which cannot match HelpOverlay. |
| `folder-picker__entry` | `FolderPicker.tsx:53` | No rule; presentation is pure utilities. Intentional-looking but unverifiable hook. |
| `kanban-card` | `Kanban.tsx:66` | No rule; presentation is pure utilities. |

Expected command result after cleanup: the orphan loop in §10 prints nothing except the documented intentional hooks.

## 5. Redundant but live

Every item below matches a real element today. Risk is the chance that deleting the duplicated declarations changes appearance in a way the existing text-only tests cannot catch.

| # | Rule(s) | Duplicates | What is actually unique | Risk |
|---|---|---|---|---|
| 1 | `.usage-pill` (6 lines) | `Badge variant="outline"` (`inline-flex`, border, text color, radius, padding, text size) | Height 26px, gap 6, padding `0 8px`, radius 13, mono font 11px | Low. Keep the unique metrics, drop display/align/border/color. |
| 2 | `.st-card` (6 lines) | `Card` (`bg-card`, `border`, `rounded-xl`) | Padding `4px 14px 12px`, radius 8 | Low. Card already paints the surface. |
| 3 | `.node-swatch` (8 lines) | JSX utilities `size-3 rounded-full border-0` | `flex-shrink`, `cursor` | Low. Utilities already express the size and shape. |
| 4 | `.ss-empty button` (11 lines) | `Button variant="outline" size="xs"` | `margin-top` and 11.5px font | Low. |
| 5 | `.ss-group__chev` (14 lines) | `Button variant="ghost" size="icon-xs"` | 18px box (vs 24px), radius 4, muted color | Low. |
| 6 | `.files-crumb` (13 lines) | `Button variant="ghost" size="xs"` | max-width/ellipsis, dense padding, muted color | Low. |
| 7 | `.files-menu button` (13 lines) | `Button variant="ghost" size="sm"` | Dense row padding only. Hover re-implements `accent` but pairs accent background with `--accent-text`, a contrast bug (see §6). | Medium. Row height changes if deleted unless padding utilities are added. |
| 8 | `.chat-list-item` (14 lines) | `Button variant="ghost"` | Full width, dense padding, muted color, selected state | Low. |
| 9 | `.st-nav` (11 lines) | `Button variant="ghost"` | Left alignment, 7/10 padding, muted color, `is-active` accent | Low. |
| 10 | `.st-chip` (11 lines) | `Button variant="ghost"` | Accent pill, 999 radius, 12px font, dense padding. Note: Button `h-9` still wins over the 3px padding, so the chip is 36px tall, not ~22px. | Medium. This is a real layer mismatch, not just redundancy. |
| 11 | `.sessions-sidebar__search input` (11 lines) | `Input` (`w-full`, border, rounded-md, outline-none, font, focus ring) | Tint background, 7px radius, right padding for the clear button, compact font | Low. |
| 12 | `.chat-composer__input` (14 lines) | `Textarea` (border, radius, outline-none, font, width) | Flex sizing, dense padding, tinted background, line-height, overflow | Low. |
| 13 | `.node-comments__composer textarea` (9 lines) | `Textarea` (border, radius, background, color, font, outline-none) | min/max height, dense padding, `field-sizing: fixed` | Low. |
| 14 | `.inbox-panel :focus-visible`, `.inbox-dialog :focus-visible`, `.chat-panel :focus-visible`, `.chat-composer__input:focus-visible` (10 lines total) | Primitive focus ring on `Button`, `Input`, `Checkbox`, `Tabs`, `Textarea` | A visible ring on non-primitive focusables (`summary`, markdown links) | Medium. Narrow the selector to those elements instead of deleting outright. |
| 15 | `.node-menu__item[aria-disabled='true']` override (6 lines) | Nothing: it patches `.node-menu__item:hover:not(:disabled)` | Makes aria-disabled rows inert | Low. Fold into the base hover selector: `:hover:not(:disabled):not([aria-disabled='true'])`, delete the override. |
| 16 | `.dock-sep` (6 lines) | `Separator` (`h-px w-full bg-border`) | 22px width, vertical margin | Low. |
| 17 | `.st-dialog-content` (19 lines) | `DialogContent` (`fixed`, `top/left 50%`, translate, max-width, padding, border, radius, background) | Full-viewport row layout and `translate: none` reset | Medium. Needs utilities on the primitive plus visual diff. |
| 18 | `.tabbar__tabs` reset (`height/width/padding/justify-content`, 4 lines) | `TabsList` (`h-9`, `w-fit`, `p-[3px]`, `justify-center`) | Overflow/fade/scroll behavior | Medium. This is the uncommitted working-tree change; verify the underline still sits inside the tab. |
| 19 | `.st-input-num`, `.st-input-hex`, `.st-select`, `.st-mono` (4 lines) | `Input w-full`, `SelectTrigger w-fit`, `font-mono` utility | Nothing | Low. Move widths to `w-[84px]`, `w-[92px]`, `w-60`. |
| 20 | `.dock-action-row` (5 lines) | `Button` (`inline-flex`, gap-2) | `justify-start`, `w-full`, gap 8 | Low. Expressible as utilities. |
| 21 | `.files-filter` (1 line) | `Input` | `margin: 4px 8px 0` | Low. Expressible as `mx-2 mt-1`. |
| 22 | `.inbox-filters > [data-slot='tabs']` (1 line) | Nothing | `min-width: max-content` | Low. Post to `TabsList className="min-w-max"`. |
| 23 | Overlay surface cluster (`.node-menu` 13, `.files-menu` 13, `.node-comments` 6, `.node-swatch-pop` 14, `.canvas-command-content` 9, `.clean-view-hint` 24) | Each other, plus `Popover`/`DropdownMenu` surfaces | Positioning, portal, submenu geometry, fade animation | High. Six implementations of one visual surface. |
| 24 | `.controls-cluster > button` (14 lines) | `Button` default variant | Menu-tinted floating plate | Medium. Cannot delete without changing the variant to `outline`/`secondary`, otherwise the blue default appears. |

Counts: roughly 16 rules restyle a `Button` (two of them only carry semantic state); 3 rules restyle `Input`/`Textarea`, plus 4 width-only field rules and 2 bespoke inputs (`.tab__edit`, `.node-title--edit`); 6 overlay surfaces duplicate each other; 1 Badge duplicate; 1 Card duplicate; 1 Separator duplicate.

## 6. Colors, specificity, and cascade

### 6.1 Invalid fallbacks (18)

The pattern `rgba(var(--token, #hex), alpha)` is invalid when the fallback fires: `rgba()` cannot parse `#ff453a`. Tokens always exist today, so this is latent, not visible. It still bypasses the token contract and will break any isolated mount that the file comments claim to support.

| Sheet | Lines |
|---|---|
| `inbox.css` | 88, 90, 194, 195, 196, 258 |
| `chat/chat.css` | 72, 133, 135, 204, 242, 244, 252, 253, 279, 280, 281, 296 |

Fix: drop the literal fallback and use `color-mix(in srgb, var(--token) 40%, transparent)` where the token exists, or define the missing token. Do not keep a hex inside `rgba(var(...))`.

### 6.2 Non-token colors (8 declarations)

| Declaration | File:line | Problem |
|---|---|---|
| `--color-primary-foreground: #fff` | `index.css:16` | Token layer hardcode. Acceptable for white-on-accent, but it should point at an `--accent-foreground` token so a theme can flip it. |
| `color: #fff` | `dock.css:58` (`.dock-add`) | Accent button foreground bypasses the token. |
| `color: #1a1206` | `dock.css:101` (`.dock-badge`) | Dark brown text on `--state-attention`. In light theme attention is `#c62a1f`, so contrast is poor. |
| `color: #fff` | `settings.css:57` (`.st-nav.is-active`) | Duplicates `--color-primary-foreground`. |
| `color: #fff` | `settings.css:113` (`.st-chip`) | Same. |
| `background: rgba(0, 0, 0, 0.24)` | `chat/chat.css:219` (`.chat-markdown pre`) | Theme-blind: stays black in the light theme. |
| `background: rgba(0, 0, 0, 0.18)` | `chat/chat.css:318` (`.chat-composer__input`) | Same. |
| `box-shadow: ... rgba(0, 0, 0, 0.45)` | `agent.css:11` (`.node-menu`) | Ignores `--shadow-k`, so the menu shadow does not lighten in the light theme. All other floating surfaces do. |

Mask endpoints (`#000` in three `linear-gradient` masks, `styles.css`) are intentional: a mask needs an opaque stop. Keep them.

### 6.3 Contrast defect worth fixing, not deleting

`.files-row--sel` (`files.css:63`) and `.files-menu button:hover` (`files.css:115`) pair `background: var(--accent)` with `color: var(--accent-text)`. Both values are blue in both themes: `accent-text` is lighter in the dark theme and darker in the light theme, but it is never a foreground for an accent fill. Contrast is low in both, so the selected row and the hovered menu item are blue-on-blue. Use `#fff` (via the primary-foreground token) or `--text`, not `--accent-text`.

### 6.4 Specificity and override hotspots

| Specificity | Selector | File:line | Verdict |
|---:|---|---|---|
| (0,5,0) | `.react-flow__node:has(.term-node.working)::after` | `node-chrome.css:45`, `:300` | Required. Glow must live on the React Flow wrapper. Guarded by `styles.test.ts`. |
| (0,5,0) | `.react-flow__node:has(.term-node.attention)::after` | `node-chrome.css:75`, `:304` | Required. Same reason. |
| (0,4,0) | `.tab:not(.tab--active):hover` | `styles.css:280` | Required. Hover must not repaint the active tab. Guarded by `workspaceBarChrome.test.ts`. |
| (0,4,0) | `.dock-btn.dock-add:hover:not(:disabled)` | `dock.css:59` | Required to beat `.dock-btn:hover`. |
| (0,3,0) | `.dock-btn:hover:not(:disabled)` | `dock.css:43` | Required. |
| (0,3,0) | `.tabbar__tabs [data-slot='tabs-trigger']::after` | `styles.css:297` | Required: moves the line inside the `overflow-x` clip. Guarded by test. |
| (0,3,0) | `.tab:hover .tab__caret` | `styles.css:367` | Fine. |
| (0,3,0) | `.react-flow__handle.bridge-handle:hover` | `styles.css:410` | Fine. |
| (0,3,0) | `.canvas-command-content [data-slot='command-item'][aria-current='true']` | `canvas-ui.css:78` | Over-specific. `.canvas-command-content` is already the DialogContent root. `[data-selected='true']` alone would cover cmdk. |
| (0,3,0) | `.node-menu__item[aria-disabled='true']:hover` | `canvas-ui.css:154` | Removable by folding into the base hover selector (§5 #15). |
| (0,3,0) | `.files-crumb-wrap:last-child .files-crumb` | `files.css:40` | Fine. |
| (0,3,0) | `.st-card .st-field:last-of-type` | `settings.css:133` | Fine. |
| (0,3,0) | `.ss-row:hover .ss-row__close` | `sessions-panel.css:389` | Fine. |
| (0,3,0) | `.editor-node__md-body th:not([align])` | `editor.css:213` | Required for markdown alignment. |
| (0,3,0) | `.chat-proposal[data-tool="..."]` | `chat/chat.css:249-250` | Fine. |

The one high-specificity override that should be *raised* is `.react-flow__minimap.minimap-dock` (`styles.css:132`). It exists because React Flow's own single-class rule loads later. Do not simplify it.

### 6.5 The cascade-layer problem (root cause of the duplication)

`index.css` imports Tailwind into layers:

```css
@layer theme, base, components, utilities;
@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/utilities.css" layer(utilities);
```

Every custom sheet is imported outside any layer. Unlayered declarations beat **all** layered utilities regardless of specificity. Consequences:

1. A JSX utility cannot override a custom sheet. `Button`'s `bg-primary` loses to `.dock-btn { background: transparent }`. That is why the dock works today.
2. Custom sheets must keep duplicating primitive chrome, because the primitive's layer is powerless.
3. Some utilities are silent no-ops or fight the sheet in surprising ways. `.st-chip` sets `padding: 3px 10px` but Button's layered `h-9` still fixes the height at 36px. `.node-swatch` sets `size-3 rounded-full border-0`, which duplicates CSS rather than overriding it. `ChatPanel`'s `gap-0 p-0` works only because `.chat-panel` never declares gap or padding.
4. **Do not wrap all sheets in `@layer components` as a first move.** That reverses the precedence and would immediately paint every default `Button` (dock, cluster, file menu) blue and apply primitive padding/height everywhere. Layering is only safe after every Button pairing is converted to a matching variant, which is a separate migration, not a cleanup.

Recommended order: delete duplicate declarations first (§9 waves 1-3), then optionally layer only sheets whose primitives already match (`settings`, `inbox`, `chat`), with a visual diff per surface.

## 7. Rules superseded by Tailwind utilities

Strict answer: **zero rules can be deleted merely because a utility exists**, because of §6.5. The dependency runs the other way: utilities cannot supersede the sheets.

What does exist is utility-shaped CSS that expresses the same thing a class list could:

| Rule | Declarations a class list already expresses |
|---|---|
| `.tabbar__tabs` | `h-auto w-auto p-0 justify-start` |
| `.st-dialog-content` | `inset-0 translate-x-0 translate-y-0 w-screen h-screen max-w-none rounded-none border-0 p-0 bg-background text-foreground` |
| `.node-swatch` | `size-3 rounded-full border-0` (already on the element) |
| `.st-input-num` / `.st-input-hex` / `.st-select` | `w-[84px]` / `w-[92px]` / `w-60` |
| `.st-mono` | `font-mono text-xs` |
| `.dock-action-row` | `justify-start gap-2 w-full` |
| `.files-filter` | `mx-2 mt-1` |
| `.inbox-filters > [data-slot='tabs']` | `min-w-max` |
| `.inbox-check` | `size-3.5 mt-0` (partially) |

Moving these to class lists does not change rendering as long as the corresponding CSS declarations are deleted at the same time, so the layered utility can take effect.

## 8. Do not delete

| Category | Selectors / assets | Why |
|---|---|---|
| Tokens | `:root` in `styles.css`, `:root[data-theme='light']`, `@theme inline` in `index.css` | Single source for surfaces, accent, status, geometry. `styles.test.ts` asserts literal values. |
| React Flow internals | `.react-flow__minimap.minimap-dock`, `.react-flow__handle.bridge-handle`, `.react-flow__node:has(.term-node.working)::after`, `.react-flow__node:has(.term-node.attention)::after` | Classes are applied by `@xyflow/react` at runtime. `.minimap-dock` override is pinned by `minimapStyle.test.ts` specifically because a single class loses the cascade. |
| xterm | `@xterm/xterm/css/xterm.css` import in `TerminalCore.tsx` | External stylesheet, no local selectors to audit. |
| Monaco | `.editor-node__monaco`, `.editor-node__body--pdf iframe`, `.editor-node__body--image img` | Wrapper layering and preview geometry owned by Monaco and the platform PDF viewer. |
| Dynamic families | `.tab__dot--*`, `.term-node.working/.attention/.waiting`, `.ss-status__icon--*`, `.ss-dot--*`, `.inbox-state--*`, `.chat-message--*`, `.chat-tool__state--*`, `.editor-node__body--*` | Produced by template literals. Enums verified: `StatusGroup` (attention, unread, working, idle, unknown), `StatusKind` (working, attention, done, unknown), `InboxState` (needs_you, review, broken), `ChatRole` (human, assistant, tool, system), `ChatToolState` (requested, running, awaiting_approval, succeeded, failed, denied, cancelled), `editorFileKind` (text, image, pdf). All variants reachable. |
| Layout and geometry | `.app-shell`, `.app-main`, `.tabbar`, `.tabbar__tabs`, `.tab`, `.dock`, `.dock-btn`, `.sessions-sidebar`, `.inbox-panel`, `.chat-panel`, `.controls-cluster`, `.node-menu`, `.files-menu`, `.minimap-dock`, `.pane-host`, `.pane`, `.pane-divider`, `.term-node`, `.node-header`, `.node-toolbar`, `.node-body` | Placement, offset, z-index, drag surfaces, React Flow sizing. Not replaceable by utilities without losing model-driven inline geometry. |
| Load-bearing `!important` | `.term-node--collapsed { height: auto !important }` (`node-chrome.css:230`) | React Flow sets `height` inline on the node wrapper. Only `!important` can override an inline style. Keep. |
| `data-slot` bridges | `.tabbar__tabs [data-slot='tabs-trigger']::after`, `.canvas-command-content [data-slot='command-input-wrapper']`, `.inbox-filters > [data-slot='tabs']` | Selectors intentionally target primitive internals that have no class API. |
| Test-pinned rules | Any rule asserted by `styles.test.ts`, `chrome-kit.test.ts`, `workspaceBarChrome.test.ts`, `cleanView.test.tsx`, `dockSessions.test.tsx`, `inboxDockState.test.tsx`, `InboxPanel.test.tsx`, `minimapStyle.test.ts`, `shadcnPolicy.test.ts` | Delete only together with the test update in the same change. |

## 9. Deletion waves

### Wave 0: correctness, line-neutral (do first)

| Work | Count |
|---|---|
| Replace 18 invalid `rgba(var(--token, #hex), alpha)` fallbacks | 18 declarations |
| Tokenize 8 raw color declarations (`#fff` x4, `#1a1206`, two black chat surfaces, one black menu shadow) | 8 declarations |
| Fix `.files-row--sel` / `.files-menu button:hover` contrast | 2 declarations |
| Remove no-op `!important` on `.cluster-search` | 1 declaration |

Expected CSS line saving: 0. This wave removes latent breakage and makes wave 2 safe. No test update needed.

### Wave 1: dead and orphan cleanup, safe

| Work | Saving |
|---|---|
| Delete `.inbox-consent input[type='checkbox']` | 6 lines |
| Delete `accent-color` from `.inbox-check` | 1 line |
| Delete `left`/`top` restatements in `.st-dialog-content` | 2 lines (counted in wave 3) |
| Remove `field` from `FilesNode.tsx` | 0 CSS |
| Remove `sessions-sidebar__filter-input` wrapper or rename selector to it | 0 CSS |
| Remove or define `dock-workspace-dialog` | 0 CSS |
| Remove `palette`, `palette__list`, `palette__section`, `palette__item`, `palette__hint` from HelpOverlay (or add intentional rules) | 0 CSS |
| Drop `folder-picker__entry`, `kanban-card` or document them as utility-only hooks | 0 CSS |

Expected: **-8 CSS lines**, 8 JSX attribute edits. No test changes.

### Wave 2: remove declarations already provided by primitives

Delete only the overlapping declarations, keep the unique metrics listed in §5.

| Sheet | Items | Saving |
|---|---|---:|
| `node-chrome.css` | usage-pill, node-swatch, comments textarea | 13 |
| `sessions-panel.css` | search input, ss-empty button, ss-group chevron | 20 |
| `files.css` | files-crumb, files-menu button | 17 |
| `settings.css` | st-card, st-chip, st-nav | 10 |
| `dock.css` | dock-sep height/background | 2 |
| `canvas-ui.css` | fold aria-disabled into hover selector, delete override | 6 |
| `inbox.css` | narrow focus-visible to non-primitive focusables | 3 |
| `chat/chat.css` | chat-list-item, composer, narrow focus-visible | 10 |
| **Total** | | **81** |

Expected: **-81 CSS lines**, about 20 JSX class/prop edits, no class rename, so existing tests still pass. Requires a visual diff of sessions, inbox, chat, settings, files, and node toolbars.

### Wave 3: utility-shaped layout resets

| Sheet | Items | Saving |
|---|---|---:|
| `styles.css` | move TabsList reset to `h-auto w-auto p-0 justify-start` | 4 |
| `settings.css` | Dialog reset to utilities, field widths/mono to utilities | 17 |
| `dock.css` | dock-action-row to utilities | 5 |
| `files.css` | files-filter margin to utility | 1 |
| `inbox.css` | filters min-width to `min-w-max` | 1 |
| **Total** | | **28** |

Expected: **-28 CSS lines**. Medium risk, because utilities only take effect after the declaration is deleted. Verify the Dialog is still full-screen and centered-content-free, and the tab underline is still inside the tab.

### Wave 4: retire duplicate overlay surfaces (optional, high risk)

| Surface | Proposal | Saving |
|---|---|---:|
| `.files-menu` | `DropdownMenu`/`Popover` with controlled `fixed` coords | 13 |
| `.node-menu` | reuse one overlay-content class | 8 |
| `.node-comments` | `Popover` | 6 |
| `.node-swatch-pop` | `Popover` | 8 |
| `.canvas-command-content` | rely on `DialogContent` tokens, keep only size | 5 |
| `.clean-view-hint` | reuse the dock plate class | 10 |
| **Total** | | **42** |

Expected: **-42 CSS lines**, high visual and interaction risk. All five menus are portalled inside a transformed React Flow viewport; each needs its own positioning and z-index regression check. Not recommended in the same change as waves 1-3.

### Totals

| Wave | CSS lines | Risk |
|---|---:|---|
| 0 | 0 | none (correctness) |
| 1 | 8 | none |
| 2 | 81 | low-medium |
| 3 | 28 | medium |
| 4 | 42 | high |
| **All** | **159** | 2,720 -> about 2,561 presentation lines (-5.8%) |

Without wave 4: 117 lines removed, about 2,603 presentation lines (-4.3%).

Per-sheet reclaim: `styles` 4, `node-chrome` 19, `dock` 7, `canvas-ui` 12, `agent` 8, `files` 31, `editor` 0, `cleanView` 10, `settings` 27, `sessions-panel` 20, `inbox` 11, `chat` 10, `index` 0.

## 10. Verification commands

Run from the repo root.

```bash
# 1. Dead rule sweep. Expect exactly one line before wave 1, nothing after.
rg -n "input\[type='checkbox'\]" src/client --glob '*.css'

# 2. Invalid fallback sweep. Expect 18 lines before wave 0, nothing after.
rg -n "rgba\(var\(--[a-z-]+, #[0-9a-fA-F]{3,8}\)" src/client --glob '*.css'

# 3. important audit. Expect 2 now; 1 after wave 0 (the collapsed-node inline override stays).
rg -n "!important" src/client --glob '*.css'

# 4. Orphan hooks. Expect nothing after wave 1 (folder-picker/kanban only if kept intentionally).
rg -n "className=\"[^\"]*\b(field|palette__list|palette__section|palette__item|dock-workspace-dialog)\b" \
  src/client --glob '!*.test.*'
rg -n "sessions-sidebar__filter-input" src/client --glob '!*.test.*'

# 5. Dynamic families must still exist. Expect all eight patterns.
rg -n "tab__dot--|ss-status__icon--|ss-dot--|inbox-state--|chat-message--|chat-tool__state--|editor-node__body--|term-node\.(working|waiting|attention)" \
  src/client --glob '*.css'

# 6. Third-party keepers must still exist.
rg -n "react-flow__|editor-node__monaco" src/client --glob '*.css'

# 7. Static reference audit: every class with no static occurrence is either dynamic or third-party.
for c in $(rg -o --no-filename -P '(?<=\.)[a-zA-Z_][\w-]*' src/client/*.css src/client/chat/chat.css | sort -u); do
  rg -q --fixed-strings "$c" src/client --glob '!*.css' || echo "UNREFERENCED $c"
done
# Expected UNREFERENCED set (documented keepers):
# react-flow__handle, tab__dot--*, ss-dot--working, ss-status__icon--*, inbox-state--*,
# chat-message--human, chat-tool__state--*, editor-node__body--image/pdf

# 8. Style guards that read the sheets.
rg -n "readFileSync|read\(" src/client/*.test.* | rg "\.css"

# 9. Gates.
TMPDIR=/tmp bun run test
bun run typecheck
bun run build
```

Manual visual checklist for waves 2-4, in both themes (`data-theme` dark and light) and at 640px:

| Surface | Check |
|---|---|
| Dock | 38px rail unchanged, Add button still accent-filled, disabled undo/redo muted |
| Tab strip | Active underline inside the tab, fade masks on overflow, kebab still 22px |
| Sessions | Card surface, row hover, working spinner, close button hover |
| Inbox | Card surface, Checkbox 14px, consent checkbox, state chips, 640px layout beside dock |
| Chat | Card surface, composer height, message bubbles, tool states, proposal borders |
| Settings | Full-screen dialog, nav active accent, chip pill height, number/hex widths |
| Files | Selected row contrast (after wave 0 fix), breadcrumb hover, menu rows |
| Node | Toolbar icon hit boxes, active tint, danger hover, collapsed height |
| Overlays | Node menu, canvas submenu, file menu, comments, swatch popover, minimap |

## 11. Bottom line

1. The sheets are not dead. Only one whole selector (`.inbox-consent input[type='checkbox']`) and three declarations are provably dead. The earlier ledger was right about that.
2. The remaining pollution is **duplication of primitive chrome**: about 16 button rules, 3 input/textarea rules, 6 overlay surfaces, one Badge and one Card. About 159 lines (5.9%) can go without a design change, most of it safely.
3. The root cause is cascade layering. Unlayered sheets beat every Tailwind utility, so the migration cannot finish by adding utilities alone and must not be "fixed" by wrapping all sheets in `@layer components` before the Button variants are audited.
4. Two latent defects should be fixed regardless of deletion: the 18 invalid `rgba(var(--token, #hex), alpha)` fallbacks, and the blue-on-blue selected file row / menu hover.
