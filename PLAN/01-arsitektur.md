# 01 — Arsitektur target

Semua path relatif ke repo. Rujukan seperti "01 §5" atau "02 #4" menunjuk ke dokumen sumber di [`PLAN/rnd/`](rnd/). Referensi yang ditiru disebut per subsistem. Tanda **[V]** berarti harus diverifikasi sebelum dibangun (lihat `05-risiko-dan-verifikasi.md`).

## 0. Keputusan atas perbedaan pendapat dalam debat

| # | Perselisihan | Posisi | Keputusan | Alasan (jenis) |
|---|---|---|---|---|
| K1 | Fase pertama | Visioner: registry + signal + policy dulu. Engineer: F0 tutup lubang same-uid dulu. User-flow: tiap gelombang harus terlihat | **F0 = hardening same-uid + quick win terlihat** (notifikasi OS, panel status efektif read-only, guard file sensitif). Spine baru dikerjakan di F1 | **Keamanan.** Menambah kuasa agent di atas `auth.json` yang bisa di-`cat` cuma memperbesar ledakan. Quick win memenuhi syarat user-flow tanpa menunda hardening |
| K2 | Jalur push ke sesi | Visioner: channel `claude/channel` jadi jalur utama, PTY sebagai fallback. Engineer: channel hanya adapter di belakang outbox | **Outbox dengan transport yang dipilih otomatis.** Urutan pilihannya: channel (bila tersedia tanpa flag *dangerous*), lalu `additionalContext` hook, lalu ketik ke PTY. Ketik ke PTY tetap transport kelas satu | **Kematangan protokol + zero-config.** Channel kustom masih research preview dan butuh `--dangerously-load-development-channels`, yang melanggar A2 |
| K3 | Grant untuk node | Visioner: tiap node otomatis mendapat grant ber-scope workspace, termasuk `node.spawn`. Engineer: grant hanya diterbitkan `human-ui`, tidak boleh berantai | **Spawn oleh manusia = persetujuan atas grant dasar** (baca R0, `memory.search`, `node.spawn` di workspace sendiri dengan kedalaman ≤2 dan cap 3/5). Node anak hanya mewarisi **subset** grant induk (atenuasi). Penerbitan grant oleh agent untuk agent lain **ditolak** | **Keamanan.** Atenuasi tidak bisa menaikkan kuasa, sedangkan penerbitan berantai bisa. Fitur orkestrasi dari terminal tetap ada |
| K4 | "Izinkan pola ini selamanya" | Visioner/user-flow: dari Inbox dan Telegram. Engineer: Telegram cukup sekali, pola permanen hanya dari UI | **Telegram: "izinkan sekali" + tautan "buka di webterm untuk izinkan selamanya".** Amandemen policy hanya lewat principal `human-ui` (same-origin, `approvalAuth.ts`) | **Keamanan.** Isi chat Telegram bisa disusupi, dan aturan permanen adalah kuasa jangka panjang |
| K5 | Tiga DB | Visioner: `ATTACH` atau view gabungan. User-flow: satu sumber hitungan | **World view berbasis `ATTACH`** (baca saja) + satu modul hitungan dipakai semua permukaan. File DB **tidak** digabung sekarang. `channels.json` dimigrasi ke tabel ledger | **Data loss.** Menggabung file berisiko di migrasi, padahal `ATTACH` sudah memenuhi fitur "angka sama" sepenuhnya. Ditinjau ulang bila butuh transaksi tulis lintas DB |
| K6 | Kapan diff/rewind | User-flow: tolak bila diff/rewind datang setelah otonomi. Visioner W2, engineer F3 | **Diff node mulai di F1 (track IDE paralel). Rewind di F3, sebelum otonomi F4** | **Keamanan/kebenaran.** Otonomi tanpa rewind hanya memindahkan risiko ke user |
| K7 | Parser teks `<webterm-proposal>` | Visioner: hapus. Engineer: pakai MCP, tetap `--strict-mcp-config` | **Hapus setelah F2 lulus** untuk runtime claude **dan** opencode. Mock ikut memakai MCP | **Kebenaran.** Function-calling native tidak lagi membuang tool diam-diam (`toolRegistry.ts` `renderCatalog`) |
| K8 | Default sakelar | Visioner: semua ON. Memory CA2: flag default OFF | **Fitur baca, awareness, dan notifikasi default ON. Level otonomi default `propose`. `act_envelope` tidak pernah default** | **Keamanan** hanya untuk mutasi. Sisanya mengikuti zero-config |
| K9 | Hash chain | Engineer: deteksi saja, jujur soal batasnya | **Adopsi + anchor eksternal** (head hash berkala ke Keychain dan ditampilkan di UI/Telegram) | **Keamanan.** Tanpa anchor di luar jangkauan uid yang sama, chain bisa dihitung ulang oleh penyerang |
| K10 | ACP client | Visioner W4, laporan 02 #7 | **F6** | **Kematangan protokol.** ACP v2 masih draft, sementara jalur PTY sudah berfungsi |

## 1. Peta subsistem

```
          ┌──────────── Proyeksi (dibangkitkan) ────────────┐
          │ MCP stdio │ CLI webterm │ HTTP+OpenAPI │ Central │ ⌘K/keys │
          └──────────────────────┬──────────────────────────┘
                                 ▼
 S1 Capability Registry ──► execCapability(principal, cap, args, opId)
                                 │
            S2 Policy/Principal/Grant ──► controlGuard (level→pause→cap→budget→doom→breaker)
                                 │                       │ ask
                                 ▼                       ▼
                        handler + S7 checkpoint     S4 Inbox ──► human-ui / Telegram
                                 │
                                 ▼
             S3 Event log (hash chain, taint) ──► subscribers:
                 wake · Awareness(S8) · Inbox · Routines(S7) · Timeline · Notifikasi · Consolidator(S5)
                                 │
          S5 Memory fabric ◄─────┴────► S6 Context engine & cache ──► Outbox ──► sesi agent
```

## 2. Subsistem

### S1. Capability Registry
- **Isi:** `defineCapability({name, summary, params: JSONSchema, result, tier, destructive, scope, idempotent, streaming, handler})`. Proyeksi: MCP `tools/list` (urutan deterministik demi prompt cache), CLI `webterm <grup> <verb>` + `webterm agent-context --json`, `POST /api/cap/:name` + OpenAPI `/doc`, katalog Central (function-calling), dan ⌘K + keybinding (registry perintah client, 05 G8).
- **Test drift** gagal bila ada capability yang tidak muncul di salah satu proyeksi, atau ada daftar verb di luar registry.
- **Katalog besar:** memakai progressive disclosure (`cap.search`, `cap.describe`). Tool tidak pernah dibuang diam-diam.
- **Typo CLI** tidak pernah disarankan menjadi perintah destruktif.
- **Diganti:** `CAPABILITY_VERBS` (`src/server/control/capabilities.ts:12-38`), `ToolDef.usage` teks (`src/server/central/tools/toolTypes.ts:40-59`), `DEFAULT_CENTRAL_TOOLS` (`chat/toolExecutors.ts:16`), shim sh+curl `browserAgentShim.ts`/`contextLinkSkill.ts` (diganti CLI hasil generate + skill stub), `BROWSER_VERB_CAP` (`shared/browser.contract.ts:177`), dan nama `browser_status`/`browser_act` (menjadi `browser.status`/`browser.act`).
- **Tiru:** Orca `defineMethod` `src/main/runtime/rpc/core.ts:181-187`, `CommandSpec` `src/cli/command-spec.ts:1-21`, `agent-context.ts:27-52`, `command-suggestion.ts`, test drift `handler-group-manifest.ts:15`. OpenCode `/doc` OpenAPI 3.1. Codex `generate-json-schema`.

### S2. Policy, principal, grant
- **Principal:** `human-ui` (same-origin, `src/server/approvalAuth.ts`), `central`, `node:<id>`, `channel:telegram:<chat>`, `routine:<id>`. Identitas dibuktikan lewat token per spawn, bukan sekadar diakui (Orca `rpc-caller-identity.ts`, `agent-session-owner-proof.ts`).
- **Evaluasi:** tier bawaan capability → aturan `allow/ask/deny` per principal × scope (*last-match-wins*, pola OpenCode) → level scope → `controlGuard`.
- **Cable-as-grant:** grant kabel **dihitung dari edge `webterm.db` saat cek**, tidak disalin ke tabel lain, sehingga tidak bisa melenceng. Grant eksplisit (aturan permanen) disimpan di ledger dan hanya ditulis `human-ui`.
- **Never-auto:** capability dengan `destructive: true` tidak bisa di-override oleh classifier, routine, atau Telegram.
- **Persistensi:** token node dan grant selamat dari restart (gap 01 §6.9).
- **Diganti:** `controlAuth.ts:15-34`, mint lewat `WEBTERM_ALLOW_TOKEN_MINT=1`, dan tier minimum yang di-hardcode di `controlGuard.ts:26` (menjadi data policy). `controlGuard` tetap jadi **satu** gerbang.
- **Tiru:** Orca 8 tier `rpc-method-permission.ts:1-36` + `rpc-caller-scope.ts`, OpenCode permissions (`remember`, `doom_loop`, `external_directory`), Codex `proposedExecpolicyAmendment`, Claude Code permission rules dan modes.

### S3. Senses / event log
- **Tabel `event` di `ledger.db`:** kolom `seq, ts, source, kind, workspace_id, node_id, principal, dedupe_key, trust ('trusted'|'untrusted'), payload_json, prev_hash, hash`. Trigger append-only menutup `TODO(ca2-audit)` di `src/server/ledger/ledgerSchemaV9.ts:5`. Hash chain + `verifyChain()` + anchor eksternal (K9).
- **Produsen:** 11 event hook Claude (hari ini tidak disimpan), hook Codex/OpenCode/Gemini yang dinormalisasi, PTY exit/exit code, `fsWatch`, edge/workspace berubah, CDP browser, Telegram, timer, port scanner, dan hasil setiap capability. Katalog event meniru katalog hook Claude Code.
- **Konsumen:** pub/sub in-process + SSE/WS ke klien. `wake(reason)` (`src/server/central/wake.ts`) menjadi salah satu subscriber.
- **Taint:** konten dari browser, web, atau output pihak luar diberi tanda `untrusted`. Event bertanda ini tidak boleh memicu routine bertier ≥R2 (firewall prompt injection).
- **Diganti:** poll 1 dtk `linkNoteDelivery.ts:131-143`, trigger tunggal `worker_settled` (`centralAutonomy.ts:190`), timer `agentReconciler`/`turnReconciler` sebisa mungkin, dan empat model status agent (D8, menjadi satu state machine yang diturunkan dari event).
- **Tiru:** Claude Code hooks (~35 event), Orca coordinator mailbox, OpenCode `/global/event` SSE.

### S4. Inbox & approval loop
- **Model:** `inbox_item {kind: notify|question|review|gate, origin, principal, cap, args_digest, impact, expires_at, state}`. Aksinya `approve / edit / reply / ignore / snooze`. Item sejenis bisa di-*batch*.
- **PermissionRequest tertutup:** hook ditahan (sudah sampai 540 dtk, `hooksSettings.ts:32,57`). Server menunggu keputusan Inbox lalu membalas `decision` (hari ini hanya `additionalContext`, `agentStatusApi.ts:162`). Timeout jatuh kembali ke prompt biasa di terminal. Format balasan **[V]**.
- **Adapter yang disatukan:** `/api/control/approval/*`, `/api/approvals*`, `channelApprovals`, `orchestratorRunApproval`, kartu proposal Central, handoff browser, izin Codex/OpenCode. Ledger `approval` tetap menjadi satu tabel kebenaran.
- **Consent bridge:** klik manusia ("izinkan push branch X", "approve plan") dicatat sebagai event `human-ui`, lalu disuntikkan ke agent sebagai **fakta terverifikasi bersumber event id**. Agent tidak perlu menolak karena aturan global, dan izinnya tetap datang dari manusia.
- **Perhatian:** tidak mengirim push kalau kamu sedang menatap node itu, berita worker selesai cukup untuk Central, ada mute per workspace dan digest. Permukaannya: canvas, judul tab, notifikasi OS, Telegram (inline button), PWA (F6), OSC 9/777.
- **Tiru:** LangChain Agent Inbox (UX saja, repo diarsipkan), Codex `requestApproval` + `availableDecisions`, OpenCode `/permissions/:pid`, Orca `agent-attention-policy.ts:15,62-64`, Orca decision gates `coordinator-decision-gates.ts:5-60`.

### S5. Memory fabric
- **Fondasi yang sudah ada dan dipertahankan:** ledger memory, FTS unicode61 + trigram, RRF (`memory/memoryHybrid.ts`), label `unverified`, dan redaksi.
- **Tambahan:** kolom `kind` (semantic/episodic/procedural), `valid_from/valid_to/superseded_by/source_event_id` (bi-temporal), tombstone, supresi "jangan sebut lagi", mode incognito, re-verifikasi saat dipakai (path/flag masih ada?), dan skor kesegaran.
- **Satu penulis:** Central/consolidator. Node hanya mengusulkan lewat `memory.propose`, kecuali perintah eksplisit `remember` dari user.
- **Consolidator sleep-time:** membaca event + transcript, mengusulkan ADD/UPDATE/INVALIDATE berlabel `unverified`. Konten `untrusted` hanya boleh menjadi `episodic` bersumber.
- **Embedding:** hanya untuk teks bebas (memori, percakapan), dengan `embed_cache` (menutup `TODO(ca2-08)`). **Tidak ada** vector index kode.
- **Akses:** semua node lewat MCP `memory.*`. Memori tidak lagi khusus Central.
- **Tiru:** Letta memory blocks + sleep-time, Mem0 ADD/UPDATE/DELETE/NOOP, Graphiti bi-temporal, ChatGPT memory controls, Claude Code auto-memory (index 200 baris).

### S6. Context engine & cache
- **Assembler prefix-stabil** (`central/context/contextAssembler.ts`) menjadi default tanpa `WEBTERM_CENTRAL_CHECKPOINT`. Urutannya: aturan → procedural → shared blocks → *(breakpoint)* → semantic hasil retrieval → situational feed → pesan. Tidak ada timestamp di prefix, dan semua daftar diurutkan deterministik.
- **Summarizer checkpoint LLM** dengan template (tujuan, keputusan + alasan, file, status, pertanyaan terbuka, langkah berikut) menggantikan `rollingSummarize`. Versi deterministik dipertahankan sebagai fallback.
- **Handoff card** di ledger: narasi dari model, evidence dari sistem.
- **Kartu identifier, bukan dump:** blok konteks berisi id/path/URL plus satu baris status, dan isinya dimuat on-demand.
- **Cache:** writer untuk tabel `prefix` (hari ini mati), metrik hit-rate, `tool_cache` (kunci = hash(cap, args, versi sumber), hanya untuk capability R0 `idempotent`), dan TTL 1 jam bersyarat untuk Central saat sesi Telegram aktif, **hanya bila metrik membuktikan**.
- **Provenance panel** per node ("apa yang dimuat sesi ini").
- **Repo-map** naik level (simbol + PageRank personal), Explore sub-agent, LSP (F6).
- **Tiru:** Anthropic context engineering + prompt caching docs, Aider repo map, Devin Customize, Claude `InstructionsLoaded`.

### S7. Agency
- **Routines:** `Schedule | Event | API` + precheck shell + catch-up sekali + riwayat skip beserta alasannya (`skipped_precheck|missed|unavailable|needs_interactive_auth`). Routine adalah principal sendiri dengan grant sempit dan budget harian. Tiru Orca `precheck-runner.ts:131-189`, `automations-types.ts:14-17`, dan Claude Desktop scheduled tasks.
- **Task DAG:** brief terstruktur wajib (objektif, format output, tool, batas, path milik), lease path, gate khusus manusia yang di-reblock tiap tick, escalation terikat dispatch, breaker 3× per task, stale-base guard (>20 commit), dan tahap **verifier wajib**. Tiru Orca `coordinator.ts:155-161,228,258,282`, `coordinator-escalation-triage.ts:20-62`, dan `coordinator-stale-base-flag.ts:2-16`.
- **Satu runner spawn:** empat pintu (D2) dilebur jadi `agent.spawn` dengan mode tampilan PTY atau headless (ACP di F6).
- **Workspace = worktree** memakai ulang `src/server/orchestrator/worktree.ts`, `orca.yaml scripts.setup`, dan `.worktreeinclude`.
- **Checkpoint/rewind:** snapshot `git stash create`/`write-tree` sebelum setiap aksi `act_*` dan setiap prompt agent, ref-nya disimpan di event. Aksi di luar fs (HTTP, Telegram, browser) diberi label "tidak bisa di-rewind". Panic snapshot dipicu saat Halt.
- **Receipt/verifier:** `done` hanya ditulis verifier dari evidence. Diff yang menyentuh path di luar lease membuat task gagal.

### S8. Awareness
- **Blok situasional** per agent (roster kabel, status peer, gate, procedural, blackboard goal) dengan TTL pendek, dikirim lewat outbox.
- **Untuk semua CLI:** adapter hook per CLI (Claude sudah ada, lalu Codex, OpenCode, Gemini) **[V]**, MCP auto-configure, dan skill stub yang memanggil `webterm skills get <x>` supaya panduan selalu sesuai versi.
- **Catatan `[webterm]` terlihat** dalam bahasa preferensimu (A7).
- **Diganti:** jalur khusus Claude `hookContext.ts:125-176` + `linkAwareness.ts` + `linkNote*.ts` menjadi satu subscriber Awareness + outbox (pengiriman ketik tetap ada sebagai transport).

## 3. Antarmuka antar subsistem

| Dari → Ke | Kontrak |
|---|---|
| Proyeksi → S1 | `execCapability(principal, name, args, {operationId})` → `Receipt` |
| S1 → S2 | `decide(principal, cap, scope, args) → allow \| ask(reason) \| deny(reason)` |
| S2 ask → S4 | `inbox.open({kind:'review', cap, args_digest, impact})` → menunggu `decision` |
| S1 → S7 | `checkpoint.before(scope)` untuk tier ≥R1 yang memutasi fs |
| Semua → S3 | `events.append({source, kind, trust, payload})` → `seq` |
| S3 → subscriber | `events.subscribe(filter, handler)` + replay dari `seq` |
| S8/S4 → sesi | `outbox.send(nodeId, message, {dedupeKey})` → transport dipilih otomatis |
| S5 ↔ S6 | `memory.retrieve(scope, query, kinds)`, `blocks.render(nodeId)` |

## 4. Data store

| Store | Isi sekarang | Isi target | Catatan |
|---|---|---|---|
| `webterm.db` | workspace, layout, edge, settings | + registry setting (sakelar live, A2), closedHistory | Edge = sumber cable-as-grant |
| `ledger.db` | V1–V9 (project, task, run, event, approval, usage, memory, central_*) | + V10 `event` hash chain/taint, `principal`, `grant_rule`, `inbox_item`, `checkpoint`, `routine`/`routine_run`, `lease`, `tool_cache`, `embed_cache`, memory temporal, `channel_*` (dari `channels.json`) | Semua lewat migration bertahap (Rule 4), idempotent `IF NOT EXISTS` |
| `knowledge.db` | kb_* | + simbol repo-map | Bisa dibangun ulang, jadi risiko data rendah |
| `channels.json` | binding Telegram | **dimigrasi** ke ledger, `.bak` disimpan | Satu sumber hitungan (A4) |
| `WEBTERM_MEMORY_DIR/user/*.md` | memori user | tetap (keputusan P4: di luar git) | Diindeks ke memory fabric |
| World view | — | `ATTACH` `webterm.db` + `knowledge.db` ke koneksi baca ledger | Hanya baca. Mode `ro` **[V]** dukungan URI di `bun:sqlite` |

## 5. Ringkasan kode yang diganti

| Diganti | Oleh | Fase |
|---|---|---|
| 7 daftar kemampuan (D1) | S1 registry | F1 |
| 3 model otorisasi | S2 | F1 |
| Poll linkNote 1 dtk | subscriber S3 | F1 |
| 4 pintu spawn (D2) | `agent.spawn` | F2 |
| Parser `<webterm-proposal>` + katalog 1200 token | MCP function-calling | F2 |
| Shim sh+curl | CLI `webterm` hasil generate + skill stub | F2 |
| 5+ adapter approval (D3) | S4 Inbox | F3 |
| `rollingSummarize` deterministik (jadi fallback) | summarizer LLM | F5 |
| ~8 flag CA2 env-only + knob env | panel Control live | F0 (baca) → F1 (tulis) |
