# 04 — Buku ide

Setiap ide dari kedelapan dokumen (R&D 01–05, posisi debat 10–12, semuanya di [`rnd/`](rnd/)) dicatat di sini. Status yang dipakai:

- **Fx**: diadopsi di fase x.
- **Tunda**: ditunda, dengan alasan dan syarat untuk ditinjau ulang.
- **Tolak**: ditolak dengan alasan.

Alasan penundaan atau penolakan hanya boleh berupa keamanan, kehilangan data, kebenaran, kematangan protokol, atau biaya yang terbukti. "Kode lama" tidak pernah dipakai sebagai alasan (memory `feedback-perkaya-fitur`).

## A. Control plane dan protokol

| # | Ide | Sumber | Status | Catatan / syarat tinjau |
|---|---|---|---|---|
| 1 | Satu registry `defineCapability` + JSON Schema | 01 §6, 02 #1, 10 S1, 11 §2 | F1 | Fondasi |
| 2 | Proyeksi MCP / CLI / HTTP+OpenAPI / Central / ⌘K | 02 #1, 10 S1 | F1–F2 | |
| 3 | Test drift antar proyeksi | 02 Orca, 11 | F1 | |
| 4 | Progressive disclosure `cap.search`/`cap.describe` sebagai ganti katalog 1200 token | 11 §2 | F1 | |
| 5 | `agent-context --json` + skill stub berversi | 02 #3 | F2 | |
| 6 | Typo tidak pernah disarankan jadi perintah destruktif | 02 #12 | F2 | |
| 7 | Receipt `{outcome, detail, next}` + `operationId` idempoten | 02 #10, 10 S1 | F1 | |
| 8 | `evidence` diisi sistem | 11 §2.4 | F1 | |
| 9 | MCP server auto-configure ke semua CLI | 02 #4, JetBrains | F2 | Adapter per CLI **[V]** |
| 10 | Central dengan function-calling native via `--mcp-config` | 01 §6.2, 10, 11 | F2 | K7 |
| 11 | Bangun di atas MCP 2026-07-28 (stateless, `server/discover`, MRTR, `ttlMs`) | 02 §10 | F2 | **[V]** sebelum F2 |
| 12 | Sampling / roots / logging MCP | 02 §10 | **Tolak** | Deprecated (verifikasi). Pakai MRTR |
| 13 | Claude channels sebagai transport push | 02 #4, 10 S6 | F2 (adapter) | K2 |
| 14 | Channels sebagai **satu-satunya** jalur push | 10 | **Tunda** | Research preview, butuh flag `--dangerously-*`. Tinjau saat channel kustom GA tanpa flag |
| 15 | ACP client: node agent jadi chat terstruktur | 02 #7, 10 S7 | F6 | ACP v2 masih draft. Fallback PTY tetap ada |
| 16 | Agent dipasang dari ACP Registry | 02 §7 | F6 | Ikut ACP |
| 17 | MCP Apps `ui://` dirender di node | 02 #14 | F6 | |
| 18 | Skills over MCP + AGENTS.md | 02 #15 | F5 (AGENTS.md/rules), F6 (skills/list) | **[V]** status SEP-2640 |
| 19 | A2A penuh antar organisasi | 02 §10 | **Tolak** | Tidak relevan untuk satu user. Format agent card diadopsi (#94) |
| 20 | Transport WS Codex app-server | 02 §4 | **Tunda** | Berlabel "experimental and unsupported". Pakai stdio. Tinjau saat stabil |
| 21 | Codex `turn/steer` | 02 #11 | F6 (via ACP/app-server) | Antrean pesan saat sibuk ada di F2 (#33) |
| 22 | Generate schema per versi (Codex/OpenCode) | 02 §4 | F2 | Dari registry |
| 23 | OpenCode `/tui` remote-drive | 02 §3 | **Tunda** | Butuh OpenCode serve per node. Tinjau setelah ACP |
| 24 | Satu runner spawn (menyatukan 4 pintu D2) | 01 D2, 10 S7 | F2 | |
| 25 | Agent terminal bisa mengorkestrasi (spawn di workspace sendiri) | 01 §6.3 | F2 | K3 |

## B. Izin, keamanan, identitas

| # | Ide | Sumber | Status | Catatan |
|---|---|---|---|---|
| 26 | F0 hardening same-uid (Keychain, deny Read datadir, token per proses) | 11 §1, F0 | F0 | K1 |
| 27 | Principal eksplisit + owner-proof | 02 #2, 11 | F1 | |
| 28 | Aturan allow/ask/deny last-match-wins | 02 #2, OpenCode | F1 | |
| 29 | Cable-as-grant | 11 §2.2 | F1 | Dihitung dari edge |
| 30 | Grant node otomatis ber-scope workspace | 10 S2 | F2 | Atenuasi (K3) |
| 31 | Agent menerbitkan grant untuk agent lain | 10 (implisit) | **Tunda** | Eskalasi berantai. Tinjau bila ada sandbox OS per node (uid terpisah) |
| 32 | Persist token node + grant | 01 §6.9 | F1 | |
| 33 | Antrean pesan saat agent sibuk | 02 Devin/VS Code | F2 | Outbox |
| 34 | "Izinkan pola ini selamanya" | 02 #6, 10 | F3 (UI saja) | K4 |
| 35 | Reviewer otomatis vs manusia (`approvals_reviewer`) | 02 §4 | F4 | Classifier |
| 36 | Classifier tier tengah | 04 #9 | F4 | Hanya setelah F3 lulus |
| 37 | Never-auto lewat `destructive` | 04 §3, 11 | F1 | |
| 38 | Doom-loop: input identik 3× | 02 #12, OpenCode | F3 | Guard Central sudah ada, diperluas ke node |
| 39 | Hash chain event | 11 | F1 | + anchor (K9) |
| 40 | Firewall prompt injection: taint `untrusted` | 10 §5.8 | F1 (tanda), F4/F5 (penegakan) | |
| 41 | Secret broker `secret.use` | 10 §5.11 | F2 | |
| 42 | Hook baca-file (cegah `.env`) | 02 Cursor | F0 | |
| 43 | Guard kebersihan repo (`cookies.txt`) | 12 §3.10 | F0 | `cookies.txt` sudah di-ignore di `main` (`c1a970a`). F0-d membangun guard otomatis untuk file sensitif lain |
| 44 | Workspace Restricted Mode (Devin) | 02 §6 | **Tunda** | Satu user, repo milik sendiri. Tinjau saat membuka repo asing |
| 45 | Prompt sudo yang tidak pernah dilihat model | 02 Cursor | F2 | Lewat secret broker |
| 46 | Endpoint usage OAuth Anthropic (G13) | 05 G13 | **Tunda** | Tidak terdokumentasi dan bisa membocorkan token. Tinjau bila ada API resmi. Sementara: usage dari ledger |
| 47 | Label "mitigasi" untuk Codex/Gemini tanpa sandbox | 11 F0 | F0 | A3 |

## C. Senses, inbox, otonomi

| # | Ide | Sumber | Status | Catatan |
|---|---|---|---|---|
| 48 | Event bus terpadu + `wake` sebagai subscriber | 01 §6.4, 04 #1, 10 S3 | F1 | |
| 49 | Katalog event meniru hook Claude Code | 02 #8 | F1 | |
| 50 | Hook dinormalisasi dari Codex/OpenCode/Gemini/Cursor | 02 #8 | F2 | **[V]** per CLI |
| 51 | Ganti poll linkNote 1 dtk | 01, 10, 11 | F1 | |
| 52 | Inbox notify/question/review/gate | 04 #3, 10 S6 | F3 | |
| 53 | Aksi approve/edit/reply/ignore/snooze + batch | 04 §3 | F3 | |
| 54 | `PermissionRequest` benar-benar dijawab | 01 D3, 11 | F3 | **[V]** format `decision` |
| 55 | Attention policy (fokus, coordinator-only, mute, digest) | 04 §2, Orca | F3 | |
| 56 | OSC 9/777 di terminal | 02 §2 | F3 | |
| 57 | Consent bridge | 12 §3.3 | F2 | |
| 58 | Routines Schedule/Event/API | 04 #2 | F4 | |
| 59 | Precheck shell sebelum LLM | 04, Orca | F4 | |
| 60 | Catch-up sekali + riwayat skip | 04 | F4 | |
| 61 | Drift jadwal cron dilaporkan | 04 Orca | F4 | |
| 62 | Klasifikasi ambient sesuai level (observe = notify saja) | 04 §1.5 | F4 | |
| 63 | Abaikan event dari path yang di-lease worker sendiri | 04, 11 | F4 | |
| 64 | Task DAG + gate human-only + reblock | 04 #5 | F4 | |
| 65 | Lease file + gelombang otomatis | 04 §2.2 | F4 | |
| 66 | Escalation terikat dispatch (anti-spoof) + breaker 3× | 04 | F4 | |
| 67 | Stale-base guard | 04 | F4 | |
| 68 | Brief worker terstruktur + aturan skala usaha | 04 §2.3 | F4 | |
| 69 | Verifier wajib | 04 #6, MAST, 11 | F4 | Bukti dari sistem sudah ada sejak F1 |
| 70 | Handoff sebagai tool + filter konteks | 04 #10 | F4 | |
| 71 | Factories / template pipeline | 02 #13, Warp | F6 | |
| 72 | Plan disetujui sebelum kode (Jules) | 04 | F4 | |
| 73 | Node Rencana dikabel ke worker | 04 §4.2 | F4 | |
| 74 | ⌘K sebagai pintu intent | 04, 12 | F4 (intent), F1 (omnibox) | |
| 75 | Badge trust mode + Halt semua | 04 §3.5 | F1 (badge), F3 (Halt + panic) | |
| 76 | Status surface (badge, dock, status bar Central) | 04 §4.4 | F1 | |
| 77 | Kontinuitas Telegram ↔ canvas (thread sama) | 04 §4.5 | F3 | |
| 78 | Kirim ke latar (`&` Cursor) | 02 Cursor | F4 | Worker headless di worktree |
| 79 | Cloud agents / VM | 02, 04 | **Tolak** | Personal di satu mesin. Tinjau bila ada mesin remote |
| 80 | Debate/blackboard bebas multi-agent | 04 pitfall | **Tolak** | Berputar tanpa ujung. Pakai ronde terbatas + keputusan lead |
| 81 | Policy simulator | 10 §5.2 | F4 | |
| 82 | Oracle biaya per routine | 10 §5.3 | F4 | |
| 83 | Bot review PR | 05 G14 | F6 | Butuh SCM |
| 84 | Cursor Rollouts (pantau deploy) | 05 §2 | **Tunda** | Tidak ada pipeline deploy di alur ini. Tinjau bila ada |

## D. Memori, konteks, cache

| # | Ide | Sumber | Status | Catatan |
|---|---|---|---|---|
| 85 | `kind` semantic/episodic/procedural | 03 #6 | F5 (procedural awal di F2) | A7 |
| 86 | Bi-temporal + `source_event_id` | 03 #3 | F5 | |
| 87 | Consolidator sleep-time | 03 #2 | F5 | |
| 88 | Shared blocks / blackboard | 03 #5 | F5 | |
| 89 | Embedding untuk teks saja + `embed_cache` | 03 #7 | F5 | |
| 90 | Vector index kode | 03 | **Tolak** | Kalah dari grep + LSP, mahal, bocor. Tinjau bila grep + LSP gagal di repo besar |
| 91 | Semantic cache jawaban agent | 03 | **Tolak** | Jawaban basi pada state berbeda (kebenaran) |
| 92 | Tulis memori hot-path di setiap turn | 03 | **Tolak** | Latency dan sering salah. `remember` eksplisit tetap ada |
| 93 | Kontrol privasi (lupakan, jangan sebut, incognito, panel) | 03 #9 | F5 | |
| 94 | Agent card per node (format A2A) + bake-off | 10 §5.10, 05 G14 | F6 | |
| 95 | Re-verifikasi saat dipakai + skor kesegaran + tombstone | 03 §5 | F5 | |
| 96 | Summarizer LLM + handoff card | 03 #1 | F5 | Brief deterministik di F3 |
| 97 | Kartu identifier, bukan dump | 03 §2.2 | F2 | |
| 98 | Repo-map simbol + PageRank | 03 #8 | F5 | |
| 99 | Explore sub-agent | 03 #8 | F5 | |
| 100 | Disiplin prefix + metrik hit | 03 #4 | F5 (metrik ditarik ke F1 bila murah) | |
| 101 | TTL 1 jam bersyarat untuk Central | 03 §3 | F5 | Hanya bila metrik membuktikan |
| 102 | `tool_cache` berkunci versi sumber | 03 #10 | F5 | |
| 103 | Context editing / compaction API server-side | 03 §2 | **Tunda** | Central berjalan via `claude -p`, bukan API langsung. Tinjau bila Central pindah ke Agent SDK atau API |
| 104 | Claude memory tool (client-side `/memories`) | 03 §1 | **Tunda** | MCP `memory.*` sudah memenuhi fungsinya. Tinjau bila ada runtime API |
| 105 | Resumable plan `next_action`/`verify_cmd` | 03 §4.2 | F4 | |
| 106 | Provenance panel | 02 #9 | F5 | |
| 107 | Rules ber-glob/deskripsi `.mdc` | 02 #9 | F5 | |
| 108 | Ghost agent / speculative prefetch | 10 §5.5 | F5 | Hanya setelah metrik cache ada |
| 109 | Retensi transcript terpisah dari memori | 03 §5 | F5 | |

## E. IDE dan UX

| # | Ide | Sumber | Status | Catatan |
|---|---|---|---|---|
| 110 | G1 diff + anotasi + Keep/Undo | 05 | F1 (I1-b) | K6 |
| 111 | G2 SCM + pesan AI + Fix with AI | 05 | F3 (I2-a) | |
| 112 | Laporan Rule 18 otomatis | 12 F5 | F3 | |
| 113 | G3 worktree workspace | 05 | F3 (I2-b) | |
| 114 | Fan-out satu prompt ke beberapa agent lalu bandingkan | 05 G3/G14 | F6 | |
| 115 | G4 notifikasi OS | 05 | F0 | |
| 116 | G5 global search + Quick Open | 05 | F1 | |
| 117 | G6 port detect + preview | 05 | F4 | Proxy remote di F6 |
| 118 | G7 riwayat sesi | 05 | F1 | |
| 119 | G8 registry perintah + keybinding | 05 | F1 | |
| 120 | G9 langkah 1 problem matcher | 05 | F4 | |
| 121 | G9 langkah 2 LSP `monaco-languageclient` | 05 | F6 | **[V]** kompat versi |
| 122 | G10 task runner | 05 | F4 | Test explorer penuh: Tunda (dampak L) |
| 123 | G11 Design Mode | 05 | F6 | |
| 124 | G12 PWA `/m` + Web Push | 05, 12 | F6 | Telegram menutup kebutuhan HP lebih dulu |
| 125 | Attribution baris AI vs manusia | 05 Orca | **Tunda** | Butuh data per hunk dari checkpoint. Tinjau setelah F3 |
| 126 | Drag file/gambar ke prompt | 05 Orca | F6 | |
| 127 | Sticky note/whiteboard | 05 G14 | **Tunda** | Dampak kecil, `NodeComments` sudah ada. Tinjau bila diminta |
| 128 | Markdown WYSIWYG + Mermaid | 05 G14 | **Tunda** | Preview Mod+M sudah ada |
| 129 | Debugger DAP | 05 G14 | **Tunda** | Biaya besar, pemakaian rendah. Sementara: `bun --inspect` + DevTools. Tinjau bila sering debug |
| 130 | Notebook, Settings Sync | 05 G14 | **Tolak** | Satu mesin, satu user |
| 131 | SSH worktree / Remote environments | 05 Orca/VS Code | **Tunda** | Tinjau bila ada mesin remote |
| 132 | Mobile companion native | 05 | **Tolak** (diganti PWA #124) | |
| 133 | Discord (P9) | 01 §2g | F6 | Keputusan produk sudah ada |
| 134 | Judul node otomatis | 12 F2 | F0 | |

## F. Ide yang terlewat oleh laporan (dari para pendebat)

| # | Ide | Sumber | Status |
|---|---|---|---|
| 135 | Self-describing app + changelog kapabilitas | 10 §5.1 | F2 |
| 136 | Session replay terkorelasi lintas node | 10 §5.4 | F6 (timeline v1 di F1) |
| 137 | Canvas sebagai sensor intent (kedekatan = konteks) | 10 §5.6 | **Tunda**: heuristik bisa menyesatkan (kebenaran). Tinjau setelah plan node F4 dipakai. Template grup → factories F6 |
| 138 | Kill-switch berjenjang + panic snapshot | 10 §5.7 | F3 |
| 139 | Eval harness dari penolakan user | 10 §5.9 | F6 (data dikumpulkan sejak F3) |
| 140 | Setting yang berbohong → status efektif | 12 §3.1 | F0/F1 |
| 141 | Restart server memutus sesi → supervisor PTY | 12 §3.2 | F1 |
| 142 | Worker identik dan zombie | 12 §3.4 | F0 |
| 143 | Anggaran latensi browser node | 12 §3.5 | F1 |
| 144 | Angka tidak sama lintas permukaan | 12 §3.6 | F1/F2 |
| 145 | Doctor yang memperbaiki sendiri | 12 §3.7 | F1 |
| 146 | Undo setting dan tutup node | 12 §3.8 | F3 |
| 147 | Preferensi bahasa untuk UI, Telegram, agent | 12 §3.9 | F2 (agent/Telegram). i18n UI penuh: Tunda, tinjau setelah F3 |
| 148 | Same-uid sebagai temuan keamanan utama | 11 §1 | F0 |

## G. Ide baru dari sintesis

| # | Ide | Status | Alasan |
|---|---|---|---|
| 149 | Anchor hash chain di luar jangkauan uid (Keychain + tampilan UI/Telegram) | F1 | Tanpa anchor, chain bisa dihitung ulang |
| 150 | Cable-grant dihitung dari edge, tidak disalin | F1 | Tidak ada state ganda lintas DB |
| 151 | `caffeinate -i` selama routine/DAG aktif | F4 | Mesin tidur adalah penyebab utama run terlewat |
| 152 | Self-test per baris Panel Control (status efektif diverifikasi, bukan diklaim) | F1 | A3 |
| 153 | Kumpulkan keputusan approve/deny sebagai dataset sejak F3 | F3 | Bahan eval harness (#139) dan policy simulator (#81) |

## H. Pola kecil dari lanskap (02/04) yang juga diadopsi atau dicatat

| # | Ide | Sumber | Status | Catatan |
|---|---|---|---|---|
| 154 | Mailbox `send`/`ask`/`reply` yang memblokir + "kabari saat node X idle/exit" | 02 #5, Claude cross-session | F2 (send/notify-once), F4 (ask/reply di DAG) | Di skill: dilarang polling |
| 155 | PreToolUse `defer` + `updatedInput` | 02 §2 | F3 | **[V]** perilaku `defer` |
| 156 | Backpressure: retry dengan jitter saat server overloaded | 02 Codex | F2 | Di klien CLI/MCP |
| 157 | Plugin yang memutasi argumen tool | 02 OpenCode | **Tunda** | Butuh model plugin. Tinjau setelah registry stabil (F2) |
| 158 | Settings bertingkat managed > project > user | 02 Claude | F1 | Policy: global → workspace → node |
| 159 | `AGENTS.local.md` untuk aturan pribadi | 02 Devin | F5 | Bersama #107 |
| 160 | `!cmd`: shell langsung tanpa approval dari input agent | 02 VS Code | F2 | Principal `human-ui`, bukan agent |
| 161 | Komentar/status per worktree (Orca `worktree set --comment`) | 02 Orca | F3 | Bersama I2-b |
| 162 | Artifacts/skills share (Orca) | 02 Orca | **Tunda** | Satu user. Tinjau bila ada kolaborator |
| 163 | Kendali UI OS (`computer`) dan emulator | 02 Orca | **Tunda** | Di luar inti dev web. Tinjau bila ada kebutuhan mobile native |
| 164 | Relay mobile e2ee | 02 Orca | **Tunda** | Token + Telegram + PWA cukup. Tinjau bila akses dari luar LAN tanpa Telegram |
| 165 | mDNS discovery | 02 OpenCode | **Tolak** | Satu mesin |
| 166 | Agent sebagai folder (`instructions.md`, `tools/`, evals) | 05 Cursor SDK | F6 | Bentuk template factories |
| 167 | Security review bot (attack path + fix) | 05 Cursor | F6 | Bersama #83 |
| 168 | Batas eksplisit per tugas (Copilot: 1 branch, 1 PR, batas waktu) | 04 | F4 | Field brief + timeout run |
| 169 | Eksekusi durable dan resumable setelah crash | 04 Anthropic | F4 | DAG state di ledger, reconcile saat boot |
| 170 | Index auto-memory ringkas (200 baris/25KB) | 03 Claude | F5 | Batas blok prosedural |
