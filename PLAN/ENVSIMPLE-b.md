# ENVSIMPLE-b: kontrak API, hot-apply, alur Telegram, tes, risiko

Lanjutan dari `ENVSIMPLE-a.md` (keputusan D1-D9, tipe W0, peta ES-xx, KE-x). Dokumen ini = kontrak teknis yang dirujuk spek di `-c`/`-c2`. Bertanda [TERVERIFIKASI]/[ASUMSI]/[BT] seperti di `-a`.

## 1. API kemampuan (ES-09 mengimplementasikan; ES-10/11 memakai)

Semua mutasi lewat `settingsGuard` (`-a` §3.3). `GET` lewat gerbang `/api` biasa. Respons tak pernah memuat secret.

| Rute | Body | Sukses | Galat |
|------|------|--------|-------|
| `GET /api/capabilities` | - | `CapabilitiesResponse` | - |
| `POST /api/capabilities/:id` | `{ enabled: boolean }` | 200 `CapabilitiesResponse` (sudah memuat `alsoTurnsOn`) | 400 `invalid_body`, 403 `forbidden`, 404 `unknown_capability` |
| `POST /api/capabilities/:id/sub` | `{ key: string, on: boolean }` | 200 `CapabilitiesResponse` | 400 `unknown_sub`, 409 `parent_off` |
| `PUT /api/capabilities/advanced` | `{ agentEngine?, chromiumPath? }` | 200 `CapabilitiesResponse` | 400 `invalid_value` (nama kunci saja) |
| `POST /api/capabilities/telegram/connect` | `{ token: string }` | 200 `{ ok: true, bot: string }` (`bot` = `@username`) | 400 `invalid_token_shape`, 422 `token_rejected`, 502 `unreachable` |
| `POST /api/capabilities/reset` | `{}` | 200 `CapabilitiesResponse` | 403 `forbidden` |

Implementasi `POST /:id`: hitung `next = enabled ? union(current, closure(id)) : minus(current, [id, ...dependents(id)])`; tulis `deriveFlags(next)` DIFF terhadap store lewat `envSettings.update({set, unset})` (satu transaksi, atomik); lalu `reconcile(prev, enabledSet())`; tulis audit; balas state. `derive` hanya menulis kunci yang berubah, supaya override pengguna lain tak tersentuh. Mematikan menulis `off` untuk primaryKey (bukan menghapus override), supaya default global masa depan tidak menghidupkan kembali diam-diam.

`connect`: validasi bentuk token (pola `envRegistry.channels.ts` secret `WEBTERM_TELEGRAM_BOT_TOKEN`), panggil Telegram `getMe` lewat egress yang ada (`telegramSend.ts`, hormati `WEBTERM_TELEGRAM_API_BASE`), baru simpan token (secret store) dan nyalakan `telegram`. Token ditolak = tidak ada yang disimpan. Galat memetakan ke pesan Indonesia yang bisa ditindaklanjuti (§6). Token tidak masuk log, audit, atau respons.

`status` per kemampuan (fungsi murni `viewOf(id, env, detect)` di `featureCapabilities.service.ts`, <=250 baris): `on` bila `isEnabled` dan `needs` terpenuhi; `needs-step` bila `needs` belum terpenuhi (browser tanpa Chromium, telegram tanpa token) atau rantai legacy putus (`fixChain`); selain itu `off`. `detail` satu kalimat Indonesia, tanpa nama env var.

## 2. Hot-apply per kemampuan (D4-REV: tidak ada restart)

Prinsip: bangun layanan SEKALI sebagai singleton "selalu siap" yang idempoten, dan tentukan aktif/tidak lewat `isEnabled` PER PANGGILAN; bila ada proses latar (poller, loop, browser), pasang `onCapabilityChange(id, {start, stop})` dengan `start`/`stop` idempoten (panggil dua kali = aman).

| Kemampuan | Kini | Hot-wire |
|-----------|------|----------|
| ledger (internal) | `index.ts:51` `startLedgerRuntime()` bersyarat `ledgerMode` | `ledgerMode` default `on` (KE-1); `startLedgerReaper` ikut selalu. Tanpa saklar |
| central + chat + CA2 | `bootCa2` di `index.ts` [BT bersyarat?]; `central/ca2Boot.ts` | `bootCa2` selalu dipanggil, merakit layanan dormant; rute/tool memeriksa `isEnabled('central')` per panggilan; sub-opsi CA2 diabaikan bila induk off |
| workers | `orchestratorRunModel.ts`, `orchestratorRunApproval.ts` membaca flag per panggilan [BT] | ganti ke `isEnabled('workers')`; koreksi label `restart` di `envRegistry.platform.ts` (RND/58 §4) |
| autonomy | `startCentralAutonomyBoot` mengembalikan `null` bila off (`centralAutonomyBoot.ts:~86-100`) | controller selalu terpasang: timer tick tunggal; tiap tick cek `isEnabled('autonomy')` dan `workers`; `enabled: true` di baris 78-80 diganti `enabled: isEnabled('workers')`; `start`/`stop` memulai/menghentikan timer |
| files | pembaca per panggilan (registry: semua `hot`) | ganti ke `isEnabled('files')`/`('filesWrite')`; sub-flag WATCH/GIT_STATUS/QUICK_OPEN dihormati bila `files` on |
| browser | `index.ts:122-136` konstanta `browserRuntime` dari `startBrowserRuntime` bersyarat | `browser.activate.ts`: `activeBrowser()` lazy; `start()` meluncurkan runtime, `stop()` menutup semua halaman lalu runtime; WS `/browser` selalu terdaftar, handler memanggil `activeBrowser()` (KE-4) |
| telegram | `startChannelsRuntime` di `index.ts:61` dan `telegramPollWiring.ts` membaca token saat boot; tiga kunci `restart:'boot'` (`envRegistry.channels.ts:17,23,29`) | `telegram.connect.ts` + hook: `start()` memulai poller bila token ada, `stop()` menghentikan; `resolveTelegramMode` dipakai ulang (poll bila token ada); label kunci diubah ke `hot` |

Setiap WS domain memiliki registry domainnya dan WAJIB mengubah label `restart` kunci `derive`-nya menjadi `hot` hanya setelah tes hot-apply miliknya hijau (tes ES-14 menegakkan: tak ada kunci `derive`/primer dengan `restart === 'boot'`).

Tes hot-apply minimum per proses latar (ES-06/07/08): `start();start()` hidup satu instans; `stop();stop()` aman; `start();stop();start()` hidup satu instans; `stop()` sebelum `start()` aman; galat saat `start` (mis. Chromium hilang) tidak melempar keluar hook, status jadi `needs-step`.

## 3. Audit dan penjaga (ES-02)

```sql
-- Catatan kenapa: jejak keputusan pengguna (grant/revoke) tanpa secret, bertahan lintas restart.
CREATE TABLE IF NOT EXISTS capability_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,                 -- epoch ms
  capability TEXT NOT NULL,            -- id katalog atau 'advanced'
  action TEXT NOT NULL,                -- 'grant' | 'revoke' | 'sub' | 'advanced' | 'denied' | 'reset'
  peer TEXT NOT NULL,                  -- 'loopback' | 'remote'
  via TEXT NOT NULL,                   -- 'ui' | 'token' | 'rejected'
  detail TEXT                          -- nama kunci saja, tak pernah nilai
);
CREATE INDEX IF NOT EXISTS capability_audit_at ON capability_audit(at);
```

Rotasi: simpan maks 1000 baris (hapus terlama saat tulis). `ensureAuditSchema(db)` idempoten, dipanggil dari `openDb` (KE-2). `settingsGuard` mengembalikan `{ ok: true, via } | { ok: false, reason }`; alasan 403 tercatat sebagai `denied` dengan `reason` generik (`forwarded|origin|token_kind|peer`), tak pernah isi header. Rute terlindungi: `PUT /api/settings/env`, `POST /api/settings/env/import`, semua `POST|PUT /api/capabilities*`. `GET` tidak.

## 4. "Lanjutan": maksimal 4 butir (D9), satu bagian kecil tertutup

| Butir | Alasan bernilai nyata untuk pemakai pribadi |
|-------|---------------------------------------------|
| Mesin agen Central: Otomatis (bawaan) / Claude / OpenCode / Simulasi | dua mesin terpasang; deteksi memilih claude lalu opencode lalu mock (D5); menampilkan hasil deteksi |
| Lokasi Chromium | satu-satunya jalan keluar bila deteksi gagal; tombol "Pilih lokasi" juga muncul di kartu Browser saat `needs-step` |
| Folder data (baca-saja) | pengguna perlu tahu di mana data dan cadangan berada |
| "Setel ulang kemampuan" | jalan keluar bila rantai legacy rusak; menghapus override turunan, bukan data |

Bukan di Lanjutan: daftar flag, kunci tuning (~40), level log, throttle, batas angka. Itu tetap bisa lewat env atau `PUT /api/settings/env` bagi yang tahu; tak ada kunci dihapus.

## 5. "Tanya saat dibutuhkan" (D9.4)

Komponen `CapabilityOffer` (ES-10): menerima `id`, memanggil `GET /api/capabilities`; bila kemampuan `off`, menampilkan satu baris di tempat: "{blurb} Nyalakan sekarang?" + tombol "Nyalakan"; sekali klik memanggil `POST /api/capabilities/:id`. Bila `needs-step` menampilkan langkahnya. Dipakai di: (1) menu kanvas "Browser" (ES-13: menu SELALU tampil; klik saat off memunculkan tawaran, bukan menghilang); (2) pembuka panel Central chat (ES-13, bila berkas pembuka ditemukan dan <=jatah; jika tidak, ditunda). Default sensibel: `files` (baca) menyala tanpa tindakan (L11); lainnya off sampai ditanya. Tawaran Worker saat tombol Run ditekan = Ditunda (lokasi UI belum terverifikasi).

## 6. Alur Telegram (D9.2): tempel token, selesai

Kartu `TelegramCard` (di tab Kemampuan; tab Channels dihapus oleh ES-12), dengan keadaan:

| Keadaan | Tampilan (Indonesia) |
|---------|----------------------|
| belum terhubung | kolom "Token bot" + tombol "Hubungkan"; satu kalimat "Buat bot lewat @BotFather lalu tempel tokennya di sini." |
| menghubungkan | "Memeriksa token..." |
| tersambung | "Tersambung sebagai @nama"; tombol "Putuskan" |
| token ditolak | "Token ditolak Telegram. Salin ulang dari @BotFather." |
| tak terjangkau | "Tidak bisa menjangkau Telegram. Periksa koneksi internet lalu coba lagi." |
| ada chat menunggu | "{nama} mengirim pesan ke bot. Tautkan chat ini?" + "Tautkan" dan "Abaikan" |
| chat tertaut | daftar "{nama}" + "Putuskan" |

Yang dibuang dari permukaan (tetap ada di server): mode poll/webhook (poll bila token ada; webhook hanya via env eksplisit, secret dibangkitkan otomatis ke `secrets/` bila belum ada), webhook secret, penghitung masuk/keluar, role (privat = `owner`, grup = `viewer`), Project ID (default [BT], KE-10), `WEBTERM_CHANNELS`/`TELEGRAM`/`CENTRAL_TELEGRAM` (diturunkan), tombol Segarkan (polling data kartu tiap 5 detik hanya saat tab terlihat). Tak ada kata `webhook|polling|secret|mode|restart` di teks kartu.

Siapa yang boleh mengirim pesan = allowlist binding yang sudah ada: chat tak tertaut tidak dibalas bot [TERVERIFIKASI `ChannelsLists`/`CH.pendingHint` di `channelsLabels.ts`]. Tautan memerlukan satu ketukan konfirmasi (bukan otomatis), supaya orang asing yang menemukan bot tidak otomatis terhubung ke Agent Pusat.

## 7. Matriks tes UI (D8/D9; ES-12 menulis, ES-10/11 untuk komponen)

Render default `Settings` (jsdom): tidak ada teks cocok regex untuk setiap butir berikut, dan tidak ada elemen `role` terkait:

| Butir D8 | Pernyataan tes |
|----------|----------------|
| 1 chip | `queryByRole('button', {name: /Diubah|Perlu restart|Berbahaya|Segarkan/})` null |
| 2 banner/lencana restart | `queryByText(/restart/i)` null |
| 3 tiga status + reset | `queryByText(/Default|Aktif sekarang|Tersimpan|Atur ulang/)` null |
| 4 nama env var | `queryByText(/WEBTERM_[A-Z_]+/)` null |
| 5 Ledger | `queryByText(/Ledger|Bayangan/)` null |
| 6 "Mesin agen" saat Central off | bagian Lanjutan tertutup; `Belum berpengaruh` null |
| 7 kelompok satu kartu | tidak ada heading kelompok `Dasar`/`Central` |
| 8 tautan ke tab Channels | `queryByText(/tab Channels/)` null; tab Channels tidak ada |
| D3-REV | `queryByText(/Berbahaya|Dikunci|Token root|Info server|WEBTERM_TOKEN/)` null |
| D9 | `queryByText(/webhook|polling|secret|mode|operator/i)` null; Lanjutan memuat maksimal 4 kontrol |

Tes tambahan: setiap kartu hanya satu kontrol on/off (`getAllByRole('switch')` panjang 7); sub-opsi `workers` hanya terlihat saat Worker on; status `needs-step` menampilkan tombol bernama manusiawi.

## 8. Strategi tes backend

1. Properti eksaustif (ES-00): untuk semua 128 subset S, `enabledSet(env(deriveFlags(S)))` ⊇ S bila S tertutup `implies`, dan hasil selalu tertutup-`implies` (0 inkoheren).
2. Legacy (ES-00 unit, ES-14 matriks `bun`): tabel kasus kunci lama -> himpunan (mis. `AUTONOMY=on` tanpa `ORCHESTRATOR_RUN` -> autonomy off, `ignored` memuat kunci, tepat satu warn); store kosong -> himpunan kosong; urutan kunci tak berpengaruh.
3. Pagar grep (ES-00, final di ES-14): berkas non-tes di `src/server` tidak boleh mengandung pembacaan `process.env.<primaryKey/derive>` atau `flagOn(env[...])` untuk kunci katalog, kecuali `featureCapabilities.*` dan registry.
4. Keamanan (ES-02): token node ditolak; `X-Forwarded-For`/`Forwarded` ditolak; `Origin` asing ditolak; `Origin` absen pada jalur tanpa token ditolak; token root lolos; tes statis V4 (tak ada berkas `central/**/*.def.ts` mengimpor `envSettings*`, `featureCapabilities*`).
5. Hot-apply (§2), audit (baris tertulis, tak ada secret: serialisasikan baris, cari token uji), `connect` (`getMe` dipalsukan: ok, 401, jaringan mati).
6. Label: tes ES-14 menolak `restart === 'boot'` pada kunci primer/`derive`.

## 9. Pemetaan kunci legacy ke kemampuan (ES-00 menuliskan datanya)

| Kunci | Perlakuan |
|-------|-----------|
| `WEBTERM_CENTRAL`, `_ORCHESTRATOR_RUN`, `_CENTRAL_AUTONOMY`, `_BROWSER`, `_FILES_VIEWERS`, `_FILES_MUTATE`, `_TELEGRAM` | primer |
| `WEBTERM_CENTRAL_CHAT`, `_CENTRAL_MEMORY`, `_CENTRAL_READ_TOOLS`, `_CHANNELS`, `_CENTRAL_TELEGRAM` | diturunkan, tak tampil |
| `WEBTERM_RUN_REQUIRE_APPROVAL` | sub `workers` |
| `WEBTERM_FILES_WATCH`, `_GIT_STATUS`, `_QUICK_OPEN`, `_UPLOAD` | anak `files`/`filesWrite`, diturunkan |
| `WEBTERM_LEDGER` | legacy diabaikan; ledger selalu hidup (KE-1) |
| `WEBTERM_CENTRAL_RUNTIME` | Lanjutan "Mesin agen" |
| 9 flag CA2 rilis + ~40 tuning | anak `central`, tak tampil; hanya berlaku bila induk on |
| `WEBTERM_TELEGRAM_MODE`, `_WEBHOOK_SECRET`, `_BOT_TOKEN` | token = kartu Telegram; mode/secret = otomatis, env tetap override |

## 10. Risiko teknis

| ID | Risiko | Mitigasi |
|----|--------|----------|
| R-E1 | Ledger selalu hidup mengubah "store kosong" | KE-1, tes footprint (file kecil), CHANGELOG |
| R-E2 | `Origin` wajib memutus skrip tanpa token | KE-8, CHANGELOG, pesan 403 menyebut cara: token |
| R-E3 | Dua koneksi SQLite menulis `app` dan audit | tabel berbeda, WAL; tes bersamaan |
| R-E4 | Hot-stop menutup browser/poller saat dipakai | `stop` menunggu operasi aktif selesai dengan batas waktu; KE-5 |
| R-E5 | Hapus UI env generik memutus importer (`channelsOpenEnv.ts`, tes bridge) | ES-12 grep importer lebih dulu, hapus bersama tes terkait |
| R-E6 | Nama berkas `featureCapabilities` bentrok istilah workspace | prefiks `feature` (`-a` §3.1) |
| R-E7 | Pengguna lama punya kunci tuning di store | tetap dibaca; hanya tak tampil |
| R-E8 | Sub-opsi anak CA2 tanpa induk diam | satu warn per kunci; tidak ada permukaan |

## 11. Ditunda (dengan alasan)

- `RETIRED_KEYS`: tak dibutuhkan pengguna; risiko rollback.
- Konstanta-isasi kunci tuning: tak ada kunci dihapus (D7).
- Tombol "Mulai ulang" (L15): tidak ada kunci yang butuh restart di permukaan.
- UI impor `.env`: alur panjang (D9); API tetap.
- "Hentikan semua yang berjalan" saat mencabut (KE-5).
- Tawaran kontekstual Worker pada tombol Run; penghapusan field `requires`/`dangerous` dari registry.
