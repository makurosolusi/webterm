# 57 - ENVSIMPLE: akar "Belum berpengaruh" dan model KEMAMPUAN

Basis `chore/envmin-int` (620b9cf). R&D saja. [TERVERIFIKASI] = kode dibaca; [ASUMSI] = inferensi. Tak mengulang `docs/decisions/env-minimal.md` (L3, L4, L14, U1, U2), `RND/54-CHENV-AUDIT.md`, `RND/55-CHENV-DESIGN.md`, `PLAN/CHENV-a.md`.

## 0. Ringkasan satu layar

1. "Belum berpengaruh" adalah nasihat sisi-client dari metadata `requires` yang TIDAK pernah ditegakkan server. Ia menyala juga pada keadaan default (32 entri) dan sebagian metadatanya salah terhadap runtime.
2. Dengan definisi koherensi registry sendiri, 99,82% kombinasi flag tidak koheren. Kegagalannya campuran: 404 diam, tool hilang diam, skip hanya-log, dan sebagian 503/409 eksplisit.
3. "Dikunci" = `dangerous && !root(token)`. Token hanya bisa diaktifkan lewat endpoint loopback tanpa UI, jadi pada setup default flag berbahaya praktis terkunci permanen dari aplikasi.
4. Akar masalah: unit konfigurasi = flag runtime, bukan keputusan pengguna. Solusi: model KEMAMPUAN, flag turunan dihitung, tak tampil, dan tak bisa disetel ke keadaan tak koheren secara konstruksi.

## 1. (a) Bagaimana "tidak berpengaruh" dihitung

| Langkah | Bukti | Status |
|---|---|---|
| `EnvSpec.requires` = `{key, oneOf?, note?}` metadata soft | `src/server/envRegistry.types.ts`, kontrak `src/shared/envSettings.contract.ts` (`EnvRequire`, `evalRequires`, `flagIsOn`) | [TERVERIFIKASI] |
| Server hanya mengirim `requires` ke client; tak ada penegakan di PUT/override | `envSettings.state.ts:79,94` (pendingRestart/effective), `envSettings.service.ts:108-111,150-153` (hanya bootstrap_only/token_required/locked) | [TERVERIFIKASI] |
| Client mengevaluasi `evalRequires` atas nilai draft/tersimpan, tanpa melihat nilai entri itu sendiri | `src/client/envRequires.ts`, `EnvRequiresNote.tsx`, `EnvEntryRow.tsx:76` | [TERVERIFIKASI] |
| Akibat: pada semua-default, 32 entri menampilkan peringatan walau tak ada yang dinyalakan | skrip sekali pakai `/tmp/rnd57/dump.ts` (di luar repo) | [TERVERIFIKASI] |

Metadata `requires` salah/tak lengkap dibanding runtime [TERVERIFIKASI]:
- T2: `CENTRAL_TELEGRAM` meminta runtime `mock|opencode` (`envRegistry.channels.ts:60`), padahal kode menerima `claude`.
- `CENTRAL_AGENTS` over-require PLANNER dan TOOLS=write; `CENTRAL_AUTONOMY` mencantumkan CENTRAL yang tidak dicek kode (`centralAutonomyBoot.ts:104-115`) dan hanya transitif ke LEDGER.
- Dependensi tersembunyi tak tercatat: tool browser Central butuh CA2 ter-boot + ledger (`central/ca2Boot.browser.ts:20`, `ca2Boot.ts:42-55,121-130`).
- `CHANNELS` (master) vs `TELEGRAM` redundan (`RND/54` sudah menandai; `channelsRuntime.ts:84-106` cek master dulu lalu `TELEGRAM`).

Kesimpulan: peringatan bukan fakta runtime, hanya tebakan statis. Memperbaiki `requires` (CHENV-a C6) berguna tapi tidak menghapus keadaan tak-koheren.

## 2. (b) Di mana runtime benar-benar menggerbang

Dua kelas pembacaan: BOOT (butuh restart) dan PER-CALL.

| Kapabilitas | Titik baca flag | Kapan | Bila tak terpenuhi |
|---|---|---|---|
| LEDGER | `ledger/ledgerRuntime.ts:74`, `apiShared.types.ts:8`, `api.ts:156` | boot | rute ledger tak dipasang; konsumen menerima ledger null |
| ORCHESTRATOR_RUN | `orchestratorRunModel.ts:36-47`, `orchestratorRunApi.ts:54-58`, `extendedApi.ts:76` | per-call | 503/404 eksplisit tanpa ledger; rute tak dipasang bila off |
| RUN_REQUIRE_APPROVAL | `orchestratorRunApproval.ts:56-95` | per-call | tanpa ORCHESTRATOR_RUN tak pernah dievaluasi (mati diam) |
| CENTRAL | `central/centralModel.ts:67`, `centralChatApi.ts:49-63` | per-call | chat jatuh ke 404 diam |
| CENTRAL_CHAT/RUNTIME/PLANNER/TOOLS | `central/chat/turnService.ts:106-123` | per-call | giliran ditolak/mock; tools hilang |
| CENTRAL_AUTONOMY | `centralAutonomyBoot.ts:104-115` | boot | skip dengan log saja |
| CA2 (agents/skills/browser tools) | `ca2Boot.ts:42-55,121-130`, `tools/registerAll.ts:45-62`, `defs/agent.defs.ts:26-33`, `defs/core.defs.ts:104` | boot | tool tak terdaftar; diam |
| `task.run` | `defs/task.run.def.ts:28,37` | saat registrasi | tool hilang dari daftar bila ORCHESTRATOR_RUN off |
| Level guard | `central/guard/levelStore.ts:37-40` | per-call | level dipaksa konservatif |
| CHANNELS/TELEGRAM | `channels/channelsMasterGate.ts`, `channelsRuntime.ts:84-106`, `telegramPollWiring.ts:28-35`, `botManager.ts:120`, `channelButtons.ts:61`, `telegramMode.ts` | boot | `logDisabled` warn, runtime null |
| BROWSER | `browser/browser.runtime.ts:53,75,88`, `browserApi.cookies.ts:76` | per-call + boot | rute 403/404 |
| FILES_*, MEMORY_FILES | `envRegistry.files.ts` dan pembaca per-call (`index.ts` ~42-125 urutan boot) | per-call | 403/404 per operasi [ASUMSI untuk kode status persis] |

[TERVERIFIKASI] Pembacaan tersebar (`flagOn`/`parseFlag` di banyak berkas); server tak pernah menolak flag tanpa prasyarat.

## 3. (c) Graf dependensi lengkap (edge `A -> B`, bukti)

Notasi: `req` = disebut di `requires` registry; `real` = ditegakkan/terbaca kode runtime.

| Edge | Bukti | req/real |
|---|---|---|
| RUN_REQUIRE_APPROVAL -> ORCHESTRATOR_RUN | `orchestratorRunApproval.ts:56-95` | req+real |
| ORCHESTRATOR_RUN -> LEDGER | `orchestratorRunModel.ts:36-47`, `orchestratorRunApi.ts:54-58` | req+real |
| task.run (Central) -> ORCHESTRATOR_RUN | `task.run.def.ts:28,37` | real saja |
| CENTRAL_CHAT -> CENTRAL | `centralChatApi.ts:49-63` | req+real |
| CENTRAL_RUNTIME -> CENTRAL | `centralModel.ts:67`, `turnService.ts:106-123` | req+real |
| CENTRAL_PLANNER / CENTRAL_TOOLS -> CENTRAL | `turnService.ts:106-123` | req+real |
| CENTRAL_AUTONOMY -> LEDGER | `centralAutonomyBoot.ts:104-115` | real saja |
| CENTRAL_AUTONOMY -> CENTRAL | `envRegistry.central.ts` | req saja (kode tak cek) |
| CENTRAL_AGENTS -> CA2 boot | `ca2Boot.ts:42-55`, `agent.defs.ts:26-33` | req+real |
| CENTRAL_AGENTS -> PLANNER, TOOLS=write | `envRegistry.ca2.ts` | req saja (over-require) |
| CENTRAL_SKILLS -> CA2 boot | `registerAll.ts:45-62` | req+real |
| CENTRAL browser tools -> BROWSER, CA2, LEDGER | `ca2Boot.browser.ts:20`, `browser.runtime.ts:53,75,88` | real; tak lengkap di req |
| MEMORY_FILES -> CENTRAL | `core.defs.ts:104` | [ASUMSI] |
| TELEGRAM -> CHANNELS | `channelsRuntime.ts:84-106` | req+real |
| TELEGRAM_MODE -> TELEGRAM | `channelsRuntime.ts:106`, `telegramMode.ts` | req+real |
| CHANNELS/TELEGRAM -> LEDGER (tombol approval) | `channelsRuntime.ts:155-172` (`ledgerApprovalPort`) | real |
| CENTRAL_TELEGRAM -> CENTRAL + runtime | `envRegistry.channels.ts:60` | req (salah, T2) |
| BROWSER (cookies, dll) -> token root untuk diubah | `browserApi.cookies.ts:76`, `envSettings.runtime.ts:53` | real |
| FILES_* sub-flag -> FILES master | `envRegistry.files.ts` | req [ASUMSI baris] |

Rantai terpanjang: RUN_REQUIRE_APPROVAL -> ORCHESTRATOR_RUN -> LEDGER (keluhan user); Central: tool browser -> BROWSER + CA2 -> CENTRAL + LEDGER.

## 4. (d) Kombinasi tak koheren dan pengalaman pengguna

Hitungan (skrip `/tmp/rnd57/comb3.ts`, 28 simpul graf, backtracking) [TERVERIFIKASI]:
- Ruang keadaan 1.811.939.328; koheren 3.255.880; tak koheren 1.808.683.448 = 99,82%.
- Dari 33 keadaan "satu saklar dinyalakan", 26 tak koheren sendirian.
- Default: 32 entri menampilkan peringatan.

Pengalaman per kasus:

| Kasus on-tapi-mati | Yang dialami pengguna | Diam? |
|---|---|---|
| ORCHESTRATOR_RUN on, LEDGER off | 503/409 saat jalankan | Eksplisit, tanpa petunjuk perbaikan |
| RUN_REQUIRE_APPROVAL on, ORCHESTRATOR_RUN off | tak terjadi apa pun | Diam total |
| CENTRAL_CHAT on, CENTRAL off | chat 404 | Diam (404) |
| Central on, ORCHESTRATOR_RUN off | tool `task.run` hilang, agen "tak bisa" | Diam, sulit dilacak |
| CENTRAL_AUTONOMY on tanpa LEDGER | skip saat boot, hanya log | Diam |
| CA2 sub-flag on tanpa CA2 boot | tool tak terdaftar | Diam |
| TELEGRAM on, CHANNELS off | bot tak jalan, warn di log | Diam di UI |
| CENTRAL_TELEGRAM + runtime `claude` | UI bilang tak berpengaruh padahal jalan | Peringatan palsu |
| Perubahan boot-key tanpa restart | `pendingRestart` badge | Eksplisit |

Mayoritas kegagalan diam; peringatan UI dan perilaku runtime tidak selaras.

## 5. (e) Apa arti sebenarnya "Dikunci"

- `editable = !locked && (!dangerous || root)` (`envSettings.state.ts:81`). `locked` = `WEBTERM_ENV_SETTINGS=off` (`envSettings.service.ts:55`); `root` = `WEBTERM_TOKEN` terkonfigurasi (`envSettings.runtime.ts:53` rootGate). Ditolak dengan `bootstrap_only`/`token_required`/`locked` (`service.ts:108-111,150-153`).
- Badge: `envLabels.ts:9,14`, `EnvBadges.tsx:26`. [TERVERIFIKASI]
- Token opt-in: loopback terbuka sampai `POST /api/settings/token/enable` (hanya loopback, `tokenAccess.api.ts`, `tokenBootstrap.ts`). Tidak ada UI client untuk itu [TERVERIFIKASI: grep client tidak menemukan pemanggil].
- Pada setup default (tanpa token), flag berbahaya (ORCHESTRATOR_RUN, BROWSER) tak bisa diubah dari aplikasi; jalan lain: edit env + restart, atau curl endpoint token. "Dikunci" tampak seperti kebijakan padahal keadaan awal tanpa jalan keluar.
- Alasan keamanan [TERVERIFIKASI, `docs/decisions/env-minimal.md` U1/U2 dan rootGate]: shell agen sesama mesin atau klien loopback tanpa autentikasi tak boleh menyalakan eksekusi shell, browser, atau mematikan pengaman sendiri. Aturan benar; yang keliru: tak ada jalur persetujuan sadar yang sah.
- Implikasi: persetujuan sadar tidak boleh datang dari kanal yang bisa dipalsukan agen (HTTP loopback). Kandidat: kode satu-kali yang dicetak ke konsol server. [ASUMSI: desain persisnya milik R&D persetujuan runtime aman yang sedang berjalan; di sini hanya antarmuka `grant(capability)`.]

## 6. Rancangan model KEMAMPUAN

### 6.1 Prinsip
1. Satu kemampuan = satu keputusan manusia ("Agen Pusat", "Pekerja otomatis", "Browser", dll.). Hanya kemampuan yang tampil di Settings.
2. Flag internal = TURUNAN murni: `derive(caps) -> Record<flagKey, string>`. Tidak pernah tampil, tidak pernah diminta.
3. Mustahil tak koheren secara konstruksi: prasyarat dideklarasikan sekali sebagai `implies`; `derive` menutup transitif. Invarian tes: untuk SETIAP subset kemampuan (2^N, N~9 = 512 kasus, murah) hasil `derive` memenuhi seluruh edge graf runtime (§3). Bukan peringatan UI.
4. Default aman: kemampuan berbahaya off.

### 6.2 Daftar kemampuan (usulan)

| Kemampuan (label) | Default | Implies (otomatis) | Berbahaya? |
|---|---|---|---|
| `central` Agen Pusat (chat, planner, tools baca) | off | LEDGER | tidak |
| `central.write` Agen Pusat boleh mengubah (tools=write, level guard) | off | central | ya (persetujuan) |
| `central.autonomy` Agen Pusat bekerja sendiri | off | central, LEDGER | ya |
| `central.agents` Sub-agen dan skill (CA2) | off | central | tidak |
| `workers` Orkestrator menjalankan pekerja | off | LEDGER | ya (eksekusi shell) |
| `workers.noApproval` Tanpa persetujuan per-run | off | workers | ya; kebalikan: approval = ON saat `workers` aktif |
| `browser` Node browser | off | (tool Central browser bila `central.agents`: implies CA2) | ya |
| `files` Kelola berkas | off | - | ya (tulis/hapus) [ASUMSI] |
| `telegram` Telegram | off | CHANNELS, TELEGRAM, LEDGER; `telegram.central` -> central | tidak, tapi butuh secret |

Catatan: `RUN_REQUIRE_APPROVAL` bukan kemampuan; dihitung ON bila `workers` aktif kecuali `workers.noApproval` (opt-out sadar). `CHANNELS` + `TELEGRAM` menyatu (redundansi `RND/54`). `PLANNER`/`TOOLS`/`RUNTIME` diturunkan (runtime terpasang, mock bila tidak ada) [ASUMSI: deteksi cukup andal].

### 6.3 Tabel kemampuan -> flag turunan -> kode yang diubah

| Kemampuan | Flag turunan | Kode yang diubah |
|---|---|---|
| central | `WEBTERM_CENTRAL`, `WEBTERM_CENTRAL_CHAT`, `WEBTERM_LEDGER`, PLANNER default | `centralModel.ts:67`, `centralChatApi.ts:49-63`, `turnService.ts:106-123`, `ledgerRuntime.ts:74` -> `isEnabled('central')` |
| central.write | `CENTRAL_TOOLS=write` | `turnService.ts`, `levelStore.ts:37-40` |
| central.autonomy | `CENTRAL_AUTONOMY` | `centralAutonomyBoot.ts:104-115` |
| central.agents | `CENTRAL_AGENTS`, `CENTRAL_SKILLS`, CA2 boot | `ca2Boot.ts:42-55,121-130`, `registerAll.ts:45-62`, `agent.defs.ts:26-33` |
| workers | `ORCHESTRATOR_RUN`, `LEDGER`, `RUN_REQUIRE_APPROVAL=on` | `orchestratorRunModel.ts:36-47`, `orchestratorRunApi.ts:54-58`, `orchestratorRunApproval.ts:56-95`, `extendedApi.ts:76`, `task.run.def.ts:28,37` |
| workers.noApproval | `RUN_REQUIRE_APPROVAL=off` | `orchestratorRunApproval.ts` |
| browser | `WEBTERM_BROWSER` (+CA2/LEDGER bila tool Central) | `browser.runtime.ts:53,75,88`, `browserApi.cookies.ts:76`, `ca2Boot.browser.ts:20` |
| files | `FILES_*` | `envRegistry.files.ts` dan pembacanya |
| telegram | `CHANNELS`, `TELEGRAM`, `TELEGRAM_MODE` (poll default), `LEDGER` | `channelsMasterGate.ts`, `channelsRuntime.ts:84-106`, `telegramPollWiring.ts:28-35`, `botManager.ts:120` |

### 6.4 Satu fungsi `isEnabled(capability)`
- Berkas baru `src/shared/capabilities.ts` (murni, tanpa IO, <=200 baris): `CAPABILITIES` (id, label, deskripsi, default, implies[], danger) dan `deriveFlags(caps)`.
- `src/server/capabilities.runtime.ts`: `isEnabled(cap, env = process.env)` membaca nilai kemampuan tersimpan (+ input legacy, §6.6) lalu menutup `implies` transitif. SATU-SATUNYA pintu baca; pembacaan `flagOn(env[...])` di titik §2 diganti. Cakupan: per-call dan boot memakai fungsi sama; kemampuan yang butuh boot tetap `pendingRestart` (kebenaran `restart` ada di definisi kemampuan, bukan per flag).
- Tes grep gagal bila `flagOn(env['WEBTERM_` muncul di luar `capabilities.runtime.ts`.

### 6.5 Dampak pada tes invarian registry (`envRegistry.invariants.test.ts`)
| Invarian | Nasib |
|---|---|
| 1-3 metadata, 5 teks, 7 default (`:81-:182`) | tetap, hanya untuk entri `audience:'advanced'` yang tersisa; entri turunan keluar dari daftar tampil |
| 4 requires (`:112-132`) | digantikan: `implies` tanpa siklus + tes eksaustif 2^N "derive memenuhi graf runtime" |
| 6 pembaca per kunci tampil (`:147-161`) | diganti: tiap kemampuan punya pembaca `isEnabled`; flag turunan dikecualikan dari "tampil" |
| 8 kunci beku (`:182-205`) | tetap: kunci lama TETAP dikenal (kompat), tak ada yang dihapus dari daftar beku |
| 9 file kecil (`:207`) | tetap; data kemampuan dalam berkas <=100 baris |
| parity/HOT_PROOF (`envRegistry.parity.test.ts:61-100`) | tetap untuk angka CA2; kemampuan tak punya angka |
Tambahan: tes properti "tidak ada keadaan tak koheren".

### 6.6 Kompatibilitas nilai tersimpan
- Override di tabel `app` dan env process tetap dibaca sebagai INPUT lama: `legacyToCapabilities(env)` memetakan `ORCHESTRATOR_RUN=on` -> `workers`, `CENTRAL=on` -> `central`, dst. Flag yang hanya sub-opsi tanpa induk (mis. RUN_REQUIRE_APPROVAL on saja) dipetakan ke kemampuan induk bila `legacy-implies` dipilih, atau diabaikan dengan satu baris log warn bila tidak [pertanyaan U2].
- Penulisan: Settings menulis kunci kemampuan baru (`WEBTERM_CAP_*` [ASUMSI nama], di tabel `app`); flag lama tidak ditulis lagi. Precedence tetap override > env > default.
- Operator env-only: `WEBTERM_ORCHESTRATOR_RUN=on` tetap berfungsi (kini juga menyalakan LEDGER).
- Kunci beku: tak ada penghapusan (L14).

### 6.7 Persetujuan sadar
Menyalakan kemampuan berbahaya = satu tindakan `grant(cap)` dengan konfirmasi manusia (menggantikan "Dikunci + token"); kanal desain: lihat §5.

## 7. Risiko regresi

| Risiko | Mitigasi |
|---|---|
| Operator dengan kombinasi tak koheren sengaja (mis. LEDGER on tanpa Central) berubah perilaku | peta legacy tertulis (§6.6), tes golden untuk setiap kunci beku |
| Menyalakan `workers` kini menyalakan LEDGER (boot) -> butuh restart | `pendingRestart` per kemampuan; jelas di UI |
| Pembacaan tersebar terlewat saat migrasi | tes grep §6.4 + migrasi per domain |
| Mengunci `RUN_REQUIRE_APPROVAL` default-on mengubah operator yang mematikannya | dipetakan ke `workers.noApproval` |
| 40 entri advanced tetap membingungkan | tahap 2: lipat di "Mode ahli" |
| Hot vs boot salah klasifikasi | pakai HOT_PROOF (`envRegistry.parity.test.ts:76-100`) |

## 8. Urutan kerja minimal

1. S: `src/shared/capabilities.ts` + tes properti 2^N (belum dipakai siapa pun).
2. S: perbaiki `requires` yang salah (T2, over-require, hidden dep) sebagai jaring pengaman sementara; cabang kecil.
3. M: `isEnabled` + `legacyToCapabilities`; migrasi pembaca Orchestrator+Ledger+Approval (rantai tiga-flag), tes regresi.
4. M: migrasi Central/CA2/Autonomy dan Channels/Telegram.
5. M: migrasi Browser dan Files setelah ada keputusan kanal `grant`.
6. M: UI Settings: daftar kemampuan, hapus `evalRequires` + badge; entri advanced dilipat.
7. S: README/docs/decisions dan CHANGELOG satu kali di akhir.

## REKOMENDASI TEGAS

1. Apa: adopsi model KEMAMPUAN (§6) sebagai satu-satunya antarmuka Settings. Kenapa: akar masalah ada di unit konfigurasi, bukan UI. Risiko: migrasi pembaca tersebar. Ukuran: L (dipecah §8).
2. Apa: satukan semua pembacaan flag ke `isEnabled(capability)` + tes grep pencegah. Kenapa: 99,82% tak koheren lahir dari 97 titik baca bebas. Risiko: salah klasifikasi boot/per-call. Ukuran: M.
3. Apa: tes properti eksaustif atas subset kemampuan menggantikan invarian 4. Kenapa: menjadikan "tidak berpengaruh" mustahil secara konstruksi. Risiko: rendah. Ukuran: S.
4. Apa: jadikan `RUN_REQUIRE_APPROVAL` turunan (default ON saat `workers`), opt-out `workers.noApproval`. Kenapa: memotong rantai tiga flag dan default aman. Risiko: operator yang mematikannya perlu peta legacy. Ukuran: S.
5. Apa: sebelum model baru, perbaiki `requires` salah (T2, CENTRAL_AGENTS, CENTRAL_AUTONOMY, dep browser). Kenapa: peringatan palsu hari ini. Risiko: nol. Ukuran: S. Lewati bila langkah 3-6 langsung dikerjakan.
6. Apa: ganti "Dikunci" dengan alur `grant(capability)` satu langkah via kanal manusia (selaras R&D persetujuan runtime). Kenapa: token opt-in tanpa UI membuat flag berbahaya terkunci permanen. Risiko: kanal salah membuka celah ke agen loopback. Ukuran: M-L. Keputusan lama "Dikunci cukup via token" (L3/U1) keliru sebagai UX; sebagai keamanan tetap benar.
7. Apa: hapus `evalRequires`, `EnvRequiresNote`, badge "Belum berpengaruh" dari client. Kenapa: tak ada lagi yang diperingatkan. Risiko: rendah. Ukuran: S.
8. Apa: gabungkan CHANNELS master + TELEGRAM jadi kemampuan `telegram`; PLANNER/TOOLS/RUNTIME diturunkan atau disembunyikan. Kenapa: redundan dan bukan keputusan pengguna. Risiko: deteksi runtime perlu diuji. Ukuran: M.

## PERTANYAAN UNTUK USER

1. Kemampuan berbahaya (`workers`, `browser`, `files`, `central.write`): konfirmasi manusia seperti apa yang bisa diterima? Default saran: dialog UI dengan kode satu-kali yang hanya dicetak di konsol server, berlaku per kemampuan.
2. Nilai legacy sub-opsi tanpa induk (mis. RUN_REQUIRE_APPROVAL on tanpa ORCHESTRATOR_RUN): diabaikan atau menyalakan induk? Default saran: diabaikan + warn satu baris di log (jangan menyalakan kemampuan berbahaya diam-diam).
3. Apakah runtime Central (claude/opencode/mock) boleh dideteksi otomatis tanpa pilihan pengguna? Default saran: otomatis, urutan claude, opencode, mock; pengaturan tetap ada di "Mode ahli".
