# 40 — Audit UI/UX Settings > Environment (bagian b)

Lanjutan dari `40-ENV-UIUX-AUDIT-a.md` (§1-§6: ringkasan, struktur, pola simpan, badge, kontrol, default/nilai efektif). Bagian ini: §7-§12. Label: `[BT]` belum terverifikasi, `[opini]` penilaian. Keparahan P0 menyesatkan/aksi salah, P1 membingungkan, P2 polish.

## 7. Dependensi antar-flag

Hubungan ada hanya sebagai kalimat di deskripsi: Telegram "butuh ledger hidup" (`envRegistry.channels.ts:18`), Central chat "butuh Central aktif" (`central.ts:8`), planner "butuh tools=write" (`central.ts:15`); di `ca2-int` Agen central butuh tools=write + planner + orchestrator run. UI tidak mengevaluasinya: user bisa menyalakan Telegram dengan Ledger `off` dan tidak ada yang terjadi, tanpa peringatan. Konsekuensinya sama dengan kebingungan "kenapa fitur tak jalan". **P0.**

Usulan perilaku (butuh metadata `requires` dari topik 3):

| Kondisi | Tampilan |
|---|---|
| Flag aktif, prasyarat belum terpenuhi (nilai draft+server) | Peringatan inline di baris: "Belum berpengaruh: butuh Ledger = on" + tombol "Buka Ledger" (scroll+fokus). Jangan disable `[opini]`: prasyarat bisa dipenuhi dari luar (env), dan disable menghalangi urutan edit. |
| Flag induk (mis. Central) off | Baris anak diredupkan dan dilipat di bawah induk. |
| Prasyarat butuh restart | Satu kalimat: "berlaku setelah restart bersama Ledger". |

## 8. Error, validasi, pencarian

| # | Temuan | Bukti | Sev |
|---|---|---|---|
| E1 | Validasi hanya di server dan alasan berbahasa Inggris ("not an allowed option", "out of range") dibungkus kalimat Indonesia "Nilai ditolak server: out of range." | `envSettings.validate.ts:17-35`, `envSettingsApi.ts:78` | P1 |
| E2 | Error baris tetap tampil walau user sudah mengubah input (hanya dibersihkan saat `apply` berikutnya untuk kunci itu). Tak ada `aria-invalid`/`aria-describedby` pada input; error ada di bawah catatan Default/Reset. | `useEnvSettings.ts:52`, `EnvEntryRow.tsx:78`, `EnvValueControl.tsx:32-34` | P1 |
| E3 | Pesan "Butuh token root" diulang di setiap baris dangerous yang tak bisa diedit (7 sekarang, 8 di `ca2-int`). Penyebab nyata di mode loopback tanpa token: `rootGate` = token terkonfigurasi (`envSettings.runtime.ts:37`), jadi TANPA `WEBTERM_TOKEN` semua baris dangerous terkunci selamanya dari UI, dan pesannya salah arah ("butuh token" padahal token memang belum ada). | `EnvEntryRow.tsx:75-77`, `envSettings.service.ts:131`, `envSettings.runtime.ts:37` | P1 |
| E4 | Pencarian Settings tidak menjangkau Environment: `EnvSection` mengembalikan null saat ada query. Baris Env tidak memakai `Field` (tak ada `data-slot="settings-field"`), jadi hitungan "N setting ditemukan" dan filter label/hint tidak berlaku. Mencari "telegram" tidak menemukan Token bot; mencari `WEBTERM_LEDGER` (KEY) pun tidak. `Field` hanya mencocokkan label+hint. Grup kosong sengaja disembunyikan CSS (`settings.css:312`), jadi tidak tampil judul kosong; tetapi user cukup melihat "Tidak ada setting yang cocok". | `EnvSection.tsx:13-16`, `SettingsPanel.tsx:66`, `SettingsFields.tsx:90`, `settings.css:312-314,335` | P1 |
| E5 | Tidak ada filter cepat ("Diubah", "Perlu restart", "Berbahaya") padahal user sudah punya tombol/badge untuk status itu. | — | P2 |

Akar E4: hook data sengaja hanya hidup saat section dirender agar tidak fetch di belakang hasil pencarian (`EnvSection.tsx:1-2`). Solusi tanpa fetch: indeks statis dari metadata registry yang dikirim sekali ke klien, atau naikkan hook ke `SettingsPanel` dengan cache.

## 9. Aksesibilitas, responsif, bahasa, konsistensi

**A11y**

| # | Temuan | Bukti | Sev |
|---|---|---|---|
| A1 | `<li aria-label={KEY}>` menamai item dengan KEY mentah, bukan label manusia; label tampak `<strong>`, tidak terhubung ke kontrol (tanpa `htmlFor`). | `EnvEntryRow.tsx:45,48` | P1 |
| A2 | Nama kontrol `Label (KEY)` (`EnvValueControl.tsx:15`) benar tetapi panjang; tombol `Simpan KEY` di tiap baris membuat daftar tombol layar-pembaca berisi puluhan item serupa. | `EnvEntryRow.tsx:58` | P2 |
| A3 | Badge/penanda status hanya visual (span); tanda "terubah" = bar warna + tag, tanpa teks tersembunyi tentang "diubah". Alasan disabled (dangerous/locked) tidak dihubungkan lewat `aria-describedby`. | `EnvEntryRow.tsx:19-29,75` | P2 |
| A4 | Fokus hilang setelah Simpan (V4). Perubahan yang berhasil/gagal tidak diumumkan (tak ada `role=status` per baris). | `EnvEntryRow.tsx:59` | P1 |

**Responsif**

| # | Temuan | Sev |
|---|---|---|
| R1 | `.st-env-ctl` flex-wrap dan input 320px dengan `max-width:100%` (`settings-env.css:12-24`) — aman. `code.st-env-key` tanpa `overflow-wrap` (`:26-29`): KEY terpanjang (`WEBTERM_CENTRAL_DAILY_COST_MICROS`, 33 karakter) bisa meluap di lebar sempit. | P2 |
| R2 | Pada ≤720px sidebar tetap 150px (`settings-controls.css:276-280`); di ponsel 360px sisa ±210px untuk konten, 3 tombol wrap ke 2-3 baris. Berlaku untuk semua tab, bukan khusus Env `[BT]` tak diuji di browser. | P2 |

**Bahasa** (campuran Indonesia/Inggris tanpa kaidah):

| Lokasi | Contoh |
|---|---|
| Tab | "Interaksi", "Shell & buffer", "Channels", "Environment", "Preview" |
| Grup/label registry | "Kanal" (grup) vs "Channels" (tab); "Memori" vs "Memory files"; "Orchestrator run", "Run wajib approval", "Level log", "File log", "Buffer log" |
| Badge/tombol | `restart`, `override`, `env`, `default`, "berbahaya", "Reset" vs "Hapus" vs "Simpan" |
| Dialog | Judul "Settings", deskripsi Inggris (`SettingsPanel.tsx:115-116`), placeholder "Cari setting" |
| Error | Alasan Inggris di kalimat Indonesia (E1) |

Usul glosarium `[opini]`: UI Indonesia; istilah teknis yang tidak ada padanan baku tetap Inggris (token, webhook, worker, runtime). Badge: "Diubah", "Restart", "Berlaku langsung", bukan `override/env/default`.

**Konsistensi dengan tab lain dan VS Code**

| Aspek | Tab lain / VS Code | Environment |
|---|---|---|
| Simpan | Autosave per perubahan (`SettingsPanel` `onChange`) | Simpan per baris |
| Modified | "(Modified)" + bar + gear Reset, muncul saat hover (`SettingsFields.tsx:103-113`) | Tag `override` + tombol Reset teks + catatan bantuan, selalu terlihat |
| ID setting | VS Code: di menu gear "Copy Setting ID" `[BT]` | KEY selalu tercetak sebagai baris tersendiri |
| Boolean | Checkbox + deskripsi sejajar (`st-checkline`) | Checkbox di bawah deskripsi |
| Pencarian | Semua tab | Tidak ikut |
| Kolaps/filter lanjutan | VS Code: `@modified`, `@tag:advanced`, `@feature` `[BT]` | Tidak ada |

## 10. Konflik dengan tab Channels

- K1: Channels hanya menampilkan status + binding Telegram, read-only (`ChannelsSection.tsx:35-52`), sedangkan nilai konfigurasinya (aktif, mode, token) diedit di Environment. Dua halaman, dua istilah ("Mode masuk Telegram" vs "Mode", "Token bot Telegram" vs "Bot token"), tanpa tautan silang.
- K2: Pesan "Channel Telegram nonaktif" menyuruh mengisi `WEBTERM_TELEGRAM=on` dan `TELEGRAM_BOT_TOKEN` "di environment server, lalu restart" (`channelsLabels.ts:7-9`). Nama variabel salah (seharusnya `WEBTERM_TELEGRAM_BOT_TOKEN`) dan cara itu usang karena Environment bisa menyetelnya langsung. **P0** (instruksi salah).
- K3: Toggle `WEBTERM_TELEGRAM`, `WEBTERM_CHANNELS`, mode, token, webhook secret idealnya hidup di Channels (atau Channels menyematkan grup itu dari registry), Environment hanya menyimpan sisanya. Keputusan vonis per entri ada di `39-...`.

## 11. Tabel celah ringkas (urut prioritas)

| ID | Celah | Sev | File utama |
|---|---|---|---|
| P0-1 | Dependensi flag tidak dievaluasi (silent no-op) | P0 | `EnvEntryRow.tsx`, `EnvSection.tsx` + metadata `requires` |
| P0-2 | Nilai `.env` nonkanonik/di luar opsi tampil salah (flag `ON`, enum asing) | P0 | `EnvValueControl.tsx:21,27`, `envSettings.service.ts:134` |
| P0-3 | Bootstrap/infra jadi baris "setting" (10 baris tanpa aksi) | P0 | `EnvSection.tsx:30-40,65-67`, `envRegistry.ts:17-28` |
| P0-4 | Channels memberi instruksi env yang salah dan usang | P0 | `channelsLabels.ts:7-9` |
| P1-1 | Breadcrumb + label identik grup + 4-6 baris meta per baris | P1 | `EnvEntryRow.tsx:45-79` |
| P1-2 | Simpan per baris, draft hilang, tanpa indikator belum-disimpan | P1 | `EnvEntryRow.tsx`, `useEnvSettings.ts` |
| P1-3 | Badge `default/env/restart` di semua baris; arti tak dijelaskan | P1 | `EnvEntryRow.tsx:18-31`, `envLabels.ts:53` |
| P1-4 | Banner restart: KEY mentah, tanpa aksi, hilang saat unmount | P1 | `EnvSection.tsx:58-60`, `useEnvSettings.ts:28` |
| P1-5 | Pencarian Settings tidak menjangkau Environment | P1 | `EnvSection.tsx:13-16`, `SettingsFields.tsx:90` |
| P1-6 | Rentang/satuan/path tak sampai ke klien; kosong ditolak | P1 | `envSettingsApi.ts:12-29`, `envSettings.validate.ts:31` |
| P1-7 | Error Inggris, basi, tak terhubung ke input; fokus hilang setelah Simpan | P1 | `envSettingsApi.ts:78`, `EnvEntryRow.tsx:59,78` |
| P1-8 | Dangerous tanpa token: pesan salah arah, diulang tiap baris | P1 | `EnvEntryRow.tsx:75-77`, `envSettings.runtime.ts:37` |
| P1-9 | IA grup (urutan, logging di Kontrol, tanpa kolaps/lanjutan) | P1 | `envLabels.ts:39-51`, `envRegistry.platform.ts` |
| P2 | Segarkan terpisah, CSS bersilang Channels, `aria` item, KEY overflow, bahasa campur, nilai aktif vs tersimpan, filter cepat | P2 | lihat §2-§9 |

## 12. Implikasi untuk webterm

**Rekomendasi tegas** `[opini]`, dari paling bernilai:

1. **Bentuk satu model simpan** (V1-V4): draft terpusat di hook (`Map<key,string>`), bar sticky di atas daftar ("N perubahan belum disimpan" + "Simpan" + "Buang"), satu PUT atomik (server sudah siap). Secret tetap dialog/field sendiri. Kunci `dangerous` dengan konfirmasi singkat sebelum PUT. Jangan autosave: toggle seperti otonomi central menjalankan worker nyata.
2. **Rapikan baris**: hapus breadcrumb, KEY pindah ke baris kecil mono (atau tooltip/menu "Salin nama"), tampilkan badge hanya bila berbeda dari normal ("Diubah", "Perlu restart", "Berbahaya"), Default hanya bila ≠ nilai, bantuan Reset jadi `title`. Target ≤3 baris per entri.
3. **Pisahkan tiga kelas isi** (butuh `audience` dari topik 3): fitur (default terlihat), lanjutan (kolaps), info server read-only (kolaps, atau buang bagian bootstrap dari daftar dan tampilkan status `locked`/token dalam satu kartu). Ganti judul tab menjadi "Fitur & server" `[opini]`.
4. **Dependensi hidup** (§7) dengan `requires` di registry + evaluator murni di klien.
5. **Perbaiki kebenaran tampilan** (P0-2): server mengirim nilai kanonik + flag `valid:false` bila nilai env tidak lolos validator; klien menampilkan "Nilai tidak sah: 'ON' (dibaca sebagai off)" dan menolak `select` kosong.
6. **Kirim metadata kontrol** ke klien: `min,max,unit,absolutePath,optionLabels,allowEmpty,pattern hint`, sehingga validasi klien dan deskripsi opsi mungkin.
7. **Pencarian**: indeks statis dari metadata (label, KEY, deskripsi, grup) sehingga Environment ikut hasil tanpa memuat state; baris Env memakai wrapper `data-slot="settings-field"`.
8. **Pindahkan Telegram ke Channels** (atau sematkan) + perbaiki teks K2 sekarang juga (satu string).

**Perubahan konkret per file** (klien saja; menghindari `envRegistry*.ts` yang disentuh WS-19 integrator CA2 sampai selesai):

| File | Perubahan |
|---|---|
| `EnvSection.tsx` (split) | Header + bar simpan sticky, banner dari `entries.filter(pendingRestart)`, grup kolaps, kartu info server |
| `EnvEntryRow.tsx` | Baris ramping, `<label htmlFor>`, `aria-describedby`, fokus kembali |
| `EnvValueControl.tsx` | Normalisasi flag, state "nilai tak sah", unit/rentang |
| `useEnvSettings.ts` | Draft map, dirty set, simpan atomik, `loading` saat refresh |
| `envLabels.ts` | Glosarium Indonesia, badge baru, urutan grup dari metadata |
| `channelsLabels.ts:7-9` | Perbaiki nama var + tautan ke Environment |
| `settings-env.css` | Pindahkan kelas `st-ch-*` yang dipakai ke sini |
| `envSettingsApi.ts` (+ server `envSettings.service.ts`) | Tipe metadata baru; tahap kedua setelah registry stabil |

**Risiko**: model draft terpusat mengubah ~14 tes `EnvSection.test.tsx` (tak ada tes pencarian, a11y, kehilangan draft: tambah). Metadata baru menyentuh kontrak API (`/api/settings/env`) dan registry yang dikerjakan paralel; hindari konflik dengan WS-19 lewat urutan: klien dulu (data lama kompatibel), server+registry setelah merge. Kunci dangerous tanpa token tetap tidak bisa diubah dari UI; itu keputusan keamanan, bukan bug.

**Belum terverifikasi**: tinggi baris nyata dan perilaku fokus di browser (dilarang membuka browser); apakah `<select>` kosong benar-benar jatuh ke opsi pertama di React 19 versi proyek (perilaku DOM standar, tak dites); detail menu gear/`@tag` VS Code 2026 (pengetahuan umum); jumlah entri `ca2-int` mengikuti snapshot worktree hari ini.

**Estimasi**: rekomendasi 1-2-5 + teks K2 = **M**; 3-4-6-7 (butuh metadata server + registry) = **L**; seluruhnya dua gelombang (klien dulu, server+registry setelahnya).
