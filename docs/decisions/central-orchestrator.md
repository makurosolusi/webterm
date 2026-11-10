# Central sebagai orkestrator: rencana untuk diskusi

Tanggal: 2026-11-10. Sumbernya empat laporan di `/tmp/st/ca-plan/`:
- `audit-memory-context-planning.md`
- `audit-supervision-tasks.md`
- `research-memory-context.md`
- `research-orchestration.md`

Status: **disetujui 2026-11-10.** Semua rekomendasi di bagian 6 diterima; dikerjakan W0 sampai W4.

---

## 1. Jawaban singkat

**Belum.** Sebagian besar mesinnya sudah ada di kode:
- registry agent `central_agents`
- ledger, DAG, plan, approval
- consolidator memory dan checkpoint
- waker

Masalahnya, mesin-mesin itu **tidak tersambung dan sebagian dormant**. Data live minggu ini memperlihatkannya:

| Gejala | Data live |
|---|---|
| Worker yang di-spawn | 4/4 berakhir *orphaned*. Tidak ada yang tahu kapan selesai. |
| Model task | 3 model task terpisah, semuanya 0 baris |
| Checkpoint | 0 baris, padahal flag-nya ON |
| Memory | 3 klaim tak terkonfirmasi, 0 panggilan `memory.*` |
| Approval | 1 approval kedaluwarsa tidak pernah disapu |

Lubang terbesar: **tidak ada catatan penugasan (assignment).** Saat Central menyuruh agent A di project B, perintah itu fire-and-forget:
- tidak ada baris yang mencatat "A sedang mengerjakan X sejak jam sekian, kriteria selesainya Y";
- tidak ada pengawas yang membaca hook A lalu memperbarui catatan itu.

Kebutuhan seperti ingat siapa disuruh apa, cek hang/error/hilang, dan board todo/review/done semuanya bergantung pada catatan penugasan ini.

## 2. Prinsip: tidak ada magic tersembunyi

1. **Satu sumber kebenaran.** Tabel event SQLite append-only (`central_events`) menjadi sumbernya. Board, status dan timeline semuanya *diturunkan* dari tabel ini dan bisa diputar ulang. Tidak ada state yang hanya hidup di memori proses.
2. **Correlation id di setiap baris.** Setiap baris membawa `turn_id`, `goal_id`, `task_id`, `assignment_id`, `project_id` dan `node_id`. Dari satu kartu di board kita bisa menelusuri turn Central yang membuatnya, perintah ke agent, setiap hook agent, laporan, verifikasi, dan siapa yang menyetujui.
3. **Aturan otomatis selalu terlihat.** Setiap aturan punya nama dan ambang yang tertulis, misalnya `liveness.heartbeat 10m`. Saat aturan menyala, ia menulis event yang tampil di timeline, misalnya "stalled karena tak ada hook 20 menit". Tidak ada sapuan diam-diam. Saat ini sapuan basi 20 menit menghapus status tanpa jejak.
4. **"Done" tidak pernah dilaporkan sendiri.** Agent hanya bisa *melapor*. Status `done` datang dari verifikasi (perintah acceptance lulus) dan/atau review user.
5. **Tiru yang terbukti.** Rujukan desainnya:
   - nodeterm-web: `board-log.jsonl`, outcome report, hand-over, durable-state
   - Claude Code: hook, `PreCompact`, subagent yang mengembalikan ringkasan
   - supervisor OTP: batas restart
   - OTel GenAI: bentuk span

## 3. Sekarang vs target per kapabilitas

| Kapabilitas | Sekarang | Target |
|---|---|---|
| Konteks jelas | State header tidak memuat node, agent, goal, plan maupun tanggal | Header kaya: tanggal/jam, project aktif, node live, penugasan terbuka, goal, item yang butuh user. Ukurannya dibatasi. |
| Memory jangka pendek | Riwayat sesi SDK saja | Catatan kerja per task (progress note) dan ringkasan turn |
| Memory jangka panjang | Mesin ada tapi dormant. Consolidator kehilangan scope project (`consolidator.store.ts:93`). Tidak ada `memory.update`/`forget`. | Tiga tier: STATE yang di-pin (≤200 baris), topik per project lewat indeks, log mentah sebagai kebenaran. Tool `memory.update`/`forget` dengan provenance. |
| Konteks tak pernah habis | Tidak ada meter. Checkpoint 0 baris (dugaan race: armed state ditangkap saat service pertama dibuat, `centralChatHandlers.ts:62,79-85`). | Hook `PreCompact` (sudah terverifikasi di SDK 0.3.318) menyimpan STATE sebelum compaction. Ada instruksi compaction kustom. Worker hanya mengembalikan 1–2k token plus pointer. Ada meter konteks di UI. |
| Planning | Plan datar tanpa UI. DAG hanya untuk manusia. Goal write-only. | Goal → Plan → Task (dengan dependensi) dalam satu model, ditampilkan di board |
| Sadar waktu dan workspace | Waker hanya menggerakkan scheduler plan. Tidak pernah memulai turn Central. Tidak ada reminder. | Check-in terjadwal per penugasan. Tool reminder. Tenggat per task. Board lintas project. |
| Checkpoint | 0 baris | Checkpoint per task: ringkasan, commit git sebagai checkpoint kode, langkah berikutnya |
| Siapa disuruh apa | Fire-and-forget (`chat.send`, `canvas.type`) | Tabel `assignments` dengan kontrak lengkap (lihat 4A) |
| Deteksi hang/error/hilang | Orphan hanya terdeteksi saat boot. Agent PTY tidak pernah keluar dari `working`. | Supervisor liveness dengan aturan bernama (lihat 4C) |
| Board todo/progress/review/done | Tidak ada | Board 4 kolom per project dan gabungan semua project |
| Bisa ditelusuri | Audit tanpa turn/node/task id | Timeline per kartu, dari ujung ke ujung |

## 4. Arsitektur yang diusulkan

### A. Model kerja: Goal → Plan → Task → Assignment

**Satu model menggantikan tiga.** `plan_item`, ledger task dan DAG digabung menjadi `tasks` + `task_deps`. Ketiganya 0 baris, jadi migrasinya murah.

- **Goal**: hasil yang diinginkan user ("app X bisa login Google").
- **Task**: satuan kerja yang bisa diverifikasi, milik satu project, dengan `blocked_by`.
- **Assignment**: satu percobaan mengerjakan sebuah task oleh satu agent/node. Satu task bisa punya beberapa percobaan.

Isi kontrak assignment:

| Field | Isi |
|---|---|
| `objective` | Apa yang dikerjakan |
| `boundaries` | File/folder yang boleh disentuh |
| `acceptance` | Perintah verifikasi, mis. `npm test` |
| `owner` | Node dan agent yang mengerjakan |
| `budget` | Waktu dan token |
| `attempts` | Jumlah percobaan |
| `heartbeat_at` | Tanda hidup terakhir |
| `artifacts` | Branch, commit, file |
| `result` | Laporan agent |
| `verification` | Hasil verifikasi |

State machine task:

```
todo → assigned → running ⇄ waiting_input / stalled → reported → verifying → needs_review → done
                                   ↘ failed / cancelled / blocked
```

Pemetaan ke 4 kolom board (label UI dalam bahasa Inggris):

| Kolom | State |
|---|---|
| **Todo** | todo, blocked (tampil dengan badge "blocked by …") |
| **In progress** | assigned, running, waiting_input ("Needs you"), stalled (kuning) |
| **Needs review** | reported, verifying, needs_review, failed (merah, butuh keputusan) |
| **Done** | done, cancelled (dilipat) |

### B. Event log (`central_events`)

- Append-only, ditulis sinkron sebelum efek samping.
- Bentuknya mengikuti span OTel GenAI: `kind`, `actor`, correlation id, `payload` kecil, `at`.
- Audit yang ada (`central` audit rows) diperkaya dengan id yang sama, tidak diganti.

### C. Supervisor liveness

Hook Claude Code yang sudah masuk lewat `hookStatus.ts` diteruskan ke **watcher penugasan**, yang memperbarui assignment dan menulis event. Aturan-aturannya:

| Aturan | Ambang (default, bisa disetel lewat select) | Aksi |
|---|---|---|
| `startup` | 120 dtk tanpa hook pertama | stalled, lalu nudge |
| `heartbeat` | 10 menit tanpa hook saat running | nudge ke agent |
| `stalled` | 20 menit tanpa hook | stalled, muncul di board dan notifikasi |
| `waiting_input` / `blocked` | — | **Tidak pernah dianggap hang**. Tampil "Needs you". |
| `stop_without_report` | Stop/idle tanpa laporan | diperlakukan sebagai reported, lalu masuk verifikasi |
| `vanished` | PTY/sesi hilang tanpa SessionEnd yang wajar | 1× respawn (resume session id), sesudahnya failed |
| `restart_limit` | maks 2 restart/jam/task | failed, butuh user |
| `loop` | error/tool yang sama berulang N kali | stalled dengan alasan "loop" |
| `approval_expired` | approval lewat tenggat | disapu menjadi expired, tercatat (`agentResume.ts:18`) |

Penyelesaian agent PTY dibaca dari hook `Stop`/`SessionEnd`, sama seperti agent exec. Saat ini agent PTY tidak pernah selesai.

Supervisor berjalan **deterministik tanpa model**. Turn Central baru dipicu saat ada event yang butuh keputusan (lihat F).

### D. Memory bertingkat

1. **STATE yang di-pin**, per project dan global. Ringkas, ≤200 baris / 25 KB, selalu disuntikkan ke header.
2. **Topik**: fakta, keputusan dan preferensi per project, dimuat lewat indeks saat relevan.
3. **Log mentah** (event + transcript) sebagai kebenaran terakhir.

Aturan:
- Setiap fakta menyimpan provenance: siapa, kapan, dari event mana.
- Fakta bersifat bi-temporal: fakta lama *diinvalidasi*, tidak dihapus.
- **Tier kepercayaan**:

  | Asal fakta | Tier |
  |---|---|
  | User | trusted |
  | Hasil verifikasi | verified |
  | Teks dari agent atau halaman web | unverified, perlu konfirmasi |

  Tier ini melindungi dari memory poisoning (MINJA).
- Setiap suntikan memory per turn dicatat, sehingga bisa dijawab "kenapa Central tahu ini".
- Perbaikan yang diperlukan: consolidator harus menjaga scope project, dan prompt steward perlu panduan kapan memakai memory.

### E. Manajemen konteks

- **Header kaya yang dibatasi ukurannya** (lihat tabel 3).
- **Persist sebelum lupa.** Hook `PreCompact` menulis STATE dan progress note sebelum compaction. Teks yang dikembalikan hook menjadi instruksi ringkasan compaction ("pertahankan: penugasan terbuka, keputusan, langkah berikutnya"). `SessionStart` dengan source `compact` menyuntik ulang STATE.
- Checkpoint juga ditulis saat konteks mencapai sekitar 70%, sebelum compaction otomatis.
- **Worker mengembalikan ringkasan pendek plus pointer** (path laporan/commit), bukan transcript penuh.
- **Perbaiki race checkpoint** di W0, dikunci dengan test.
- UI menampilkan meter konteks, ringkasan compaction yang bisa dibaca, dan diff memory.

### F. Planning dan waktu

- Waker diperluas dengan **check-in terjadwal per assignment**, tenggat task dan reminder (tool `reminder.set`).
- Supervisor memfilter dulu secara deterministik. Model hanya dipanggil bila ada keputusan, misalnya task stalled, laporan masuk, atau tenggat lewat.
- **Budget harian** untuk turn yang dimulai Central sendiri, berupa sakelar dan select di Settings.
- Planning sadar workspace: task terikat project. Central melihat beban per project (berapa agent jalan, apa yang blocked) sebelum menugaskan.
- Skala upaya mengikuti pola riset: tugas kecil 1 agent, sedang 2–4, besar 10+ dengan DAG.

### G. Checkpoint terorganisir

Checkpoint ditulis per task saat:
- reported;
- sebelum compaction;
- saat hand-over.

Isinya: ringkasan, commit/branch (git = checkpoint kode), langkah berikutnya, dan pointer ke event. Checkpoint bisa dibuka dari kartu.

### H. UI

1. **Board**: 4 kolom, filter per project atau "All projects". Kartu menampilkan agent/node (klik → buka node), umur, heartbeat terakhir dan badge aturan.
2. **Timeline/trace** per kartu dan per turn Central, berisi event berurutan beserta alasan setiap transisi.
3. **Memory panel**: STATE, topik, fakta beserta provenance dan tier, serta diff terbaru.
4. **Meter konteks** di header Central chat.
5. **Perbaikan panel Control (Task B)**, diserap ke sini:
   - Tab **Status**: refresh live, styling bar, label L3 yang jujur, baris liveness.
   - Tab **Agents**: filter, opsi live-only, tombol Open node. Data diambil dari assignment, bukan registry mentah.
   - Tab **Skills**: pipeline, Rollback dan Reject yang benar-benar tersambung.

## 5. Gelombang kerja

Setiap gelombang berjalan di branch sendiri dan wajib lolos ketiga gate. Setiap perbaikan akar punya test pengunci.

| Gelombang | Isi | Hasil yang terlihat |
|---|---|---|
| **W0 — Perbaikan dasar** | Race checkpoint. Scope project di consolidator. Sapuan approval kedaluwarsa. Sapuan basi menulis event, tidak lagi menghapus diam-diam. Penyelesaian agent PTY lewat Stop/SessionEnd. Panel Control (Task B). | Checkpoint mulai terisi, worker tidak lagi orphan selamanya, panel Control jujur |
| **W1 — Assignment + watcher** | Tabel `tasks`/`task_deps`/`assignments`/`central_events` dan migrasi penggabungan 3 model. `chat.send`/`canvas.type`/`agent.spawn` membuat assignment. Watcher hook. Aturan liveness. Tool `task.*` (create/assign/report/verify). | Central tahu siapa disuruh apa dan mendeteksi hang/hilang |
| **W2 — Board + timeline** | Route tasks (dengan paginasi). Board 4 kolom. Timeline per kartu. Notifikasi "Needs you"/"Stalled". | Board todo/progress/review/done yang bisa ditelusuri |
| **W3 — Memory + konteks** | Tiga tier memory. `memory.update`/`forget`. Tier kepercayaan. Log suntikan. Hook `PreCompact` + `SessionStart:compact`. Header kaya. Meter konteks. Memory panel. | Konteks tidak hilang saat compaction. Memory terlihat dan bisa dikoreksi. |
| **W4 — Planning + waktu** | Goal → plan → task di UI. Check-in terjadwal. Reminder. Budget harian. Planning lintas project. | Central merencanakan dan menindaklanjuti sendiri sesuai waktu |

Urutan W0 → W1 → W2 wajib berurutan. W3 bisa paralel dengan W2 karena file-nya terpisah. W4 terakhir.

## 6. Keputusan yang perlu dari user

Setiap keputusan disertai rekomendasi saya.

1. **Gabungkan 3 model task menjadi satu?** Rekomendasi: **ya**. Ketiganya kosong, dan tiga model adalah sumber kebingungan.
2. **Siapa yang menyatakan done?** Rekomendasi:
   - Central menjalankan perintah acceptance lalu memindahkan kartu ke Needs review.
   - **User menekan Approve untuk done.**
   - Tersedia sakelar per project "Auto-done bila verifikasi lulus" (default OFF).
3. **Respawn otomatis saat agent hilang?** Rekomendasi: **1× respawn dengan resume session**, sesudahnya failed dan butuh user. Batasnya 2/jam/task.
4. **Boleh Central memulai turn sendiri** (check-in, reminder)? Rekomendasi:
   - Ya, tapi hanya saat supervisor menemukan sesuatu yang butuh keputusan.
   - Ada budget harian (select).
   - Default ON dengan batas rendah.
5. **Memory ditulis otomatis?** Rekomendasi:
   - Fakta dari user dan hasil verifikasi otomatis masuk.
   - Fakta dari teks agent/web masuk sebagai *unverified* sampai dikonfirmasi.
6. **Board default** per project atau gabungan? Rekomendasi: **gabungan "All projects"** dengan filter, karena Central mengelola semuanya.
7. **Ambang liveness** (120 dtk / 10 menit / 20 menit): pakai default ini dulu, lalu setel ulang dari data setelah 2 minggu.

## 7. Risiko

- **Biaya token** dari turn yang dimulai Central sendiri. Diredam dengan filter deterministik dan budget harian.
- **Migrasi model task** menyentuh tool Central yang ada. Semua tool lama harus dipetakan ke model baru dalam satu gelombang, tanpa shim.
- **False stalled** pada agent yang memang lama berpikir. Diredam karena `waiting_input` tidak pernah dianggap hang, aturannya memberi nudge dulu sebelum stalled, dan alasannya terlihat di timeline.
- **Memory poisoning** dari teks agent/web. Diredam dengan tier kepercayaan dan konfirmasi.
