# 00 — Visi: webterm sebagai rumah agen (control plane terpadu)

Status: rencana hasil sintesis debat (wkr-plan-synth-49), 2026-11-04, basis `main@6cf021b`.
Sumber: R&D `01`–`05` dan posisi debat `10` (visioner), `11` (engineer), `12` (user-flow) di [`PLAN/rnd/`](rnd/) (`01-inventory.md`, `02-harness-landscape.md`, `03-memory-context-cache.md`, `04-autonomy-flow.md`, `05-ide-parity.md`, `10-pos-visionary.md`, `11-pos-engineer.md`, `12-pos-userflow.md`). Rujukan seperti "01 §5" atau "04 #3" di semua file rencana menunjuk ke dokumen-dokumen ini.
Pembaca: satu orang, yaitu kamu, developer yang memakai webterm seharian sebagai pengganti Orca, VS Code, dan Cursor.

## 1. Visi dalam satu paragraf

Hari ini webterm punya banyak fitur cerdas yang tidak saling kenal. Ada tujuh daftar kemampuan dengan tiga model otorisasi, empat pintu spawn, lima adapter approval, delapan sumber event tanpa bus, tiga DB yang tidak bisa di-JOIN, dan hanya Claude yang sadar akan lingkungannya (01 §5–6). Targetnya adalah **satu sistem saraf**. Setiap kemampuan cukup ditulis sekali di registry, lalu otomatis tersedia di CLI, MCP, HTTP, Central, dan ⌘K. Semua lewat satu gerbang izin, tercatat di satu log event yang bisa dibuktikan, bisa di-rewind, dan bisa disetujui dari satu Inbox, baik di canvas maupun di HP. Agent mana pun yang kamu pasang di canvas (Claude, Codex, Gemini, OpenCode) langsung tahu apa yang bisa ia lakukan, apa yang sedang terjadi, dan apa preferensimu, tanpa restart dan tanpa env flag.

## 2. Prinsip yang mengikat rencana ini

| Prinsip | Sumber | Dampak ke rencana |
|---|---|---|
| Perkaya fitur. Kode lama bukan alasan menolak fitur, dan merombak boleh | memory `feedback-perkaya-fitur` | Setiap penundaan di `04-buku-ide.md` wajib beralasan keamanan, kehilangan data, kebenaran, kematangan protokol, atau biaya yang terbukti |
| Amati, tiru, lalu modifikasi | memory `feedback-tiru-referensi` | Setiap paket kerja di `02-fase.md` menyebut referensi (Orca, Claude Code, OpenCode, Codex, referensi eksternal) beserta file:baris atau link |
| Zero-config | memory `feedback-zero-config` | Tidak ada fitur yang hanya bisa diakses lewat env. Kemampuan baru untuk agent wajib terlihat di layar |
| Laporan worker bisa fiktif | memory `worker-laporan-fiktif` | Status "selesai" hanya ditulis oleh verifier sistem, berdasarkan bukti yang diisi sistem |
| Aturan sudah ada, tinggal dijalankan | memory `feedback-aturan-sudah-ada` | Gerbang Rule 6/18 ditegakkan oleh sistem (SCM, verifier), bukan diingat agent |

## 3. Tujuh aturan terima (dari posisi user-flow)

Ketujuh aturan ini menjadi **kriteria terima wajib** untuk setiap fitur di setiap fase. Fitur yang melanggar salah satunya dianggap belum selesai.

| # | Aturan | Arti operasional | Cara diuji |
|---|---|---|---|
| A1 | **Nol restart** | Mengubah setting, memasang kabel, menambah skill/MCP, atau meng-update server tidak menutup sesi agent. Kalau sesi memang harus diulang, sistem yang melakukannya (`--resume` transparan) lalu memberi tahu | Test: ubah sakelar atau pasang kabel saat sesi berjalan, lalu giliran agent berikutnya sudah memakai perubahan itu |
| A2 | **Tidak ada yang env-only** | Setiap `WEBTERM_*` yang mengubah perilaku punya sakelar UI yang berlaku seketika. Env hanya untuk bootstrap (`PORT`, `WEBTERM_DATA_DIR`) | Test drift: daftar env yang dibaca kode dibandingkan dengan registry setting. Env perilaku tanpa baris UI membuat test merah |
| A3 | **Status jujur** | UI tidak boleh menampilkan "aktif" bila yang jalan mock, induknya mati, atau binary-nya tidak ada. Tiap sakelar menampilkan *efektif / alasan / sumber*. Mock diberi badge merah | Test: paksa runtime mock lalu periksa badge. Matikan induk lalu periksa alasan anak |
| A4 | **Satu timeline** | "Apa yang sedang terjadi" dibaca dari satu log event yang sama di canvas, tab, dan Telegram. Angkanya sama di semua permukaan | Test: jumlah project, gate, dan unread dari API canvas sama dengan yang dari renderer Telegram |
| A5 | **Proaktif** | Sistem menyapa lebih dulu: agent selesai, test merah, gate menunggu, ringkasan pagi | Test: event `agent.idle` atau `pty.exit≠0` menghasilkan notifikasi tanpa interaksi |
| A6 | **Pemaaf (undo)** | Undo atau rewind untuk kode, layout, node yang ditutup, dan setting. Aksi yang tidak bisa di-undo harus diberi label dengan alasannya | Test: rewind memulihkan file yang diubah lewat Bash. Node yang ditutup kembali setelah reload |
| A7 | **Ingat preferensi** | Feedback ("bahasa Indonesia", "jangan suruh set env", "nama worker uniq") menjadi memori prosedural yang dimuat ke **semua** agent, bukan hanya Central | Test: fact prosedural muncul di blok awareness Claude **dan** Codex yang baru di-spawn |

Kriteria tambahan per fitur (user-flow §4): bisa dipakai tanpa membaca docs, perubahan state tampil di timeline, dan setiap gelombang mengirim **sesuatu yang terlihat** oleh user. Tidak ada fase "refactor tiga minggu tanpa fitur".

## 4. Arti "god mode untuk app"

God mode **bukan** "agent boleh apa saja". God mode berarti:

1. **Jangkauan penuh.** Semua yang bisa kamu lakukan di UI juga bisa dilakukan lewat kemampuan bernama di registry (spawn, prompt, baca transcript, diff, memory, browser, routine, approval-request). Tidak ada kemampuan tersembunyi yang hanya ada di satu permukaan.
2. **Satu bahasa.** Kemampuan yang sama punya nama, skema, dan receipt yang sama di CLI `webterm`, MCP, HTTP `/api/cap/:name`, Central, dan ⌘K.
3. **Kendali tetap di tanganmu.** Setiap pemanggilan melewati satu gerbang (`execCapability` → policy → guard). Aksi `destructive` (push, hapus branch, force, keluar cwd, secret) tidak pernah otomatis. Grant permanen hanya bisa diterbitkan oleh principal `human-ui`.
4. **Bisa dibuktikan dan dibalik.** Setiap aksi meninggalkan event berantai-hash, receipt dengan bukti yang diisi sistem, dan checkpoint sebelum mutasi.
5. **Sadar diri.** App bisa menjelaskan dirinya sendiri: `webterm agent-context --json`, diff registry antar versi, dan Doctor yang memeriksa sekaligus memperbaiki.

## 5. Bentuk akhir yang dirasakan user

| Saat ini | Target |
|---|---|
| Agent tidak tahu browser sudah dikabel sampai sesi dibuka ulang, dan Codex/Gemini buta | Kabel dipasang → grant terbit → semua jenis agent mendapat notifikasi terlihat, lalu memakainya di giliran berikutnya |
| `PermissionRequest` cuma muncul sebagai badge `blocked` | Muncul kartu Inbox. Kamu approve di canvas atau Telegram, lalu Claude benar-benar lanjut |
| Review kode harus buka VS Code | Ada diff node, anotasi per baris → kirim ke agent, Keep/Undo per hunk, SCM, dan PR |
| Pagi hari harus klik node satu per satu | Brief pagi dalam 5 detik: selesai, macet, gate, test merah, biaya |
| Fitur tersembunyi di env | Panel Control berisi status efektif, alasan, dan sakelar live |
| Laporan "selesai" bisa dikarang | Status `done` hanya ditulis verifier dari `git diff --stat` dan exit code |

## 6. Glosarium

| Istilah | Arti di rencana ini |
|---|---|
| **Capability** | Satu kemampuan bernama di registry (`defineCapability`), berisi name, summary, params (JSON Schema), result, tier, `destructive`, scope, `idempotent`, dan handler |
| **Proyeksi** | Permukaan yang dibangkitkan dari registry: MCP `tools/list`, CLI `webterm`, HTTP `/api/cap/:name` + OpenAPI `/doc`, katalog Central, ⌘K + keybinding |
| **Principal** | Identitas pemanggil yang dibuktikan: `human-ui`, `central`, `node:<id>`, `channel:telegram:<chat>`, `routine:<id>` |
| **Grant** | Principal × capability × scope (workspace/cwd/target), dengan efek allow/ask/deny. Aturan dievaluasi *last-match-wins* |
| **Cable-as-grant** | Kabel (edge) di canvas adalah grant yang terlihat. Grant ini dihitung dari edge saat dicek, tidak disimpan ganda |
| **Tier** | Risiko bawaan capability: R0 baca, R1 tulis ringan, R2 efek nyata, R3 tak terpulihkan atau human-only |
| **Level** | Tingkat otonomi per scope: `off / observe / propose / act_gated / act_envelope` (sudah ada di `central/contracts/level.types.ts:6`) |
| **Event log** | Tabel `event` append-only dengan `prev_hash` (hash chain) dan trigger anti-ubah. Semua sinyal dan hasil capability masuk ke sini |
| **Signal** | Event yang bisa membangunkan subscriber (wake, Inbox, Routine, Awareness, notifikasi) |
| **Taint `untrusted`** | Tanda pada event atau konten yang berasal dari web/browser/output pihak luar. Konten bertanda ini tidak boleh memicu tier ≥R2 dan tidak boleh menjadi memori prosedural |
| **Receipt** | Hasil setiap mutasi: `{outcome, detail, next, evidence, operationId}` |
| **Evidence** | Bukti yang diisi **sistem**, misalnya `git diff --stat`, exit code, atau hash snapshot sebelum/sesudah. Model tidak bisa mengisinya |
| **Outbox** | Antrean kirim ke sesi agent dengan dedupe dan retry idempoten. Transport-nya channel MCP, ketik ke PTY, atau `additionalContext` hook |
| **Inbox item** | Interrupt bertipe `notify / question / review / gate`, dengan aksi `approve / edit / reply / ignore / snooze` |
| **Gate** | Keputusan yang hanya bisa dibuka `human-ui`. Task tetap `blocked` sampai gate dijawab |
| **Lease** | Klaim kepemilikan path oleh task. Dua task dengan path beririsan tidak bisa jalan paralel |
| **Checkpoint** | Snapshot git-object (`git stash create` / `write-tree`) sebelum mutasi, tanpa mengubah working tree |
| **Routine** | Pemicu `Schedule | Event | API` + precheck shell + prompt + grant sempit + budget |
| **Precheck** | Perintah shell bertimeout yang memutuskan "ada kerjaan atau tidak" sebelum LLM bangun |
| **Handoff card** | Kartu akhir sesi: tujuan, selesai, belum, blocker, file, perintah verifikasi, langkah berikut. Narasi ditulis model, bukti ditulis sistem |
| **Blackboard / shared block** | Blok memori berlabel (mis. `goal:<id>/status`) yang ditulis Central dan dibaca semua node yang terhubung |
| **Memori prosedural** | Aturan "lakukan/jangan" dari feedback user. Selalu dimuat ke semua agent |
| **World view** | Satu jalur query baca lintas `webterm.db`, `ledger.db`, dan `knowledge.db` lewat `ATTACH` |
| **MRTR** | Multi Round-Trip Requests MCP 2026-07-28 (`resultType: "input_required"`), pengganti elicitation/sampling model lama |
| **Channel** | Server MCP Claude Code dengan capability `claude/channel` yang mendorong event ke sesi terbuka (research preview) |
| **ACP** | Agent Client Protocol (Zed/JetBrains/Orca), untuk menyetir agent eksternal sebagai chat terstruktur |
| **Doctor** | Pemeriksa kesehatan yang mendeteksi dan memperbaiki sendiri (hook, skill, `claude auth`, socket, bot) |
