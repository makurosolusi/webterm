# ENVSIMPLE changelog (Unreleased)

User-facing changes of the ENVSIMPLE program: Settings no longer exposes environment keys; it exposes seven capabilities, each with one switch that takes effect immediately. Design notes and known debts are in `docs/decisions/envsimple.md`. In-app strings quoted below are Indonesian, as in the UI.

## Added

- **Capabilities.** Settings has a "Kemampuan" tab with seven cards, each one on/off switch that applies at once, with no restart: Agent Pusat (Central), Worker orchestrator, Otonomi Agent Pusat, Browser di kanvas, Kelola file, Ubah dan unggah file, and Telegram.
- **Dependencies are explicit.** Turning a capability on also turns on what it needs, and the card says so ("Ikut menyalakan: ..."). Turning one off also turns off what depends on it ("Ikut mati: ..."). Worker orchestrator needs Agent Pusat, Otonomi needs Worker, and "Ubah dan unggah file" needs "Kelola file".
- **Telegram: paste a token.** Create a bot with @BotFather, paste its token in the Telegram card and press "Hubungkan". The token is checked against Telegram first and is only saved if it works; the card then shows "Tersambung sebagai @name". A chat that messages the bot appears in the card with "Tautkan" / "Abaikan"; private chats are linked as owner and group chats as viewer. Failed attempts say what to do ("Token ditolak Telegram. Salin ulang dari @BotFather.", "Tidak bisa menjangkau Telegram. Periksa koneksi internet lalu coba lagi.", "Bentuk token tidak dikenali. Salin lengkap dari @BotFather.").
- **Contextual Browser offer.** "New Browser" is always in the canvas menu. If the Browser capability is off, choosing it asks "Nyalakan sekarang?" inside the menu and opens the node once enabled.
- **"Lanjutan" section.** A collapsed section with at most four items: agent engine (auto, claude, opencode, mock), Chromium location, data folder (read-only), and reset.
- **Security audit.** Every capability change, and every refused attempt, is recorded in a local `capability_audit` table (reason only, never values or secrets; the newest 1000 rows are kept).
- **Legacy environment keys keep working.** Existing primary keys such as `WEBTERM_CENTRAL=on` are still read as capabilities. A child or sub-option that is on without its parent capability is ignored, with one warning per key per process (key name only).

## Changed

- **The ledger is always on.** It no longer needs `WEBTERM_LEDGER`; that value is ignored. A small SQLite ledger file now exists in the data directory even with every capability off. `WEBTERM_LEDGER_SHADOW=1` keeps the old shadow mode for developers.
- **Settings changes need an `Origin`.** Changing settings or capabilities without a token is accepted only from a loopback peer, with an allowed `Host`, no `Forwarded` / `X-Forwarded-*` headers, and a same-origin `Origin` header. Scripts that call `PUT /api/settings/env` or `/api/capabilities*` without a token (for example plain `curl`) now get `403 {"error":"forbidden"}`; they should send the root token in `x-webterm-token`. Node and capability tokens are refused on these routes. This does not stop a same-user local process that sets a fake `Origin` header; see the decision doc.
- **Tuning keys are hidden.** Limits, thresholds and similar keys no longer appear in Settings. Values you already stored, and keys set in the environment, are still honored.
- **Worker approval defaults to ON.** `WEBTERM_RUN_REQUIRE_APPROVAL` is now on by default when Worker orchestrator is enabled; the card has "Minta persetujuan sebelum worker berjalan" to turn it off.
- **Worker orchestrator implies Agent Pusat.** Enabling workers enables Central.
- **Upload needs "Ubah dan unggah file".** `WEBTERM_FILES_UPLOAD` is now derived from that capability; enabling file upload alone is no longer a separate step. Viewing, watching, git status and quick open follow "Kelola file".
- **Telegram has no separate channel switch.** The channel runtime exists exactly while the Telegram capability is on. `WEBTERM_CHANNELS` and `WEBTERM_CENTRAL_TELEGRAM` are no longer read as switches: they are derived keys written by the capability (Agent Pusat also for the central bridge), and a legacy value set while its capability is off is ignored with one warning. `WEBTERM_TELEGRAM` is the capability switch itself. Polling is used by default; the webhook is used only with `WEBTERM_TELEGRAM_MODE=webhook`, and its secret is generated automatically.
- **One flag dialect.** Flags accept `on|1|true` and `off|0|false`, so a value such as `X=1` that used to stay silently off is now on. The three security keys (`WEBTERM_ALLOW_LOOPBACK_APPROVAL`, `WEBTERM_ALLOW_TOKEN_MINT`, `WEBTERM_STRICT_HOOK_AUTH`) still accept only `1`.
- **Turning a capability off stops new work, not running work.** Workers and terminals already running are not killed; the browser waits up to 5 seconds for active pages before closing.
- **Unchanged protocol names.** `NODETERM_NODE_ID`, `NODETERM_PORT`, the `x-nodeterm-node-token` header and `nodeterm:` events keep their names. The data directory is still `WEBTERM_DATA_DIR` (default `~/.webterm-server`).

## Removed

- **Environment and Channels tabs** in Settings. Old links to them open "Kemampuan".
- **The "Perlu restart", "Berbahaya" and "Dikunci" statuses**, the "Belum berpengaruh" badge, the restart banner, per-key Default / Aktif sekarang / Tersimpan chips, and the root-token and confirmation dialogs.
- **The generic key list and filters.** Capabilities replace the per-feature environment explanations in Settings.
