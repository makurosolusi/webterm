# RND 51 (b) — Inventaris C, selisih, set minimal, implikasi

Lanjutan `51-ENV-MINIMAL-INVENTORY.md` (fakta F1-F7, tabel A bootstrap, tabel B registri). Saudara: `52-ENV-MINIMAL-ZERO-CONFIG-BOOT.md`, `53-ENV-MINIMAL-CONFIG-LAYERS.md` (asumsi `[BT]`).

## 1. Inventaris C — env di luar registri

| Nama | Dibaca di | Jenis | Vonis | Catatan |
|---|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | `telegramSend.ts:23-30` (fallback setelah `WEBTERM_TELEGRAM_BOT_TOKEN`) | WARISAN/SECRET | HAPUS (deprecate) | TIDAK disapu `LEAKED_ENV` => bocor ke anak PTY bila ada di `.env` (F5) |
| `VITE_WEBTERM_CENTRAL_CHAT` | `client/central/centralControlApi.ts:31-33` (`import.meta.env`) | FLAG build-time | HAPUS / pindah ke capability server | satu-satunya env klien; tak ada API runtime; panel central sebaiknya mengikuti `WEBTERM_CENTRAL_CHAT` dari server `[opini]` |
| `NODETERM_NODE_ID`, `NODETERM_PORT` | disuntik `sessions.ts:74-83` ke sesi agen context-capable | PROTOKOL | TETAP (jangan rename) | bukan config operator |
| `NODETERM_NODE_TOKEN`, `NODETERM_PERM_WAIT_SECS` | `hooks.ts:40`, `hooksTokens.ts:14` (hanya bila `hookReplyApprovals > 0`) | PROTOKOL | TETAP | per-node, disuntik server |
| `WEBTERM_TOKEN` (anak) | `sessions.ts` — diganti token per-node untuk sesi agen | PROTOKOL | TETAP | nama sama dengan root token; jangan tertukar |
| `WEBTERM_BROWSER_NODE_ID`/`_READ_CAP`/`_ACT_CAP` | disuntik `browser` envFor/shim | PROTOKOL | TETAP | bukan config |
| `WEBTERM_CHANNEL_HMAC_SECRET` | hanya `redactSecrets.ts:12` (`SECRET_ENV_NAMES`), tanpa pembaca | MATI (hantu) | HAPUS dari daftar redaksi atau pertahankan sebagai nama terlarang `[opini]` | tak ada fitur |
| `WEBTERM_TELEGRAM_WEBHOOK_SECRET_FILE` | `channelSecret.ts:57-75` | SECRET varian | tak terdaftar di registri; DOKUMENKAN atau jadikan jalur resmi `*_FILE` `[BT 52]` | satu-satunya varian `_FILE` |
| `HOME`, `SHELL`, `PATH` | `ptyShell.ts:13,39,55`; `nameGen.ts:39,43`; `sessionsLog.ts:13`; `fsOps.mutate.ts:42`; `binaryOnPath.ts:6` | LINGKUNGAN OS | TETAP (bukan config) | selalu ada pada shell normal; `launchd`/Docker minimal perlu cek `[BT]` |
| `CLAUDE_CONFIG_DIR` | `transcriptPresence.ts:83`, `transcriptPath` | LINGKUNGAN pihak ketiga | TETAP | milik Claude CLI |
| Kunci provider (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_*`, `GROQ_*`, dll.) | allowlist `opencodeOptions.ts` PROVIDER_ENV_ALLOWLIST | SECRET pihak ketiga | TETAP di luar webterm | webterm hanya meneruskan; `claudeOptions` memblokir `ANTHROPIC_`/`OPENAI_`/`CLAUDE_CODE_OAUTH` |
| `GIT_TERMINAL_PROMPT`, `GIT_OPTIONAL_LOCKS` | `gitInfo.ts:86`, `fsGit.ts:27` | disetel untuk anak git | TETAP | bukan input |
| `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`, `OPENCODE_PERMISSION` | `opencodeOptions.ts` allowlist / set sendiri | pihak ketiga / internal | TETAP | |
| `${env:NAME}` di agentCatalog | `central/agents/agentCatalog.ts:108` (+ filter `RESERVED_ENV`) | referensi pengguna | TETAP | sumber = `process.env` |
| Seluruh `process.env` diteruskan ke anak PTY | `pty.ts:187` via `ptyEnv` | PEWARISAN | PERLU DIAUDIT | hanya regex F5 yang menyapu; `execRunner.scrubExecEnv`, `verifyEnv`, `claudeOptions`, `opencodeOptions` berbasis allowlist (aman) |
| Tes/fixture: `WEBTERM_PORT`, `WEBTERM_ROOT_TOKEN`, `NODETERM_TOKEN`, `WEBTERM_FUTURE_FLAG`, `WEBTERM_X`, `WEBTERM_TEST_FLAG`, `WEBTERM_CENTRAL_NOTIFY` | hanya berkas tes | DEV-TES | tak perlu tindakan | `central/eval/goldenHarness.ts:104-152` memutasi `process.env` di harness (non-tes, perlu restore) |

## 2. Selisih `.env.example` vs registri vs kode

`.env.example` = 51 kunci (diurai dari baris `KEY=`/`# KEY=`). Registri = 66 + bootstrap.

| Selisih | Rincian |
|---|---|
| Ada di registri, TIDAK di contoh (21) | `BROWSER` x8, `FILES_*` x8, `LOG_LEVEL`, `LOG_BUFFER`, `LOG_FILE`, `OPENCODE_ALLOW_TOOLS`, `TELEGRAM_MODE`. Pengguna `.env` tidak tahu fitur ini ada. |
| Ada di contoh, TIDAK di registri (6) | `HOST`, `PORT`, `WEBTERM_TOKEN`, `ALLOW_LOOPBACK_APPROVAL`, `ALLOW_TOKEN_MINT`, `STRICT_HOOK_AUTH` = semua bootstrap yang disengaja; bukan yatim. |
| Contoh mendokumentasikan kunci yang tak dibaca | `.env.example:111` `WEBTERM_CENTRAL_TOOL_BRIDGE` (mati). Juga `KNOWLEDGE_GRAPHIFY`, `EMBED_MODEL`, `EMBED_URL` ada di contoh (mati). |
| Contoh basi | `.env.example:62-64`: "`claude`/`codex` belum diimplementasikan" -- registri kini `claude/opencode/mock/off`, `buildService` membuat `ClaudeRuntime` (`centralChatHandlers.ts:49-57`); `codex` hanya di `SUPPORTED` (`runtimeFlag.ts`) tapi menghasilkan `null`. |
| Contoh menyesatkan | `.env.example:90` `# WEBTERM_CHANNELS=off` tampil sebagai nilai contoh, padahal default kosong/`on`. Mengomentari-balik baris itu mematikan seluruh kanal. |
| Default bertentangan | Tidak ada selisih angka antara contoh dan registri (MAX_STEPS 2, TURN_STEPS 12, WALL_MS 120000, TURN_TOKENS 60000, DAILY 1000000/20/0, CONTEXT_WINDOW 128000, MAX_INFLIGHT 3, IDLE_DONE_MS 45000, TOOLS=read semua cocok). |
| Dialek flag | `WEBTERM_LOG_FILE`: registri bertipe flag default `on`, pembaca `logger.ts:108` memperlakukan apa pun selain `off` sebagai hidup; `flagOn` tidak. README: `WEBTERM_ALLOW_LOOPBACK_APPROVAL` default `0`, `=== '1'` (F4). |
| README | `README.md:30,48,67,108` menyebut: PORT/HOST/TOKEN/NODE_ENV/DATA_DIR/LEDGER/ALLOW_LOOPBACK_APPROVAL/BROWSER_COOKIE_*, dan baris "Any of these can go in a `.env`... Bun loads that file automatically" (pewarisan; benar). Tidak ada `bunfig.toml`, Dockerfile, atau compose di repo. |
| Pemisahan tersirat | `ledger` "off" di README tetapi kanal webhook & inbox bergantung ledger `on` => zero-config membuat inbox/approval/webhook tidak aktif. |

## 3. Set env minimal yang benar-benar tak terhindarkan

Hasil inventaris: **di jalur loopback, nol env var wajib.** Server bisa naik tanpa satu pun (default 127.0.0.1:8700, token tak ada, DB di `~/.webterm-server`) [belum diuji; uji boot ada di 52 `[BT]`]. Yang tak terhindarkan hanyalah yang harus diketahui SEBELUM overlay Settings/DB hidup, atau yang tak boleh diubah oleh pihak yang bisa memanggil API:

| Kunci | Wajib? | Alasan tak bisa di Settings |
|---|---|---|
| `HOST` (+`WEBTERM_HOST`) | hanya untuk non-loopback | dibaca sebelum bind; bind LAN harus keputusan operator di tingkat proses. |
| `PORT` | hanya bila 8700 bentrok | dibaca sebelum bind dan saat import (`launchLine.ts:17`). |
| `WEBTERM_DATA_DIR` | hanya bila bukan `~/.webterm-server` | menentukan lokasi DB tempat Settings disimpan (telur-ayam). |
| `WEBTERM_TOKEN` | wajib untuk non-loopback hari ini | sumber otentikasi; ke depan dapat dibangkitkan+dipersist `[BT 52]` sehingga env jadi override saja. |
| `WEBTERM_ENV_SETTINGS=off` | opsional | kunci kendali override; tak boleh diubah oleh override itu sendiri. |
| `WEBTERM_ALLOW_LOOPBACK_APPROVAL`, `_ALLOW_TOKEN_MINT`, `_STRICT_HOOK_AUTH` | opsional (default aman) | keamanan: agen shell di mesin yang sama dapat memanggil API; mengubahnya lewat API = eskalasi hak. `STRICT_HOOK_AUTH` juga import-time (F2). |
| `WEBTERM_TRUST_PROXY` | opsional | `[opini]` serumpun kunci keamanan; saat ini `dangerous` (butuh token) sehingga praktis sudah semi-bootstrap. |
| `WEBTERM_TELEGRAM_API_BASE` | tes saja | seam tes/proksi. |
| `NODE_ENV=production` | hanya jalur `bun src/server/index.ts` | biner sudah menanam; dapat diganti deteksi otomatis `[BT 52]`. |

Total: 4 kunci operasional (HOST, PORT, DATA_DIR, TOKEN) + 4-5 kunci keamanan/kunci-kendali. Sisa 66 kunci registri dan semuanya (kecuali sebagian `dangerous`) bisa hidup di Settings atau default. Secret (bot token, webhook secret) pindah ke store berkas 0600 yang sudah ada (`envSecrets.store.ts`), bukan `.env`.

## 4. Implikasi untuk webterm

### 4.1 Rekomendasi tegas
1. **Sasaran: `.env` opsional total, bukan dihapus.** Env tetap override (F1: override Settings sebenarnya menang atas env; ini dokumentasikan, atau balik bila ingin "env menang" `[BT 53]`).
2. Set env bootstrap dibekukan pada ≤9 kunci (§3). Semua selainnya: default + Settings. Tambah kunci baru ke `.env.example` DILARANG kecuali bootstrap.
3. Selesaikan F3 sebelum menjanjikan "UI jalur utama": tanpa token auto-generate, 14 kunci dangerous tak bisa diubah pada instalasi loopback default. Rekomendasi: bangkitkan token root saat run-pertama dan persist (rincian 52). Konsekuensi: loopback tak lagi anonim (perubahan perilaku; lihat D1).
4. Perkecil `.env.example` jadi ~8 baris bootstrap, tandai sisanya "lihat Settings > Environment"; README tinggal satu paragraf.
5. Bersihkan: hapus 4 kunci mati, alias `TELEGRAM_BOT_TOKEN`, hantu `CHANNEL_HMAC_SECRET`; satukan dialek flag atau dokumentasikan.

### 4.2 Risiko
| Risiko | Mitigasi |
|---|---|
| Pengguna `.env` lama: override tersimpan menang atas env => nilai `.env` "tak berlaku" secara diam-diam | impor sekali + peringatan di log; 53 |
| Kunci import-time (PORT, STRICT_HOOK_AUTH) tak bisa dari Settings | tetap bootstrap (sudah) |
| Bun otomatis memuat `.env` dari cwd; di biner, cwd sembarang bisa memuat `.env` asing (tak diinginkan) | `--no-env-file`/`bunfig` `env=false` `[BT 52]`, verifikasi flag di Bun 1.4.2 |
| Pewarisan: alias lama dan kunci provider bocor ke PTY | perluas `LEAKED_ENV` ke `TELEGRAM_BOT_TOKEN`; kunci provider = keputusan D5 |
| Default `FILES_*` semua off: pengguna zero-config tak melihat file manager | D4 |
| Token auto + remote exposure | 52 |
| `goldenHarness` memutasi `process.env` | audit restore, ukuran S |

### 4.3 Keputusan yang perlu user (default usulan)
| ID | Keputusan | Usulan |
|---|---|---|
| D1 | Loopback tetap anonim, atau bangkitkan root token saat run-pertama? | Bangkitkan + persist 0600 di data dir; cetak di terminal; UI memintanya sekali |
| D2 | Urutan prioritas: override Settings > env (kini) atau env > override? | Pertahankan yang sekarang (UI menang) tapi tampilkan sumber nilai di Settings |
| D3 | Hapus alias `TELEGRAM_BOT_TOKEN` dan 4 kunci mati? | Ya, tandai deprecation 1 rilis lalu hapus |
| D4 | Default fitur berkas (FILES_*) dinyalakan pada zero-config? | `FILES_VIEWERS/WATCH/GIT_STATUS/QUICK_OPEN` on (baca-saja), `MUTATE/UPLOAD` tetap off |
| D5 | Sapu kunci provider dari PTY? | Tidak (pengguna mengandalkannya untuk CLI agen); hanya sapu `TELEGRAM_BOT_TOKEN` |
| D6 | `VITE_WEBTERM_CENTRAL_CHAT` | Ganti dengan capability dari server |
| D7 | Satukan dialek flag (terima `1/true/on`)? | Ya di `envFlag.ts` untuk kunci non-keamanan; kunci keamanan tetap `1` ketat |

### 4.4 Workstream usulan
| Nama | Berkas milik | Ukuran |
|---|---|---|
| WS-A bersih-bersih registri | `envRegistry*.ts`, `redactSecrets.ts`, `.env.example` (4 kunci mati, hantu, contoh basi) | S |
| WS-B hapus alias legacy + sapu PTY | `telegramSend.ts`, `ptyShell.ts` + tes | S |
| WS-C dialek flag seragam | `envFlag.ts`, pembaca `=== '1'`/`off`-only | M |
| WS-D token root auto + persist (bergantung 52) | `auth.ts`, `index.ts`, store token | M |
| WS-E default fitur berkas (D4) | `envRegistry.files.ts` | S |
| WS-F `VITE_` -> capability server | `centralControlApi.ts`, `CentralControlPanel.tsx`, endpoint capability | M |
| WS-G `.env.example` + README ramping | `.env.example`, `README.md` (baris 30,48,67,108) | S, gelombang akhir |
| WS-H tes zero-config boot | tes Bun `env -i` + `WEBTERM_DATA_DIR` tmp | M |

Urutan: A, B, C paralel (berkas terpisah) → D, E, F → H → G (dokumen rangkuman sekali di akhir).
