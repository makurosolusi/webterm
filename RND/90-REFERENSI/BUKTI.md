# 90 — Bukti, Sumber, dan Artefak

Tanggal: 2026-10-31
Status: indeks bukti. Dokumen ini tidak menggantikan `AGENT_PUSAT.md`.

---

## 1. Clone dan repositori

| Benda | Lokasi / nilai |
|---|---|
| Jcode clone | `~/.jcode/scratch/jcode-src` |
| Jcode commit | `cb602e1` |
| Artefak wave 1 | `~/.jcode/scratch/orchestra/wave1-*.md` |
| Artefak wave 2 | `~/.jcode/scratch/orchestra/wave2-*.md` |
| Artefak wave 3 | `~/.jcode/scratch/orchestra/wave3-*.md` |
| Artefak wave 4 | `~/.jcode/scratch/orchestra/wave4-*.md` |
| Artefak wave 5 | `~/.jcode/scratch/orchestra/wave5-*.md` |
| Artefak wave 6 | `~/.jcode/scratch/orchestra/wave6-*.md` |
| Arsip dokumen lama | `~/.jcode/scratch/orchestra/archive/` |

---

## 2. Dokumen sumber utama

- Telegram Bot API 10.3: https://core.telegram.org/bots/api
- Telegram Bots FAQ: https://core.telegram.org/bots/faq
- Slack rate limits: https://api.slack.com/docs/rate-limits
- Discord rate limits: https://discord.com/developers/docs/topics/rate-limits
- WhatsApp Cloud API: https://developers.facebook.com/docs/whatsapp/cloud-api/overview
- Standard Webhooks: https://www.standardwebhooks.com/
- Web Push RFC 8030: https://datatracker.ietf.org/doc/html/rfc8030
- MCP spec 2026-07-28: https://modelcontextprotocol.io/specification/2026-07-28/changelog
- A2A: https://a2a-protocol.org/latest/specification/
- OWASP Agentic Top 10: https://genai.owasp.org/
- OTel GenAI semconv: https://github.com/open-telemetry/semantic-conventions-genai

Daftar URL lengkap per track ada di `90-REFERENSI/AGENT_PUSAT.md` §16.

---

## 3. Uji empiris

Lingkungan: Bun 1.4.2, macOS arm64, SQLite 3.43.2.

- LangGraph core + MemorySaver lulus; SqliteSaver gagal (`better-sqlite3`).
- Mastra workflow + step lulus.
- MCP server/client in-memory lulus.
- ACP 2.2.0, Codex SDK 0.166.0, Claude Agent SDK 0.3.316, MCP SDK 1.32.2 import lulus.
- opencode 2.0.26: API `/api/*`, wait, persistent PTY, SSE, basic auth.
- FTS5 `MATCH`, `bm25()`, `ORDER BY rank`, `unicode61` lulus.
- `db.create/list/getSettings` dengan data dir terisolasi lulus.
- Test sesi baseline 33 pass.
- Audit AGENT_PUSAT: 22 VERIFIED, 6 PARTIAL, 1 WRONG dari 29 sampel.
- SQLite default: FK off, busy_timeout 0, `db.transaction()` DEFERRED.
- `VACUUM INTO` berfungsi; `PRAGMA user_version` ikut rollback.
- Telegram Bot API: belum diuji live; semua klaim dari dokumentasi resmi.

---

## 4. Klaim yang tidak boleh dipakai sebagai dasar

- Perbandingan Mem0 92,32 vs audit 38,38 (92,32 adalah EverMemOS, bukan Mem0).
- Klaim backup Railway hancur (cascading delete menyembunyikan, DB dipulihkan).
- MAST 41-86,7% dan 17,2x sebagai angka model 2026 (model lama, abstrak).
- Angka adopsi vendor (500 juta unduhan MCP, 150+ org A2A, 60k repo AGENTS.md).
- Nested subagent 5 level sebagai batas desain.
- Ukuran file/nomor baris dari dokumen lama; ukur ulang di P0.

---

## 5. Cara menambah bukti

1. Simpan artefak mentah di `~/.jcode/scratch/orchestra/`.
2. Catat perintah, tanggal, versi runtime, dan hasil.
3. Tandai UNVERIFIED bila tidak ada sumber primer.
4. Jangan menyalin secret, token, atau isi credential ke dokumen.
5. Update `05-TRACEABILITY.md` bila bukti mengubah status requirement.
