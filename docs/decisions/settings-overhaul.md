# Settings overhaul: simple, automatic, transparent

Status: disetujui arah oleh user 2026-11-12 ("sebar agent untuk memperbaiki semuanya"). Disusun dari tiga kajian read-only
(wkr-review-464 Editor/Workspace/System, wkr-review-465 Agents, wkr-review-466 shell/komponen/setting mati) plus audit
sebelumnya (Claude IA, default, tombol aksi, shortcut).

## Prinsip

1. Sistem yang memutuskan bila bisa (deteksi, default maksimal). Setting hanya untuk preferensi nyata.
2. Paling banyak ±5 kontrol terlihat per halaman; sisanya di satu disclosure "Advanced".
3. Tiap aksi: sibuk → hasil baru dengan waktu → gagal dengan alasan + Retry (`components/ui/action.tsx`).
4. Kontrol nonaktif: fungsi tetap terlihat + alasan + tombol perbaikan (`lock`).
5. Tidak ada baris info yang menyamar sebagai setting; status = satu baris teks.
6. Tidak loncat halaman: atur di tempat; bila perlu tautan, tautan membuka field yang tepat (`?settings=&field=`).
7. Bahasa awam, satu kalimat hint, tanpa jargon.

## Anatomi field

Label (sentence case, tanpa prefix halaman) · titik "modified" · hint ≤1 kalimat (string, terbaca search) · kontrol +
status inline (Saving… / Saved ✓ / error) · tombol Reset terlihat saat modified · `lock` bila nonaktif · `data-field`.
Nilai sementara (pending) ditampilkan segera; gagal = kembali + pesan di tempat; toast hanya setelah server mengonfirmasi.

## Struktur sidebar baru

| Grup | Halaman | Isi utama |
|---|---|---|
| General | Appearance | Theme Light/Dark/System, skema warna terminal (preview), font (hanya yang terpasang), ukuran font, kursor, background canvas (satu kontrol "workspace ini: sama / kustom") |
| | Terminal | Copy on select, "Shortcut ke: webterm dulu / program dulu", History length (satu kontrol untuk dua buffer). Advanced: weight, line height, letter spacing, word separators, shell (deteksi), contrast |
| | Canvas | Grid (off/dots/snap), quick move & resize, folder project. Advanced: grid size, kabel |
| | Notifications | Notifikasi desktop (status izin asli), suara. Mute per workspace pindah ke menu workspace |
| | Keyboard Shortcuts | Editor shortcut (tabel, rekam, bentrok, reset) |
| Claude | Claude | Connection (satu pilihan + test bertahap + baris "perintah yang dipakai"), Permissions (satu pilihan 3 level), Models ("dipilih otomatis", ladder dilipat), Advanced (profil tambahan, CLI kustom, simulator, header kredensial) |
| | Central | On/off, apa yang boleh dilakukan, check-in, satu batas biaya harian (live "terpakai / batas"). Advanced: workers per hari, check-in per hari |
| Safety | Rules & secrets | Daftar aturan + "Always allow / block" dari kartu persetujuan terbaru; secrets |
| Account & system | Account | Seperti sekarang, satu Sign out |
| | Features | (dulu Capabilities) Browser, Files (+ izin edit), Telegram. Advanced: lokasi Chromium, Reset (konfirmasi + umpan balik) |
| | Health | Status; setiap "pergi ke X" menjadi tautan field atau perbaikan di tempat |

Keluar dari Settings (satu tautan masing-masing): Memory (satu daftar) dan Automations ke panel Central; laporan Spending
ke Control panel; Developer hanya di mode developer.

## Dihapus / otomatis

Agent default (mati), engine Central (selesai), GPU rendering, inactive cursor style, ukuran node baru (ingat ukuran
terakhir), minimum contrast (4.5 tetap), default model provider + model Central + model per workspace di Settings (ladder;
override per workspace pindah ke menu workspace), context window (dari model), batas waktu/langkah per balasan (dari tier
model), token budget harian (cukup batas dolar), skill on/off (selalu menyala), baris info Browser/Telegram/Report/Ladder,
duplikat scrollback, dua Sign out, flag env turunan yang tidak dibaca runtime (verifikasi dulu).

## Catatan pelaksanaan W2b

- Theme "System" = nilai `auto`, kini mengikuti `prefers-color-scheme` OS (deviasi sadar dari referensi eksternal, yang
  `auto`-nya mengikuti tema terminal; di referensi eksternal tidak ada mode developer — referensi lokal `referensi-eksternal`).
- Developer mode: `localStorage` per browser (`client/developerMode.ts`), dinyalakan dari Health › "Show developer
  tools" atau `?dev=1` (`?dev=0` mematikan). Tautan langsung ke `?settings=developer` tetap membuka halamannya.
- Doctor memberi `go: { field }` terstruktur; klien mencari halamannya di indeks pencarian.

## Keputusan

Diputuskan user 2026-11-12:

- Default izin agent = **Ask for risky things** (aksi tak bisa dibatalkan bertanya dulu; nilai eksplisit lama dipertahankan).
- Secret "Allow agents to use this" = selamanya, **hanya agent di project/workspace tempat tombol ditekan**.
- File pembungkus lama `MemorySection`/`AutomationsSection`/`SpendingSection` dihapus (pindah ke panel Control).

## Gelombang

1. Fondasi (paralel): jalur simpan + status inline + pending value; shell (search index tanpa mount halaman, prefix,
   Escape combobox, Reset terlihat, responsif); bug & setting mati (defaultAgent, auto=manual, max workers, hint biaya,
   value-in-options) + policy test setting mati.
2. Restrukturisasi (paralel): Claude + Central; General + Account/Features/Health; pindahan Memory/Automations/Spending/Rules.
3. Default maksimal + safeguard, editor Keyboard Shortcuts + label + bug Ctrl di Linux/Windows, sisa migrasi ActionButton
   (daftar PENDING menyusut ke nol).

Setiap gelombang: worker hanya test terkait; merge dengan gate cepat; suite penuh di latar belakang setelah batch.
