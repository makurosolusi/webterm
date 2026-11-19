# Secret masking: detector design

`src/shared/secretMask.detect.ts` decides which parts of a file the file-manager editor hides.
It is pure (no I/O, no DOM): `detectSecrets(path, text)` returns `{ fileWide, ranges, truncated }`.

## Decisions

- **Ranges cover values only**, never the key, and respect quotes (only the text inside them).
  Ranges are sorted by offset (UTF-16) and never overlap; overlapping hits are merged.
- **Three signals**: secret-looking key names, well-known token shapes (anywhere in the text,
  prose included), and `scheme://user:pass@host` (password only). Files named `.env` / `.env.*`
  mask every value; `.env.example|sample|template` do not.
- **File-wide** by name (`*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa|ed25519|ecdsa` without `.pub`,
  `credentials.json`, `service-account*.json`, `.netrc`, `.pgpass`, `kubeconfig`) or by a
  `-----BEGIN ... PRIVATE KEY-----` block in the scanned text.
- **Favour hiding over showing** when a value is ambiguous, but skip what is clearly not a secret:
  empty values, `${VAR}` / `$VAR`, `<placeholder>`, `changeme`, `xxx`, `...`, booleans, `null`,
  numbers up to 6 digits, and in non-`.env` files unquoted code-looking values (spaces, calls,
  `process.env.X`, `a.b.c`).
- **Comment lines** only count when the line itself reads `KEY: value` (so "Set API_KEY in ..."
  is ignored). A commented-out assignment is still masked. Token shapes are matched everywhere.
- `author`/`authors` is excluded from the `AUTH` key family.

## Known limits

- YAML block scalars (`key: |`): only the first content line is masked; later lines stay visible
  unless they match another rule.
- Prose-like values after a secret key (`# password: required`) are masked (false positive).
- Unquoted secrets containing spaces outside `.env` files are not masked.
- Only the first 1 MiB (`MAX_SCAN_CHARS`) is scanned; `truncated: true` means the tail was not
  examined, so the UI should treat it as unprotected (or hide it) rather than clean.

## Performance

Linear time. Every unbounded run is anchored by a lookbehind so it is scanned once per run, the
scan is line based, placeholder regexes only run on values up to 256 chars, and tests include
hostile inputs (long runs, repeated prefixes, unclosed `${`) with time limits.

## Editor integration

Wired in `useEditorMask.ts` (state), `editorMask.tokens.ts` (per-value reveal), `editorMask.items.tsx`
(status bar + banners), `editorMask.live.ts` (setting for Monaco-side code). Active only while the
`maskSecrets` setting is on; `maskAutoHideSec` drives `useSecretReveal`.

- **The model holds display text, not the real text.** Masked: `maskText(real, scan, reveal)` (same
  length, bullets), read-only. The real text lives only in a ref. No CSS blur or decoration-only hiding.
- **Reveal / Reveal all** change the display text only; the editor stays read-only. **Edit** reveals
  everything and swaps the real text in, editable ("Secrets visible — editing.").
- **Masked mode never writes**: save is a no-op, dirty is always false, `getValue()` is not used for
  save/dirty. Reload reads the real text from disk and masks again. Markdown preview and conflict
  Compare use the masked text. LSP sees the model text (so display text); peek copies and the rename
  preview of files read from disk go through `maskDisplay` (`editorMask.live.ts`).
- **Data-loss guard**: when auto-hide / blur / Escape fires while editing with unsaved changes, nothing
  is re-masked and no edit is dropped; a notice says so, and the re-mask happens after save or discard
  (reload). A clean edit session re-masks right away with "Secrets hidden again."
- **Undo / view state**: swaps use `model.setValue`, which in Monaco 0.57 clears the undo stack and the
  model decorations (`textModel.js` `_setValueFromTextBuffer`), so undo can never cross between real and
  display text. Cursor and scroll are restored with `saveViewState` / `restoreViewState` around it.
  Per-value hover/click decorations are rebuilt after every swap.
- When Settings turns the status bar off, Reveal all / Edit / Hide appear in the banner instead.

Known limits: a rename (LSP) that edits an open masked node changes only the display text and is not
written back (reveal and Edit first); Monaco model markers/glyph decorations from the language server
are cleared by a swap until the next diagnostics push.
