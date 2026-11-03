# 40 — Audit UI/UX Settings > Environment (bagian a)

Bagian b (`40-ENV-UIUX-AUDIT-b.md`): §7-§12 (dependensi, error/pencarian, a11y/bahasa, Channels, tabel celah, implikasi).

Topik 2 R&D Environment (`wkr-env-rnd-02-ux`). Cakupan: klien (`src/client/Env*`, `Settings*`, CSS) + bentuk data server yang menentukan UI. Inventaris per-entri ada di `39-ENV-REGISTRY-AUDIT.md`; benchmark dan model data di `41`. Dokumen ini hanya UI/UX. Tanpa kode produksi. Kutipan `file:baris` dari worktree `rnd-env` (branch dari `main`). Label: `[BT]` = belum terverifikasi, `[opini]` = penilaian.

Keparahan: **P0** = menyesatkan atau bisa memicu aksi salah. **P1** = membingungkan atau merusak alur. **P2** = polish.

## 1. Ringkasan

Environment dibangun sebagai daftar form generik dari registry (27 entri + 10 baris bootstrap sekarang; branch `ca2-int` menambah 17 entri `central`, jadi 44 + 10). Halaman ini tidak mengikuti pola tab Settings lain: tab lain autosave lewat `onChange`, punya penanda "Modified" + gear Reset, dan ikut pencarian (`SettingsFields.tsx:90,103-113`). Environment memakai Simpan per baris, badge sendiri, dan tidak ikut pencarian. Akar kekacauan yang terlihat user:

1. Tiap baris memuat 4-6 baris teks meta (breadcrumb, deskripsi, KEY, Default, bantuan Reset, badge) di atas satu kontrol.
2. Halaman mencampur tiga hal: saklar fitur, konfigurasi nilai, dan info infrastruktur read-only.
3. Hubungan antar-flag (Telegram butuh Ledger) hanya berupa teks, bukan peringatan yang hidup.
4. Tidak ada hierarki prioritas: semua entri setara (tidak ada "lanjutan", tidak ada kolaps).

## 2. Struktur dan hierarki

| # | Temuan | Bukti | Sev |
|---|---|---|---|
| S1 | Breadcrumb `Webterm › Grup: Label` diulang di tiap baris padahal judul grup (h3) sudah tepat di atasnya. Label sering identik dengan grup: "Ledger: Ledger", "Telegram: Telegram", "Central: Central". Tab lain memakai `Kategori: Nama` (kategori = nama tab, satu level). | `EnvEntryRow.tsx:47`, `EnvSection.tsx:34`, `envLabels.ts:4`, `envRegistry.channels.ts:11,18`, `envRegistry.central.ts:7`, `SettingsFields.tsx:100` | P1 |
| S2 | Tombol "Segarkan" sendirian di baris toolbar `justify-content:flex-end`, di dalam kolom 900px, jauh dari judul. Judul sticky 35px dan toolbar adalah baris terpisah yang ikut scroll. Pola ini disalin dari Channels. Segarkan tidak mengubah `loading`, jadi tak ada umpan balik. | `EnvSection.tsx:50-54`, `settings-channels.css:8-12`, `settings.css:277-294`, `useEnvSettings.ts:31-42,67` | P2 |
| S3 | `EnvSection` memakai kelas `st-ch-toolbar/heading/list` yang didefinisikan di `settings-channels.css`, tetapi hanya mengimpor `settings-env.css`. Jalan karena Channels ikut di-bundle di `SettingsPanel`; rusak kalau salah satu dilepas. | `EnvSection.tsx:10,50,63-64`, `settings-env.css:1-2` | P2 |
| S4 | Judul "Environment" adalah istilah developer (env var). User ingin tahu "fitur apa yang bisa kunyalakan". 10 baris Bootstrap (HOST, PORT, WEBTERM_TOKEN, ...) ditampilkan sebagai "setting" tanpa nilai dan tanpa aksi; hanya berguna bagi operator. | `SettingsPanel.tsx:43`, `EnvSection.tsx:30-40`, `envRegistry.ts:17-28` | P0 |
| S5 | IA grup tak masuk akal: Kanal (saklar utama channel) tampil SETELAH Telegram (anaknya); log level/buffer/file masuk grup "Kontrol" bersama cwd roots dan trust proxy; satu grup `central` bisa memuat 28 entri di `ca2-int`. Urutan grup di-hardcode, tipe `EnvGroup` tertutup. | `envLabels.ts:39`, `envRegistry.platform.ts:21-44`, `envRegistry.types.ts:5` | P1 |
| S6 | Tidak ada kolaps, "lanjutan", atau lompat-ke-grup. Estimasi tinggi: baris ~120-130 px (padding 12px + judul 22 + deskripsi 18-36 + KEY 18 + kontrol 30 + Default 18 `[BT]` tak diukur di browser) kali 54 baris di `ca2-int` kira-kira 6.500-7.000 px dalam satu scroll. | `settings.css:14,340-347`, `EnvEntryRow.tsx:46-79` | P1 |

Tab Channels dan Environment tumpang-tindih (lihat K3 di §10); kedua halaman sama-sama membahas Telegram.

## 3. Pola simpan dan indikator status

| # | Temuan | Bukti | Sev |
|---|---|---|---|
| V1 | Simpan per baris (tombol di tiap baris). Tab lain autosave. Server sebenarnya mendukung PUT atomik multi-kunci (`validate()` mengecek semua kunci sebelum menulis), tetapi UI selalu mengirim satu kunci. | `EnvEntryRow.tsx:58-61`, `EnvSection.tsx:46-47`, `envSettings.service.ts:150-167` | P1 |
| V2 | Draft hidup di `useState` lokal tiap baris. Hilang tanpa peringatan saat pindah tab Settings, saat mengetik di pencarian (EnvSection di-unmount), atau menutup dialog. Segarkan mengganti `state` tanpa membuang draft, sehingga tampilan campur data baru dan draft lama. | `EnvEntryRow.tsx:36`, `EnvSection.tsx:15`, `useEnvSettings.ts:35` | P1 |
| V3 | "Belum disimpan" hanya terbaca dari tombol Simpan yang aktif; tak ada penanda di baris, header, atau sidebar. Tak ada "Buang perubahan". | `EnvEntryRow.tsx:40,59` | P1 |
| V4 | Setelah Simpan sukses, `draft` menjadi null, `dirty` false, tombol yang baru diklik menjadi `disabled` sambil memegang fokus. Browser menjatuhkan fokus ke body: pengguna keyboard/pembaca layar kehilangan posisi. Selama satu PUT berjalan, SEMUA baris `disabled` (flag `busy` global). | `EnvEntryRow.tsx:37,41-43,59`, `useEnvSettings.ts:51,63` | P1 |
| V5 | Banner restart: daftar KEY mentah digabung koma (bisa 20 kunci), tanpa label manusiawi, tanpa tombol aksi (server tak punya endpoint restart; hanya handler sinyal di `index.ts:202`), akumulasi di state hook sehingga hilang saat unmount/reload walau tiap baris masih membawa `pendingRestart` dari server. Banner tidak sticky, tergulung ke luar layar. | `EnvSection.tsx:58-60`, `useEnvSettings.ts:28,57`, `envSettings.service.ts:130` | P1 |
| V6 | Tombol Reset dihitung hanya bila `source==='override'`, dan setelah klik `setDraft(null)` jalan walau `onUnset` gagal. Bantuan "Reset mengembalikan ke nilai env atau default." diulang di tiap baris override. | `EnvEntryRow.tsx:62-67,74`, `envLabels.ts:14` | P2 |

## 4. Badge dan arti status

Badge dirender oleh `Tags` (`EnvEntryRow.tsx:18-31`): sumber (`override|env|default`), `restart`, `menunggu restart`, `berbahaya`. Semua `<span>` polos tanpa `title`, tanpa penjelasan di halaman.

| # | Temuan | Sev |
|---|---|---|
| B1 | Badge sumber tampil di SETIAP baris. `default` = keadaan normal, tidak perlu diberi tanda (VS Code hanya menandai yang Modified). `env` artinya "nilai datang dari proses/.env" — jargon, dan user tak bisa mengubah asalnya. `override` artinya "diubah dari halaman ini" — kata yang tidak dipakai di tab lain ("Modified"). | P1 |
| B2 | `restart` menempel pada 20 dari 27 entri sekarang (hanya 7 `hot`: `grep "hot: true" envRegistry.*.ts`), dan pada 17 dari 17 entri CA2 (`hot` = 0). Default registry "aman = butuh restart" (`envRegistry.types.ts:24`) membuat badge tidak informatif: semua baris punya. Yang berguna bagi user adalah kebalikannya ("berlaku langsung") atau status pending saja. | P1 |
| B3 | Dua istilah untuk satu hal: `restart` (kebutuhan) vs `menunggu restart` (sudah berubah). Tidak ada kalimat yang menyatakan nilai AKTIF saat ini vs nilai TERSIMPAN. | P1 |
| B4 | Penanda "terubah" (bar kiri `is-modified` + tag) memakai `source==='override'`, bukan `nilai != default`. Menyimpan nilai sama dengan default menandai baris "diubah". | P2 |
| B5 | `berbahaya` hanya berupa tag; tak ada penjelasan akibatnya (mis. otonomi central MENJALANKAN WORKER NYATA hanya ada di deskripsi). | P2 |

## 5. Kontrol per tipe

| Tipe | Perilaku sekarang | Celah | Sev |
|---|---|---|---|
| flag | Checkbox (`EnvValueControl.tsx:21`), benar. Diletakkan DI BAWAH deskripsi dengan baris KEY, bukan `st-checkline` seperti `ToggleField` (`SettingsFields.tsx:256`). Label `<strong>` bukan `<label>`: klik label tidak mengubah kontrol. Checked = `value === 'on'` (persis). | Server memakai `flagOn` yang case-insensitive + trim (`envFlag.ts:5`), sedangkan nilai dari `.env` dikirim apa adanya (`envSettings.service.ts:134`). `WEBTERM_X=ON` aktif di server tetapi tampil TIDAK tercentang. Nilai nonkanonik lain ("true", "1") tampil off dan memang off, tapi tak ada tanda nilai tidak sah. | **P0** |
| enum | `<select>` native (`EnvValueControl.tsx:27`). Opsi = string mentah. | Tanpa deskripsi per opsi: `shadow` pada Ledger tak dijelaskan (`envRegistry.channels.ts:10`). `WEBTERM_CHANNELS` enum `on/off` tampil sebagai dropdown on/off (`:14`) — itu boolean, bukan enum; ini yang user lihat di screenshot (Ledger `on`). Nilai `.env` di luar opsi: `<select>` tak punya `<option>` yang cocok, React menampilkan opsi pertama = tampilan salah, tanpa peringatan. | **P0** (nilai di luar opsi), P1 (lainnya) |
| number | `<Input type="text" inputMode="decimal">` (`:32`). | `EnvEntry` tak membawa `min/max/unit` (`envSettingsApi.ts:12-29`, `envSettings.service.ts:18-36`), jadi rentang dari `num()` (`envRegistry.types.ts:63`) tak pernah terlihat; error baru muncul setelah Simpan ("out of range"). Satuan (ms, token, mikro-dolar di CA2) tak terbaca. | P1 |
| string/path | Input teks, placeholder = default. | `absolutePath` tak dikirim ke klien; kosong ditolak (`envSettings.validate.ts:31`) padahal deskripsi bilang "kosong = `<dataDir>/memory`" (`envRegistry.platform.ts:17`). User tak bisa mengosongkan nilai yang berasal dari `.env` (Reset hanya muncul untuk override). | P1 |
| daftar | Tidak ada tipe. `WEBTERM_CONTROL_CWD_ROOTS` = satu string dipisah delimiter path (`platform.ts:21-26`); delimiter tak disebut di UI. | Perlu tipe `list`/textarea satu-per-baris `[opini]`. | P2 |
| secret | Input password + status Terisi/Kosong + Simpan/Hapus; draft dikosongkan di `finally` (`EnvSecretField.tsx:18-25`). Bagus: write-only konsisten dengan Rule 7. | Secret dari `.env` (source `env`) tampil "Terisi" tanpa tombol Hapus dan tanpa penjelasan (`:37`). Pola ditolak: "has an unexpected shape" tanpa menyebut bentuk yang benar (`validate.ts:20`). | P2 |

## 6. Default, nilai aktif, nilai efektif

- Baris menampilkan "Default: off" di bawah KONTROL yang sudah bernilai off (`EnvEntryRow.tsx:71-73`). Untuk source `default` nilai kontrol DIISI dari default (`envSettings.service.ts:134`), jadi "tidak diset" dan "diset eksplisit sama dengan default" tidak bisa dibedakan selain lewat badge. Usul: tampilkan default hanya bila `value != default`, dan sebagai teks "default: X" di samping Reset `[opini]`.
- Nilai efektif ≠ nilai tersimpan setelah ubah tanpa restart: service memutasi `process.env` di `apply()` (`:103-117`), tetapi pembaca boot-time masih memakai nilai lama sampai restart. UI hanya menandai `menunggu restart`; tidak menunjukkan "aktif sekarang: X, tersimpan: Y" (data `bootEnv` ada di server, tidak dikirim). **P1.**
- Prioritas sumber (override > env > default, `service.ts:1`) tidak dijelaskan di halaman. Override yang dihapus kembali ke nilai `.env`, bukan default; user baru tahu setelah Reset. **P2.**
- Aturan `WEBTERM_ENV_SETTINGS=off` mengunci halaman; banner menyebut nama env var (`envLabels.ts:7`) tanpa langkah yang bisa dilakukan. **P2.**

