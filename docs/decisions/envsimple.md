# ENVSIMPLE: pengaturan tanpa kebingungan (D1-D9, KE-1..KE-10)

Sumber lengkap: `PLAN/ENVSIMPLE-a.md` (keputusan, risiko, konflik), `-b.md` (kontrak API, hot-apply, audit), `-c.md` dan `-c2.md` (spek per workstream ES-00..ES-15). Dokumen ini merangkum keputusan akhir dan alasannya; lanjutan dari `docs/decisions/env-minimal.md` (yang memuat bootstrap, token, dialek flag). Pengguna = satu orang, satu mesin.

## Inti

Settings tidak lagi menampilkan kunci env. Ada tujuh kemampuan, masing-masing satu sakelar on/off yang berlaku langsung tanpa restart. Kemampuan adalah VIEW atas kunci di store override yang sudah ada: menyalakannya menulis kunci primer dan kunci turunan lewat `envSettings.update`, tanpa tabel penyimpanan baru. Satu fungsi `isEnabled(id)` (`src/server/featureCapabilities.runtime.ts`) adalah satu-satunya pembaca runtime kunci katalog; tes pagar grep (`featureCapabilities.grep.test.ts`, allowlist kosong) menggagalkan pembaca mentah di tempat lain.

## Keputusan terkunci (D1-D9)

| ID | Keputusan | Alasan |
|----|-----------|--------|
| D1 | Model kemampuan dengan `implies`, `isEnabled` tunggal, pagar grep, tes properti eksaustif (128 subset, 0 yang inkoheren). `evalRequires`, `EnvRequiresNote`, dan badge "Belum berpengaruh" dibuang dari client. Field `requires` di registry tetap (KE-7). | "Belum berpengaruh" hanya nasihat client dari `requires` yang tak pernah ditegakkan server; 99,82% kombinasi flag lama inkoheren. |
| D2 | Tanpa penyimpanan baru. Kunci env lama = input legacy; anak/sub-opsi tanpa induk aktif diabaikan, satu `warn` per kunci per proses (nama kunci saja, bukan nilai). | Pengguna lama tidak kehilangan konfigurasi dan tidak ada migrasi data. |
| D3-REV | Tidak ada "berbahaya", "Dikunci", token root, atau dialog bertingkat di permukaan. Satu sakelar, langsung. Keamanan pindah ke penjaga server tak terlihat (bagian berikut). Non-loopback tetap wajib token (bootstrap env, bukan Settings). | Atas perintah user (G1/Opsi R dibuka ulang): gesekan di UI tidak melindungi dari proses sesama user, penjaga server yang melakukannya. |
| D4-REV | Tidak ada "Perlu restart" di permukaan, tanpa pengecualian. Tiap kunci yang tampil wajib hot. Boot-only (`HOST`, `PORT`, `WEBTERM_DATA_DIR`, token) keluar dari Settings. Browser, autonomy, CA2, Telegram dibuat hot-wire lewat `onCapabilityChange` (start/stop idempoten). | Pengguna tidak boleh diminta memahami kapan sebuah saklar "benar-benar" berlaku. |
| D5 | Deteksi dan turunan: runtime Central (claude, opencode, mock), `CHANNELS`/`CENTRAL_TELEGRAM`/`CENTRAL_CHAT` diturunkan (`TELEGRAM` adalah kunci primer kemampuan), webhook secret dibangkitkan otomatis, Chromium dideteksi. Satu dialek flag di `envFlag.ts`. `RETIRED_KEYS` ditunda. Tidak ada kunci yang dihapus. | Mengurangi keputusan yang dipaksakan ke pengguna tanpa memutus env lama. |
| D6 | Tab Environment diganti "Kemampuan"; tab Channels hilang. Teks UI Indonesia. | UI generik 62 kartu tidak lagi punya fungsi. |
| D7 | Tidak ada secret ke DOM, log, respons, atau audit. `NODETERM_NODE_ID`, `NODETERM_PORT`, header `x-nodeterm-node-token`, event `nodeterm:` tidak diubah. | Identitas protokol demi kompatibilitas upstream. |
| D8 | Delapan elemen lama tidak ada di UI mana pun: chip filter; banner dan lencana restart; Default/Aktif sekarang/Tersimpan + Atur ulang per kunci; nama env var; Ledger Aktif/Bayangan; "Mesin agen" saat Central mati; kelompok berisi satu kartu; tautan "ada di tab Channels". Sub-opsi hanya di kartu induk saat induk aktif. Central chat bukan pengaturan. | Elemen itu mengekspos mekanisme, bukan kemampuan. |
| D9 | Tidak ada "operator". Daftar flag Lanjutan dihapus; kunci tuning tidak tampil. Bagian tertutup "Lanjutan" maksimal 4 butir (mesin agen, lokasi Chromium, folder data baca-saja, setel ulang). Telegram = tempel token, selesai. Kemampuan yang belum nyala ditawarkan saat dibutuhkan. | Satu pengguna lokal; kunci tuning tetap dibaca, hanya tidak tampil. |

## Tujuh kemampuan

Katalog di `src/shared/featureCapabilities.ts`. `implies` = prasyarat: menyalakan kemampuan ikut menyalakan seluruh `implies`-nya (`closure`), mematikan prasyarat ikut mematikan pemakainya (`dependents`); kartu menyebut ini ("Ikut menyalakan" / "Ikut mati").

| Id | Judul UI | Kunci primer | implies | Catatan |
|----|----------|--------------|---------|---------|
| `central` | Agent Pusat | `WEBTERM_CENTRAL` | - | Menurunkan `CENTRAL_CHAT`, `CENTRAL_MEMORY`, `CENTRAL_READ_TOOLS`. |
| `workers` | Worker orchestrator | `WEBTERM_ORCHESTRATOR_RUN` | `central` | Sub-opsi `WEBTERM_RUN_REQUIRE_APPROVAL`, default ON (Q3). |
| `autonomy` | Otonomi Agent Pusat | `WEBTERM_CENTRAL_AUTONOMY` | `workers` | Scheduler start/stop idempoten; stop tidak membunuh worker yang berjalan (KE-5). |
| `browser` | Browser di kanvas | `WEBTERM_BROWSER` | - | Butuh Chromium (`needs: chromium`); `activeBrowser()` lazy. |
| `files` | Kelola file | `WEBTERM_FILES_VIEWERS` | - | Menurunkan `FILES_WATCH`, `FILES_GIT_STATUS`, `FILES_QUICK_OPEN`. |
| `filesWrite` | Ubah dan unggah file | `WEBTERM_FILES_MUTATE` | `files` | Menurunkan `FILES_UPLOAD`: unggah butuh `filesWrite`. |
| `telegram` | Telegram | `WEBTERM_TELEGRAM` | - | Butuh token bot (`needs: telegramToken`); menurunkan `CHANNELS`, dan `CENTRAL_TELEGRAM` bila `central` juga on. |

Sembilan kunci turunan (`DERIVED_FLAGS`): `CENTRAL_CHAT`, `CENTRAL_MEMORY`, `CENTRAL_READ_TOOLS`, `CHANNELS`, `CENTRAL_TELEGRAM`, `FILES_WATCH`, `FILES_GIT_STATUS`, `FILES_QUICK_OPEN`, `FILES_UPLOAD`. Mereka on bila semua kemampuan `needs`-nya on; ditulis `deriveFlags`, tidak tampil di UI. Mematikan menulis `off` eksplisit (bukan menghapus kunci), supaya nilai env lama tidak menyala kembali.

Hot-apply: `reconcile(prev, next)` memanggil hook `onCapabilityChange` secara idempoten; mutasi diserialkan lewat antrean `exclusive` agar dua POST bersamaan tak menyisipkan reconcile satu sama lain. Boot memanggil `reconcile` sekali lagi di akhir `index.ts`.

Env lama: `legacyToCapabilities(env)` memetakan kunci primer lama (`WEBTERM_CENTRAL=on`, dst.) ke himpunan kemampuan. Kunci primer on tanpa prasyaratnya, serta anak/sub on tanpa induk aktif, masuk `ignored` dengan satu warn per kunci per proses. `WEBTERM_LEDGER` sengaja tidak dibaca. Kunci turunan (mis. `WEBTERM_CHANNELS`) tidak pernah dibaca sebagai saklar: runtime kanal mengikuti `isEnabled('telegram')` (`channelsMasterGate.ts`), dan kunci turunan yang on tanpa kemampuan induknya diabaikan dengan warn.

API: `GET /api/capabilities`, `POST /api/capabilities/:id` (`{enabled}`), `POST /api/capabilities/:id/sub`, `GET|PUT /api/capabilities/advanced`, `POST /api/capabilities/reset`, `POST /api/capabilities/telegram/connect`.

## Penjaga tak terlihat dan batas jujurnya

`settingsGuard(req)` melindungi mutasi `PUT /api/settings/env`, `POST /api/settings/env/import`, dan semua `POST|PUT /api/capabilities*`; `GET` tidak. Lolos bila:

- (A) token root valid lewat `x-webterm-token` (token node/capability ditolak), atau
- (B) tidak ada token yang ditegakkan DAN peer socket loopback DAN tanpa header `Forwarded`/`X-Forwarded-*` DAN `Host` lolos allowlist DAN header `Origin` ADA dan sama-origin.

Selain itu: 403 `{error:'forbidden'}` dan satu baris di tabel `capability_audit` dengan alasan generik (`forwarded|origin|token_kind|peer|host`), tanpa isi header, tanpa nilai. Tabel dibatasi 1000 baris (terlama dihapus), dibuat idempoten oleh `ensureAuditSchema` dari `openDb` (KE-2). Sengaja lebih ketat dari `sameOrigin` biasa, yang mengizinkan Origin absen: browser selalu mengirim Origin pada POST/PUT.

Batas jujur (a §7), jangan dikesankan lebih:

- Loopback tanpa token tidak lagi dibendung oleh persetujuan manual. Proses sesama user (termasuk shell PTY dan agent) dapat menyalakan Worker/Otonomi lewat API. Ini sebelumnya juga mungkin (`token/enable` lalu `PUT`), jadi bukan kemampuan teknis baru, tetapi gesekan satu langkah hilang.
- Penjaga TIDAK menghentikan `curl` dari proses sesama user yang menambahkan header `Origin` palsu. Itu batas yang diterima user.
- Pengganti yang nyata: pemeriksaan peer/Host/Origin/forwarded, penolakan token node dan capability, tes bahwa tool Central tak bisa memanggil rute settings, audit tiap grant/revoke, dan token wajib untuk akses non-loopback.
- Mencabut kemampuan menghentikan pemicu BARU, bukan worker/PTY yang sedang berjalan (KE-5).
- Jawaban 403 hanya `{error:'forbidden'}`; ia belum menyebut bahwa skrip bisa memakai token (lihat Hutang).

## Konflik yang ditemukan dan resolusinya (KE-1..KE-10)

| ID | Konflik | Resolusi |
|----|---------|----------|
| KE-1 | Ledger selalu hidup bertabrakan dengan "store kosong": `ledgerMode` default off. | `ledgerMode` default `on`, tanpa saklar; `WEBTERM_LEDGER` diabaikan, `WEBTERM_LEDGER_SHADOW=1` = shadow (gagal buka tidak menjatuhkan server). Satu file SQLite kecil di data dir. Perubahan terlihat pengguna, dicatat di changelog. |
| KE-2 | `db.ts` tak punya direktori migration. | Mengikuti pola yang ada: `CREATE TABLE IF NOT EXISTS` inline lewat `ensureAuditSchema(db)`, idempoten, dipanggil dari `openDb`. |
| KE-3 | `ledgerMode`, `runtimeFlag.ts`, `reliabilityEnabled` memakai dialek berbeda dari `parseFlag`. | Dialek kanonik di `envFlag.ts` (`on|1|true`, `off|0|false`); tiga kunci keamanan tetap persis `1` (`strictFlag`). `X=1` yang dulu senyap off kini on; dicatat di changelog. |
| KE-4 | Rute WS browser bergantung `browserRuntime` yang bersyarat. | Rute selalu terdaftar; handler memakai `activeBrowser()`; status off dijawab `off` sehingga menu kanvas bisa menawarkan kemampuan. |
| KE-5 | Mencabut kemampuan vs worker/PTY berjalan. | Tidak membunuh yang berjalan; "Hentikan semua" ditunda. Stop browser menunggu operasi aktif dengan batas `BROWSER_STOP_TIMEOUT_MS` = 5000. |
| KE-6 | Nomor baris di RND basi (`centralAutonomyBoot.ts`, `Dock.tsx`). | Spek memakai nomor hasil baca kode; tidak ada keputusan produk. |
| KE-7 | Tes registry masih memakai `requires`. | Hanya pemakaian client yang dihapus; penghapusan field ditunda. |
| KE-8 | Mutasi tanpa token dan tanpa `Origin` (skrip curl) kini 403. | Diterima: pengguna skrip memakai `WEBTERM_TOKEN`. Dicatat di changelog. |
| KE-9 | Tidak ada kode pendeteksi URL publik untuk webhook otomatis. | Poll selalu bila token ada; webhook hanya bila `WEBTERM_TELEGRAM_MODE=webhook` eksplisit (secret dibangkitkan otomatis ke `secrets/`). |
| KE-10 | Tautan chat satu ketukan butuh `projectId` dan `role`. | Chat privat = `owner`, grup = `viewer`; `projectId` dibawa kartu dari pemanggil `CapabilitiesSection`, tanpa kolom di UI. |

Q1-Q3 (default dipakai): audit lewat `ensureAuditSchema`; entri changelog ditaruh di `docs/changelog/envsimple.md` dengan 3 baris tautan di `CHANGELOG.md` (berkasnya melewati batas Rule 8); `WEBTERM_RUN_REQUIRE_APPROVAL` default ON saat Worker dinyalakan.

## Telegram: tempel token

`POST /api/capabilities/telegram/connect`: periksa bentuk token, panggil `getMe` lewat egress yang ada, 401/404 = `token_rejected`, jaringan = `unreachable`. Hanya bila sukses token disimpan ke secret store dan `telegram` dinyalakan. Mode, webhook secret, penghitung, role, dan Project ID tidak tampil. Env lama `WEBTERM_TELEGRAM_BOT_TOKEN` (dan alias `TELEGRAM_BOT_TOKEN` yang deprecated) tetap dibaca sebagai override.

## Mengapa CHENV dibatalkan

Seri CHENV (UI untuk token/env generik, `PLAN/CHENV-*`) tidak dijalankan. Alasan di `PLAN/ENVSIMPLE-a.md` bagian 4: D9 mengganti alur Telegram dan menghapus UI env generik, sehingga CH-xx tak lagi punya sasaran (CH-00 "pecah SettingsPanel" digantikan ES-12 karena tab Environment/Channels dihapus). Basis `chore/chenv-int` memang tidak ada, jadi tidak ada tabrakan berkas. Akibatnya UI untuk mengaktifkan token root lewat Settings (U1 di `env-minimal.md`) tetap tidak ada; token dipakai lewat env dan API.

## Ditunda / Hutang

Ditunda dengan sengaja (b §11):

- `RETIRED_KEYS`: tidak dibutuhkan pengguna; risiko rollback.
- Konstanta-isasi kunci tuning: tidak ada kunci dihapus (D7).
- Tombol "Mulai ulang": tidak ada kunci yang butuh restart di permukaan.
- UI impor `.env`: alur panjang; API tetap ada.
- "Hentikan semua yang berjalan" saat mencabut (KE-5).
- Tawaran kontekstual Worker pada tombol Run, dan penghapusan field `requires`/`dangerous` dari registry.
- Tawaran kontekstual Central dari Dock (yang terpasang baru tawaran Browser di menu kanvas).

Hutang teknis yang diketahui:

- (a) `derivedFlagKey()` di `src/server/central/tools/defs/read.shared.ts` mengambil nama kunci turunan dari katalog agar `toolExec`/`toolRegistry` masih bisa mencocokkan `def.flag`. Pembersihan sebenarnya: petakan `def.flag` ke kemampuan lewat `isEnabled`. Terkait: kunci turunan hanya ditulis oleh sakelar kartu (`deriveFlags`). Pengguna yang hanya mengatur `WEBTERM_CENTRAL=on` lewat env tanpa menyentuh kartu dapat mendapat Central tanpa read tools/memory, karena `def.flag` tetap off. Belum direproduksi di runtime; temuan dari pembacaan kode.
- (b) Tipe `needs_root` di `src/shared/envSettings.import.contract.ts` (`ImportSkipReason`) mati: konsep kunci `dangerous`/root gate dibuang dari permukaan.
- (c) Tombol langkah Chromium (`needs-step`) di menu kanvas belum punya aksi: `CapabilityOffer` menerima `onStep`, tetapi `canvasMenu.pane.tsx` tidak memasangnya.
- (d) Tawaran kontekstual Central dari Dock ditunda (lihat di atas).
- (e) `hooks.test.ts` flaky dengan timeout 5 detik pada run vitest paralel penuh; lulus bila dijalankan sendiri. Dilaporkan orkestrator; tidak direproduksi oleh penulis dokumen ini.
- (f) Default berkas tidak konsisten: API melayani viewer berkas default on lewat `filesFlagOn` (L11), sementara kartu "Kelola file" membaca `isEnabled('files')` mentah dan tampil mati sampai dinyalakan.
- (g) `.env.example` dan beberapa komentar kode (`centralChatApi.ts`, `Dock.tsx`) masih menyebut "Settings > Environment".
- (h) Pesan 403 tidak menyebut cara memakai token untuk skrip (R-E2 menjanjikannya di mitigasi).
- (i) Interaksi proxy dev Vite dengan syarat `Origin` (KE-8) tidak pernah diverifikasi.
