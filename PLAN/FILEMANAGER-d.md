# PLAN FILEMANAGER-d — Spec siap-tempel WS-FM-06..11 + urutan eksekusi orkestrator

Lanjutan `-c.md`. Gunakan preambul wajib di awal `-c.md` untuk SETIAP worker. Kepemilikan: `-a.md` §4.1; kontrak: `-b.md` §5; tes: `-b.md` §6.

---

## WS-FM-06 — Viewer + endpoint raw (W1, `feature/fm-viewers`)

**Tujuan**: G-03, tampilan & format yang didukung (RND/36).

**File milik**: server `fsRaw.ts`, `fsRaw.bun.test.ts`; klien `src/client/viewers/` → `ViewerHost.tsx`, `viewerRegistry.ts`, `ImageViewer.tsx`, `MediaViewer.tsx`, `PdfViewer.tsx`, `BinaryPlaceholder.tsx`, `viewers.css`, tes `viewerRegistry.test.ts`, `ViewerHost.test.tsx`.

**Perilaku**:
- `rawResponse(path, headers)`: `Bun.file`/stream, `ETag` = `FsVersion`, `If-None-Match`→304, `Range` (satu rentang; tidak valid→416), `Accept-Ranges: bytes`, `Content-Type` dari tabel `fileKind` (tak dikenal → `application/octet-stream`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: private, no-store`, CSP `sandbox; default-src 'none'` untuk SVG/HTML. Menolak direktori/path luar (`resolveFsPath`). Tidak memuat file penuh ke memori. Dikunci flag VIEWERS.
- Registry: `fileKind→komponen`; image=`<img src=rawUrl>` (SVG juga `<img>`, bukan iframe), audio/video=`<audio|video controls preload="metadata">`, pdf=`<iframe src=rawUrl>` (sandbox), markdown = jalur `openMarkdownPreview` yang ada, `binary|archive` = `BinaryPlaceholder` (nama, ukuran, Download bila UPLOAD aktif, Copy Path). Flag VIEWERS mati → semua non-teks = placeholder (aman).
- `ViewerHost` props: `{path, kind, version?, onError}`; dipasang oleh WS-02 (W2). Jangan menyentuh `EditorNode.tsx`.

**Tes**: §6 baris 06. **Selesai bila**: tiga gerbang hijau; header keamanan teruji; SVG tak pernah di iframe; tak ada dependensi baru.

---

## WS-FM-07 — Watcher & sinkronisasi (W2, `feature/fm-watch`)

**File milik**: `src/server/fsWatch.ts`, `fsWatch.bun.test.ts`; `src/client/filesSlot.watch.ts`, `filesSlot.watch.test.ts`.

**Perilaku**: `fsWatchHub`: `watch(dir, clientId, send)` / `unwatch` / `dropClient(clientId)`; satu `fs.watch(dir)` per direktori (refcount), debounce 150 ms (konstanta bernama), abaikan `.webterm-*.tmp` dan `.git/`, kirim `{t:'fsdirty',dir}`; saat error/`EMFILE` → polling `readdir` per N dtk (konstanta) dan batas jumlah watcher; direktori dihapus → kirim dirty sekali lalu lepas. Hub dipanggil dari cabang WS yang sudah dipasang WS-00. Klien: slot `useSlot` mengirim `fswatch` untuk `dir` node saat mount/ganti dir, `fsunwatch` saat unmount, dan pada `fsdirty` → `refresh()` + `emitFsEvent({kind:'dirty',origin:'remote'})`; mutasi lokal (origin local) tidak men-trigger refresh ganda. Dikunci flag WATCH.

**Tes**: §6 baris 07. **Selesai bila**: tiga gerbang hijau; tak ada kebocoran watcher (tes refcount); tak ada event badai (tes debounce).

---

## WS-FM-08 — Dekorasi git (W2, `feature/fm-git-status`)

**File milik**: `src/server/fsGit.ts`, `fsGit.bun.test.ts`; `src/client/filesSlot.git.tsx`, `filesSlot.git.test.tsx`.

**Perilaku**: `gitStatusMarks(dir)`: `git -C <dir> status --porcelain=v2 -z --untracked-files=normal` (argumen array, tanpa shell; timeout konstanta), parse `1/2/u/?` → `GitMark` ('?' → 'U'), path relatif ke `dir`, rollup folder = mark terkuat (C>D>M>A>R>U), cap entri; bukan repo/ git tak ada → `marks:{}`. Klien: slot `decorate` menambah huruf+warna token VS Code (tanpa literal warna), refresh pada `fsEvents`. Dikunci flag GIT_STATUS.

**Tes**: §6 baris 08. **Selesai bila**: tiga gerbang hijau; nama dengan spasi/unicode benar; tidak ada interpolasi shell.

---

## WS-FM-09 — Quick Open, cari, DnD (W3, `feature/fm-quickopen-dnd`)

**File milik**: `src/server/fsSearch.ts`, `fsSearch.bun.test.ts`; `src/client/filesSlot.search.tsx`, `filesSlot.dnd.ts`, `QuickOpen.tsx`, tes.

**Perilaku**: `searchFiles(root,q,limit)`: `rg --files` → `git ls-files` → `Bun.Glob` (urutan fallback bila perintah tak ada), hormati `.gitignore`, cap 50.000 (konstanta), fuzzy-match sederhana subsequence di klien (tanpa dependensi). Quick Open `Ctrl/⌘+P` hanya saat node files fokus (P-7); buka hasil di editor. DnD: sumber `dragstart` memuat MIME `application/x-webterm-path` + `text/plain` (path dikutip shell: `'…'`, `'` → `'\''`, tanpa newline akhir). Drop pada terminal membutuhkan `TerminalNode` (BUKAN milik WS ini): **langkah 1 verifikasi** apakah ada jalur klien yang ada untuk menulis ke sesi terminal `[BT]`; bila tidak ada, v1 hanya Copy Path/“Insert Path” via clipboard dan laporkan R-09 ke orkestrator, jangan edit TerminalNode. Dikunci flag QUICK_OPEN.

**Tes**: §6 baris 09. **Selesai bila**: tiga gerbang hijau; quoting teruji dengan `'`, spasi, `$`, backtick.

---

## WS-FM-10 — Upload/download (W3, `feature/fm-transfer`)

**File milik**: `src/server/fsUpload.ts`, `fsUpload.bun.test.ts`; `src/client/filesSlot.upload.tsx`, `filesSlot.upload.test.tsx`.

**Perilaku**: `upload` = body mentah di-stream (`Request` body → file `.webterm-up-<rand>.tmp` di `dir` → `rename`), `name` divalidasi (tanpa `/`, `..`, NUL, ≤255 byte), cap `FILES_UPLOAD_MAX_MB` (413 + bersihkan tmp), `EEXIST` tanpa overwrite. Satu file per request (tanpa multipart → tanpa dependensi); klien meng-upload beberapa file berurutan dengan progres (`XMLHttpRequest` atau `fetch` stream). Download: tautan ke `raw?download=1` (WS-06 menambah `Content-Disposition` dengan nama RFC 5987 — **koordinasi**: ini permintaan ke WS-06 sejak W1 agar `?download=1` didukung; bukan edit lintas-WS). Drop file OS ke daftar → upload (slot `onDrop`). Dikunci flag UPLOAD.

**Tes**: §6 baris 10. **Selesai bila**: tiga gerbang hijau; tmp tak tersisa saat gagal; nama berbahaya ditolak.

---

## WS-FM-11 — Dokumen & integrasi (W4, `chore/fm-docs`)

**File milik**: `CHANGELOG.md`, `README.md` (update terbatas: env baru §5.5 & endpoint `/api/fs/*`; narasi/badge milik user dipertahankan), `docs/decisions/files-manager.md`, `src/server/fileManager.integration.bun.test.ts`.

**Perilaku**: CHANGELOG `Added/Changed/Fixed` dari sudut pandang user (empat perbaikan P0 di `Fixed`); dokumen keputusan P-1..P-15 + alasan + catatan P-6 (DNS-rebinding tidak ditutup); tes integrasi berurutan (create→write versi→konflik→rename→delete→restore→raw) di server uji bun. Setelah semua bukti masuk saja. Tampilkan checklist Rule 6 dan laporan Rule 18 untuk orkestrator (tidak push).

**Selesai bila**: tiga gerbang hijau; CHANGELOG ada entri versi manifest; docs hanya menyentuh bagian yang berubah.

---

## Urutan eksekusi untuk orkestrator (ringkas)

1. Buat `feature/fm-integration` dari `main`; luncurkan WS-00 (satu worker, nama `wkr-fm-foundation-01`). Verifikasi `git diff --stat` & tiga gerbang sebelum menerima (R-10); merge ke integrasi.
2. Serentak dalam satu pesan (nama uniq, file tidak tumpang-tindih): `wkr-fm-server-core-01` (01), `wkr-fm-editor-safety-01` (02 fase 1), `wkr-fm-files-shell-01` (03 fase 1). Verifikasi, merge. **Setelah W0b: 4 P0 tuntas dan dapat dilaporkan ke user**.
3. W1: `wkr-fm-files-shell-02`, `wkr-fm-mutate-server-01`, `wkr-fm-viewers-01` (minta `?download=1` di spec 06 sejak awal).
4. W2: `wkr-fm-mutate-ui-01`, `wkr-fm-editor-safety-02`, `wkr-fm-watch-01`, `wkr-fm-git-status-01`.
5. W3: `wkr-fm-quickopen-dnd-01`, `wkr-fm-transfer-01`. W4: `wkr-fm-docs-01`.
6. Temuan baru dari worker → suarakan ke user, jangan sebar worker tambahan. Merge ke `main` hanya atas perintah user.
