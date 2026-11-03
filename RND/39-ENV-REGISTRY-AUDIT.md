# 39 - Audit Registry Env (Settings > Environment)

Topik 1 R&D Environment. Basis: worktree `rnd-env` (dari `main`, 26 entri registry + 10 kunci bootstrap). Pratinjau `ca2-int` (+17 entri) di bagian 6. Semua kutipan `file:baris` relatif `src/server/` kecuali disebut. Tanda `[BT]` = belum terverifikasi, `[opini]` = penilaian saya. Tidak ada nilai env yang dibaca atau dicetak.

## 1. Ringkasan

| Metrik | Nilai |
|---|---|
| Entri registry editable | 26 (channels 6, central 11, platform 9) |
| Kunci bootstrap (read-only) | 10, tampil sebagai baris "Terisi/Kosong - hanya lewat env" |
| Var dibaca kode tapi tak terdaftar | 4 notable (bagian 5) |
| Vonis: KEEP / FIX / MOVE / HIDE / REMOVE | lihat kolom Vonis, ringkasan di 7 |
| Pembaca nyata ditemukan | 26/26 (tak ada entri mati total) |
| Entri yang salah/sebagian salah menandai restart/hot | 8 (bagian 4) |
| Default registry berbeda dari perilaku kode | 2 (TELEGRAM_MODE, CHANNELS secara tipe) |

Struktur: `envRegistry.types.ts:7-28` (EnvSpec), builder `:43-65`, gabungan `envRegistry.ts:7`. Overlay memutasi `process.env` (override > env > default kode): `envSettings.service.ts:103-123`.

## 2. Inventaris entri registry (E01-E26)

Kolom: Tipe (F=flag on/off, E=enum, S=string, N=number, X=secret), Def = default registry, R = `restart` (R) atau hot (H) menurut registry, D = `dangerous` (butuh root token, `envSettings.service.ts:131`), Pembaca = lokasi baca nyata, Kapan = kapan dibaca (boot / per-request / per-turn).

### 2.1 Grup Ledger, Kanal, Telegram (`envRegistry.channels.ts`)

| ID | Var (baris) | Tipe | Def | R | Pembaca (file:baris) | Kapan | Vonis |
|---|---|---|---|---|---|---|---|
| E01 | `WEBTERM_LEDGER` (10-13) | E off/shadow/on | off | R | `ledger/ledgerRuntime.ts:74`, boot `index.ts:40` | boot | KEEP+FIX |
| E02 | `WEBTERM_CHANNELS` (14-17) | E on/off | on | R | `channels/channelsMasterGate.ts:17-22`, `channelsRuntime.ts:149` | boot | MOVE+FIX |
| E03 | `WEBTERM_TELEGRAM` (18) | F | off | R | `channelsRuntime.ts:50,158` (`flagOn`) | boot | MOVE+FIX |
| E04 | `WEBTERM_TELEGRAM_MODE` (19-22) | E poll/webhook | poll | R | `channels/telegramMode.ts:14-24`, `index.ts:51` | boot | MOVE+FIX |
| E05 | `WEBTERM_TELEGRAM_BOT_TOKEN` (23-26) | X | - | R | `channels/telegramSend.ts:18-25` (+alias lama `TELEGRAM_BOT_TOKEN`), `telegramPollWiring.ts:56` | per-send; poll start di boot | MOVE+FIX |
| E06 | `WEBTERM_TELEGRAM_WEBHOOK_SECRET` (27-30) | X | - | R | `channels/channelSecret.ts:9,57`, `channelsRuntime.ts:165` | boot, hanya mode webhook | MOVE+FIX |

Catatan per entri:
- E01: deskripsi (`envRegistry.channels.ts:12`) hanya menjelaskan `on`; `shadow` (ledger jalan, tak memblok boot; `ledgerRuntime.ts:80-84`) tak dijelaskan. Label "Ledger" = judul grup, sehingga breadcrumb jadi "Webterm > Ledger: Ledger". Prasyarat untuk Telegram, autonomy, memory, central chat (sebagian besar flag lain secara efektif mati bila ledger `off`).
- E02: bertipe `enum` dua nilai `on|off` padahal semantik flag. Kode juga menerima kosong sebagai `on` dan nilai lain sebagai `unsupported` yang fail-closed (`channelsMasterGate.ts:17-22`); registry tak bisa menghasilkan nilai selain on/off sehingga aman, tetapi UI menampilkan dropdown on/off (inkonsisten dengan flag lain yang checkbox). Ini yang terlihat di screenshot. Dependensi: tanpa E02=on, E03-E06 tak berefek (`channelsRuntime.ts:149-152`).
- E03: deskripsi "butuh ledger hidup" benar (`channelsRuntime.ts:171` log-disable hanya di log; UI diam). Tidak tahu bahwa mode webhook juga butuh E06 (`channelsRuntime.ts:165-167`).
- E04: default registry `poll`, padahal kode: nilai kosong -> `poll` bila ada token, selain itu `webhook` (`telegramMode.ts:23`). UI menampilkan "poll" untuk instalasi tanpa token yang sebenarnya berjalan sebagai webhook. Tes mengunci perilaku keliru ini (`envRegistry.test.ts:26`). Opsi enum cocok dengan kode (`telegramMode.ts:7`).
- E05: sumber efektif menyesatkan. Kode juga membaca alias lama `TELEGRAM_BOT_TOKEN` (`telegramSend.ts:19-24`, `channelSenderBoot.ts:20`); bila hanya alias yang terisi, UI menampilkan "Kosong" (`sourceOf` hanya melihat kunci registry) padahal bot jalan. Terdaftar di `redactSecrets.ts:9`.
- E06: hanya relevan mode `webhook`; di mode `poll` kode tak membacanya (`channelsRuntime.ts:162-169`). Alternatif `WEBTERM_TELEGRAM_WEBHOOK_SECRET_FILE` (`channelSecret.ts:11`) tak ada di UI dan bila terisi maka UI "Kosong" padahal valid.

### 2.2 Grup Central (`envRegistry.central.ts`)

| ID | Var (baris) | Tipe | Def | R | Pembaca | Kapan | Vonis |
|---|---|---|---|---|---|---|---|
| E07 | `WEBTERM_CENTRAL` (7) | F | off | H | `central/centralModel.ts:67`; boot juga `telegramPollWiring.ts:20,35` | request + boot (jembatan Telegram) | KEEP+FIX |
| E08 | `WEBTERM_CENTRAL_CHAT` (8) | F | off | R | `centralChatApi.ts:24,47`; boot `telegramPollWiring.ts:33` | request + boot | KEEP+FIX |
| E09 | `WEBTERM_CENTRAL_TELEGRAM` (9) | F | off | R | `channels/telegramCentralBridge.ts:13`, `telegramPollWiring.ts:34` | boot | MOVE+FIX |
| E10 | `WEBTERM_CENTRAL_RUNTIME` (10-13) | E off/mock/opencode | off | R | `central/runtime/runtimeFlag.ts:9,18-22`, `centralChatHandlers.ts:49-53` | request (cache per kind) + boot | KEEP+FIX |
| E11 | `WEBTERM_CENTRAL_MODEL` (14) | S | `opencode/deepseek-v4.1-flash-free` | R | `central/runtime/opencodeOptions.ts:55`, `opencodeRuntime.ts:134` | per-turn (hot) | FIX (advanced) |
| E12 | `WEBTERM_CENTRAL_PLANNER` (15) | F | off | H | `central/chat/turnService.ts:177` | per-turn | KEEP+FIX |
| E13 | `WEBTERM_CENTRAL_TOOLS` (16) | E read/write | read | H | `turnService.ts:178` (`=== 'write'`) | per-turn | KEEP+FIX |
| E14 | `WEBTERM_CENTRAL_MEMORY` (17) | F | off | H | `turnService.ts:179` | per-turn | KEEP+FIX |
| E15 | `WEBTERM_CENTRAL_AUTONOMY` (18-22) D | F | off | R | `central/centralAutonomy.ts:79`, `centralAutonomyBoot.ts:34` | boot | KEEP |
| E16 | `WEBTERM_OPENCODE_BIN` (23) D | S | `opencode` | R | `opencodeOptions.ts:60`, `opencodeRuntime.ts:135` | per-turn (hot) | HIDE |
| E17 | `WEBTERM_OPENCODE_ALLOW_TOOLS` (24-28) D | F | off | R | `opencodeOptions.ts:65`, `opencodeRuntime.ts:140` | per-turn (hot) | HIDE |

Catatan:
- E07: `hot:true` (central.ts:7) hanya benar untuk HTTP (`centralChatApi.ts:48`); jembatan Telegram membacanya sekali saat boot. Label "Central" = judul grup.
- E10: registry membatasi `off|mock|opencode`; parser kode menerima juga `claude` dan `codex` (`runtimeFlag.ts:9`, tipe `centralRuntime.ts:6`) tetapi `buildService` hanya membuat runtime untuk `mock` dan `opencode` (`centralChatHandlers.ts:49-53`); `claude/codex` -> runtime `null` -> 503 `central_runtime_off` (`turnService.ts:81,166`). Jadi enum registry benar, parser kode terlalu longgar (di luar scope UI). `mock` = demo (`envRegistry.central.ts:12`): layak disembunyikan dari pengguna biasa [opini].
- E11: nilai default adalah nama model gratis pihak ketiga yang rapuh `[BT]`; relevan hanya bila E10=`opencode`. 
- E13: `read|write` adalah boolean terselubung ("izinkan tool tulis"); hanya bermakna bersama E12 (`turnService.ts:183`, `planner && toolsWrite`). Pasangan E12+E13 = satu keputusan, dua kontrol.
- E15 D: README menyebut butuh ledger + `WEBTERM_ORCHESTRATOR_RUN=on` (`README.md:39`; `centralAutonomyBoot.ts:98-99`). Registry tidak menyatakan dependensi.
- E16 D: path executable yang dijalankan server; default `opencode` di PATH sudah cukup untuk hampir semua kasus. HIDE dari UI (cukup `.env`/dokumentasi) [opini].
- E17 D: melepas deny `bash/edit/webfetch/task` pada child opencode (`opencodeOptions.ts:21-26,121-125`). Saklar pengaman paling sensitif di halaman; kelasnya sama dengan kunci bootstrap `ALLOW_TOKEN_MINT` yang justru read-only. HIDE (jadikan bootstrap-only) [opini].

### 2.3 Grup Orchestrator, Memori, Kontrol (`envRegistry.platform.ts`)

| ID | Var (baris) | Tipe | Def | R | Pembaca | Kapan | Vonis |
|---|---|---|---|---|---|---|---|
| E18 | `WEBTERM_ORCHESTRATOR_RUN` (8-12) D | F | off | R | `orchestratorRunModel.ts:11,36`; `orchestratorRunApi.ts:54`; `orchestratorControlService.ts:49`; boot `centralAutonomyBoot.ts:98` | per-request + boot | KEEP+FIX |
| E19 | `WEBTERM_RUN_REQUIRE_APPROVAL` (13) | F | off | R | `orchestratorRunModel.ts:13,41`; `orchestratorRunProduction.ts:206` | per-call | KEEP+FIX |
| E20 | `WEBTERM_MEMORY_FILES` (14) | F | off | H | `memory/memoryFilePath.ts:19,23`; `memoryFileHttp.ts:127` | per-request | KEEP |
| E21 | `WEBTERM_MEMORY_DIR` (15-20) D | S abs | kosong | H | `memoryFileHttp.ts:27,55-63` | per-request | HIDE |
| E22 | `WEBTERM_CONTROL_CWD_ROOTS` (21-26) D | S | kosong | H | `control/controlCwd.ts:15`, `control/mount.ts:63` | per-call | HIDE |
| E23 | `WEBTERM_TRUST_PROXY` (27-31) D | F | off | R | `channels/webhookPeer.ts:21-23,49` | per-request (hot) | HIDE |
| E24 | `WEBTERM_LOG_LEVEL` (33-36) | E trace..error | info | R | `logs/logger.ts:34,105` | boot | MOVE |
| E25 | `WEBTERM_LOG_BUFFER` (37-40) | N 100-100000 | 5000 | R | `logs/logBus.ts:12-15,117`; `logger.ts:106` | boot | MOVE (advanced) |
| E26 | `WEBTERM_LOG_FILE` (41-44) | F | on | R | `logs/logger.ts:108` (semua nilai selain `off` = on) | boot | MOVE |

Catatan:
- E18: dibaca per-request (`orchestratorRunApi.ts:54`) sehingga sebenarnya hot; hanya autonomy yang mengikatnya di boot. Mengaktifkan = server boleh spawn PTY worker nyata; tanpa token root tak bisa diubah (T1).
- E19: dibaca per-call (`orchestratorRunProduction.ts:206`), tandai hot.
- E20: tanpa `WEBTERM_LEDGER` aktif endpoint tetap 503 `LEDGER_OFF` (`memoryFileHttp.ts:128-131`); dependensi tak dinyatakan.
- E21: path absolut ke root memory; relatif diabaikan dengan warn (`memoryFileHttp.ts:58-62`). Teks kosong ditolak validator (`envSettings.validate.ts:31`), jadi "kosong = default" (E11, E21, E22) hanya lewat Reset. Infrastruktur: HIDE.
- E22: dipakai kontrol API (`control/mount.ts:63`); daftar dipisah `path.delimiter` (OS-dependen). HIDE [opini].
- E23: hanya berguna di belakang reverse proxy; hot di kode (per-request). HIDE.
- E24-E26: topik logging; panel Output sudah punya kontrol level runtime (`envRegistry.platform.ts:35` menyebut itu). Pindah ke grup "Log" atau halaman Output; E25 angka teknis -> advanced.

## 3. Temuan lintas entri

| # | Temuan | Bukti | Dampak |
|---|---|---|---|
| T1 | Dalam mode dev (loopback, tanpa `WEBTERM_TOKEN`) semua entri `dangerous` read-only dengan pesan "Butuh token root" yang tak bisa dipenuhi dari UI | `envSettings.runtime.ts:37`, `envSettings.service.ts:131`, `client/EnvEntryRow.tsx:75-77`; token tak wajib untuk loopback `auth.ts:51-61` | 7 dari 26 entri (27%) mustahil diedit di pemakaian default; membingungkan |
| T2 | Tidak ada dependensi terstruktur. Rantai: Telegram -> Kanal on + Ledger on/shadow (+ secret bila webhook); Central chat -> Central; Central telegram -> Telegram + Chat + Central + Runtime!=off (5 gerbang); Planner -> Tools=write; Autonomy -> Ledger + Orchestrator run | `telegramPollWiring.ts:32-37`, `channelsRuntime.ts:149-171`, `centralAutonomyBoot.ts:98` | Pengguna menyalakan flag yang diam-diam tak berefek (hanya tercatat di log) |
| T3 | Pengelompokan tak jelas: grup `central` berisi 11 entri campur (flag fitur, runtime, model, binary, izin tool); grup `memory` dan `control` berisi item yang tak terkait (log di grup "Kontrol") | `envRegistry.platform.ts:33-44` (log di grup `control`) | Grup tak memetakan tab Settings; log tersembunyi di "Kontrol" |
| T4 | Duplikat dengan tab Channels: tab Channels hanya status + bind chat, dan teks `inactiveHint` menyuruh user mengisi `WEBTERM_TELEGRAM=on` dan `TELEGRAM_BOT_TOKEN` "di environment server" padahal kini bisa dari Environment; nama token juga alias lama | `client/channelsLabels.ts:8-9` | Dua tempat untuk satu topik, instruksi usang dan beda nama var |
| T5 | Bentuk boolean tak seragam: kunci via `flag()` = checkbox, `WEBTERM_CHANNELS` (enum on/off) = dropdown; bootstrap memakai nilai `'1'` (`approvalAuth.ts:15`, `control/mount.ts:62`, `agentStatusAuth.ts:15`) sedangkan flag lain `on` | `envRegistry.channels.ts:14`, `client/EnvValueControl.tsx:19-30` | Semantik boolean berbeda tiga cara (`on`/`1`/enum) |
| T6 | Tidak ada metadata untuk memfilter: `group`, `kind`, `restartRequired`, `dangerous` saja; tak ada `audience`, `requires`, `owner tab`. Daftar `ENV_GROUP_ORDER` dikodekan di klien terpisah | `envRegistry.types.ts:7-28`, `client/envLabels.ts:39` | Tak bisa menyembunyikan internal/lanjutan tanpa mengubah kode klien |
| T7 | Invarian tes hanya: kunci unik, tak bootstrap, default lolos validator, file <=100 baris. Tidak ada tes "tiap entri punya pembaca" atau "tiap entri punya metadata UI" | `envRegistry.test.ts:11-44` | Entri mati atau salah bisa masuk tanpa terdeteksi |

## 4. Audit restart/hot (registry vs kode)

`restartRequired = !hot` (`envRegistry.types.ts:39`); default "aman" = restart. Berikut ketidaksesuaian terbukti dari pembacaan per-panggilan.

| Var | Registry | Kenyataan | Aksi |
|---|---|---|---|
| E11 `CENTRAL_MODEL` | R | dibaca per-turn (`opencodeRuntime.ts:134`, tanpa cache; `new OpenCodeRuntime()` tanpa opsi, `centralChatHandlers.ts:51`) | tandai hot |
| E16 `OPENCODE_BIN` | R | per-turn (`opencodeRuntime.ts:135`) | hot |
| E17 `OPENCODE_ALLOW_TOOLS` | R | per-turn (`opencodeRuntime.ts:140`) | hot |
| E18 `ORCHESTRATOR_RUN` | R | per-request (`orchestratorRunApi.ts:54`); boot hanya untuk autonomy | hot (+catatan autonomy) |
| E19 `RUN_REQUIRE_APPROVAL` | R | per-call (`orchestratorRunProduction.ts:206`) | hot |
| E23 `TRUST_PROXY` | R | per-request (`webhookPeer.ts:49`) | hot |
| E08 `CENTRAL_CHAT`, E10 `CENTRAL_RUNTIME` | R | HTTP per-request, tetapi jembatan Telegram di boot | tetap R, deskripsi |
| E07 `CENTRAL` | H | HTTP per-request, jembatan Telegram di boot | H hanya sebagian; catat |
| E05 `BOT_TOKEN` | R | egress per-send (`telegramSend.ts:15-16`), tetapi poll start & mode diputuskan di boot | tetap R |

Dampak: banner "Perlu restart server untuk: ..." (`EnvSection.tsx:58-60`) memuat 6 kunci yang sebenarnya langsung berlaku -> restart tak perlu.

## 5. Var dibaca kode tetapi tak ada di registry

| Var | Pembaca | Status | Vonis |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` (alias lama) | `channels/telegramSend.ts:19-24` | alias E05, tampil "Kosong" bila hanya ini terisi | FIX di E05 (tampilkan "terisi via alias") |
| `WEBTERM_TELEGRAM_WEBHOOK_SECRET_FILE` | `channels/channelSecret.ts:11` | alternatif E06 | dokumentasi saja (HIDE) |
| `WEBTERM_RETRIES` | hanya `client/EnvSection.test.tsx` | fixture tes, bukan var produk | abaikan |
| `NODETERM_PERM_WAIT_SECS`, `NODETERM_NODE_ID/TOKEN/PORT` | `hooks.ts:40`, `shared/settings.ts:155` | protokol agent, diatur lewat tab Agent (`SettingsAgents.tsx:91`) | JANGAN masuk registry (CLAUDE.md: tetap `nodeterm`) |

## 6. Bootstrap (B01-B10, `envRegistry.ts:17-28`) dan pratinjau ca2-int

| ID | Kunci | Pembaca | Catatan | Vonis |
|---|---|---|---|---|
| B01 | `HOST` | `serverConfig.ts:9` | alias `WEBTERM_HOST` (B03), duplikat | HIDE |
| B02 | `PORT` | `serverConfig.ts:10`, `launchLine.ts:17` | | HIDE |
| B03 | `WEBTERM_HOST` | `serverConfig.ts:9` | alias lama | HIDE |
| B04 | `WEBTERM_DATA_DIR` | `config.ts:6` | | HIDE (info "lokasi data" cukup di About) |
| B05 | `WEBTERM_TOKEN` | `auth.ts:51`, `envSettings.runtime.ts:37` | secret; "Terisi" berguna untuk T1 | KEEP sebagai status |
| B06 | `WEBTERM_ALLOW_LOOPBACK_APPROVAL` | `approvalAuth.ts:15` (`=== '1'`) | | HIDE |
| B07 | `WEBTERM_ALLOW_TOKEN_MINT` | `control/mount.ts:62` (`=== '1'`) | | HIDE |
| B08 | `WEBTERM_STRICT_HOOK_AUTH` | `agentStatusAuth.ts:15` (`=== '1'`) | | HIDE |
| B09 | `WEBTERM_TELEGRAM_API_BASE` | `telegramSend.ts:117`, `telegramPollApi.ts:56` | | HIDE |
| B10 | `WEBTERM_ENV_SETTINGS` | `envSettings.service.ts:79` | dipakai banner terkunci | KEEP sebagai status |


Pratinjau `ca2-int/src/server/envRegistry.ca2.ts` (belum di `main`, +17 entri ke `central` dan `memory`): jika digabung tanpa perubahan UI, grup `central` menjadi 26 entri dan total 43. Pembaca di `ca2-int`: ada untuk `CENTRAL_AGENTS` (`central/guard/levelStore.ts:12`), `CHECKPOINT` (`context/contextAssembler.ts:21`), `MAX_STEPS` (`chat/toolLoop.ts:18`), `TURN_WALL_MS/TURN_TOKENS` (`chat/turnLimits.ts:5-6`), `DAILY_*` (`guard/budgetStore.ts:29`), `SKILLS/SKILL_PROPOSE` (`tools/defs/skill.defs.ts:10-11`), `BOTS` (`channels/botManager.ts:13`), `KNOWLEDGE` (`tools/defs/kb.defs.ts:9`), `EMBED_URL` (`memory/memoryHybrid.ts:118`), `AGENT_IDLE_DONE_MS` (`orchestrator/workerSignal.ts:10`). Tanpa pembaca di `ca2-int` (per grep): `WEBTERM_CENTRAL_TOOL_BRIDGE`, `WEBTERM_KNOWLEDGE_GRAPHIFY`, `WEBTERM_EMBED_MODEL` -> kandidat REMOVE/tunda sampai pembaca ada `[BT]` (WS integrasi mungkin belum selesai). Angka teknis (`MAX_STEPS`, `TURN_*`, `DAILY_*`, `AGENT_IDLE_DONE_MS`) = 8 entri tipe `num` yang jelas berkelas advanced.

## 7. Ringkasan vonis (registry `main`, 26 entri)

| Vonis | Entri | Jumlah |
|---|---|---|
| KEEP (+FIX label/deskripsi/dependensi) | E01, E07, E08, E10, E12, E13, E14, E15, E18, E19, E20 | 11 |
| MOVE ke tab Channels | E02, E03, E04, E05, E06, E09 | 6 |
| MOVE ke grup/halaman Log | E24, E25, E26 | 3 |
| HIDE (advanced/`.env`) | E16, E17, E21, E22, E23 | 5 |
| FIX (advanced) | E11 | 1 |
| REMOVE | (tidak ada pada `main`) | 0 |

Bootstrap: KEEP-status B05, B10; HIDE sisanya (8). Pratinjau ca2: 3 kandidat REMOVE/tunda, ~8 advanced.

## 8. Implikasi untuk webterm

Rekomendasi tegas:
1. Pindahkan seluruh pengaturan Telegram/Kanal (E02-E06, E09) ke tab Channels yang sudah ada, di atas status; hapus duplikat di Environment dan perbarui `channelsLabels.ts:8-9` (S/M).
2. Tambahkan metadata registry: `audience: 'user'|'advanced'|'internal'`, `requires: string[]` (kunci + nilai), `ownerTab`, `hot` terkoreksi untuk 6 kunci di bagian 4; tampilkan peringatan dependensi bila prasyarat mati (M).
3. Koreksi: E04 default `auto` (resolusi: token ada -> poll, selain itu webhook) dan ubah tes `envRegistry.test.ts:26`; E02 menjadi `flag(..., 'on')` agar checkbox; E01 deskripsi `shadow`; E05/E06 tampilkan "terisi via alias/file" (S).
4. Sembunyikan E16, E17, E21, E22, E23 dan delapan bootstrap non-informatif dari tampilan default (jadikan "Lanjutan", atau bootstrap-only untuk E17); tangani T1 dengan pesan yang menjelaskan cara memberi `WEBTERM_TOKEN` atau sembunyikan entri `dangerous` saat tak ada token (M).
5. Tambah tes invarian registry: tiap entri punya `audience`/`ownerTab`; tiap kunci punya pembaca (grep di tes) agar entri mati tak masuk (S).
6. Gabungkan E12+E13 menjadi satu kontrol "Izinkan Central menulis (planner)" bila ingin menyederhanakan [opini].

Perubahan konkret (file): `src/server/envRegistry.types.ts` (metadata), `envRegistry.{channels,central,platform}.ts` (koreksi + metadata), `envRegistry.test.ts`, `client/EnvSection.tsx`, `EnvEntryRow.tsx`, `envLabels.ts`, `ChannelsSection.tsx`+`channelsLabels.ts` (pindah Telegram). Urutkan setelah integrasi `ca2-int` karena `envRegistry.ts` dan `envRegistry.ca2.ts` disentuh di sana.

Risiko: nilai override tersimpan dikunci per nama var (`envSettings.store.ts:7-31`); memindah tampilan ke tab lain tidak mengubah penyimpanan, jadi aman, asalkan nama var tak diubah. Menyembunyikan entri `dangerous` tak boleh menghapusnya dari `specFor` (nilai tersimpan tetap diterapkan oleh `apply()` `envSettings.service.ts:103`).

Belum terverifikasi `[BT]`: apakah `WEBTERM_TELEGRAM_WEBHOOK_SECRET` dibaca ulang per-request oleh `respondToWebhook` (hanya boot yang terbukti); apakah nama model default E11 masih valid; pembaca untuk 3 var ca2 tanpa grep-hit di `ca2-int`; perilaku UI sebenarnya (screenshot hanya dari deskripsi, tanpa menjalankan app).

Estimasi: koreksi data registry S; metadata + tes invarian M; pemindahan Telegram ke Channels M; total M-L tergantung desain UI (topik 2 dan 3).
