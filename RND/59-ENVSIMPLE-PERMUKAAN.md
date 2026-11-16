# RND-59 ENVSIMPLE: permukaan akhir Settings dan migrasi

Basis: `chore/envmin-int`. Melengkapi `RND/55-CHENV-DESIGN.md` (Opsi B: ganti nama + lipatan "Lanjutan"). Tag: [V] = kode dibaca, [A] = asumsi.

## 0. Akar masalah (satu paragraf)

Rantai flag lahir dari empat hal, bukan dari UI. (1) `requires` keras antar flag: `RUN_REQUIRE_APPROVAL` -> `ORCHESTRATOR_RUN` -> `LEDGER` (`envRegistry.platform.ts:19,24`; `envRegistry.channels.ts:12`) [V]. (2) Runtime dirangkai sekali saat boot: ledger `index.ts:51`, Telegram `index.ts:65`, browser `index.ts:125-136`, rute WS browser `index.ts:188` [V]; maka hampir semua perubahan butuh restart. (3) Kunci `dangerous` hanya bisa diubah bila `ctx.root` (`envSettings.service.ts:111`), sedangkan UI token tidak ada dan pesannya menyuruh edit `.env` (`envLabels.ts:45`) [V]. (4) Fitur mati menyamar: menu hilang (`browser.feature.ts:2-3`), 503 `ledger_off` (`apiShared.types.ts:8`, `centralChatApi.ts:63`), pesan "Set WEBTERM_BROWSER_BIN" (`browser.status.ts:12`) [V]. Pengguna lokal tidak punya satu pun keputusan bernama "LEDGER". Itu detail implementasi yang bocor.

Penilaian keputusan lama (terang): Opsi B RND/55 (ganti nama + lipat) TIDAK cukup. Ia merapikan daftar flag tetapi daftar itu tetap permukaan utama, jadi keadaan "Belum berpengaruh" tetap bisa dicapai. Keputusan `LEDGER` default off (`envRegistry.channels.ts:16`) tidak salah per se, tetapi menjadikannya pilihan pengguna itu salah. Token opt-in tanpa UI (U1, `env-minimal.md:29,68`) kini harus selesai karena menjadi syarat persetujuan.

## A. Tujuh keputusan nyata

Prinsip mekanik: "Kemampuan" = VIEW atas kunci yang sudah ada, bukan penyimpanan baru. Mengaktifkan kemampuan menulis kunci hasil `implies` secara atomik lewat PUT batch yang sudah ada (`envSettings.service.ts:108-114` memproses `change` berisi banyak kunci + `unset`) [V]. Keadaan "tidak berpengaruh" tak bisa dicapai lewat jalur ini.

| # | Kalimat untuk pengguna | Default | Restart | Kunci di bawahnya (implied ditulis otomatis) |
|---|---|---|---|---|
| 1 | "Izinkan agen menjalankan worker di mesin ini?" (+ sub: "Minta persetujuan tiap run", default ya) | tidak | sekarang ya (`platform.ts:18` restart boot); target TIDAK (W1) | `ORCHESTRATOR_RUN`=on, `RUN_REQUIRE_APPROVAL`=on, `LEDGER`=shadow |
| 2 | "Tampilkan node Browser di kanvas?" | tidak | sekarang ya (`index.ts:125`); target TIDAK (lazy) | `BROWSER`=on. `BROWSER_BIN` hanya muncul bila Chromium tak terdeteksi |
| 3 | "Hubungkan Telegram" (tempel token bot, tombol Sambungkan) | tidak | sekarang ya (T3 RND/54; `index.ts:65`); target TIDAK | `TELEGRAM`=on, `TELEGRAM_BOT_TOKEN` (secret), `CHANNELS`=on, `LEDGER`=shadow, mode=otomatis |
| 4 | "Biarkan Central mengurus project: Mati / Usul / Otomatis" | Mati | `CENTRAL` hot (`central.ts:13`); `CENTRAL_AGENTS` dangerous (`ca2.ts:24-28`) | `CENTRAL`=on, `CENTRAL_AGENTS`, `LEDGER`=shadow |
| 5 | "Izinkan ubah / unggah berkas dari UI?" | tidak | tidak [A: baca per panggilan via `filesFlagOn`, `invariants.test.ts:41`] | `FILES_MUTATE`, `FILES_UPLOAD` |
| 6 | "Batas pemakaian harian agen" (angka token) | `DEFAULT_DAILY_TOKENS` | tidak (`ca2.ts:34` hot) | `CENTRAL_DAILY_TOKENS` (opsional `COST_MICROS`) |
| 7 | "Lindungi dengan token akses" (kartu "Akses", bukan flag) | tidak | tidak, tapi muat ulang tab | `tokenAccess.api.ts` enable/rotate/status; bukan kunci registry |

Kunci lain (62 registry: 18 `user` + 44 `advanced`, ditambah 11 `BOOTSTRAP_ONLY_KEYS`; sisa ~24 dari ~97 literal di `src` adalah internal/protokol `WEBTERM_*`) [V dari dump registry]:
- Diturunkan (hilang dari permukaan, masih ada sebagai kunci): `LEDGER`, `CHANNELS`, `TELEGRAM_MODE`, `RUN_REQUIRE_APPROVAL` (jadi sub-switch #1), `BROWSER_AGENT` (sudah ada toggle persetujuan per node, jadi bukan keputusan global), `MEMORY_FILES`, `KNOWLEDGE`, `CENTRAL_SKILLS` dan turunan central lain (`requires: CENTRAL`, `ca2.ts:37-50`).
- Angka tuning (`CENTRAL_TURN_*`, `BROWSER_MAX_LIVE`, `FILES_LIST_MAX`, dst): tetap di lipatan "Lanjutan (operator)", tanpa badge apa pun selain nilai/sumber.
- 9 bootstrap (`env-minimal.md:9`): tidak di Settings; satu baris informasi baca-saja (data dir, port, token aktif/tidak).
- TIDAK ADA kunci dihapus (lihat D). `audience` hanya proyeksi UI (`envSettings.state.ts:81` menyalin ke entri; `apply()` bekerja per kunci) [V], jadi menurunkan `audience` dari `user` ke `advanced` tidak mengubah fungsi.

## B. Pengalaman pertama dan harian

Nol-konfigurasi: `bun run dev`, tab terbuka, terminal dan kanvas langsung bekerja; tak satu pun kemampuan butuh .env [V: `.env.example` 9 kunci, L1]. Semua kemampuan off sampai diminta, kecuali read-only berkas (L11).

Titik "dead flag" dan penggantinya:

| Titik (bukti) | Gejala sekarang | Pengganti |
|---|---|---|
| `browser.feature.ts:2-3,11` + `canvasMenu.pane.tsx` + `useBrowserAdd.ts:6,17` | flag off: `/status` 404, status `null`, item "New Browser" tidak ada sama sekali | Server selalu menjawab `/api/browser/status` dengan `{enabled:false, binFound}`. Menu menampilkan "Browser" dengan penanda; klik membuka dialog "Aktifkan Browser?" (satu kartu persetujuan, lihat di bawah). Setelah ya, node langsung ditambahkan |
| `browser.status.ts:12` `no_binary: '... Set WEBTERM_BROWSER_BIN.'`; deteksi `chromium.launch.ts:21-41` | pesan menyuruh isi env | Pesan: "Chromium tidak ditemukan." Aksi: [Pilih lokasi] (input path, menulis `BROWSER_BIN`, divalidasi ada) dan tautan unduh. Status `binFound` sudah ada di `BrowserStatusResp`, jadi dialog bisa memeriksa SEBELUM mengaktifkan |
| `envLabels.ts:45` `noRootGate` | "Atur WEBTERM_TOKEN di shell atau .env, restart" | Tidak pernah ditampilkan sebagai jalan buntu. Dialog persetujuan memuat langkah token (lihat di bawah) |
| `apiShared.types.ts:8`, `api.ts:154-156`, `centralChatApi.ts:63` `ledger_off` | 503 senyap, Inbox menampilkan error mentah | Hilang untuk jalur normal karena kemampuan #1/#3/#4 menulis `LEDGER=shadow`. Sisa kasus (operator memaksa off) dipetakan klien ke "Ledger dimatikan operator" + tautan ke lipatan Lanjutan |
| `index.ts:65`, `telegramPollWiring.ts` (`startTelegramInbound` null bila tanpa token) | token baru tidak berefek sampai restart (T3) | Ekspor `ensureTelegramInbound()` yang dipanggil hook apply saat token/flag berubah; kartu menampilkan "Tersambung sebagai @bot" setelah `getMe` (flow C1 RND/55) |
| `index.ts:188` rute WS bergantung pada `browserRuntime ?` | rute tidak ada sampai boot berikutnya | Rute WS selalu terdaftar; runtime dibuat malas pada aktivasi pertama dan menolak upgrade dengan kode jelas bila belum aktif |

Persetujuan satu langkah untuk kemampuan `dangerous` (#1, #2, #4 sebagian):
1. Dialog memuat `dangerNote` spec (`platform.ts:21`, `browser.envRegistry.ts:~16`) dalam bahasa biasa + satu tombol "Izinkan".
2. Bila token belum ditegakkan: klien memanggil `POST /api/settings/token/enable` (`tokenAccess.api.ts:66`), memegang nilai yang keluar sekali, `storeToken` (`api.ts` ~51-53), lalu PUT batch bermodal token. Pengguna melihat satu klik, bukan dua langkah.
3. Muat ulang tab hanya bila WS lama perlu token (batas jujur `env-minimal.md:43`).
4. Kejujuran: token ini speed bump, bukan batas keamanan terhadap proses uid sama (`env-minimal.md:42`). Teks dialog tidak boleh menjanjikan lebih.

Hari-hari biasa: kartu menampilkan satu baris status ("Siap", "Butuh Chromium [Pilih lokasi]", "Perlu persetujuan [Izinkan]", "Diatur dari .env, disembunyikan override" untuk `envShadowed`). Tidak ada keadaan "Belum berpengaruh" untuk kunci kemampuan.

## C. Apakah halaman flag harus ada?

Untuk pengguna biasa: tidak. Struktur akhir (konsisten dengan Opsi B, tetapi permukaan utamanya diganti):

1. Tab "Kemampuan": tujuh kartu di atas (data di satu berkas katalog `src/shared/envCapabilities.data.ts`, <=100 baris sesuai invarian 9 untuk berkas data). Skema entri: `{id, question, keys:{kunci:nilai}, implies:{kunci:nilai}, consent?:true, needs?:'chromium'|'botToken', hint}`.
2. Kartu "Akses": status token, [Aktifkan], [Rotasi]. Ini UI U1 yang tertunda.
3. Lipatan "Lanjutan (operator)", tertutup: daftar kunci yang ada sekarang (kartu, `requires`, `envShadowed`, impor `.env`) dipertahankan utuh, dengan pencarian. `requires` tetap hidup HANYA di sini (jebakan nyata bagi operator yang memakai .env).

Dihapus / dipensiunkan: judul "Environment" untuk pengguna biasa; badge "Belum berpengaruh" dan teks "Dikunci" di jalur kemampuan; 11 dari 18 kartu `audience:'user'` pindah ke `advanced` atau menjadi implied. Tidak ada mockup kosmetik; semua usul di atas punya titik kode (Bagian E).

Keberatan terhadap kemampuan sebagai view: dua tempat mengubah kunci yang sama (kartu dan lipatan). Aman karena keduanya memanggil PUT yang sama dan kartu menurunkan status dari nilai efektif tiap render (`flagIsOn`, `evalRequires` di `envSettings.contract.ts`) [V].

## D. Migrasi

Temuan inti: karena kemampuan adalah view dan tidak ada kunci yang dihapus atau diganti nama, TIDAK ADA nilai tersimpan yang perlu ditulis ulang. Migrasi data = nol baris. Itu disengaja; setiap migrasi tulis-ulang menambah risiko "pengguna lama berubah".

| Lapisan | Perilaku |
|---|---|
| SQLite `envSettings.store` (satu baris JSON `env_overrides` di tabel `app`, `envSettings.store.ts`) | Tidak disentuh. Kunci tersimpan tetap dibaca lewat registry; kunci tak dikenal tetap di `unknownKept` (`store.ts:45,76`) |
| `.env` / `process.env` | Presedensi stored > env > default tak berubah (L2). Kartu menandai "diatur dari .env" dan `envShadowed` |
| Impor `.env` (`envSettings.import.ts`) | Tak berubah; kunci sama |
| Alias / `RETIRED_KEYS` (`store.ts:33-36`, `invariants.test.ts:39`) | Dipakai hanya bila kelak kunci dipensiunkan; belum perlu sekarang |
| Pengguna dengan rantai putus (mis. `TELEGRAM=on`, `LEDGER=off`) | TIDAK diubah diam-diam. Kartu menampilkan "Butuh Ledger [Perbaiki]" satu klik (menulis `LEDGER=shadow`). Alasan: menyalakan bot yang tadinya inert tanpa sepengetahuan pengguna adalah perubahan perilaku |

Sengaja TIDAK membalik default global (`LEDGER` off->shadow, `RUN_REQUIRE_APPROVAL` off->on): store kosong = kontrak "pengguna lama tidak berubah" bisa dibuktikan identik. Persetujuan menulis nilai eksplisit (`RUN_REQUIRE_APPROVAL=on`) hanya untuk aktivasi baru. Catatan keamanan: default `RUN_REQUIRE_APPROVAL=off` (`platform.ts:23-26`, `flag()` default 'off', `types.ts:48`) berarti run tanpa approval bagi yang sudah `RUN=on`; ini diwariskan, bukan diperburuk, dan diangkat sebagai pertanyaan.

Idempotensi: tak ada langkah tulis yang perlu penanda versi. Bila suatu hari default dibalik, gunakan penanda `app.env_schema_version` dan langkah bersyarat "tulis hanya bila kunci absen di store DAN env" (aman diulang). Tidak perlu migrasi skema DB (Rule 4 tidak terpicu).

Apakah ada yang kehilangan fungsi? Tidak, selama (a) tidak ada kunci dihapus dari registry, (b) `audience` hanya mengubah tampilan [V `state.ts:81`], (c) hot-start tidak mengubah default. Risiko nyata: pengguna yang mengandalkan "restart = reset" untuk Telegram/browser; hot-start menghapus jeda itu [A].

Strategi tes "pengguna lama tidak berubah" (vitest node, fungsi murni, tanpa `bun:sqlite`):
- Fixture store: kosong; `RUN=on` tanpa approval; `TELEGRAM=on` tanpa ledger; `BROWSER=on` + `BROWSER_BIN`; semua-off; override + env bentrok.
- Untuk tiap fixture, hitung env efektif lewat resolver yang ada sebelum dan sesudah perubahan kode, lalu `expect(sesudah).toEqual(sebelum)` untuk SEMUA kunci registry.
- Tes kemampuan: `set(cap,on)` lalu `evalRequires` tak mengembalikan satu pun entri "unmet" untuk kunci milik kemampuan (properti: tak ada keadaan tidak berpengaruh).
- Tes konsistensi katalog: tiap kunci di `keys/implies` ada di registry; tak ada siklus; ditambahkan ke `envRegistry.invariants.test.ts` (213 baris, batas test 400).

Berkas dokumen: `.env.example` TIDAK berubah (L1: tepat 9 kunci; tes menjaganya). README: perbarui bagian kontrak env saja (baris 26-68, 82-86, 132 menyebut flag; ganti rujukan "Settings > Environment" menjadi "Settings > Kemampuan"); narasi milik user diflag, bukan ditulis ulang (Rule 16, L15). CHANGELOG `[Unreleased]` entri Added/Changed. `docs/decisions/env-minimal.md` ditambah satu bagian pendek "Addendum: Kemampuan" atau berkas baru `env-capabilities.md`. Tes paritas registry (`envRegistry.test.ts`, `.invariants.test.ts`, `.defaults.test.ts`): tidak berubah selama kunci tak berubah; jika `audience` digeser, periksa asersi jumlah/label user (<=40/<=160 karakter) [A: ada asersi per-entri user].

## E. Ukuran, gelombang, kepemilikan berkas

Estimasi [A, dari ukuran berkas yang dibaca]: ~1.300-1.500 baris kode+tes, ~25 berkas (13 baru). Berkas melewati batas Rule 8 setelah disentuh: TIDAK ADA yang melewati 500 baris. Berkas yang mendekati/menyalahi batas tipe dan harus dijaga:

| Berkas | Baris | Batas | Tindakan |
|---|---|---|---|
| `src/client/Dock.tsx` | 399 | (komponen, hard 500) | hanya 1-2 baris; logika baru di berkas baru |
| `src/server/api.ts` | 202 | route 150 (sudah lewat) | JANGAN tambah; rute baru di `envCapabilities.api.ts` seperti `tokenAccess.api.ts`, pasang di `mount.ts` (hak U5) |
| `src/server/index.ts` | 259 | n/a entry | worker W1a pemilik tunggal; tambahan <=15 baris |
| `src/server/channelsRuntime.ts` | 256 | service 300 | W1b; tambah <=40 |
| `src/client/SettingsPanel.tsx` | 278 | n/a | tab baru dirender komponen anak; tambah <=10 |
| `SettingsPanel.test.tsx` | 310 | test 400 | tes baru di berkas baru |
| `envRegistry.test.ts` / `.invariants.test.ts` | 232 / 213 | test 400 | invarian katalog di berkas baru `envCapabilities.test.ts` |

Gelombang (kepemilikan berkas tak tumpang tindih; worker dilarang commit/push):

| Gelombang | Isi | Berkas milik | Paralel dengan |
|---|---|---|---|
| W0 kontrak | `envCapabilities.contract.ts` + `.data.ts` (tujuh kartu), `envCapabilities.service.ts` (turunkan status; terapkan = panggil PUT batch), `envCapabilities.api.ts` (GET `/api/settings/capabilities`, POST `/:id`), 1 baris `mount.ts`, tes properti + "pengguna lama" | semua baru + `mount.ts` | W1a/W1b (API disepakati di spek) |
| W1a browser | status selalu menjawab; runtime malas; rute WS selalu terdaftar | `index.ts`, `browser/browser.runtime.ts`, `browserApi.ts`, tes bun | W0, W1b, W2 |
| W1b telegram | `ensureTelegramInbound()` hot + hook apply; `getMe` (C1) | `telegramPollWiring.ts`, `channelsRuntime.ts`, `envSettings.runtime.ts` | W0, W1a, W2 |
| W2 klien | `CapabilitiesPanel.tsx`, `ConsentDialog.tsx`, kartu Akses (token), lipatan Lanjutan, `envLabels.ts`, `browser.status.ts`, `browser.feature.ts`, `useBrowserAdd.ts`, `canvasMenu.model.ts`, `canvasMenu.pane.tsx`, `SettingsPanel.tsx` | seluruh `src/client` terkait | W1 (setelah kontrak W0 beku) |
| W3 registri | geser `audience` 11 kunci (`envRegistry.platform/ca2/central/channels.ts`, `browser/browser.envRegistry.ts`) + penyesuaian tes paritas | berkas registry + tes registry | setelah W0 |
| W4 dokumen | README (terbatas), CHANGELOG, addendum decisions | sekali, satu worker, di akhir | sendirian |

Urutan: W0 -> (W1a, W1b, W2 paralel; W2 bergantung kontrak W0) -> W3 -> W4. Verifikasi tiap gelombang: `TMPDIR=/tmp/st npm run typecheck`, `npm test`, `bun test src/server/*.bun.test.ts`.

## REKOMENDASI TEGAS

1. Kemampuan sebagai view (katalog + `implies`), tanpa penyimpanan baru. Kenapa: menghapus keadaan "tidak berpengaruh" tanpa menyentuh data. Risiko: dua UI untuk kunci sama (diredam dengan status turunan). Ukuran M.
2. Jangan balik default global; persetujuan menulis nilai eksplisit. Kenapa: "pengguna lama tidak berubah" bisa dibuktikan dengan tes. Risiko: default `RUN_REQUIRE_APPROVAL` off diwariskan. Ukuran S.
3. Persetujuan satu klik yang membundel token (enable -> `storeToken` -> PUT). Kenapa: memutus jalan buntu `noRootGate`. Risiko: token hanya speed bump (`env-minimal.md:42`); copywriting jujur. Ukuran M.
4. Browser: status selalu dijawab, menu selalu tampil, runtime dan rute WS malas. Kenapa: hapus restart + menu hilang + 404 senyap. Risiko: lapisan WS dan proses Chromium harus tidak bocor saat off (`index.ts:188`). Ukuran M.
5. Telegram hot-start + tes koneksi `getMe`. Kenapa: memperbaiki T3 (klaim hot palsu). Risiko: dua pemanggil start (boot dan hook) -> wajib idempoten. Ukuran M.
6. Deteksi Chromium sebelum aktivasi dan aksi "Pilih lokasi". Kenapa: pesan `browser.status.ts:12` menyuruh edit env. Risiko: rendah. Ukuran S.
7. Turunkan 11 kunci `audience` user ke advanced, pertahankan `requires` hanya di lipatan operator. Kenapa: permukaan 18 -> 7. Risiko: tes label/count; tidak ada efek fungsi (`state.ts:81`). Ukuran S.
8. Jangan hapus kunci apa pun pada program ini; pensiun lewat `RETIRED_KEYS` kelak. Kenapa: nol kehilangan fungsi. Risiko: registry tetap 62 entri (Rule 8: berkas data sudah dekat 100 baris). Ukuran S.

## PERTANYAAN UNTUK USER

1. Buka kembali G1 (L14): izinkan persetujuan `dangerous` di loopback TANPA token (Opsi R), dengan cek Origin/Host + dialog, mengingat token tak melindungi dari proses uid sama? Saran default: TIDAK, tetap Opsi P yang sudah disetujui, token dibundel otomatis di dialog.
2. Kemampuan #1: saat diaktifkan, sub-switch "minta persetujuan tiap run" nilai awalnya ON? Saran default: ON (pengguna boleh matikan di dialog).
3. Ganti nama tab "Environment" menjadi "Kemampuan" dan pindahkan flag list ke lipatan "Lanjutan (operator)" tertutup? Saran default: ya.
4. Hot-start Telegram dan Browser (tanpa restart) diterima sebagai ganti tombol restart yang ditunda (L15)? Saran default: ya; tombol restart tetap ditunda.
