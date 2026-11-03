# 55 — Desain ulang Settings: Channels & Environment

Topik 2 dari `SPEC-CHENV-RND`. Dasar: vonis R&D 51-53 (tidak diulang). Saudara: `RND/54-CHENV-AUDIT.md` (audit per kunci; belum dibaca, semua rujukan ke sana adalah asumsi `[BT]`). Tanpa kode produksi. `[BT]` = tak terverifikasi, `[opini]` = penilaian saya.

## 1. Temuan kode yang mendasari desain

| # | Temuan | Bukti |
|---|---|---|
| T1 | Sidebar punya dua bagian terpisah ("Channels", "Environment") di antara enam bagian setelan nyata; keduanya isinya env var. | `SettingsPanel.tsx:43-52` |
| T2 | Kartu Channels tidak ikut pencarian Settings: komponen mengembalikan `null` saat ada query. Pencarian lintas-bagian menutup Channels. | `ChannelsSection.tsx:17-20` |
| T3 | Status kanal hanya poll 5 dtk; HTTP 404 dipetakan ke satu keadaan "inaktif" tanpa alasan. | `useChannels.ts:15,19` |
| T4 | 404 itu menyembunyikan empat sebab berbeda: master `WEBTERM_CHANNELS` off, `WEBTERM_TELEGRAM` off, ledger off, atau mode webhook tanpa secret. Tidak ada satu pun yang dijelaskan ke pengguna. | `channelsRuntime.ts:6-7,52,167`; `channelsMasterGate.ts:4` |
| T5 | Poller hanya dijalankan saat boot dan hanya bila token ada; token dibaca ulang per panggilan, jadi rotasi token "hot", tetapi token pertama butuh restart. Tidak ada tombol restart di UI. | `telegramPollWiring.ts:56`; `telegramPoll.ts:100` |
| T6 | Tidak ada pemanggilan `setWebhook` di `src/server`: mode webhook berarti pengguna mendaftarkannya sendiri ke Telegram. Tidak ada endpoint tes koneksi untuk kanal. | grep `setWebhook` di `src/server` = 0 hasil (non-test) |
| T7 | Verifikasi token via `getMe` SUDAH ada, tetapi hanya untuk bot terkelola (central), bukan untuk token kanal Telegram. Bisa dipakai ulang. | `botManager.ts:46,77` |
| T8 | Registry kanal Telegram memiliki enam kunci tampil; panel Channels merender kunci milik owner `channels`, Environment menyingkirkannya agar tidak ganda. | `envRegistry.channels.ts`; `envDraft.ts:7`; `envRegistry.ca2.ts:37-38` |
| T9 | Tes menjaga kontrak lewat label teks env var (`getByLabelText('WEBTERM_TELEGRAM')`), nama tombol sidebar, dan `getByRole('navigation',{name:'Section settings'})`. Mengubah label = mengubah tes. | `ChannelsTelegramConfig.test.tsx:31-47`; `SettingsPanel.test.tsx:35,43,52,65,187,211` |
| T10 | Invarian registry: label <=40, deskripsi <=160, daftar kunci beku `KNOWN_KEYS_FROZEN`. Kunci tidak boleh dihapus dari registry hanya karena disembunyikan di UI. | `envRegistry.invariants.test.ts:22,185` |

## 2. Pembanding industri (diambil via curl karena WebSearch/WebFetch gagal; detail halaman `[BT]`)

| Produk | Pola relevan | URL |
|---|---|---|
| Home Assistant, integrasi Telegram bot | Satu integrasi, pilih platform (Broadcast / Polling / Webhooks); allowlist chat ID; webhook dibuat sadar-konteks (butuh URL publik) | https://www.home-assistant.io/integrations/telegram_bot/ |
| Grafana Alerting, contact point Telegram | Satu formulir: bot token + chat ID + tombol **Test**; token disimpan sebagai secret (tampil "configured", ganti atau reset) | https://grafana.com/docs/grafana/latest/alerting/configure-notifications/manage-contact-points/integrations/configure-telegram/ |
| Telegram Bot API | `getMe` sebagai cek token; `setWebhook` dan `getUpdates` saling eksklusif; `secret_token` header untuk webhook | https://core.telegram.org/bots/api |
| GitHub Webhooks | Secret hanya ditulis, tidak pernah dibaca ulang; ada **Redeliver** dan daftar pengiriman terakhir dengan status | https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries |
| VS Code Settings | Pencarian lintas-bagian, label bahasa tujuan, ID setelan hanya terlihat via tooltip/gear "Copy Setting ID", edit JSON untuk lanjutan | https://code.visualstudio.com/docs/getstarted/settings |
| WAI-ARIA APG Switch | Saklar = `role=switch` + `aria-checked`, label tunggal | https://www.w3.org/WAI/ARIA/apg/patterns/switch/ |
| WCAG 3.3.1 Error Identification | Kesalahan harus diidentifikasi dan dijelaskan dalam teks | https://www.w3.org/WAI/WCAG22/Understanding/error-identification.html |
| 12-factor, Config | Config deploy hidup di env; UI aplikasi tidak perlu menampilkan semuanya | https://12factor.net/config |

## 3. Prinsip desain

| Prinsip | Konsekuensi |
|---|---|
| P-A Tujuan, bukan mekanisme | Label menyatakan hasil ("Sambungkan Telegram"), bukan kunci. |
| P-B Satu kanal, satu kartu, satu status | Status dihitung dari kondisi nyata, dengan alasan. |
| P-C Default aman dan otomatis | Tempel token -> jalan. Mode, master, ledger tidak ditanyakan. |
| P-D Secret write-only | Tampil "Tersimpan", aksi Ganti / Hapus; nilai tak pernah kembali ke klien (R&D 52/53). |
| P-E Nama env hanya di Lanjutan/tooltip | Lencana "Dari .env" hanya muncul bila nilai efektif DIKUNCI oleh env (override tidak mungkin) `[opini]`. |
| P-F Jujur soal restart | Bila perubahan belum aktif, tampilkan tindakan ("Mulai ulang server"), bukan istilah `restart: boot`. |

## 4. Opsi struktur sidebar (butir a)

### Opsi A — Minimal: pertahankan dua bagian, rapikan isinya
Sidebar tetap: Terminal, Interaksi, Shell & buffer, Agent, Canvas, Preview, Channels, Environment. Perubahan hanya di dalam bagian (kartu Telegram sederhana, label Indonesia).

```
Channels                         Environment
+- Telegram -------------+       Server (3 grup)
| [ ] Aktif              |       - Jaringan, Penyimpanan ...
| Token  [Tersimpan][Ganti]      (daftar env tetap)
| Status: Terhubung @bot |
+------------------------+
```

| Kelebihan | Kekurangan |
|---|---|
| Diff terkecil; nama bagian tes tetap | Gejala utama (dua bagian env var) tetap; "Environment" tetap tempat sampah `[opini]` |

### Opsi B (DIREKOMENDASIKAN) — "Integrasi" + "Server & fitur" + panel "Lanjutan"
Gabung Channels menjadi **Integrasi** (kanal sebagai kartu; ruang untuk kanal berikutnya dan bot terkelola). Environment menjadi **Server & fitur** hanya berisi setelan yang masuk akal bagi operator (port, direktori data, kunci fitur ber-`audience: user`). Semua sisanya (`audience: advanced`, `dangerous`, kunci mekanisme) masuk satu lipatan **Lanjutan** di dasar Server & fitur, yang menjadi satu-satunya tempat nama env var tampil lengkap.

```
Terminal | Interaksi | Shell & buffer | Agent | Canvas | Preview
Integrasi            <- menggantikan "Channels"
Server & fitur       <- menggantikan "Environment"
   ...kontrol berguna...
   v Lanjutan (nama variabel, webhook, kunci berbahaya)

[Integrasi]
+-- Telegram ---------------------------- (o) Terhubung --+
|  Bot: @namabot  *  Mode: otomatis (polling)             |
|  Token   Tersimpan  [Ganti] [Hapus]       [Tes koneksi] |
|  Chat terhubung: 2   Terakhir menerima: 3 mnt lalu      |
|  Error terakhir: -                                      |
|  > Lanjutan: webhook, daftar chat, ledger               |
+---------------------------------------------------------+
```

| Kelebihan | Kekurangan |
|---|---|
| Menghapus dualisme T1; "Lanjutan" = tempat jelas untuk nama env (butir e); selaras Grafana/HA | Mengubah label tombol sidebar -> tes `SettingsPanel.test.tsx` ikut berubah (T9); butuh endpoint tes (workstream baru) |

### Opsi C — Radikal: satu bagian "Integrasi & server", Environment dibuang dari UI
Hanya kartu; semua env var lain hanya lewat `.env`/CLI (12-factor). Memutus kunci PINDAH-SETTINGS (R&D 51) dan pengguna tanpa shell kehilangan kendali `[opini]`. Tidak direkomendasikan.

### Perbandingan

| Kriteria | A | B | C |
|---|---|---|---|
| Jumlah bagian sidebar | 8 | 8 (nama baru) | 7 |
| Kontrol terlihat untuk pengguna biasa | ~6 | ~3 (Telegram) | ~3 |
| Risiko regresi tes | rendah | sedang | tinggi |
| Memenuhi "minimalkan, tepat guna" | sebagian | ya | ya, berlebihan |
| Ukuran | S | M | L |

Rekomendasi: **Opsi B**. Bagian tidak bertambah, jadi biaya navigasi nol; "Lanjutan" menampung apa yang dibuang dari permukaan utama tanpa menghapus kemampuan.

## 5. Kartu kanal dengan status nyata (butir b)

Mesin keadaan satu kartu Telegram. Alasan status = fungsi murni dari data yang sudah ada di server (gerbang berlapis, T4) sehingga tidak ada lagi "404 diam".

| Status | Syarat (urut evaluasi) | Teks pendek | Aksi utama |
|---|---|---|---|
| Belum disambung | tidak ada token | "Tempel token bot untuk menyambungkan." | Field token + Sambungkan |
| Token ditolak | `getMe` gagal 401 | "Token ditolak Telegram. Periksa penyalinan." (WCAG 3.3.1) | Ganti token |
| Menunggu mulai ulang | token tersimpan tetapi poller belum jalan (T5) | "Token tersimpan. Mulai ulang server agar aktif." | Mulai ulang `[BT]` (butuh endpoint) |
| Dimatikan | master/Telegram/ledger off (T4) | "Dimatikan lewat pengaturan Lanjutan." | Buka Lanjutan |
| Perlu secret webhook | mode webhook tanpa secret (T4) | "Mode webhook butuh secret." | Buka Lanjutan |
| Terhubung | token valid + runtime hidup | "Terhubung sebagai @bot." | Tes koneksi |
| Error | pengiriman/poll gagal terakhir | pesan + waktu | Tes ulang |

Data yang ditampilkan: nama bot (dari `getMe`, cached), jumlah chat terikat, waktu aktivitas terakhir, error terakhir. Tombol **Tes koneksi** memanggil `getMe` memakai token tersimpan (server-side; token tak lewat klien), meniru Grafana Test dan GitHub Redeliver (bagian 2). Implementasi memanfaatkan `callBotApi` (`telegramPollApi.ts:53`) dan pola `botManager.ts:77`.

Catatan jujur: endpoint status saat ini (`channelStatusHttp.ts`) harus diperluas untuk mengembalikan `reason`; menghentikan 404 sebagai sinyal "inaktif" adalah perubahan kontrak API `[BT]` terhadap `useChannels.ts:19`. Rekomendasi: tambah field, jangan ubah kode status lama dulu (kompatibel mundur).

## 6. Alur menyambungkan Telegram (butir c)

Opsi alur (rekomendasi: **C1**).

| Opsi | Alur | Catatan |
|---|---|---|
| C0 sekarang | Aktifkan master -> aktifkan Telegram -> pilih mode -> isi token -> (webhook) isi secret -> simpan -> restart | 5-6 langkah, 6 kunci (T8) |
| **C1** | Tempel token -> **Sambungkan** (server memanggil `getMe`, menyimpan token sebagai secret, mengaktifkan Telegram + master secara implisit, mode otomatis) -> status "Terhubung sebagai @bot" -> bila runtime perlu mulai, tampilkan banner "Mulai ulang" | 1 langkah pengguna |
| C2 | C1 + wizard "kirim /start ke bot untuk menautkan chat" | Menambah UX; bagus tetapi bisa tahap 2 |

Wireframe C1:

```
Telegram
 Belum disambung
 1. Buat bot lewat @BotFather, salin token.
 2. [ Tempel token di sini          ] [Sambungkan]
 Setelah tersambung: kirim pesan apa saja ke bot untuk
 menautkan chat (muncul di "Chat menunggu").
```

Aturan perilaku (semua `[opini]` kecuali dirujuk):
- **Mode otomatis dipertahankan**: polling bila token ada (`telegramMode.ts` `[BT]` barisnya), jadi pengguna lokal tidak butuh URL publik; sejalan dengan HA "Polling".
- **Webhook hanya Lanjutan**: karena webterm tidak pernah memanggil `setWebhook` (T6), mode ini mengharuskan pengguna mendaftarkan sendiri; letakkan di Lanjutan dengan teks "Hanya bila server dapat dijangkau publik dan Anda sudah mendaftarkan webhook ke Telegram." Telegram melarang webhook + `getUpdates` bersamaan (Bot API), jadi mode ditampilkan sebagai pilihan radio, bukan saklar ganda.
- **WEBTERM_CHANNELS (master) dan WEBTERM_TELEGRAM (per-provider)**: untuk pengguna cukup satu saklar kartu "Aktif". Master pindah ke Lanjutan/env-saja (keputusan produk K1). Konsekuensi: UI menulis kedua kunci (atau menghapus override) saat Sambungkan. Kunci tetap di registry (T10).
- **Hot-apply**: agar "Menunggu mulai ulang" hilang, poller/sender perlu bisa start setelah token pertama (T5). Itu perubahan runtime, bukan UI; dijadikan workstream terpisah (WS-4), dan sebelum selesai banner restart dipertahankan.
- **Prasyarat tersembunyi**: ledger harus bukan off (T4) dan 5 prasyarat `WEBTERM_CENTRAL_TELEGRAM` (`envRegistry.ca2.ts:37-38`, `requires`) tidak dihitung sebagai bagian alur dasar; ditampilkan di Lanjutan dengan `EnvRequiresNote`.

## 7. Penanganan secret (butir d)

| Keadaan | Tampilan | Aksi |
|---|---|---|
| Kosong | field kosong, placeholder "Tempel token" | Sambungkan |
| Tersimpan | teks "Tersimpan" + empat karakter terakhir TIDAK ditampilkan (cukup panjang opsional) | Ganti (membuka field), Hapus (dengan konfirmasi) |
| Dikunci env | "Diatur lewat variabel lingkungan; tidak dapat diubah di sini." + lencana | tanpa aksi |
| Salah | pesan galat teks + `aria-describedby` | Coba lagi |

- Kontrak write-only dipertahankan: tes sudah memastikan nilai tak muncul di DOM maupun input (`ChannelsTelegramConfig.test.tsx` blok "never renders the token") `[BT]` barisnya; sesuai P-D dan R&D 52/53 (berkas 0600).
- Placeholder "Nilai baru (write-only)" diganti bahasa tujuan ("Tempel token baru"); ini mengubah dua kueri tes (T9).
- "Hapus token" adalah kemampuan baru: menghapus berkas secret dan menghentikan poller (butuh perilaku server, masuk WS-2).
- Jangan pernah mencetak token di log/error status (Rule 12).

## 8. Di mana nama env var terlihat (butir e)

| Lokasi | Tampilan nama env | Lencana "Dari .env" |
|---|---|---|
| Kartu Integrasi | tidak | tidak |
| Server & fitur (baris utama) | tooltip "ID: WEBTERM_X" pada ikon info (pola "Copy Setting ID" VS Code) | hanya bila dikunci env |
| Lanjutan | ya, monospace di bawah label | ya, bila dikunci |
| Pesan galat | tidak, kecuali alasan butuh (mis. "atur WEBTERM_X di .env") | tidak |

Alasan: pengguna tahu Telegram, bukan `WEBTERM_TELEGRAM_MODE`. Operator yang butuh nama tetap menemukannya di Lanjutan atau tooltip. Lencana "Diubah" (perbedaan dari default) dipertahankan karena berguna sebagai petunjuk reset `[opini]`.

## 9. Kebijakan bahasa label (butir f)

| Aturan | Contoh salah | Contoh benar |
|---|---|---|
| Bahasa Indonesia, kalimat tujuan | "Kanal utama" / "Telegram" saklar ganda | "Aktifkan Telegram" |
| Tanpa istilah mekanisme di permukaan utama | "Kosong = otomatis", "write-only", "boot" | "Dipilih otomatis", "Tersimpan", "Berlaku setelah mulai ulang" |
| Istilah teknis baku dibiarkan Inggris | | "token", "webhook", "polling" (dengan padanan sekilas) |
| Label <=40, deskripsi <=160 (invarian T10) | | tetap |
| Galat: apa, mengapa, apa yang dilakukan | "Failed" | "Token ditolak Telegram. Salin ulang dari @BotFather." |
| Konsisten dengan sisa Settings | campur Inggris/Indonesia | tentukan satu glosarium (lihat bawah) |

Glosarium usulan: kanal (channel), tersambung (connected), tersimpan (stored), mulai ulang (restart), lanjutan (advanced). Rule 15: semua string pindah ke satu berkas konstanta (`channelsLabels.ts` sudah melakukannya) dan tidak di-inline di JSX.


## 10. Aksesibilitas dan pencarian (butir g)

| Isu | Usulan | Dasar |
|---|---|---|
| Channels hilang saat mencari (T2) | Biarkan kartu ikut pencarian: hasil menampilkan kartu "Telegram" jika query cocok kata tujuan atau kunci (daftar sinonim: telegram, bot, token, webhook, kanal); polling dihentikan bukan dengan `null` melainkan dengan `enabled` pada hook | `ChannelsSection.tsx:17-20`; `useChannels.ts:15` |
| Saklar | `role=switch` + `aria-checked` + satu label (sudah di tes via `getByRole('switch')`) | APG Switch |
| Status | wilayah `aria-live="polite"` untuk perubahan status, bukan hanya warna; ikon + teks | WCAG 1.4.1 `[BT]` |
| Galat token | teks galat terkait `aria-describedby`, fokus kembali ke field | WCAG 3.3.1 |
| Navigasi sidebar | pertahankan panah/Home/End yang sudah diuji | `SettingsPanel.test.tsx:65` |
| Banner restart | `role=status`, tombol dapat difokus | `EnvRestartBanner.tsx` `[BT]` barisnya |
| Pencarian Lanjutan | hasil pencarian yang cocok kunci di dalam lipatan Lanjutan membuka lipatan otomatis | `[opini]` |

## 11. Risiko regresi dan tes

| Risiko | Tingkat | Mitigasi |
|---|---|---|
| Mengubah label bagian dan field memecah tes berbasis label | sedang | Ubah tes bersamaan; pegang daftar di bawah |
| Sambungkan menulis dua kunci; salah satu gagal | sedang | Satu PUT atomik (pola sudah ada: `putBodies` dalam tes) |
| Menghilangkan 404 sebagai sinyal merusak klien lama | rendah | Tambah field `reason`, pertahankan kode status lama |
| Menyembunyikan kunci mengira "dibuang" | rendah | tidak ada kunci dihapus dari registry; `KNOWN_KEYS_FROZEN` tetap hijau (T10) |
| Kebocoran token lewat respons tes koneksi | tinggi bila lalai | Server memanggil, mengembalikan hanya `{ok, botUsername, reason}`; tes memastikan nilai tak ada di body |
| Pencarian ikut Channels memicu polling tersembunyi | rendah | Hook `enabled` |

| Tes | Perlakuan |
|---|---|
| `envRegistry.invariants.test.ts` (`:22,185`), `envRegistry.parity.test.ts` | dipertahankan tanpa ubah |
| `ChannelsTelegramConfig.test.tsx` kontrak write-only dan satu PUT | dipertahankan (isi), kueri label diubah |
| `ChannelsSection.test.tsx`, `ChannelsEnvBridge.sa08.test.tsx` | diubah (struktur kartu, jembatan env) |
| `SettingsPanel.test.tsx` kueri nama tombol Channels/Environment, navigasi panah | nama diubah; perilaku panah, `aria-current`, Esc membersihkan query dipertahankan |
| `EnvSection.test.tsx`, `EnvEntryRow.test.tsx`, `envDraft.test.ts` | diubah bila lencana dan partisi Lanjutan berubah |
| Baru | status-reason server, tes koneksi (token tak bocor), pencarian menampilkan kartu, label tanpa nama env di permukaan utama |

## 12. Implikasi

### Rekomendasi tegas
1. **Opsi B**: "Channels" -> "Integrasi", "Environment" -> "Server & fitur" dengan lipatan "Lanjutan". Tidak ada kunci dihapus dari registry.
2. **Telegram = satu kartu** dengan status dan alasan nyata; alur **C1** (tempel token -> Sambungkan -> `getMe` -> status); mode otomatis tetap; webhook hanya di Lanjutan.
3. **Secret**: Tersimpan / Ganti / Hapus; nama env hanya di Lanjutan dan tooltip.
4. Hot-apply token pertama dikerjakan sebagai workstream runtime terpisah; sebelum itu pakai banner "Mulai ulang".

### Keputusan produk (butuh user)

| # | Keputusan | Default saran | Opsi veto |
|---|---|---|---|
| K1 | Pindahkan `WEBTERM_CHANNELS` (master) ke Lanjutan/env-saja; satu saklar "Aktif" per kartu | Ya | Pertahankan master terlihat |
| K2 | Ganti nama bagian: "Integrasi" dan "Server & fitur" | Ya | Pakai "Kanal" dan "Lingkungan" |
| K3 | Tambah tombol **Tes koneksi** dan **Hapus token** (kemampuan baru) | Ya | Hanya status pasif |
| K4 | Seluruh label termasuk `aria-label` navigasi jadi Indonesia | Ya | Biarkan Inggris untuk aria |
| K5 | Webhook tetap didukung tetapi hanya Lanjutan | Ya | Hapus mode webhook dari UI sepenuhnya (kunci tetap di env) |
| K6 | Lencana "Dari .env" hanya bila dikunci env | Ya | Tampil di semua baris seperti sekarang |
| K7 | Wizard tautkan chat (C2) tahap 2 | Tunda | Masuk rilis ini |

### Workstream usulan

| WS | Nama | Berkas milik | Ukuran | Tes dijaga |
|---|---|---|---|---|
| WS-1 | Struktur sidebar + Lanjutan + glosarium label | `SettingsPanel.tsx`, `envLabels.ts`, `envSectionLabels.ts`, `channelsLabels.ts`, `EnvSection.tsx`, `envDraft.ts` | M | `SettingsPanel.test.tsx`, `EnvSection.test.tsx`, `envDraft.test.ts`, invarian registry |
| WS-2 | Kartu Telegram + alur Sambungkan + secret Ganti/Hapus | `ChannelsSection.tsx`, `ChannelsTelegramConfig.tsx`, `EnvSecretField.tsx`, `ChannelsLists.tsx` | M | `ChannelsTelegramConfig.test.tsx` (write-only, satu PUT), `ChannelsSection.test.tsx` |
| WS-3 | Status beralasan + endpoint tes koneksi | `channelStatus.ts`, `channelStatusHttp.ts`, `useChannels.ts`, `channelsApi.ts` (baru: handler tes) | M | tes status server, tes token tak bocor |
| WS-4 | Hot-apply start poller/sender saat token pertama | `telegramPollWiring.ts`, `channelSenderBoot.ts`, `index.ts` | M-L | tes round-trip Bun poller, sessions |
| WS-5 | Pencarian menyertakan kartu + a11y (`aria-live`, `enabled`) | `SettingsPanel.tsx` (koordinasi dengan WS-1), `useSettingsSearch`, `ChannelsSection.tsx` | S | `SettingsPanel.test.tsx` blok pencarian |

Urutan: WS-3 dan WS-1 paralel (berkas berbeda), WS-2 setelah WS-3, WS-5 setelah WS-1 (berkas `SettingsPanel.tsx` bentrok), WS-4 lepas dan bisa menyusul. Dokumen rangkuman (README/CHANGELOG) sekali di akhir oleh satu worker.
