# R&D 04: Otonomi, proaktivitas, dan flow untuk webterm

Worker: wkr-rnd-autonomy-44. Tanggal: 2026-11-04. Riset web lewat `ego-browser` (berhasil, tanpa fallback). Sumber lokal: clone Orca `/tmp/st/orca-src`, repo webterm (read-only).

Prinsip yang dipakai: perkaya fitur ([[feedback-perkaya-fitur]]), tiru yang sudah terbukti jalan, zero-config.

## 0. Posisi webterm sekarang (yang relevan)

- `src/server/central/wake.ts`: waker yang bekerja dari event, debounce 250 ms, sweep pengaman 60 s. Alasan wake di kode produksi baru dua, `assigned` dan `worker_settled`.
- `src/server/central/centralAutonomy.ts`: loop otonom mengambil satu plan item per tick dan tidak pernah membuat plan sendiri. Kalau gagal berturut-turut, project dikarantina.
- `central/contracts/level.types.ts:6`: level `off / observe / propose / act_gated / act_envelope`, default global `propose` (`guard/levelStore.ts:9`). Sudah ada budget harian (`guard/budgetStore.ts`), breaker, dan halt.
- `src/server/fsWatch.ts` cuma melayani file manager (`fsdirty`), tidak masuk ke Central. Hook status agent (`agentStatusApi.ts`) juga tidak saya temukan diteruskan ke `central/`.
- Sudah ada palette ⌘K (`client/App.tsx:206`), Inbox (`InboxPanel`), Kanban, dan catatan `[webterm]` yang diketik ke sesi Claude yang sedang idle (commit `62411c9`).

Artinya mesin otonominya sudah ada, tetapi indra pemicunya sedikit. Central baru bangun kalau ada tugas yang di-assign atau worker yang selesai. Kalau file berubah, test gagal, agent menganggur, atau jadwal tiba, Central tidak tahu.

---

## 1. Asisten proaktif / event-driven

### Temuan

**LangChain ambient agents.** Agen mendengarkan *event stream*, tidak menunggu chat, dan boleh menangani banyak event sekaligus. Ada tiga pola HITL: **notify** (kabari saja), **question** (tanya supaya tidak menebak), **review** (setujui, edit, atau beri feedback atas aksi berisiko). Semuanya muncul di "Agent Inbox" yang meniru email dan tiket support. https://www.langchain.com/blog/introducing-ambient-agents. Skema Agent Inbox punya aksi `accept / edit / respond / ignore` (https://github.com/langchain-ai/agent-inbox, repo diarsipkan 2026-09-20, jadi pakai sebagai referensi UX saja, bukan dependency).

**Claude Code scheduled tasks (dulu "routines").** Satu konfigurasi (prompt + repo + connector) bisa dipicu tiga jenis trigger yang boleh digabung: **Schedule** (cron atau sekali jalan), **API** (POST dengan bearer token), **GitHub event** (PR, rilis). Contohnya satu tugas review PR yang jalan tiap malam, bisa dipanggil dari skrip deploy, dan juga bereaksi ke tiap PR baru. https://code.claude.com/docs/en/routines

**Claude Code Desktop scheduled tasks (lokal).** Tugas hanya jalan kalau app hidup dan mesin tidak tidur. Saat app start atau mesin bangun, dicek run yang terlewat dalam 7 hari terakhir. Yang dijalankan cuma **satu catch-up run** untuk jadwal terlewat yang paling baru, sisanya dibuang, dan muncul notifikasi. Riwayat juga menampilkan run yang dilewati beserta alasannya (mesin tidur, run sebelumnya masih jalan, slot penuh). Ada opsi worktree terisolasi per run. Prompt disarankan memuat guardrail waktu ("kalau sudah lewat jam 17, ringkas saja"). https://code.claude.com/docs/en/desktop-scheduled-tasks

**Claude Code hooks.** Event yang bisa dipakai sebagai sinyal antara lain `Notification` dengan matcher `idle_prompt`, `permission_prompt`, `agent_needs_input`, `agent_completed`; `Stop`, `StopFailure`, `SubagentStop`, `PreToolUse` (bisa memblok), dan `FileChanged`. https://code.claude.com/docs/en/hooks

**Cursor Cloud Agents.** Jalan di VM terisolasi, bisa dipicu dari Slack (`@cursor`), mengerjakan *branch terpisah*, lalu push untuk diserahkan ke manusia. Menurut Cursor, setup environment adalah langkah terpenting supaya agen bisa build dan test sendiri. https://cursor.com/docs/cloud-agent

**GitHub Copilot (cloud).** Batasannya eksplisit: satu branch dan satu PR per tugas, sesi Actions maksimal 59 menit, ruleset bisa memblok. Ada "automation" mingguan, misalnya mencari test yang hilang lalu mengusulkan tambahan. Sesi bisa berpindah client (web, mobile, CLI, IDE). https://docs.github.com/en/copilot/concepts/copilot-surfaces/copilot-on-github

**Jules.** Setiap tugas menghasilkan **plan yang disetujui dulu** sebelum ada kode yang berubah. AGENTS.md dibaca otomatis. Notifikasi browser dikirim saat selesai atau butuh input. https://jules.google/docs

**Devin.** Tab Progress menyatukan Shell, IDE, dan Browser. Tiap langkah progres tertaut ke perintah shell dan edit yang dilakukan, jadi timeline-nya bisa ditelusuri. https://docs.devin.ai/work-with-devin/devin-session-tools

**Factory Droid.** Dipasarkan sebagai cara meng-"autopilot" code review, QA, dan dokumentasi lintas repo, dengan delegasi lalu review diff lalu merge. https://docs.factory.ai/

(OpenHands: halaman GitHub Action yang saya tuju 404 setelah pindah domain ke docs.openhands.dev, jadi tidak saya kutip.)

### Orca automations (lokal)

- Status run punya alasan skip eksplisit: `skipped_precheck | skipped_missed | skipped_unavailable | skipped_needs_interactive_auth` (`src/shared/automations-types.ts:14-17`).
- **Precheck**: sebelum run terjadwal, satu perintah shell dijalankan dengan timeout dan output dibatasi. Kalau gagal, agen tidak di-spawn (`src/main/automations/automation-dispatch-request.ts:199-221`, `precheck-runner.ts:131-189`). Hasilnya hemat token karena "tidak ada kerjaan" diputuskan oleh shell, bukan oleh LLM.
- Drift jadwal dilaporkan kalau parser cron berubah makna (`automations/schedule-drift-report.ts:5-22`).

### Tiru di webterm

1. **Event bus "Indra Central"**: setiap sumber sinyal yang sudah ada diarahkan ke `wake(reason)`. Sumbernya fsWatch (perubahan di cwd workspace), hook status agent (`idle_prompt`, `agent_needs_input`, `Stop`, `StopFailure`), exit code PTY yang bukan 0 setelah perintah test, cable/link berubah, dan jadwal. Waker yang sekarang sudah punya debounce dan sweep, jadi tinggal tambah produsen. Sinyal disimpan sebagai baris `signal` di SQLite (truth di DB, sama seperti prinsip `wake.ts`).
2. **Trigger = Schedule | Event | API** dalam satu objek "Rutin" per workspace. API trigger cukup endpoint lokal ber-token node yang sudah ada.
3. **Precheck shell ala Orca** sebelum LLM bangun, misalnya `git diff --quiet || exit 1` atau `bun test` gagal → bangun. Gratis token.
4. **Catch-up satu kali** untuk jadwal yang terlewat waktu laptop tidur, ditambah riwayat skip beserta alasannya.
5. Respons ambient diklasifikasi **notify / question / review**. Kalau levelnya `observe`, yang keluar hanya notify. Kalau `propose`, question dan review.

**Pitfall:** banjir event (fsWatch saat `bun install`). Solusinya debounce per sumber, filter `.git`/`node_modules` (sudah ada di fsWatch), dan *dedupe key* per sinyal. Pitfall lain: agen bangun karena perubahan yang ia buat sendiri. Abaikan event yang path-nya sedang di-lease oleh worker yang aktif.

---

## 2. Pola orkestrasi multi-agent yang terbukti

### Temuan

**Anthropic multi-agent research.** Orchestrator-worker paralel mengalahkan single-agent sebesar 90,2% pada eval internal mereka, tetapi biayanya sekitar 15× token chat (agen tunggal sekitar 4×). Penyebab duplikasi dan celah: delegasi yang terlalu singkat. Tiap subagen butuh **objektif, format output, panduan tool, dan batas tugas**. Besar usaha diskalakan lewat aturan eksplisit: fakta sederhana cukup 1 agen dengan 3-10 tool call, perbandingan 2-4 subagen, riset kompleks lebih dari 10. Pelajaran lain: error berlipat ganda, jadi eksekusi harus *durable* dan bisa resume, deploy memakai rainbow deployment, dan eksekusi sinkron menjadi bottleneck. Evaluasi dilakukan pada *end-state*. https://www.anthropic.com/research/multi-agent-research-system

**Cognition, "Don't Build Multi-Agents".** Dua prinsip: *share context* dan *actions carry implicit decisions*. Contohnya Flappy Bird: subagen A membuat latar ala Mario, subagen B membuat burung yang tidak cocok. Pekerjaan paralel yang saling bergantung secara keputusan itu rapuh. https://cognition.ai/blog/dont-build-multi-agents

**MAST (Cemri dkk., arXiv 2503.13657).** Dari 1642 trace di 7 framework ditemukan 14 mode gagal dalam 3 kategori: (i) desain sistem dan spesifikasi, (ii) misalignment antar-agen, (iii) verifikasi tugas. Contohnya "Disobey Role Specification". Perbaikan workflow yang sederhana sudah membantu. https://arxiv.org/html/2503.13657v3

**OpenAI Agents SDK handoffs.** Handoff dimodelkan sebagai tool `transfer_to_<agent>`. Penerima melihat seluruh history kecuali disaring `input_filter`. Ada peringatan bahwa nested history tidak meredaksi data sensitif. https://openai.github.io/openai-agents-python/handoffs/

**Claude Code agent teams.** Ada task list bersama dengan status `pending / in progress / completed`, plus dependensi. Tugas yang masih blocked tidak di-*self-claim*. Teammate yang selesai mengambil tugas berikutnya yang belum di-assign dan tidak blocked. Plan approval dikirim ke lead. Dokumennya terang-terangan bilang agent teams tidak cocok untuk "same-file edits, or work with many dependencies". https://code.claude.com/docs/en/agent-teams

### Orca orchestration (lokal, file:line)

- Loop coordinator: poll 2000 ms, `MAX_CONCURRENT_DEFAULT = 4` (`src/main/runtime/orchestration/coordinator.ts:31-32`). Loop `while (!this.stopped)` ada di `:103`.
- Urutan tick: `processMessages → processEscalations → reblockTasksWithPendingGates → dispatchReadyTasks → checkConvergence` (`coordinator.ts:155-161`). Mailbox diproses per tipe pesan, yaitu `worker_done`, `escalation`, `decision_gate`, `status` (`:163-180`).
- Slot konkurensi dihitung dengan `maxConcurrent - dispatched.length` (`coordinator.ts:228`). Kedalaman worker bersarang dibatasi `NESTED_WORKER_MAX_DEPTH_DEFAULT` (`:282`).
- **Decision gate**: worker mengirim `decision_gate` (taskId, dispatchId, question, options), lalu task menjadi `blocked`. **Hanya manusia** yang bisa membuka blokir. Setiap tick, task yang gate-nya masih pending di-reblock (`coordinator-decision-gates.ts:5-60`, komentar `:52`).
- **Deteksi macet**: kalau tidak ada task aktif tapi ada yang blocked, muncul log "Resolve decision gates to continue" (`coordinator-dag-convergence.ts:19-28`).
- **Circuit breaker per task**: escalation harus terikat ke dispatch yang tepat dan pengirim yang memilikinya (anti-spoof). Jika di bawah ambang, task di-requeue. Kegagalan ke-3 membuat status `circuit_broken` lalu task `failed` (`coordinator-escalation-triage.ts:20-62`).
- **Stale base guard**: dispatch ditolak kalau worktree tertinggal lebih dari 20 commit, kecuali spec memuat `allow-stale-base: true` (`coordinator-stale-base-flag.ts:2-16`, `coordinator.ts:258`).
- **Attention policy**: kalau worker selesai, beritanya untuk coordinator, bukan manusia (`coordinatorOnlyNews`). Workspace yang dibisukan tidak mendapat unread, banner, maupun push (`src/renderer/src/attention/agent-attention-policy.ts:15,62-64`).

### Tiru di webterm

1. **Task DAG + decision gate yang tidak bisa dibuka oleh agen.** Tiru reblock-tiap-tick milik Orca. Gate tampil sebagai kartu di Inbox dan tombol Telegram.
2. **Kepemilikan file eksplisit (lease)** per task di DB. Dispatcher menolak dua task yang path-nya beririsan untuk jalan paralel dan otomatis menjadikannya gelombang berurutan. Ini jawaban konkret atas peringatan Cognition dan agent-teams soal same-file edits.
3. **Brief worker terstruktur ala Anthropic**: objektif, format output, tool, batas, dan file yang dimiliki menjadi field wajib. Planner ditolak kalau ada field yang kosong. Tambahkan aturan skala usaha di prompt planner.
4. **Escalation terikat dispatch + breaker 3x per task**, berdampingan dengan karantina per project yang sudah ada.
5. **Stale-base guard** sebelum dispatch.
6. **Verifier/review terpisah** sebagai tahap DAG (kategori MAST iii). Klaim "selesai" tidak sah tanpa bukti `git diff` dan test hijau. Ini juga cocok dengan memory "laporan worker bisa fiktif".
7. **Handoff = tool**, dengan *context filter* yang membuang secret dari transcript yang diteruskan.

**Pitfall:** biaya token 15×. Tunjukkan perkiraan biaya di plan dan pakai budget harian yang sudah ada. Pitfall kedua: debate dan blackboard bebas cenderung berputar tanpa ujung. Batasi ronde dan tutup dengan keputusan lead atau manusia.

---

## 3. UX human-in-the-loop

### Temuan

- **Claude Code checkpoints**: checkpoint dibuat otomatis sebelum tiap prompt, 100 terakhir disimpan per sesi. `/rewind` atau Esc dua kali menawarkan opsi *restore code+conversation*, *conversation saja*, *code saja*, *summarize from/up to here*. Ada batasan penting: perubahan lewat Bash, edit subagen, dan perubahan eksternal **tidak** tercatat. Fitur ini bukan pengganti git. https://code.claude.com/docs/en/checkpointing
- **Cursor checkpoints**: snapshot dibuat sebelum perubahan signifikan. Pengguna klik checkpoint di *chat timeline* untuk preview lalu restore. Yang di-restore hanya file, pesan tidak dihapus. Disimpan lokal, terpisah dari git. https://cursor.com/docs/agent/overview
- **Claude Code permission modes**: `default / acceptEdits / plan / auto / bypassPermissions`. Mode *auto* memakai **classifier model kedua** sebagai pengganti prompt manusia. Path terlindungi dan beberapa aksi tidak pernah di-auto-approve di mode apa pun, dan ask-rule seperti `Bash(git push *)` tetap muncul. https://code.claude.com/docs/en/permission-modes
- **Agent Inbox (LangChain)**: tiap interrupt membawa aksi yang diizinkan (accept / edit / respond / ignore).
- **Jules**: approve plan dulu, kode berubah kemudian, plus notifikasi saat butuh input.
- **Orca attention**: pemberitahuan ditekan kalau surface sedang dilihat, workspace dibisukan, atau berita hanya relevan untuk coordinator (lihat atas).

### Tiru di webterm

1. **Checkpoint level workspace**, lebih kuat dari Claude/Cursor karena webterm memegang PTY dan fs. Sebelum setiap aksi `act_*`, ambil snapshot `git stash create` / `git write-tree` (tanpa mengubah working tree) untuk cwd itu dan simpan ref-nya. Tombol "Rewind" ada di timeline per aksi. Ini menutup celah "perubahan lewat Bash tidak tercatat" yang diakui Claude Code, karena snapshot dibuat di level fs, bukan di level tool edit.
2. **Inbox seragam** untuk notify, question, review, dan gate, dengan aksi `approve / edit / reply / ignore / snooze`, disinkronkan ke Telegram sebagai inline button (channelApprovals sudah ada).
3. **Classifier sebagai tier tengah**: di `act_gated`, aksi berisiko rendah disaring model kecil, aksi berisiko tinggi tetap ke manusia. Seperti Claude Code, ada daftar "never auto": push, hapus file, secret, keluar dari cwd.
4. **Aturan perhatian ala Orca**: jangan push Telegram kalau user sedang menatap node itu. Berita worker selesai cukup untuk Central. Ada mute per workspace dan *digest* untuk notify.
5. **Trust mode per workspace yang terlihat** (badge level di header node dan dock), ditambah satu klik "Halt semua" (haltApi sudah ada).

**Pitfall:** kelelahan approval membuat user menekan approve tanpa membaca. Solusinya: batch approval sejenis, tampilkan diff ringkas dan dampak, dan naikkan otomatis ke tier tinggi untuk aksi tak terpulihkan. Checkpoint juga harus jujur soal hal yang tidak bisa di-rewind (efek di luar fs: HTTP, Telegram, browser) dan memberi label pada aksi seperti itu.

---

## 4. "Flow" UX di IDE

### Temuan

- **VS Code sessions view**: daftar sesi dengan status, harness, dan file yang berubah. Opsinya mencakup badge ikon app, indikator status di title bar, dan halaman welcome sesi. Pola alurnya review lalu validasi lalu integrasi. https://code.visualstudio.com/docs/agents/run/sessions/manage-sessions
- **Devin Progress**: satu timeline yang menghubungkan langkah, shell, editor, dan browser.
- **Cursor**: checkpoint ditempel langsung di chat timeline. Agen bisa dipicu dari tempat kerja (Slack), dan hasilnya berupa branch.
- **Copilot**: sesi berpindah antar client tanpa kehilangan konteks.
- **Jules/Claude plan mode**: intent, lalu plan yang disetujui, lalu eksekusi.

### Tiru di webterm

1. **Palette ⌘K sebagai pintu agen**. Mengetik teks bebas menghasilkan intent untuk Central. Ada perintah `> rutin baru`, `> rewind`, `> halt`, `> beri tugas ke node…`. Konteks (node terpilih, cwd, file terbuka) otomatis terlampir.
2. **Kartu Intent → Plan → Eksekusi** di canvas: satu node "Rencana" yang tersambung dengan kabel ke node worker yang mengerjakannya, sehingga canvas sendiri menjadi peta DAG. Inilah keunggulan webterm dibanding IDE linear, jadi manfaatkan.
3. **Activity feed / timeline** di bottom panel. Setiap sinyal, keputusan, aksi, checkpoint, dan approval menjadi satu baris yang bisa diklik untuk loncat ke node, diff, atau rewind. Filter per workspace atau per agen.
4. **Status surface**: badge per node (idle / working / needs-input / blocked-gate), counter di dock, title browser `(2) webterm` untuk inbox, dan status bar "Central: observe · 3 sinyal · 1 gate".
5. **Kontinuitas lintas surface**: tugas yang dimulai dari Telegram muncul di canvas dengan thread yang sama, dan sebaliknya.

**Pitfall:** timeline yang terlalu ramai. Kelompokkan per tugas (seperti Devin, progres induk dengan detail di dalamnya). Status yang berbohong juga berbahaya: status harus diturunkan dari DB dan hook, bukan dari tebakan LLM.

---

## 5. Rekomendasi berperingkat

1. **Indra Central (event bus → `wake`)**. Hubungkan fsWatch, hook status agent (`idle_prompt` / `agent_needs_input` / `Stop` / `StopFailure`), exit code test di PTY, perubahan kabel, dan timer ke tabel `signal` + `wake(reason)`. Dampaknya terbesar dengan biaya terkecil karena waker, debounce, dan sweep sudah ada. Ini yang mengubah webterm dari tanya-jawab menjadi asisten "yang punya tempat".
2. **Rutin (Schedule | Event | API) + precheck shell + catch-up satu kali**. Tiru Claude Code scheduled tasks dan Orca precheck/skip-reason. Riwayat run menampilkan skip beserta alasannya.
3. **Inbox HITL seragam (notify / question / review / gate)** dengan aksi accept/edit/reply/ignore/snooze, tombol Telegram, dan aturan perhatian ala Orca (suppress-while-focused, coordinator-only news, mute, digest).
4. **Checkpoint level workspace + Rewind di timeline**, berupa snapshot git-object sebelum setiap aksi `act_*`. Inilah yang membuat level otonomi tinggi aman dinyalakan.
5. **Task DAG dengan decision gate khusus manusia, lease file, breaker 3x per task, dan stale-base guard**. Semuanya diambil langsung dari pola Orca yang terbukti, dan mencegah worker saling menimpa atau menduplikasi kerja.
6. **Brief worker terstruktur + tahap verifier wajib** (Anthropic + MAST). Field kosong berarti ditolak, dan "selesai" baru sah kalau ada bukti diff dan test.
7. **Palette ⌘K sebagai pintu intent + node "Rencana" yang dikabel ke worker di canvas**, supaya alur intent → plan → eksekusi terlihat secara spasial.
8. **Activity timeline + status surface** (badge node, counter dock, status bar Central), dikelompokkan per tugas.
9. **Classifier tier tengah di `act_gated`** dengan daftar "never auto" yang keras. Kerjakan setelah poin 3-4, karena tanpa inbox dan rewind classifier hanya memindahkan risiko.
10. **Handoff sebagai tool dengan context filter** (redaksi secret) untuk serah-terima antar node agen.
