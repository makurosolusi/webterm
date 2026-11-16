# 10 — Posisi VISIONER: webterm sebagai "rumah" agen (wkr-debate-visionary-46)

Prinsip: perkaya fitur (`feedback-perkaya-fitur`). Kompatibilitas dengan kode lama tidak dihitung sebagai alasan. Alasan yang sah hanya keamanan, kehilangan data, atau biaya yang terbukti. Semua ide meniru pola yang sudah jalan (`feedback-tiru-referensi`) dan aktif tanpa env flag (`feedback-zero-config`). Bukti diambil dari laporan 01–05. Saya juga mengecek langsung tiga klaim di repo: `toolRegistry.ts:40-45` membuang tool yang tidak muat budget tanpa memberi tahu, `linkNoteDelivery.ts:131-137` memakai `setInterval` 1 dtk, dan grep `permissionDecision` di `src/server` tidak menemukan apa pun.

## 1. Tesis

Saat ini webterm berisi fitur-fitur cerdas yang berdiri sendiri-sendiri. Ada tujuh daftar kemampuan dengan tiga model otorisasi (01 §5 D1), empat pintu spawn (D2), lima adapter approval (D3), delapan sumber event tanpa bus (01 §4), dan tiga DB yang tidak bisa di-JOIN (01 §6.10). Hanya Claude yang "sadar" (D7). Masalahnya ada di **arsitektur**, bukan fitur yang kurang. Karena itu saya tidak mengusulkan 40 tambalan. Saya mengusulkan **satu sistem saraf** dengan tujuh organ yang saling mengunci. Fitur IDE (05) menjadi "tangan" yang memakai sistem saraf itu, bukan modul terpisah.

## 2. Arsitektur target: tujuh subsistem

### S1. Capability Registry: satu sumber kebenaran untuk "god mode"
`defineCapability({name, summary, params: JSONSchema, result, tier, destructive, scope, idempotencyKey, streaming, handler})`, meniru Orca `defineMethod` (02 §1, `rpc/core.ts:181-187`). Registry ini **membangkitkan** lima proyeksi:
- tool MCP (stdio + HTTP, spesifikasi 2026-07-28 stateless, `tools/list` deterministik demi prompt cache, 02 §10),
- CLI `webterm <grup> <verb>` + `webterm agent-context --json` (pola Orca),
- route `/api/v1/<name>` + OpenAPI `/doc` (pola OpenCode),
- katalog Central, yang berubah menjadi function-calling native,
- palette ⌘K beserta keybinding (05 G8).

Test drift memaksa tiap kapabilitas muncul di semua proyeksi. Tiap mutasi mengembalikan receipt `{outcome, detail, next}` dan aman di-replay lewat `operationId` (02 §12.10).

**Diganti:** `CAPABILITY_VERBS` (`control/capabilities.ts:12-38`), `ToolDef.usage` berupa teks (`toolTypes.ts:40-59`), `DEFAULT_CENTRAL_TOOLS` (`toolExecutors.ts:16`), shim sh+curl `browserAgentShim.ts`/`contextLinkSkill.ts` (diganti CLI hasil generate), dan **parser teks `<webterm-proposal>`** (`proposalParser.ts`). Central dijalankan dengan `--mcp-config` yang menunjuk ke MCP webterm, tetap di belakang guard (01 §6.2). Pembuangan diam-diam di `renderCatalog` hilang karena MCP memakai progressive disclosure, bukan katalog 1200 token. Nama `browser_status`/`browser_act` diseragamkan memakai titik.

### S2. Identity & Policy: satu model izin
Tier R0–R3 digabung dengan verb capability menjadi **tier + aturan pola allow/ask/deny (last-match-wins) + mode (observe/propose/act_gated/act_envelope) + grant per caller** (02 §12.2, Orca 8 tier, OpenCode `remember`). Identitas caller dibuktikan (owner-proof), tidak cukup diakui. Setiap node agent otomatis mendapat grant ber-scope workspace sendiri, misalnya `node.spawn` ke workspace sendiri dan `memory.search`. Ini menutup gap "agent terminal tidak bisa mengorkestrasi" (01 §1d, §6.3). Token node dan capability dipersist ke DB supaya tetap hidup setelah restart (01 §6.9). Kartu approval selalu menawarkan **"izinkan pola ini selamanya"**, yang menulis amandemen policy (Codex `proposedExecpolicyAmendment`, 02 §4).

**Diganti:** `controlAuth.ts`, mint lewat `WEBTERM_ALLOW_TOKEN_MINT=1` (env-only, melanggar zero-config), dan tier minimum yang di-hardcode di `controlGuard.ts:26`. `controlGuard` tetap ada sebagai *satu* gerbang. Inputnya saja yang berganti, dari policy yang di-query.

### S3. Senses: event bus terpadu
Satu tabel `signal` (append-only, dedupe key, sumber, workspace, node) + pub/sub in-process + SSE/WS ke klien. Produsennya hook Claude (11 event, sekarang tidak disimpan, 01 §4), fsWatch, exit code PTY, kabel/workspace, CDP browser, Telegram, timer, port scanner (05 G6), dan hook yang dinormalisasi dari Codex/OpenCode/Gemini. Katalog event-nya meniru katalog hook Claude Code (02 §12.8). `wake(reason)` menjadi salah satu subscriber, begitu juga Awareness, Inbox, Routines, Timeline, dan notifikasi OS.

**Diganti:** poll 1 dtk `linkNoteDelivery.ts:131-143`, trigger tunggal `worker_settled` (`wake.ts`, `centralAutonomy.ts:190`), dan sebagian besar timer reconciler (01 §4). Trigger append-only V9 yang tertunda (`ledgerSchemaV9.ts:5`) dikerjakan di sini.

### S4. Memory Fabric
Fondasinya sudah benar: ledger, FTS ganda, RRF, provenance, redaksi (03 §0). Yang ditambahkan:
- kolom `kind` semantic/episodic/procedural, dengan procedural selalu dimuat (03 §1.1),
- validitas bi-temporal `valid_from/valid_to/superseded_by/source_event_id` (Graphiti, 03 §1.2),
- **Sleep-time consolidator** yang membaca `signal` + transcript lalu mengusulkan ADD/UPDATE/INVALIDATE berlabel `unverified` (Letta/Mem0, 03 §1.3),
- **shared blocks / blackboard** `goal:<id>/status` yang read-only untuk node (03 §1.4, §4.3),
- leg embedding untuk teks bebas saja beserta `embed_cache` (03 §6.7), dan sengaja tanpa vector index kode,
- re-verifikasi saat dipakai (path/flag masih ada?), tombstone, incognito, serta "lupakan / jangan sebut lagi" (03 §5).

Hal terpenting: memory **tidak lagi khusus Central**. Semua node mengaksesnya lewat MCP `memory.*` (01 §6.7).

### S5. Context Engine: konteks, cache, kontinuitas
- Assembler prefix-stabil (`contextAssembler.ts`) dijadikan default tanpa flag `WEBTERM_CENTRAL_CHECKPOINT`.
- Summarizer checkpoint LLM dengan template terstruktur menggantikan `rollingSummarize` deterministik (03 §2.1, celah terbesar).
- **Handoff card** di ledger berisi bukti yang diisi *sistem* (diff stat, exit code test), bukan klaim model (03 §4.1, memory `worker-laporan-fiktif`).
- `tool_cache` berkunci versi sumber (git HEAD/mtime/ledger seq), dan tabel `prefix` yang selama ini mati akhirnya ditulis (01 §3), lengkap dengan metrik hit-rate di dashboard (03 §3).
- **Provenance panel** per node, "apa yang dimuat sesi ini" (Devin Customize, 02 §6).
- Repo-map naik level: simbol + PageRank personal + LSP (03 §2.3, 05 G9).

### S6. Inbox & Attention: satu tempat untuk semua "butuh manusia"
Satu model interrupt: **notify / question / review / gate** dengan aksi approve/edit/reply/ignore/snooze (04 §1, §3). Inbox menyatukan approval proposal, decision gate DAG, hook `PermissionRequest` yang **benar-benar dijawab** (sekarang hanya badge, knob `WEBTERM_PERM_WAIT_SECS` mati, 01 D3), handoff browser, dan izin Codex/OpenCode. Antarmukanya ada di canvas, Telegram (inline button), Web Notification/PWA push (05 G4/G12), dan OSC 9/777 di terminal. Aturan perhatiannya meniru Orca: tidak mendorong notifikasi kalau user sedang menatap node itu, berita worker cukup untuk Central, ada mute dan digest (04 §2 `agent-attention-policy.ts`).

**Diganti:** lima adapter approval (D3) diganti satu Inbox. Pengetikan `[webterm]` ke PTY turun menjadi **fallback**, sedangkan jalur utamanya adalah channel MCP `claude/channel` (02 §2, §12.4).

### S7. Agency: Routines, DAG, Workspaces-as-Worktrees, Checkpoints
- **Routines** = Schedule | Event (signal) | API, ditambah precheck shell, catch-up satu kali, dan riwayat skip beserta alasannya (04 §1, Orca `precheck-runner.ts`).
- **Task DAG** dengan decision gate khusus manusia, lease file, breaker 3x per task, stale-base guard, brief terstruktur wajib, dan tahap verifier wajib (04 §2, MAST).
- **Workspace = worktree** sebagai warga kelas satu. Memakai ulang `orchestrator/worktree.ts`, dengan `orca.yaml` setup dan `.worktreeinclude` (05 G3). Spawn PTY dan spawn headless digabung menjadi **satu runner** dengan dua mode tampilan (PTY atau ACP chat terstruktur, 02 §7). Empat pintu spawn (D2) dilebur jadi satu kapabilitas `agent.spawn`.
- **Checkpoint/Rewind level workspace** lewat `git stash create`/`write-tree` sebelum setiap aksi `act_*` dan setiap prompt agent. Ini lebih kuat dari Claude/Cursor karena menangkap perubahan lewat Bash (04 §3.1). Inilah yang membuat `act_envelope` aman dinyalakan.
- **Review loop**: diff node Monaco + anotasi per baris → "Send to agent", Keep/Undo per hunk, SCM dengan pesan commit dari AI (05 G1/G2). Diff node dikabel ke agent dan refresh otomatis saat status `done`.

**Diganti:** empat model status agent (D8) menjadi satu state machine yang diturunkan dari `signal`. Delapan flag rilis CA2 yang env-only (01 §5) pindah ke **satu panel Control** berisi level per workspace, budget, policy, dan sakelar fitur, semuanya default ON (zero-config).

## 3. Cara organ saling mengunci

Registry adalah *mulut dan tangan*. Senses adalah *telinga*. Memory dan Context adalah *ingatan*. Inbox adalah *hati nurani*. Agency adalah *kehendak*. Tiap kapabilitas yang dipanggil (S1) melewati Policy (S2), menulis `signal` (S3), membuat checkpoint bila memutasi (S7), dan bila perlu manusia, masuk ke Inbox (S6). Konsolidator (S4) belajar dari `signal`. Context Engine (S5) menyuntikkan blackboard dan situational feed ke semua agen lewat MCP/channel. Hasilnya, satu fitur baru cukup ditulis **sekali**, lalu langsung muncul di CLI, MCP, Central, HTTP, palette, timeline, dan audit.

**World model**: buat satu `ATTACH DATABASE` (atau view gabungan) atas webterm.db, ledger.db, dan knowledge.db supaya Central bisa bertanya "node mana di project X yang blocked sejak kemarin?" (01 §6.10). Ini murah dan tidak perlu memindahkan data.

## 4. Sehari bersama webterm

- **07:30, di HP (PWA).** Ada digest pagi dari handoff card: "Kemarin 3 task selesai (diff + test hijau, diverifikasi sistem). 1 gate menunggu: pilih skema A/B. Routine nightly menemukan 2 test flaky." Saya ketuk B. DAG lanjut sendiri.
- **09:00, ⌘K: "tambah export CSV di laporan".** Central membuat node Rencana di canvas, lalu memecahnya menjadi tiga task dengan lease file yang tidak beririsan. Tiap task mendapat worktree sendiri. Codex dan Claude dikabel ke Rencana. Perkiraan biaya tampil sebelum saya setujui.
- **09:20.** Codex meminta izin `bun add papaparse`. Kartu muncul di Inbox, bukan sekadar badge. Saya pilih "izinkan `bun add *` di workspace ini selamanya". Policy bertambah satu aturan.
- **10:05.** Signal: test gagal di PTY worker B. Sistem membuatnya bangun dengan konteks error dari Problems matcher, tanpa saya mengetik apa pun. Pada percobaan ketiga yang identik, breaker berbunyi dan masuk Inbox sebagai `question`.
- **11:00.** Diff node menampilkan perubahan ketiga worktree. Saya beri dua anotasi lalu "Send to agent". Keep/Undo per hunk, lalu commit dengan pesan dari AI. Push tetap human-only.
- **14:00.** Agen salah menghapus folder lewat Bash. Saya buka timeline, klik checkpoint 13:58, dan Rewind. Working tree pulih.
- **Malam.** Consolidator mengusulkan memory procedural "user tolak dependency untuk hal < 20 baris". Besok semua node mewarisinya lewat blackboard.

## 5. Ide yang luput dari kelima laporan

1. **Self-describing app.** Registry menjadi sumber docs, HelpOverlay, dan *changelog kapabilitas*. Agen bisa bertanya "apa yang baru sejak sesi lalu?" lewat diff registry antar versi.
2. **Policy simulator / dry-run.** Sebelum menaikkan level ke `act_envelope`, putar ulang signal 7 hari terakhir terhadap policy baru: "dengan policy ini, 42 aksi auto, 3 akan ke Inbox, 0 never-auto dilanggar." Keputusan otonomi jadi berbasis data.
3. **Cost/latency oracle per routine.** Ledger `usage` sudah mencatat biaya. Biaya itu diproyeksikan per routine/DAG, dan routine yang ROI-nya rendah dimatikan otomatis dengan notify.
4. **Session replay terkorelasi.** Timeline menyatukan scrollback PTY, transcript, diff, dan screenshot browser pada satu sumbu waktu (Devin Progress, tapi lintas node). Rewind bisa dilakukan dari titik mana pun.
5. **Ghost agent / speculative prefetch.** Saat user idle di file X, prefetch `project.brief`, repo-map, dan memory relevan ke `tool_cache`, supaya prompt berikutnya instan dan cache sudah hangat.
6. **Canvas sebagai sensor intent.** Posisi dan kedekatan node, kabel, dan grup menjadi sinyal: node yang ditaruh berdekatan dianggap satu konteks. Kelompok node bisa disimpan sebagai "Factory template" (Warp, 02 §9).
7. **Kill-switch berjenjang + "panic snapshot".** Halt global langsung membuat checkpoint semua worktree lalu membekukan grant, jadi berhenti tanpa kehilangan state.
8. **Prompt-injection firewall di boundary Senses.** Konten browser/web diberi tag `untrusted`. Signal bertag itu tidak boleh memicu routine bertier ≥R2 atau masuk memory procedural (memperluas 03 §1 pitfall poisoning ke seluruh bus).
9. **Eval harness pribadi.** Setiap gate dan approval yang ditolak menjadi kasus eval regresi untuk planner/classifier. Sistem belajar dari "tidak" milik user, bukan hanya dari "ya".
10. **Agent Card per node (format A2A).** Kapabilitas, model, worktree, dan biaya node bisa di-query, sehingga Central memilih harness terbaik untuk tiap task (bake-off otomatis, 05 G14).
11. **Secret broker.** Agen meminta `secret.use(name)` lewat registry, dan nilainya disuntik ke proses tanpa pernah masuk konteks model (Cursor sudo prompt, 02 §5; Rule 7).

## 6. Urutan (supaya visi ini tidak menjadi big-bang)

- **Fondasi (W1):** S1 Registry + MCP + CLI generate, S3 tabel `signal`, dan S2 policy minimal. Semua organ lain bergantung pada tiga ini.
- **W2:** S6 Inbox penuh (termasuk jawaban `PermissionRequest`), S7 Checkpoint/Rewind, dan diff node.
- **W3:** S4 consolidator + temporal + shared blocks, dan S5 summarizer + handoff card.
- **W4:** Routines, DAG + lease, worktree workspace, ACP, dan ide §5.

Risiko yang saya akui secara eksplisit:
- Channel Claude masih research preview, jadi fallback ketik-PTY tetap dipertahankan (02 §12 catatan risiko).
- Biaya multi-agent bisa 15× (04 §2). Ini dimitigasi lewat budget dan oracle.
- Mutasi git (G2/G3) tetap human-only untuk push dan hapus branch.

Tidak ada risiko lain yang membenarkan mempertahankan tujuh daftar kemampuan, lima adapter approval, dan poll 1 detik.
