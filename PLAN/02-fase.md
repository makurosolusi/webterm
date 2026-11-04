# 02 — Fase, kriteria keluar, dan paket kerja

Urutan: **F0 → F1 (∥ track IDE I1) → F2 → F3 (∥ I2) → F4 → F5 → F6.** F5 bagian ringan (procedural ke semua agent) ditarik maju ke F2 karena aturan A7.

Rujukan "01–05" dan "10–12" menunjuk ke dokumen sumber di [`PLAN/rnd/`](rnd/).

Ukuran: S ≈ 1–2 hari, M ≈ 3–5 hari, L ≈ 1–2 minggu, XL > 2 minggu (kerja orkestrator + worker paralel).

Aturan dispatch untuk setiap paket kerja (WP):
- Satu worker per WP, nama `wkr-<domain>-<nn>`.
- Kepemilikan file eksplisit. WP dengan file yang bertabrakan dikerjakan dalam gelombang berurutan.
- Gelombang pertama setiap WP adalah studi referensi read-only (memory `feedback-tiru-referensi`).
- Bukti diff dan test wajib ditempel (memory `worker-laporan-fiktif`).
- Gate: `TMPDIR=/tmp/st npm run typecheck`, `npm test`, `npm run test:bun`.
- Ketujuh aturan terima A1–A7 (`00-visi.md`) berlaku di setiap fase.

---

## F0. Hardening same-uid + quick win terlihat (M)

**Tujuan.** Tutup lubang "agent ber-uid sama bisa `cat auth.json`" sebelum agent diberi kuasa lebih. Bersamaan dengan itu, kirim tiga perubahan yang langsung terasa.

| WP | Isi | File (kepemilikan) | Referensi |
|---|---|---|---|
| F0-a `wkr-sec-01` | Secret server (token root, secret bot) pindah ke Keychain macOS (`security`) atau hanya hidup di memori. Token node per spawn dikirim lewat fd/env proses, bukan file bersama. Settings Claude hasil generate berisi `permissions.deny` `Read(~/.webterm-server/**)`, `Read(**/.env*)`, `Bash(cat ~/.webterm-server*)`, plus sandbox Claude Code bila tersedia **[V]** | `src/server/auth.ts`, `src/server/hooksTokens.ts`, `src/server/hooksSettings.ts`, `src/server/hooks.ts` | Engineer F0; Cursor `beforeReadFile`; Claude Code permissions/sandbox |
| F0-b `wkr-notif-02` | Notifikasi OS (Web Notifications, izin diminta lewat sakelar di Settings), suara pendek, `document.title` "(n) webterm", favicon badge, dan klik notifikasi memfokuskan node. Diteruskan ke Telegram bila tab tersembunyi > N menit | `src/client/unread.ts`, berkas baru `src/client/osNotify.ts`, `src/client/canvasViewport.ts` (hanya fungsi fokus) | Orca `src/main/notifications/desktop-away-state.ts` |
| F0-c `wkr-ctl-03` | Panel Control **baca**: setiap flag dan knob env menampilkan *efektif / alasan / sumber*. Badge MOCK merah saat runtime mock aktif. Status "terlindung / mitigasi" per jenis agent (hasil F0-a) | `src/server/featureCapabilities.*.ts`, `src/server/envSettings.api.ts`, panel client baru `src/client/ControlPanel.tsx` | `featureCapabilities` yang ada; Devin Customize |
| F0-d `wkr-hyg-04` | Guard file sensitif: `cookies.txt`, `.env*`, `*.pem` otomatis ditambahkan ke `.gitignore` saat terdeteksi, dan SCM/agent dilarang men-stage file itu | `.gitignore`, berkas baru `src/server/repoHygiene.ts` | Rule 7 global |
| F0-e `wkr-wid-05` | Identitas worker: nama uniq + warna per node, judul node otomatis dari tugas pertama, dan tombol kill per nama | `src/server/nameGen.ts`, chrome node client | Orca `first-work-branch-rename.ts` |

**Kriteria keluar**
- Test spawn agent nyata yang menjalankan `cat ~/.webterm-server/auth.json` ditolak atau tidak menemukan token.
- Token node A ditolak untuk resource node B.
- Codex/Gemini berlabel "mitigasi" di UI.
- Notifikasi muncul saat status agent berubah ke idle/needs-input ketika tab tidak fokus.
- Panel Control menampilkan semua `WEBTERM_*` perilaku dengan status efektif.

**Test:** `*.bun.test.ts` spawn PTY yang mencoba membaca secret; vitest jsdom untuk title badge dan notifikasi (mock `Notification`); test drift env (A2) dibuat sekarang dan boleh *expected-fail* untuk daftar yang baru dipindah di F1.
**Dependensi:** tidak ada. **Paralel:** semua WP F0 bisa jalan bersamaan.

---

## F1. Tulang punggung (XL)

**Tujuan.** Satu registry, satu model izin, satu log event, satu bentuk receipt. Setiap gelombang tetap mengirim hal yang terlihat (timeline v1, awareness instan, sakelar live).

| WP | Isi | File | Referensi |
|---|---|---|---|
| F1-a `wkr-cap-01` | `defineCapability` + JSON Schema. ToolDef Central diangkat, 7 daftar D1 dilebur, test drift, `cap.search`/`cap.describe`. Receipt `{outcome, detail, next, evidence, operationId}` + replay idempoten | baru `src/server/capability/` (registry, exec, receipt, drift test), `src/server/central/tools/*`, `src/server/control/capabilities.ts` | Orca `rpc/core.ts:181-187`, `handler-group-manifest.ts` |
| F1-b `wkr-pol-02` | Principal + grant + aturan last-match-wins, persist token/grant, cable-as-grant dihitung dari edge, atenuasi grant node anak (K3), dan tier minimum pindah dari konstanta ke data | baru `src/server/policy/`, `src/server/control/controlAuth.ts`, `src/server/central/guard/controlGuard.ts` | Orca `rpc-method-permission.ts`, OpenCode permissions |
| F1-c `wkr-evt-03` | Ledger V10: `event` + `prev_hash/hash/trust/dedupe_key`, trigger append-only (menutup TODO ca2-audit), `verifyChain()`, anchor eksternal, pub/sub + SSE | baru `src/server/ledger/ledgerSchemaV10.ts`, baru `src/server/events/` | Claude Code hooks catalog; Engineer §2.3 |
| F1-d `wkr-evt-04` | Produsen: hook Claude disimpan, PTY exit, fsWatch, edge berubah. linkNote poll 1 dtk diganti subscriber, dan `wake` mendapat produsen baru | `src/server/linkNoteDelivery.ts`, `src/server/agentStatusApi.ts`, `src/server/fsWatch.ts`, `src/server/central/wake.ts` | `wake.ts` yang ada |
| F1-e `wkr-tl-05` | Activity timeline v1 di panel bawah: dikelompokkan per tugas, bisa difilter, klik untuk loncat ke node. Badge level per workspace | client baru `src/client/Timeline.tsx` | Devin Progress, VS Code sessions view |
| F1-f `wkr-ctl-06` | Panel Control **tulis**: semua env perilaku menjadi sakelar live di `settingsStore`, Doctor v1 (cek dan perbaiki hook/skill/`claude auth`/bot), dan world view `ATTACH` + satu modul hitungan | `src/server/settingsStore.ts`, `src/server/envSettings.*`, `src/client/ControlPanel.tsx`, baru `src/server/worldView.ts` | user-flow P0-1 |
| F1-g `wkr-pty-07` | Supervisor PTY: sesi tetap hidup saat proses HTTP di-reload (nol restart untuk developer yang mengedit server) | `src/server/pty.ts`, `src/server/sessions*.ts` | nodeterm tmux socket `-L node-terminal` (`~/Documents/spawn/nodeterm-web`) |

**Track IDE I1 (paralel dengan F1, hanya bergantung pada F1-a untuk versi baca agent)**

| WP | Isi | File | Referensi |
|---|---|---|---|
| I1-a `wkr-srch-01` | Global search `rg --json` dengan limit + paginasi, Cmd+P global berskor recency, ⌘K omnibox (node/file/URL/agent/perintah) dari registry perintah, keybinding kustom, HelpOverlay digenerate | `src/server/fsSearch.ts`, `src/client/App.tsx`, `src/client/HelpOverlay.tsx`, baru `src/client/commandRegistry.ts` | VS Code Search; Orca Quick Open/Jump |
| I1-b `wkr-diff-02` | Diff node Monaco `createDiffEditor`, `GET /api/git/diff`, anotasi per baris → kirim batch ke agent, Keep/Undo per hunk (`git apply -R`), kabel agent→diff dengan auto-refresh saat `done` | baru `src/client/DiffNode.tsx`, baru `src/server/gitDiff.ts`; `src/server/gitInfo.ts` hanya dibaca | Orca `diff-comments/`, `ChangesModeView.tsx`; VS Code working set |
| I1-c `wkr-hist-03` | Riwayat sesi agent (indeks transcript `~/.claude/projects/*/*.jsonl` + Resume), `closedHistory` dipersist ke SQLite | `src/client/closedHistory.ts`, baru `src/server/sessionHistory.ts` | Orca `agents/session-history.mdx` |
| I1-d `wkr-lat-04` | Chip anggaran latensi browser node (input→frame). Perbaikan mengikuti referensi, bukan tambalan | client browser node | Orca/nodeterm screencast |

**Kriteria keluar F1**
- Test drift hijau: setiap capability ada di semua proyeksi yang sudah tersedia.
- `verifyChain()` mendeteksi baris yang diubah, dan anchor tidak cocok memicu peringatan di UI.
- CPU idle tidak lagi memuat tick 1 dtk.
- Restart server tidak memutus grant kabel, dan sesi PTY selamat (F1-g).
- Memasang kabel menghasilkan catatan terlihat dalam < 1 dtk lewat event, bukan poll.
- Tidak ada env perilaku tanpa sakelar UI (test drift A2 hijau penuh).

**Dependensi:** F0-a. **Gelombang:** F1-a, F1-c, F1-g, I1-a, I1-c paralel → F1-b (butuh a), F1-d (butuh c) → F1-e, F1-f → I1-b (butuh a untuk `git.diff` R0).

---

## F2. Proyeksi ke agent (L)

**Tujuan.** Semua jenis agent tahu kemampuannya dan menerima push tanpa restart. Central memakai function-calling native.

| WP | Isi | File | Referensi |
|---|---|---|---|
| F2-a `wkr-mcp-01` | `webterm mcp` stdio (MCP 2026-07-28 stateless, `server/discover`, MRTR, `ttlMs`, tanpa sampling/roots) **[V]**. Token dari fd/env per spawn. Auto-configure per CLI: claude/codex/opencode/gemini | baru `src/server/mcp/`, `src/server/hooks.ts`, `src/server/sessions.ts` (env spawn) | JetBrains MCP auto-configure |
| F2-b `wkr-cli-02` | CLI `webterm` + `agent-context --json` hasil generate, skill stub berversi (`webterm skills get`), diff registry antar versi ("apa yang baru"), pengganti shim sh+curl | baru `src/server/cli/`, `src/server/browserAgentShim.ts`, `src/server/contextLinkSkill.ts` | Orca `agent-context.ts`, `skill-stubs/orca-cli.md` |
| F2-c `wkr-ctr-03` | Central `--mcp-config` ke MCP webterm (`--strict-mcp-config`, tool bawaan tetap `none`, filter env `claudeOptions.ts:60-75` dipertahankan). OpenCode juga lewat MCP. Parser proposal dihapus setelah lulus (K7) | `src/server/central/runtime/*`, `src/server/central/proposal/*`, `src/server/central/chat/toolLoop.ts` | Claude Agent SDK |
| F2-d `wkr-out-04` | Outbox: dedupe, retry `operationId`, antrean saat agent sibuk (diantar di akhir giliran), dan transport channel → hook `additionalContext` → ketik PTY yang dipilih otomatis (K2) | baru `src/server/outbox/`, `src/server/linkNote*.ts` | Orca mailbox wake-not-poll; Claude channels **[V]** |
| F2-e `wkr-awr-05` | Subscriber Awareness untuk semua CLI: roster, kabel, status peer, gate. Blok kartu identifier. Memori **prosedural** user dimuat ke semua agent (A7, versi awal dari S5). Catatan berbahasa preferensi. Consent bridge (klik manusia → fakta terverifikasi) | `src/server/hookContext.ts`, `src/server/linkAwareness.ts`, baru `src/server/awareness/` | Letta shared blocks; user-flow P1-1 |
| F2-f `wkr-sec-06` | Secret broker `secret.use(name)`: nilai disuntik ke proses, tidak pernah masuk konteks model | baru `src/server/secrets/` | Cursor sudo prompt; ide visioner #11 |
| F2-g `wkr-tg-07` | Telegram parity: pairing satu ketuk lewat deep link/QR, satu renderer (HTML + split pesan panjang/blok kode), hitungan dari world view, migrasi `channels.json` → ledger | `src/server/channels/*` | user-flow F6 |
| F2-h `wkr-spawn-08` | Empat pintu spawn dilebur menjadi `agent.spawn` (PTY/headless), dengan kedalaman nesting dan cap | `src/server/control/controlApiSessions.ts`, `src/server/orchestrator/*`, `src/server/central/agents/*` | Orca `NESTED_WORKER_MAX_DEPTH` |

**Kriteria keluar**
- Test e2e per CLI: spawn, `tools/list`, lalu memanggil `project.brief`.
- Node tanpa kabel ditolak saat memanggil `browser.act`.
- Pesan outbox terkirim tepat satu kali walau di-retry.
- Kabel dipasang langsung dipakai Codex di giliran berikutnya (A1).
- Central menjalankan tool via MCP tanpa parser teks.
- Fact prosedural ada di blok Claude dan Codex (A7).
- Angka project di Telegram sama dengan di canvas (A4).

**Dependensi:** F1-a/b/c. **Gelombang:** a, b, d, f, g paralel → c (butuh a), e (butuh d), h.

---

## F3. Human-in-the-loop + rewind (L) ∥ track IDE I2

**Tujuan.** Satu Inbox untuk semua "butuh manusia", `PermissionRequest` benar-benar dijawab, dan semua perubahan bisa dibalik.

| WP | Isi | File | Referensi |
|---|---|---|---|
| F3-a `wkr-inb-01` | Model `inbox_item` (notify/question/review/gate), aksi approve/edit/reply/ignore/snooze, batch, dampak ringkas, attention policy, digest, tombol Telegram (permanen hanya di UI, K4) | `src/client/InboxPanel.tsx`, baru `src/server/inbox/`, `src/server/channels/channelApprovals.ts` | Agent Inbox; Orca attention |
| F3-b `wkr-perm-02` | `PermissionRequest` → Inbox → balasan `decision`. Deny memblok, timeout jatuh ke prompt biasa. Izin Codex/OpenCode **[V]**. Doom-loop di PreToolUse (input identik 3×) | `src/server/agentStatusApi.ts`, `src/server/hooksSettings.ts`, `src/server/hookStatus.ts` | Claude hooks; OpenCode `doom_loop` |
| F3-c `wkr-ckpt-03` | Checkpoint git-object sebelum aksi `act_*` dan sebelum prompt agent, tombol Rewind di timeline, label "tidak bisa di-rewind", peringatan untuk repo tanpa git atau file ignored, panic snapshot saat Halt | baru `src/server/checkpoint/`, `src/client/Timeline.tsx` | Claude/Cursor checkpoints (dan perbaiki celah Bash mereka) |
| F3-d `wkr-undo-04` | Undo setting dan undo tutup node lintas reload | `src/client/layoutHistory.ts`, `src/server/settingsStore.ts` | `layoutHistory` yang ada |
| F3-e `wkr-brief-05` | Brief pagi **deterministik** dari event + receipt (selesai, macet, gate, test merah, biaya), auto-resume agent setelah boot dengan status "dipulihkan" | baru `src/server/brief/`, `src/server/sessions.ts` | user-flow F1 |

**Track IDE I2:** I2-a `wkr-scm-01` SCM (stage/commit dengan pesan AI berformat Rule 9, push human-only, `gh pr create`, laporan Rule 18 digenerate dari test/typecheck/lint yang sungguh dijalankan sebelum tombol Push aktif, "Fix with agent" saat hook gagal; file `src/server/gitScm.ts` baru, panel SCM client; tiru Orca `review/commit-push.mdx`). I2-b `wkr-wt-02` workspace = worktree (`orchestrator/worktree.ts` dipakai ulang, `orca.yaml`, `.worktreeinclude`, hapus = konfirmasi; tiru Orca worktrees).

**Kriteria keluar**
- Approve di Inbox membuat Claude benar-benar menjalankan tool (test hook nyata).
- Rewind memulihkan file yang diubah lewat Bash.
- Push hanya bisa oleh `human-ui` (test 403 untuk node/central).
- Brief pagi tampil dalam ≤ 5 dtk setelah tab dibuka.
- Approve dari Telegram dan dari canvas menghasilkan event yang sama.

**Dependensi:** F1, F2-d. I2 bergantung pada I1-b.

---

## F4. Otonomi (XL)

**Tujuan.** Sistem bertindak sendiri dari sinyal, aman karena ada Inbox (F3) dan rewind (F3).

| WP | Isi | File | Referensi |
|---|---|---|---|
| F4-a `wkr-rtn-01` | Routines Schedule/Event/API + precheck + catch-up sekali + riwayat skip, `caffeinate -i` selama run aktif, template (mis. "cari test yang hilang" mingguan) | baru `src/server/routines/` | Orca automations; Claude Desktop scheduled tasks; Copilot automation |
| F4-b `wkr-dag-02` | Task DAG: brief wajib + aturan skala usaha, lease + gelombang otomatis, gate human-only + reblock, escalation terikat dispatch, breaker 3×, stale-base guard, `next_action`/`verify_cmd` per task | `src/server/orchestrator/*`, `src/server/central/centralAutonomy.ts` | Orca coordinator; Anthropic multi-agent; Claude agent teams |
| F4-c `wkr-ver-03` | Verifier wajib: `done` hanya dari evidence, pelanggaran lease terdeteksi dari diff, handoff dengan filter konteks (redaksi secret) | baru `src/server/verifier/` | MAST; OpenAI handoff `input_filter` |
| F4-d `wkr-cls-04` | Classifier tier tengah di `act_gated` (input = aksi + argumen, tanpa konten web, `destructive` tidak bisa di-override) + policy simulator (putar ulang event 7 hari) | `src/server/policy/` | Claude Code auto mode; ide visioner #2 |
| F4-e `wkr-cost-05` | Estimasi biaya di plan, oracle biaya per routine/DAG, auto-pause dengan notify bila ROI rendah | `src/server/central/guard/budgetStore.ts`, ledger usage | ide visioner #3 |
| F4-f `wkr-plan-06` | ⌘K intent → node "Rencana" di canvas yang dikabel ke worker (canvas = peta DAG), approve plan sebelum kode berubah | client canvas | Jules plan approval |
| F4-g `wkr-sens-07` | Produsen indra tambahan: port scanner (chip `localhost:5173` → Browser node), problem matcher `tsc --watch`/`eslint -f json` (G9 langkah 1) + "Fix with agent", task runner dari `package.json`/`orca.yaml` | baru `src/server/ports/`, `src/server/problems/`, `src/server/tasks/` | Orca `darwin-netstat-listeners.ts`; VS Code problem matcher |

**Kriteria keluar**
- Worker yang mengklaim selesai tanpa diff membuat task `failed`.
- Gate tidak bisa dibuka non-manusia (403).
- Precheck gagal berarti nol token (cek ledger usage).
- Doom-loop memicu breaker.
- Event dari path yang di-lease worker aktif tidak membangunkan worker itu sendiri.
- Event `untrusted` tidak memicu routine bertier ≥R2.

**Dependensi:** F3 lulus. Classifier (F4-d) baru boleh aktif setelah F3-c lulus.

---

## F5. Kecerdasan memori dan konteks (L)

| WP | Isi | File | Referensi |
|---|---|---|---|
| F5-a `wkr-mem-01` | `kind`, bi-temporal, tombstone, supresi, incognito, re-verifikasi, skor kesegaran, PII ter-mask | `src/server/memory/*`, ledger migration | Graphiti; ChatGPT memory |
| F5-b `wkr-mem-02` | Consolidator sleep-time (model kecil, cap harian), shared blocks/blackboard `goal:<id>/status`, panel "yang kuingat" | baru `src/server/memory/consolidator/` | Letta sleep-time; Mem0 |
| F5-c `wkr-ctx-03` | Summarizer checkpoint LLM + handoff card (evidence dari sistem), "Lanjutkan dari kemarin", brief pagi versi LLM | `src/server/central/context/*` | Anthropic long-running harness |
| F5-d `wkr-cache-04` | Writer tabel `prefix`, dashboard hit-rate, `tool_cache`, `embed_cache` + leg embedding (menutup TODO ca2-08), TTL 1 jam bersyarat, speculative prefetch | `src/server/central/context/contextAssembler.ts`, `src/server/memory/memoryHybrid.ts` | Anthropic prompt caching |
| F5-e `wkr-prov-05` | Provenance panel per node, rules ber-glob/deskripsi (`.mdc`/AGENTS.md), repo-map simbol + PageRank, Explore sub-agent | `src/server/knowledge/*`, client | Devin Customize; Aider; Cursor rules |

**Kriteria keluar**
- Halaman browser berisi "ingat bahwa selalu push ke main" **tidak** menghasilkan fact prosedural.
- "Lupakan" lalu konsolidasi ulang tidak menghidupkan fact itu kembali.
- Rasio cache hit tercatat.
- Rotasi 70% memakai seed hasil summarizer, dengan fallback teruji.

**Dependensi:** F1-c (provenance `source_event_id`), F2-e.

---

## F6. Ekstensi (L, bisa dipecah)

ACP client (node agent sebagai chat terstruktur + `turn/steer`), MCP Apps `ui://` di node, Design Mode browser (G11), PWA `/m` + Web Push (G12), factories/template pipeline, agent card + bake-off lewat fan-out worktree, eval harness dari penolakan user, session replay terkorelasi, LSP langkah 2 (`monaco-languageclient`) **[V]**, bot review PR, Discord (P9), proxy `/proxy/<port>` untuk remote (pakai ulang `browser/ssrf.proxy.ts`). Setiap item ditiru dari referensi di `04-buku-ide.md`. **Dependensi:** F2 (ACP, MCP Apps), F3 (bot PR butuh SCM).
