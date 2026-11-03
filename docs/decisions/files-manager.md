# File manager: keputusan desain (P-1..P-15)

Sumber lengkap: `PLAN/FILEMANAGER-a.md` (tujuan, keputusan, workstream), `-b.md` (kontrak, keamanan, risiko), `-c.md` dan `-d.md` (spec per workstream). Dokumen ini hanya merangkum keputusan dan alasannya supaya tetap terbaca setelah PLAN dihapus.

## Keputusan

| ID | Keputusan | Alasan |
|----|-----------|--------|
| P-1 | Delete default masuk trash buatan sendiri (`<data dir>/trash/<id>`, retensi 30 hari) dengan Undo; `permanent` hanya eksplisit. | Hapus permanen tanpa jalan kembali terlalu mahal untuk salah klik; rename ke trash OS tidak portabel di server headless. |
| P-2 | Tampilan v1 = list satu direktori, bukan tree. | Tree butuh perubahan model seleksi; ditunda sampai ukurannya terukur. |
| P-3 | Nol dependency baru. | Rule 10; semua fitur cukup dengan `node:*` dan primitive yang sudah ada. |
| P-4 | File non-UTF-8 dibuka read-only dengan banner; biner murni tampil placeholder dan tidak memuat Monaco. | Menulis balik Latin-1/UTF-16 dengan benar butuh deteksi encoding; menyimpan hasil decode lossy merusak file. |
| P-5 | `raw` memakai token di query (pola `fsClient.url`) plus `Referrer-Policy: no-referrer` dan `Cache-Control: private, no-store`. | Elemen `<img>`/`<video>` tidak bisa mengirim header. Ticket sekali-pakai ditunda; query tidak pernah dicatat, log hanya basename. |
| P-6 | DNS-rebinding TIDAK ditutup. | Butuh allowlist Host di `auth.ts`, area lain. Lihat catatan di bawah. |
| P-7 | Quick Open `Ctrl/Cmd+P` hanya saat fokus ada di dalam node files. | Global akan bentrok dengan print browser dan shell. |
| P-8 | File baru langsung dibuka di editor. | Meniru Explorer. |
| P-9 | File hidden tetap tampil (ada toggle); yang di-ignore diredam. | Tidak mengubah perilaku yang sudah dikenal user. |
| P-10 | Sort natural-numeric, folder dulu; toggle nama/ukuran/mtime. | Daftar `file2` sebelum `file10`. |
| P-11 | Enam flag `WEBTERM_FILES_*` default OFF; empat perbaikan P0 tidak di balik flag. | Fitur baru bisa dimatikan; perbaikan keselamatan data harus selalu hidup. |
| P-12 | Konflik simpan = banner Reload / Overwrite, tanpa diff 3-arah. | Diff adalah fitur terpisah; buffer user tidak pernah dibuang diam-diam. |
| P-13 | Write atomik (tmp + rename) untuk file reguler `nlink=1`; selain itu fallback in-place (hardlink, pemilik lain, dir tak writable). | Agent yang membaca bersamaan tidak boleh melihat file setengah tertulis; hardlink akan putus bila di-rename-over. |
| P-14 | Tabrakan nama beda-huruf = konflik (`EEXIST`); rename yang hanya mengganti huruf diizinkan. | FS case-insensitive tidak bisa menampung keduanya. |
| P-15 | Opsi tampilan per node (`viewOpts`: hidden, sortKey, sortDir) dipersist di workspace; absen = default. | Pilihan user bertahan lintas restart. |

## Catatan P-6: DNS-rebinding tidak ditutup

Server tidak memeriksa header `Host`. Halaman web luar yang berhasil me-rebind nama domain ke alamat server dapat mengirim request same-origin ke `/api/fs/*`. Satu-satunya pagar adalah token (`WEBTERM_TOKEN`), yang opsional pada bind loopback. Perbaikan yang benar (allowlist Host/Origin di `auth.ts`) belum dikerjakan dan diusulkan sebagai workstream keamanan terpisah. Jangan menganggap file manager aman terhadap serangan ini.

## Kontrak slot (`src/client/filesSlots.ts`)

`FilesNode` merender `FILES_SLOTS` tanpa tahu isinya; tiap fitur mengisi file slot-nya sendiri dan menyaring diri lewat `capabilities()`.

- `FilesSlot`: `id` plus opsional `menu(ctx)`, `onKey(e, ctx)` (true = tombol ditangani, FilesNode berhenti), `decorate(entry, ctx)`, `toolbar(ctx)`, `overlay(ctx)`, `useSlot(ctx)`.
- `FilesSlotCtx`: `cwd`, `dir`, `entries`, `selection` (nama, bukan indeks), `refresh(select?)`, `startInput(req)` (input nama inline untuk file/folder baru atau rename; menggantikan `window.prompt`), `open(entry)`, `nodeId`.
- Urutan `FILES_SLOTS` tetap: mutate, git, watch, search, dnd, upload. `useSlot` dipanggil tiap render dalam urutan itu, jadi aman terhadap aturan hooks; menambah atau menukar urutan harus mempertahankan jumlah hook yang konstan.
- Kontrak lintas-lapisan (kode galat, tabel status HTTP, `FsVersion`, `FsCapabilities`) dibekukan di `src/shared/fsContract.ts`; mengubahnya mempengaruhi server, klien, dan WebSocket.

## Batas v1 yang diketahui

- Pencarian Quick Open: urutan sumber `rg --files` lalu `git ls-files`, lalu penelusuran `fs`. Fallback terakhir (tanpa rg dan tanpa repo git) TIDAK membaca `.gitignore`; hanya `.git` dan `node_modules` dilewati.
- Drop path ke terminal yang sesinya sudah exit dibuang diam-diam oleh `send` di `src/client/ws.ts`, jadi tidak ada yang tertulis atau dieksekusi. Path yang di-drop tidak pernah diakhiri newline.
- `capabilities()` fail-closed: bila request gagal, semua fitur opsional (mutate, viewers, watch, git, quickOpen, upload) dianggap mati, bukan ditebak hidup.
- Belum terbukti di browser nyata: Monaco, upload 100 MB, progres XHR, drag native, paste ke xterm. Belum terbukti: `fs.watch` di macOS di bawah Node dan reconnect WebSocket nyata.
