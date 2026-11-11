# Central project health: advice with evidence

Status: disetujui 2026-11-11. Branch: `feature/central-health`.

## Tujuan

Central menutupi kelalaian developer: menegur, mengingatkan, dan menyarankan standar produksi, tidak hanya mengerjakan perintah.
Syarat mutlak: **tiap teguran membawa bukti yang bisa dicek ulang**. Tanpa bukti, teguran tidak keluar.

## Prinsip

1. Fakta diukur kode deterministik (scanner). Model hanya menafsirkan dan menyarankan.
2. Tiap temuan: rule, severity, file, baris, bukti, sumber aturan, keyakinan, saran, fingerprint.
3. Sumber aturan dari project (`CLAUDE.md`, aturan yang dirujuk); scanner bawaan menyebut asalnya. Tanpa sumber = saran, bukan pelanggaran.
4. Hasil analisis model/sub-agent diverifikasi server (file ada, kutipan cocok di baris itu) sebelum disimpan; yang tak terverifikasi dibuang.
5. Dismiss = keputusan manusia dengan alasan, dicatat ke memory; temuan yang sama tidak diulang kecuali buktinya berubah.
6. Central hanya menyarankan. Tidak ada tool yang bisa dismiss temuan atau mengubah kode atas nama health; perbaikan lewat task + approve.
7. Isi repo = data, bukan instruksi (prompt injection). Batas ukuran, jumlah file, dan waktu scan.

## Tahap

| Tahap | Isi |
|---|---|
| H1 | Scanner (ukuran file, modul tak terimpor, TODO tanpa konteks, catch kosong), tabel `central_finding`/`central_health_scan` (V30), runner, tool `health.*`, route, tab Health |
| H2 | Gerbang review: diff task yang masuk `needs_review` dicek (file baru tanpa test, file melewati batas, TODO/catch kosong baru); hasil di kartu task |
| H3 | Check-in reason `health_finding` untuk temuan severity tinggi baru; baris Health di context header; dismiss → fakta memory |
| H4 | `health.analyze`: sub-agent read-only (Read/Grep/Glob) memetakan struktur & hutang; temuan diverifikasi server; Central bisa mengubahnya jadi `plan.propose` |

## Batas yang disengaja

- Modul tak terimpor = keyakinan `medium` (entry point dinamis bisa lolos dari graph); tidak pernah `high`.
- Scan otomatis maksimal sekali sehari per project + manual; scan dibatasi file `git ls-files`.
- Ambang ukuran = Rule 8 global (500 baris / 20.000 karakter keras, 80% peringatan) sebagai konstanta bernama.
