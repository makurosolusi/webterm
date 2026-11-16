# 36 — File manager: viewer, preview, dan dukungan format

Topik 2 R&D file manager. Basis: worktree `rnd-files` (dari `main` fdaf2b4), tanggal 2026-11-03. Label: `[BT]` belum terverifikasi, `[opini]` pendapat penulis. Versi/lisensi paket dari `npm view` hari ini.

## 1. Temuan utama

1. **P0 kehilangan data: file media dibuka sebagai teks.** `fileOpenTarget` mengembalikan `canvas` untuk audio/video (`fileBrowse.ts:216-218`), tetapi `FilesNode.open` selalu membuat node `editor` (`FilesNode.tsx:142`) dan `editorFileKind` hanya mengenal `image|pdf|text` (`editorFile.ts:39-44`). Tidak ada player di webterm (`<video>`/`<audio>` tidak ada di `src/client`; referensi eksternal punya `VideoNode.tsx`). mp4 <=10 MB dibaca `readFile(...,'utf-8')` (`fsOps.ts:189`), byte tak sah jadi U+FFFD, lalu ⌘S menulis balik (`EditorNode.tsx:210` memanggil `save()` tanpa cek `dirty`, `:99-117`). File asli rusak permanen.
2. **Pola sama untuk semua biner di luar denylist.** `OS_OPEN_EXTENSIONS` adalah denylist pendek (`fileBrowse.ts:177-182`). `.jar .class .docx .xlsx .pptx .ttf .woff2 .psd .pyc .so .parquet` dan sejenisnya lolos ke Monaco sebagai teks.
3. **Kodek teks tidak dijaga.** Non-UTF-8 (Latin-1, UTF-16, Shift-JIS) jadi U+FFFD saat baca lalu tersimpan rusak. BOM dibuang Monaco (`pieceTreeTextBufferBuilder.js:71-72`; `getValue` tanpa `preserveBOM`, `textModel.js:546-553`). EOL campuran dinormalkan ke dominan (`pieceTreeTextBufferBuilder.js:38-40`). Semua terjadi senyap.
4. **Transport gambar/PDF boros.** JSON base64 (+33%), `atob`, lalu loop `charCodeAt` per byte (`editorFile.ts:101-102`); cap 24 MB (`fsLimits.ts:12`). Tidak ada Range, ETag, atau cache, sehingga video dan file besar tidak mungkin.
5. **Server tanpa header keamanan sama sekali.** Tidak ada `nosniff`, CSP, atau `Content-Disposition` di `src/server/*` selain `Content-Type` (`api.ts:34`, `index.ts:146`). Aman hari ini karena semua isi file dibungkus JSON; ia **langsung jadi risiko** begitu ada endpoint raw (bagian 6).
6. **Tiga tabel ekstensi terpisah:** `IMAGE_MIME` (`editorFile.ts:13`), `VIDEO/AUDIO/OS_OPEN` (`fileBrowse.ts:171-182`), `BY_EXT` ikon (`fileIcon.ts:5`). Tidak ada satu sumber kebenaran, dan tidak ada deteksi isi.

## 2. Yang sudah didukung sekarang

| Jenis | Cara tampil | Bukti | Catatan |
|---|---|---|---|
| Teks/kode | Monaco 0.57.0 lazy; bahasa dari `Uri.file(path)` | `lazyMonaco.tsx:21-62`, `EditorNode.tsx:200-202` | Worker json/css/html/ts; bahasa lain lewat chunk per-bahasa (`dist/assets/abap-*.js` dst., terukur) |
| Teks >10 MB | Ditolak: "File too large" | `fsLimits.ts:11`, `editorFile.ts:75-80` | Aman dari data loss, tanpa jalan masuk alternatif. Ambang tokenisasi Monaco sendiri 20 MB/300K baris (`textModel.js:120-121`) |
| Gambar png/jpg/gif/webp/bmp/ico/svg/avif | `<img src=data:>` | `EditorNode.tsx:130,254-264` | Tanpa zoom/pan; ukuran px tampil (`:260`); latar kotak-kotak (`editor.css:100-106`); SVG tidak bisa dilihat sumbernya |
| PDF | `blob:` + `<iframe>` viewer browser | `EditorNode.tsx:161,268` | Zoom/cari/print dari browser; `revokeObjectURL` benar (`:172`) |
| Markdown | `marked` 18.1.2 + DOMPurify 3.4.17, overlay di atas Monaco | `markdown.ts:12-22`, `EditorNode.tsx:281-291` | Tanpa highlight kode, link relatif, gambar relatif; setting `openMarkdownPreview` |
| JSON | Monaco + json worker | `lazyMonaco.tsx:42` | Tanpa tree/format |
| Audio/video | **tidak ada** (lihat P0) | | |
| CSV/TSV, hex, arsip, ipynb, font, HTML preview | **tidak ada** | | |
| Ikon | codicon per ekstensi | `fileIcon.ts` | Hanya 9 kelas ikon |

## 3. Matriks celah per format

| # | Format | Celah | Sev |
|---|---|---|---|
| V1 | Audio/video | Terbuka sebagai teks + risiko tulis rusak (temuan 1) | **P0** |
| V2 | Biner umum | Denylist, bukan deteksi isi (temuan 2) | **P0** |
| V3 | Teks non-UTF-8 | Transkode lossy saat simpan | **P0** |
| V4 | BOM/EOL | BOM hilang, EOL campuran dinormalkan, tanpa indikator | P1 |
| V5 | Teks 10 MB+ / log | Ditolak total; tak ada "buka awal/akhir read-only" | P1 |
| V6 | Gambar | Tanpa zoom/pan/fit; SVG tak bisa dibuka sebagai kode; base64 JSON | P1 |
| V7 | CSV/TSV | Hanya teks mentah | P1 |
| V8 | Arsip (zip/tar/gz) | Hanya notice "needs an application on the server" (`FilesNode.tsx:139`): jalan buntu, tanpa listing atau unduh | P1 |
| V9 | PDF | Seluruh file ke memori JS; viewer bawaan tak ada di sebagian browser mobile `[BT]` | P2 |
| V10 | Markdown | Link/gambar relatif rusak (menavigasi tab ke SPA fallback `staticAssets.ts:33-35`); gambar remote tak terkontrol (tanpa CSP) | P1 |
| V11 | HTML | Hanya sumber; tanpa preview terisolasi | P2 |
| V12 | ipynb, font | Teks JSON mentah / biner-sebagai-teks | P2 |
| V13 | Deteksi tipe | Ekstensi saja; tanpa magic bytes; file tanpa ekstensi diasumsikan teks | P1 |
| V14 | Save tanpa cek dirty | ⌘S menulis ulang file tak berubah (memperparah V1-V3) | **P0** |

V14 bisa ditutup satu baris (`if (!dirty) return` di `save()`), terlepas dari seluruh rancangan di bawah. `[opini]` kerjakan sebagai hotfix sendiri.

## 4. Deteksi tipe

Urutan keputusan yang direkomendasikan, dihitung **server** (client tidak dapat membaca byte tanpa mengunduh):

1. `stat`: ukuran, `mtimeMs`, bukan-file (dir/symlink/FIFO/device ditolak; FIFO membuat `readFile` menggantung).
2. Baca kepala 8 KB. Cek magic bytes (tabel ~20 signature: PNG `89504E47`, JPEG `FFD8FF`, GIF `GIF8`, WEBP `RIFF....WEBP`, PDF `%PDF`, ZIP `PK\x03\x04`, gzip `1F8B`, ELF `7F454C46`, Mach-O `CFFAEDFE`/`CAFEBABE`, wasm `0061736D`, SQLite `SQLite format 3\0`, MP4/MOV `ftyp` di offset 4, OGG `OggS`, MP3 `ID3`, WOFF `wOFF`/`wOF2`, OTF `OTTO`).
3. Teks vs biner: ada byte NUL di 8 KB pertama = biner (heuristik yang sama dengan git, 8000 byte `[BT: dari ingatan, cek xdiff-interface.c]`); kecuali diawali BOM UTF-16.
4. Encoding: BOM (`EF BB BF`, `FF FE`, `FE FF`), lalu `TextDecoder('utf-8',{fatal:true})` pada kepala; gagal = kandidat non-UTF-8.
5. Ekstensi hanya memilih **viewer** di antara yang cocok dengan hasil 2-4 (mis. `.svg` teks XML boleh gambar atau kode), tidak pernah menimpa hasil biner.

Hasil dikirim sebagai `FileMeta = { size, mtimeMs, kind, mime, binary, encoding, bom, eol }`. `src/shared/fileKind.ts` baru menjadi satu-satunya tabel ekstensi-ke-kind-mime (menggantikan tiga tabel di temuan 6); sniff magic jalan di server saja.

Pustaka: `file-type` 22.3.0 (MIT, 137 KB terurai, rilis 2026-10-29) mencakup ratusan format. `[opini]` mulai dengan tabel sendiri (~30 baris, murah, nol dependency, Rule 10) dan pakai `file-type` hanya bila daftar membengkak. `isbinaryfile` 6.0.0 (MIT, 20 KB) setara langkah 3 tetapi 5 baris cukup.

## 5. Teks, kode, encoding, ukuran

**Kodek.** WHATWG `TextDecoder` bawaan Node/Bun menangani decode label non-UTF-8 (`windows-1252`, `shift_jis`, `utf-16le`, ...) `[BT: set label Bun penuh? uji di Bun 1.x]`. `TextEncoder` hanya UTF-8, jadi **menulis** non-UTF-8 butuh `iconv-lite` 0.7.3 (MIT, 344 KB, rilis 2026-11-02). Deteksi tebakan: `chardet` 2.2.0 (MIT, 179 KB); `jschardet` 4.1.0 (0BSD, 7.5 MB terurai) terlalu besar. Rekomendasi bertahap:
- Tahap 1: file non-UTF-8 dibuka **read-only** dengan banner "Encoding: windows-1252 (terdeteksi). Reopen with Encoding..." dan tombol Save mati. Menutup V3 tanpa dependency baru.
- Tahap 2: menu "Reopen with Encoding"/"Save with Encoding" (seperti VS Code status bar) dengan `iconv-lite` di server.

**BOM/EOL.** Baca: server mengirim `bom` dan `eol` dominan; client menampilkan `UTF-8 BOM`, `LF/CRLF` di footer node. Simpan: client memakai `editor.getValue({ preserveBOM: true })` atau server menambah BOM ulang bila `bom:true`; EOL mengikuti `model.getEOL()`. EOL campuran: tampilkan peringatan sekali ("akan dinormalkan ke CRLF") sebelum simpan pertama.

**File besar.** Alih-alih menolak, ada tiga mode berbasis Range (butuh endpoint raw, bagian 6): (a) buka N KB pertama read-only, (b) buka N KB terakhir (log), (c) "buka penuh" sampai cap yang bisa diubah setting. Semuanya read-only dengan banner, jadi tidak menyentuh gerbang `loadedRef`. Ukuran M. `[opini]` (b) adalah yang paling berguna untuk pengguna terminal-banyak.

**Bahasa.** Pemetaan Monaco dari ekstensi sudah memadai untuk kasus umum. Celah: file tanpa ekstensi (`Dockerfile`, `Makefile`, shebang). Pakai `languages.getLanguages()` `filenames` (Monaco punya `Dockerfile`/`Makefile`) dan tebak shebang dari baris 1; kecil (S). Monaco 0.57 tidak menyertakan `csv`/`toml`/`env` `[BT]`; cukup plaintext.

## 6. Transport: endpoint raw tunggal

Satu rute baru `GET /api/fs/raw?path=...&token=...` di file baru `src/server/fsRaw.ts`:
- **Range**: `Accept-Ranges: bytes`; `Range: bytes=a-b` menjawab `206` + `Content-Range` lewat `fs.createReadStream({start,end})`; di luar rentang `416`. Wajib untuk `<video>`/`<audio>` dan seek; Safari menolak memutar media tanpa Range `[BT: dari pengetahuan umum]`.
- **ETag/cache**: ETag lemah `W/"<size>-<mtimeMs>"`, `If-None-Match` menjawab `304`; `Cache-Control: private, no-cache` (selalu revalidasi karena file mutable). Setelah simpan, client menambah `&v=<mtime>` bila perlu.
- **Auth**: tag `<img>/<video>/<iframe>` tak dapat menyetel header, jadi token lewat query seperti `fsClient.ts:4-6` (`authorize()` menerima keduanya). Risiko: token terbawa ke Referer dan log. Mitigasi tahap 2: tiket sekali pakai berumur pendek `POST /api/fs/ticket {path}` lalu `/api/fs/raw/<ticket>` (referensi eksternal punya mekanisme tiket download, `fsOps.ts:5-6`). `[opini]` tahap 1 cukup memakai token query + `Referrer-Policy: no-referrer`.
- **Verifikasi tipe di raw**: kind dari sniff (bagian 4), bukan ekstensi.

Header keamanan raw (pola `raw.githubusercontent.com`, diverifikasi `curl -I` hari ini: `content-security-policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`, `x-content-type-options: nosniff`, `accept-ranges: bytes`, `etag`):

| Kelas | `Content-Type` | Header tambahan |
|---|---|---|
| Gambar raster, audio, video, font | dari sniff | `nosniff`; `inline` |
| SVG, HTML, XML, apa pun yang aktif | `text/plain; charset=utf-8` bila dibuka inline; `attachment` bila diunduh | `nosniff`, `CSP: default-src 'none'; style-src 'unsafe-inline'; sandbox` |
| PDF | `application/pdf` | `nosniff`; **tanpa** `sandbox` (viewer Chrome memblok PDF di frame ber-sandbox `[BT]`) |
| Sisanya | `application/octet-stream` | `Content-Disposition: attachment; filename*=UTF-8''...`, `nosniff` |

Alasannya: raw di origin yang sama dengan app berisi token dan akses PTY. File `.html`/`.svg` hostile (hasil `git clone`) yang dibuka sebagai navigasi top-level akan menjalankan skrip dengan hak penuh. Maka `<img src=raw>` aman (konteks gambar tidak menjalankan skrip), navigasi langsung tidak.

## 7. Keamanan tampilan, per viewer

| Viewer | Ancaman | Kontrol |
|---|---|---|
| Markdown | XSS lewat HTML mentah (`marked` meneruskan HTML) | Sudah: DOMPurify fail-closed (`markdown.ts:19`). Tambah hook `afterSanitizeAttributes`: link http(s) jadi `target=_blank rel="noopener noreferrer"`, link relatif jadi aksi "buka di editor", `<img>` relatif dirutekan ke `raw` lokal, `<img>` remote diblok kecuali setting (beacon pelacak) |
| SVG | Skrip di dalam SVG | Tampil lewat `<img>` (skrip tak jalan); jangan pernah `innerHTML`/`<object>`/`<iframe>` tanpa sandbox |
| HTML | Skrip/navigasi | `<iframe sandbox srcdoc>` tanpa token (statis); opsi "Run scripts" = `sandbox="allow-scripts"` **tanpa** `allow-same-origin`. MDN: kombinasi keduanya pada origin sama membuat sandbox bisa dilepas (diverifikasi) |
| PDF | Skrip PDF | Viewer browser (PDFium/pdf.js) sudah ber-sandbox sendiri `[BT]` |
| ipynb | `text/html`, `application/javascript` di output | Render `text/plain` dan `image/png|jpeg|svg` (via `<img>`); output HTML lewat DOMPurify; JS tidak pernah dijalankan |
| Font | Parser font | `FontFace` memakai sanitizer browser `[BT]`; muat dari `raw`, bukan `data:` |
| Arsip | Zip-slip, bom | Hanya **listing** di server (`unzip -Z1`, `tar -tf` via `execFile` + cap entri); tidak ada ekstrak di viewer |
| Hex | - | Hanya baca Range |

Server juga perlu `X-Content-Type-Options: nosniff` + `Referrer-Policy: no-referrer` global dan CSP untuk shell SPA (`index.ts:146`). CSP SPA belum bisa ketat karena Monaco worker dan style inline; `[BT]` ukur dulu, hanya `frame-ancestors 'none'` sudah aman dipasang (S).

## 8. Pustaka kandidat (Rule 10: native dulu)

| Kebutuhan | Pilihan | Alternatif | Putusan |
|---|---|---|---|
| Gambar/video/audio/font | `<img>`, `<video>`, `<audio>`, `FontFace` native | - | Native |
| PDF | `<iframe>` viewer browser | `pdfjs-dist` 6.5.438 (Apache-2.0, **37.6 MB** terurai, rilis 2026-11-01) | Native default; pdf.js hanya bila butuh seragam di mobile/Safari, lazy `import()` |
| CSV/TSV | `papaparse` 5.7.0 (MIT, 270 KB, rilis 2026-08-24) | Parser sendiri ~40 baris (RFC4180 dengan kutip) | Papaparse (>20 baris); `import()` lazy; tabel dengan windowing baris tetap sendiri |
| Zip listing | server `execFile unzip -Z1` | `fflate` 0.8.3 (MIT, 797 KB) di server | `execFile` (pola sama `fsOps.ts:104`), `fflate` bila `unzip` tak ada di host |
| Deteksi tipe | tabel sendiri | `file-type` 22.3.0 | Sendiri dulu |
| Encoding tulis | - | `iconv-lite` 0.7.3 | Tahap 2 |
| Highlight kode di markdown | `monaco.editor.colorize()` (sudah ada) | highlight.js | Monaco, tanpa paket baru |
| Hex | sendiri (~80 baris) | - | Sendiri |
| ipynb | sendiri (~150 baris; reuse `renderMarkdown` dan `colorize`) | - | Sendiri |
| HLS/streaming adaptif | tidak perlu | `hls.js` 1.7.4 (Apache-2.0, 33 MB) | Tidak |

Semua lisensi permisif (MIT/Apache-2.0/0BSD); DOMPurify dwilisensi MPL-2.0/Apache-2.0, sudah dipakai. Semua dirilis dalam 6 bulan terakhir kecuali `exifr` (2022, tidak direkomendasikan; EXIF di luar lingkup).

## 9. Lazy-load

Terukur dari `dist/assets` (106 berkas): `index-*.js` 1.58 MB, `editor.api` 2.7 MB, `ts.worker` 6.9 MB, `css.worker` 1.1 MB, `html.worker` 0.74 MB. Monaco sudah di balik `loadMonaco()` (`lazyMonaco.tsx:21`). Aturan:
- Setiap viewer non-teks = modul `viewers/*.tsx` dimuat `React.lazy` hanya saat kind-nya dipilih; viewer gambar/media/hex nyaris nol-byte (native), jadi mengurangi bobot node editor untuk kasus non-teks (tak lagi menarik Monaco bila file gambar/PDF; hari ini `EditorNode` impor statis hanya tipe Monaco, sudah benar).
- `papaparse`, `pdfjs-dist`, `iconv-lite` hanya lewat `import()` di dalam viewer.
- Data besar tidak lewat state React: media dan gambar pakai URL `raw`; hex dan file besar memuat halaman Range 64 KB-1 MB sesuai scroll.

## 10. Registry "viewer by type"

Satu fungsi memilih viewer dari `FileMeta`, menggantikan `editorFileKind` + cabang `kind` di `EditorNode.tsx:253-293`:

```ts
interface Viewer {
  id: string
  match: (m: FileMeta) => number          // skor; 0 = tidak cocok
  load: () => Promise<{ default: ComponentType<ViewerProps> }>
  editable: boolean                        // hanya TextViewer
  alt?: string[]                           // id viewer alternatif ("Open With")
}
```

| Kind (dari sniff) | Viewer utama | Alternatif |
|---|---|---|
| text, kode | `text` (Monaco) | `hex` |
| markdown | `text` + overlay preview | - |
| csv/tsv | `table` | `text` |
| svg | `image` | `text` |
| html | `text` | `htmlPreview` (sandbox) |
| image | `image` (fit/zoom/pan) | `hex` |
| pdf | `pdf` (iframe `raw`) | `hex` |
| audio/video | `media` | `hex` |
| ipynb | `notebook` (read-only) | `text` |
| font | `font` | `hex` |
| archive | `archive` (listing + Download) | - |
| binary/unknown | `hex` + tombol Download | - |

Aturan resolusi: pilihan pengguna ("Open With", disimpan di `data.viewer` pada node) > skor tertinggi dari `match` > `hex`. `EditorNode` menyusut menjadi cangkang (header, breadcrumb, dirty dot, error strip) yang menampung `ViewerHost`. **Tipe node tetap `editor` dan `data.filePath` tidak berubah**, supaya board tersimpan tetap terbuka. `fileOpenTarget` (`fileBrowse.ts:216`) tidak lagi berbalik ke `os`: semua file dibuka (jalan terakhir `hex`/Download), dan notice di `FilesNode.tsx:139` dihapus. Gerbang kehilangan data diwarisi: hanya `text` yang `editable`, dan hanya setelah load sukses dengan encoding UTF-8 (`loadedRef`).

## Implikasi untuk webterm

**Rekomendasi tegas:** (1) hotfix P0 dulu, terpisah dari redesain; (2) bangun endpoint raw + `FileMeta` + registry; (3) viewer ditambah bertahap dengan prioritas pengguna terminal/agent.

| # | Perubahan | File disentuh | Ukuran |
|---|---|---|---|
| H1 | Hotfix: `save()` tolak bila `!dirty`; media/biner tidak dibuka sebagai teks (mulai dari V1: deteksi NUL di `read`, tolak) | `EditorNode.tsx`, `editorFile.ts`, `fsOps.ts` (+ tes `fsOps.bun.test.ts`, `EditorNode.test.tsx`) | S |
| H2 | `src/shared/fileKind.ts`: satu tabel ekstensi, mime, kind; hapus tiga tabel lama | `shared/fileKind.ts`, `editorFile.ts`, `fileBrowse.ts`, `fileIcon.ts`, tes | M |
| R1 | `FileMeta` + sniff: `GET /api/fs/stat` (atau perluas `read`) dengan encoding/BOM/EOL | `fsOps.ts`, `fsApi.ts`, `fsClient.ts`, `shared/fsLimits.ts`/tipe baru | M |
| R2 | Endpoint raw: Range, ETag, 304, header keamanan, `nosniff` global | `server/fsRaw.ts` (baru), `api.ts`, `index.ts` | M |
| R3 | Registry + `ViewerHost`; `EditorNode` jadi cangkang | `client/viewers/registry.ts`, `ViewerHost.tsx`, `EditorNode.tsx`, `nodeTypes.tsx` | M |
| V-a | Image viewer dari `raw` (zoom/pan/fit, svg source toggle) | `viewers/ImageViewer.tsx`, `editor.css` | M |
| V-b | Media viewer (`<video>/<audio>`), fallback unduh | `viewers/MediaViewer.tsx` | S |
| V-c | Hex + biner/arsip/unduh | `viewers/HexViewer.tsx`, `ArchiveViewer.tsx`, `fsOps.ts` (listing) | M |
| V-d | Teks: preserve BOM/EOL, banner encoding read-only, mode awal/akhir file besar | `viewers/TextViewer.tsx`, `fsOps.ts` | M-L |
| V-e | Tabel CSV/TSV (`papaparse`, windowing) | `viewers/TableViewer.tsx`, `package.json` | M |
| V-f | Markdown: hook link/gambar relatif, highlight via `colorize` | `markdown.ts`, `markdown.test.ts` | S |
| V-g | HTML preview sandbox, ipynb read-only, font | `viewers/*` | M |
| V-h | Tiket sekali pakai menggantikan token di URL | `fsRaw.ts`, `fsClient.ts` | M |
| V-i | Dekode tulis non-UTF-8 (`iconv-lite`) | `fsOps.ts`, `package.json` | M |

**Risiko:** (a) kontrak wire `read` ikut dipakai tes dan node lain, jadi tambahan harus aditif (sentinel `webterm:too-large:` tetap); (b) endpoint raw memperbesar permukaan serangan, harus dikerjakan bersama tes header (`fsRaw.bun.test.ts`) dan jangan dirilis tanpa bagian 6 lengkap; (c) token di URL bocor lewat Referer/log sampai V-h; (d) beririsan dengan Topik 3 (`expectedVersion`, `mtime` konflik) dan Topik 1 (ikon, pembukaan file): R1 harus memakai `mtimeMs` yang sama dengan rancangan konflik tulis; (e) satu board tersimpan dengan node editor ke media/biner akan berubah perilaku, yang disengaja.

**Belum terverifikasi `[BT]`:** perilaku Safari tanpa Range; Chrome PDF di iframe `sandbox`; dukungan label `TextDecoder` penuh di Bun; heuristik NUL git; keberadaan grammar `toml/env/csv` di Monaco 0.57; CSP SPA yang tidak memecah Monaco worker; viewer PDF bawaan pada Android/iOS.
