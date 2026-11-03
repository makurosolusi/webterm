# 54 — Audit Settings > Channels & Environment (Topik 1)

Lanjutan: `54-CHENV-AUDIT-b.md` (tabel 60 kunci Environment + Implikasi). Dasar vonis: `RND/51..53-ENV-MINIMAL-*` (rujuk `51:NN` = baris di `51-ENV-MINIMAL-INVENTORY.md`; tak diulang). Konvensi: `[BT]` = tak terverifikasi; `[opini]` = penilaian. Semua path relatif `src/`. Vonis memakai set spek: TAMPIL-SETTINGS / GABUNG / SEMBUNYI-ADVANCED / PINDAH-KE-ENV-SAJA / HAPUS.

## 1. Ringkasan temuan

| # | Temuan | Bukti |
|---|---|---|
| T1 | `WEBTERM_CHANNELS` adalah gerbang-AND di atas `WEBTERM_TELEGRAM`. Telegram satu-satunya provider, jadi saklar itu tak menambah keadaan baru. | `server/channels/channelsRuntime.ts:159-168`, `channelsMasterGate.ts:17-22` |
| T2 | `requires` kunci `CENTRAL_TELEGRAM` menolak runtime `claude` padahal kode menerimanya (satu-satunya runtime nyata). UI menampilkan prasyarat "belum terpenuhi" padahal bisa jalan. | `server/envRegistry.channels.ts:60` vs `channels/telegramPollWiring.ts:34-35`, `central/runtime/runtimeFlag.ts:9` |
| T3 | Token diklaim `hot` tetapi poller baru hidup saat boot; tak ada banner restart untuk token. Urutan "nyalakan -> restart -> isi token" berakhir mati diam-diam. | `envRegistry.channels.ts:43`, `envSettings.state.ts:64-67`, `server/index.ts:63-72`, `channelsRuntime.ts:170-177` |
| T4 | Tidak ada pemanggil `setWebhook` di `src/`. Mode webhook memaksa operator mendaftarkan webhook + secret manual ke Telegram. | grep `setWebhook` di `src/server src/client` nol hasil |
| T5 | Tidak ada tes koneksi token. `botManager` sudah punya `getMe`; status UI hanya "Terisi/Belum". | `channels/botManager.ts:46,77`; `client/ChannelsSection.tsx:45-48` |
| T6 | 4 kunci tampil di UI tanpa efek (tanpa pembaca). | `51:84-90`; `envRegistry.invariants.test.ts:43` (allowlist) |
| T7 | "Environment" memajang 60 kunci mekanisme (nama KEY, lencana "Dari .env") untuk pengguna biasa; hanya 13 yang berstatus `user`. | dump registry; `client/SettingsPanel.tsx:50-51` |

## 2. Audit Channels (6 kunci registry + komponen UI)

Kolom: efek nyata = bukti pembaca di kode. Audiens: U end user, O operator, D dev.

| Item | Label UI | Env | Sebenarnya mengatur | Audiens | Efek nyata? | Ambigu/tumpang tindih? | Vonis | Alasan |
|---|---|---|---|---|---|---|---|---|
| Saklar utama | "Kanal (saklar utama)" | `WEBTERM_CHANNELS` (on/off, default on) | Kill-switch seluruh runtime kanal; `off` -> `startChannelsRuntime` return null | O | Ya: `channelsRuntime.ts:159-166`. Pembaca lain: hanya `requires` CENTRAL_BOTS (`envRegistry.ca2.ts:37`) dan teks | Ya. Dua saklar untuk satu kanal; "Mati" di sini mengalahkan "Aktif" di Telegram (`envRegistry.channels.ts:25`). Nilai asing = fail-closed `unsupported` (`channelsMasterGate.ts:19-21`); `.env.example:90` mencontohkan `off` (`51-b:36`) | PINDAH-KE-ENV-SAJA | Redundan dengan `WEBTERM_TELEGRAM` selama provider tunggal. Tetap dibaca env sebagai kill-switch operator; keluar dari UI. Wajib ubah `requires` CENTRAL_BOTS (`ca2.ts:37`) dan TELEGRAM (`channels.ts:32`) |
| Telegram | "Telegram" | `WEBTERM_TELEGRAM` (flag, off) | Menyalakan runtime kanal + route `/webhooks/telegram` + poller | U | Ya: `channelsRuntime.ts:94-96,168`; `index.ts:60-72` | Sebagian. `requires` menuntut ledger dan CHANNELS (`channels.ts:32`) tetapi alasan "nonaktif" tak ditampilkan (`channelsLabels.ts:8` hanya "Nyalakan ... lalu restart") | TAMPIL-SETTINGS | Satu-satunya saklar kanal. Lihat §3 untuk usulan menyatukan dengan token (nyala = token tersimpan + dinyalakan) |
| Mode masuk | "Mode masuk Telegram" | `WEBTERM_TELEGRAM_MODE` (poll/webhook/kosong) | Cara menerima pesan: `getUpdates` vs POST dari Telegram | O (webhook), U tidak perlu | Ya: `telegramMode.ts:14-24`, dipakai `channelsRuntime.ts:170`, `index.ts:64` | Ya. "Kosong = otomatis" (`channels.ts:37`) tergantung ada-tidaknya token pada saat boot; pengguna tak melihat hasil akhirnya. Pilihan webhook butuh URL publik + `setWebhook` manual (T4) | SEMBUNYI-ADVANCED | Default otomatis sudah benar (poll bila token). UI cukup menampilkan hasil ("Menerima via polling") dan menyimpan pilihan di Lanjutan. Cocok dengan `51:47` (DEFAULT-OTOMATIS) |
| Token bot | "Token bot Telegram" | `WEBTERM_TELEGRAM_BOT_TOKEN` (secret) + alias lama `TELEGRAM_BOT_TOKEN` | Kredensial bot untuk kirim + poll | U | Ya: dibaca per kirim `telegramSend.ts:23-30`; poller `telegramPollWiring.ts:56`; ingress mode `telegramMode.ts:23` | Ya. Deskripsi menyebut "Write-only" dan "penerimaan setelah restart" (`channels.ts:45`): jargon + mekanisme. `restart:'hot'` (`channels.ts:43`) menipu untuk ingress (T3). Alias lama tidak disapu `LEAKED_ENV` (`51:15`) | TAMPIL-SETTINGS | Inti kartu Telegram. Perbaiki: validasi `getMe` saat simpan, status "Tersambung sebagai @bot", poller start tanpa restart. Alias -> HAPUS (`51:48`) |
| Secret webhook | "Secret webhook Telegram" | `WEBTERM_TELEGRAM_WEBHOOK_SECRET` (+ `_FILE` tak terdaftar) | Header rahasia yang diperiksa pada POST masuk (32-256 karakter) | O | Ya, hanya mode webhook: `channelsRuntime.ts:172-177`, `channelSecret.ts:57-75` | Ya, kuat. `requires` menyala saat MODE `''` (`channels.ts:52`) padahal mode otomatis+token = poll, yang tak membaca secret (`channelsRuntime.ts:172`). Manusia diminta mengarang string acak | SEMBUNYI-ADVANCED | Target jangka panjang DEFAULT-OTOMATIS (`51:49`), tapi bernilai hanya bila server memanggil `setWebhook` sendiri (T4). Tanpa itu, otomatis tak berguna: secret tetap harus disalin ke Telegram |
| Central via Telegram | "Central via Telegram" | `WEBTERM_CENTRAL_TELEGRAM` (flag, off) | Jembatan chat Central ke Telegram | U | Ya: `telegramPollWiring.ts:32-35`, `telegramCentralBridge.ts:16` | Ya. Rantai 5 prasyarat (TELEGRAM, CENTRAL, CHAT, RUNTIME, LEDGER) melintasi dua tab (`channels.ts:58-61`); bug runtime `claude` (T2). Dibaca hanya jika `CENTRAL_CHAT` on (`telegramPollWiring.ts:32`) | TAMPIL-SETTINGS (kondisional) | Tampil di kartu Telegram hanya bila Central menyala; teks "Balas pesan Telegram lewat Central". Perbaiki `requires` runtime. Bukan pajangan: jalur nyata |
| Panel Status | "Status" (Mode, Token bot, Secret, Ingress, Egress) | (API `/api/channels/telegram/status`) | Ringkasan baca-saja | U/O | Ya: `ChannelsSection.tsx:39-56` | Sebagian. "Mode" tanpa alasan; "Secret webhook" muncul di status padahal pengguna tak perlu tahu | GABUNG | Jadi badge status kartu (Tersambung / Perlu token / Error terakhir). Ingress/egress+error terakhir bernilai; "Token bot: Terisi" diganti hasil `getMe` |
| Pending chat | daftar "Menunggu" + peran + ID proyek + Bind/Abaikan | (API bindings) | Memetakan chat Telegram ke proyek + peran | U | Ya: `ChannelsLists.tsx:47-71`; tes `ChannelsSection.test.tsx:90-135` | Sebagian. ID proyek berupa teks bebas (`ChannelsLists.tsx:61`); peran 3 chip tanpa penjelasan | TAMPIL-SETTINGS | Alur inti pasca-sambung; bukan env. Ganti input teks dengan pemilih proyek `[opini]` (domain Topik 2) |
| Binding | daftar "Terhubung" + Hapus | (API bindings) | Memutus chat | U | Ya: `ChannelsLists.tsx:112-118` | Tidak | TAMPIL-SETTINGS | Perlu; konfirmasi hapus sudah ada (tes `:123`) |
| Segarkan | "Segarkan" | - | Muat ulang status; ada polling interval juga (tes `ChannelsSection.test.tsx:162`) | U | Ya | Ya, tumpang tindih dengan polling | SEMBUNYI-ADVANCED | Polling sudah ada; tombol manual cukup jadi ikon kecil `[opini]` |

## 3. Pasangan saklar: hubungan sebenarnya di kode

Urutan evaluasi di `startChannelsRuntime` (`channelsRuntime.ts:150-253`):

1. `channelsMasterState` (`WEBTERM_CHANNELS`): `''|on` -> lanjut; `off`/asing -> `null` (`:159-166`).
2. `telegramChannelEnabled` (`WEBTERM_TELEGRAM`, hanya literal `on`) -> kalau tidak, `null` (`:168`; dialek `flagOn`, `51:F4`).
3. Mode: `resolveTelegramMode` (`:170`). Webhook: butuh secret, else `null` (`:174-177`). Poll: tanpa token hanya `warn` (`:178-180`).
4. Ledger wajib: tanpa ledger `null` (`:181`).
5. `WEBTERM_CENTRAL_TELEGRAM` tidak mengaktifkan kanal; ia hanya mengisi port `centralChat` yang diteruskan ke runtime (`index.ts:61-62`; `telegramPollWiring.ts:27-36`). Jika (3)/(2)/(1) gagal, jembatan tak pernah dipakai.

| Keadaan | Hasil nyata |
|---|---|
| CHANNELS=off, TELEGRAM=on | Sama dengan TELEGRAM=off (`:160-166`). UI tetap menampilkan Telegram "Aktif" dengan `requires` terlanggar |
| CHANNELS=on (default), TELEGRAM=off | Tak ada route, tak ada secret dibaca (`:167-168`) |
| TELEGRAM=on, tanpa token, tanpa secret | Mode otomatis -> webhook -> `logDisabledAndNull` -> kanal mati meski "Aktif" (`:170-177`) |
| CENTRAL_TELEGRAM=on, CENTRAL_CHAT=off | Port tidak dibuat (`telegramPollWiring.ts:32`); saklar tidak berefek |
| CENTRAL_TELEGRAM=on, runtime=claude | Berfungsi (`:34-35`), tetapi registry menolak (T2) |

Kesimpulan: tiga saklar bukan tiga fitur; itu satu rantai yang dibelah menjadi dua tab. `CHANNELS` = kebijakan operator (kill-switch), `TELEGRAM` = niat pengguna, `CENTRAL_TELEGRAM` = fitur turunan Central. Usulan UX [opini]: satu aksi pengguna "Hubungkan Telegram" (tempel token -> tes -> aktif). `WEBTERM_TELEGRAM` tetap dibaca sebagai override; nilai tersimpan ditetapkan otomatis saat token valid. `CHANNELS` tetap hidup di env sebagai kill-switch operator.

Efek samping yang harus dijaga: `CENTRAL_BOTS` memakai `WEBTERM_CHANNELS` di `requires` (`envRegistry.ca2.ts:37`); tes invarian 4 (`envRegistry.invariants.test.ts:114-127`) memeriksa kunci `requires` ada di registry atau bootstrap. Bila `CHANNELS` dikeluarkan dari UI tetapi tetap di registri, tes tetap lulus; bila dihapus dari registri, `requires` harus diganti dan daftar beku (`:184-191`) diubah sadar.

## 4. Token "write-only"

| Aspek | Keadaan sekarang | Bukti | Penilaian |
|---|---|---|---|
| Penyimpanan | Berkas 0600 `<dataDir>/secrets/*`; nilai tak pernah dikembalikan API | `53` §2, `52` §6; `client/EnvSecretField.tsx` `[BT baris]` | Sesuai praktik (GitHub Secrets, Portainer: tersimpan + ganti) `[opini]`; pertahankan |
| Teks UI | Deskripsi "Write-only, tidak pernah ditampilkan lagi..." | `envRegistry.channels.ts:45` | Jargon + mekanisme. Ganti ke "Tersimpan. Tempel token baru untuk mengganti." |
| Validasi | Hanya bentuk `\d+:[A-Za-z0-9_-]{10,}` | `channels.ts:6` | Token salah ketik lolos; kesalahan baru terlihat di log. `getMe` tersedia (`botManager.ts:77`) |
| Restart | `hot` | `channels.ts:43`; `envSettings.state.ts:64-67` (`pendingRestart` hanya `boot`) | Salah untuk ingress (T3): `telegramMode.ts:23` & poller dibaca saat boot |
| Alias lama | `TELEGRAM_BOT_TOKEN` jadi fallback | `telegramSend.ts:14,23-30` | HAPUS bertahap (`51:48`); tak disapu dari anak PTY |
| Cakupan UI | Tidak ada "Hapus token" yang jelas dibedakan dari "kosongkan" `[BT]` | `EnvSecretField.tsx` | Verifikasi di Topik 2 |

Vonis: pertahankan konsep write-only, hapus kata itu dari UI; tampilkan status nyata (tersambung/tidak/galat terakhir) alih-alih "Terisi".

## 5. Mode masuk dan secret webhook

- Poll: default otomatis bila token ada (`telegramMode.ts:23`); tak perlu URL publik, cocok untuk bind loopback default (`51:25` `HOST=127.0.0.1`). Mayoritas pengguna webterm lokal memenuhi ini.
- Webhook: butuh endpoint HTTPS publik, `TRUST_PROXY` benar (`51:52`), secret, dan `setWebhook` manual (T4). Ini skenario operator di balik proksi.
- Persilangan jebakan: dalam mode otomatis, pengguna yang lupa token dan secret menerima kanal "Aktif tapi mati" (§3 baris 3). Usulan: UI harus menampilkan alasan mati (token/secret/ledger/saklar) dari `startChannelsRuntime` (sekarang hanya log `channels.disabled`, `:90-92`) dan `channelStatus`.
- Secret webhook: bernilai hanya setelah ada `setWebhook` otomatis. Tanpa itu, `DEFAULT-OTOMATIS` (`51:49`) menciptakan nilai yang tak terlihat siapa pun sehingga tak bisa dipasang ke Telegram. Jadi: tetap Lanjutan, tampil hanya bila MODE=webhook eksplisit; ubah `requires` dari `oneOf ['webhook','']` menjadi `['webhook']`.

## 6. Apakah "Environment" layak sebagai bagian untuk pengguna biasa?

Tidak sebagai nama dan bentuk sekarang. Argumen:

1. Konsep "environment variable" adalah mekanisme; tujuan pengguna adalah fitur (Central, Browser, File, Orkestrator, Memori). Label sudah dibuat manusiawi (`envLabels.ts`) tetapi bagian tetap bernama Environment (`SettingsPanel.tsx:51`) dan tiap baris menampilkan KEY mentah serta lencana "Dari .env" `[BT detail komponen: EnvBadges.tsx]`.
2. Dari 60 kunci Environment: 10 lolos sebagai kontrol pengguna, 11 digabung, 16 Lanjutan, 19 cukup env, 4 mati (§7, `54-b`). Hanya 13 berstatus `audience:user` di registry sekarang.
3. Gagasan "pajangan" nyata: 4 kunci tanpa pembaca, 19 angka tuning (`51:66-68,77,78`) yang default-nya sudah benar, dan 5 flag berkas (`VIEWERS/WATCH/GIT_STATUS/QUICK_OPEN/UPLOAD`) yang default `off` sehingga fitur berkas "gelap" pada zero-config (`51:78`).
4. Nilai sah untuk operator: kunci `dangerous` perlu root token (`envSettings.service.ts` `validate`, `ctx.root`) dan `pendingRestart` (`envSettings.state.ts:64-67`). Mekanisme itu layak, tetapi di panel "Lanjutan" (operator), bukan tab sejajar dengan Channels.

Rekomendasi [opini]: bagian "Environment" dihapus sebagai tab; isinya dipecah menurut fitur ("Central", "Browser", "File", "Orkestrator"/"Memori") dan satu panel "Lanjutan" bernama KEY untuk operator. Struktur akhir = Topik 2 (`55-CHENV-DESIGN.md`); asumsi `[BT]`.

## 7. Hitungan kontrol

Definisi: 1 kontrol = 1 entri registry yang bisa diubah di UI (66 total = Channels 6 + Environment 60). Tidak menghitung daftar dinamis Pending/Binding.

| Kategori | Sekarang | Usulan |
|---|---|---|
| Terlihat default (audience user) | 18 (Channels 5 + Env 13) | 13 (Channels 3 + Env 10) |
| Di Lanjutan (disembunyikan, ada UI) | 48 (Channels 1 + Env 47) | 18 (Channels 2 + Env 16) |
| Tanpa kontrol sendiri (GABUNG ke kontrol lain) | 0 | 11 |
| Hanya env/`.env.example` (keluar UI) | 0 | 20 (Channels 1 + Env 19) |
| Dihapus dari registri | 0 | 4 |
| Total kontrol di layar | 66 | 31 (-53%) |

Catatan: selain 66 itu, tab Channels memuat Segarkan + daftar Pending/Binding dinamis (tak dihitung). Env `bootstrap` (10 kunci, `51` §2) tak ada di UI dan tak berubah.

Rincian per kunci dan alasan ada di `54-CHENV-AUDIT-b.md` §1; Implikasi di §2 file itu.
