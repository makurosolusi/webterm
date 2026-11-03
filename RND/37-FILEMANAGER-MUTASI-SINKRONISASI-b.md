# 37-b — File manager: kebenaran mutasi & sinkronisasi (lanjutan)

Lanjutan dari `37-FILEMANAGER-MUTASI-SINKRONISASI-a.md` (ringkasan, inventaris, tabel celah M-01..M-15, semantik tulis). Basis, notasi `[BT]`/`[opini]` sama.

## 4. Operasi baru: kontrak yang diusulkan

Semua di bawah `/api/fs/<verb>` (pola yang ada, auth sudah menggerbangi `/api/*`, `api.ts:87-91`). Body JSON ≤1 MiB lewat `cappedBodyGetter` (`cappedRequestBody.ts`) untuk semua verb non-konten; konten tulis diberi cap sendiri (mis. 64 MiB, stream, bukan `data +=`).

| Verb | Request | Semantik | Error khusus |
|---|---|---|---|
| `create` | `{path, kind:'file'\|'dir', content?}` | `wx` / `mkdir` non-recursive; parent otomatis `mkdir -p` hanya bila `parents:true` | `EEXIST` 409, `ENOENT` 404, `ENOTDIR` 409 |
| `write` | `{path, content, expectedVersion?}` | §3.1+3.2; **tidak membuat** bila `mustExist:true` (editor selalu kirim) → menutup "dibuat ulang saat dihapus" | `EVERSION` 409, `ENOENT` 404 |
| `rename` | `{from, to, overwrite?:false}` | `rename(2)` satu volume; tolak bila `to` ada kecuali `overwrite`; case-only rename di FS case-insensitive = dua langkah via nama sementara | `EEXIST`, `EXDEV` → pakai copy+delete |
| `move` | sama dengan rename lintas folder | `EXDEV` → `cp` rekursif lalu `rm`; tolak memindah folder ke dirinya/keturunannya (`EINVAL`) | `EXDEV` ditangani, `EINVAL` |
| `copy` / `duplicate` | `{from, to?}` | `fs.cp` (`recursive`, `errorOnExist:true`, `force:false`, `verbatimSymlinks:true`); duplicate = nama `x copy.ext` (Finder) / `x (1).ext` | `EEXIST` |
| `delete` | `{path, mode:'trash'\|'permanent'}` | lihat §4.1 | `ENOTEMPTY` bila bukan recursive |
| `download` | `GET ?path=` | stream `fs.createReadStream`, `Range`, `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` — bentuk viewer di topik 36 | 404/403 |
| `upload` | `PUT ?path=&expectedVersion=` raw stream (bukan multipart) | tulis ke tmp → rename (§3.2); cap per-file; `Content-Length` wajib | 413, 409 |

Idempotensi: `mkdir`/`create dir` idempotent (`created:false`); `delete` pada path yang sudah tiada = `200 {existed:false}` `[opini]` (retry aman, UI tak error saat dua klien menghapus); `rename` ke dirinya = no-op; `write` idempoten oleh `expectedVersion` (retry setelah timeout yang sebenarnya sukses → `EVERSION`; klien membandingkan isi sebelum menganggap gagal).

### 4.1 Delete: trash vs permanen

| Opsi | Bobot | Catatan |
|---|---|---|
| `fs.rm` permanen | kecil | Cepat tapi tak ada undo. Hanya setelah konfirmasi eksplisit (dialog dengan nama + jumlah item) |
| Paket `trash` v10.1.1 (MIT, node>=20, terbit 2026-02, unpacked ±770 KB, dep: `xdg-trashdir`, `move-file`, `globby`, dll) | sedang | macOS memakai biner `macos-trash` (ada "Put Back"), Linux ikut spec XDG; README sendiri menyebut **dukungan Linux "tidak bagus & tidak dipelihara"**. ESM murni; kompatibilitas Bun `[BT]` |
| Trash buatan sendiri di `WEBTERM_DATA_DIR/trash/<ts>-<rand>/` + `meta.json {origPath, deletedAt}` | ±120 baris | Kontrol penuh, undo UI-driven (toast "Undo"), tidak mengandalkan GUI Finder; `rename` ke data dir bisa `EXDEV` → copy+rm; perlu purge TTL (mis. 7 hari) |

Rekomendasi `[opini]`: **trash buatan sendiri sebagai default** (undo yang terjangkau dari browser — Finder "Put Back" tak berguna bagi pengguna yang mengakses via web/remote), `permanent` hanya lewat Shift+Delete dengan konfirmasi. Rule 10: tulis sendiri (±120 baris) lebih baik karena `trash` bergantung Linux yang tak terpelihara dan membawa 9 dep; tolak.

Tombol "Close" node (`FilesNode.tsx:302`) hanya menghapus node, bukan file — pastikan label/ikon tidak ambigu dengan delete file.

## 5. Keamanan

| Topik | Status | Rekomendasi |
|---|---|---|
| Traversal | Sengaja tanpa jail (`fsOps.ts:32-39`); `newEntryPath` menolak `..` dan absolut di klien (`fileBrowse.ts:59-67`) tapi **server tidak mengulang validasi** | Server tetap tanpa jail (setara akses PTY), tapi validasi nama **di server** juga: tolak NUL, segmen `.`/`..` pada `name`, panjang >255 byte. Klien-saja = bukan batas |
| Batas root workspace | Tidak ada; workspace punya `cwd` tapi fs tidak memakainya | Jangan jail. Pakai `cwd` hanya untuk UX (default root, peringatan keluar root), `[opini]` |
| Symlink escape | Tak relevan tanpa jail; **relevan untuk delete/copy**: `rm` tidak mengikuti symlink (aman), `cp` pakai `verbatimSymlinks`, hindari rekursi tak hingga lewat loop symlink (`fs.cp` mengikuti `dereference:false` default) | Delete symlink = hapus tautannya, tampilkan ikon/penanda |
| DNS rebinding | M-10 | Tambah allowlist `Host` di `authorize()`: loopback names + `HOST` terkonfigurasi (+ `WEBTERM_ALLOWED_HOSTS`); tolak sisanya 421/403. Vite menambah `server.allowedHosts` untuk kelas serangan yang sama `[BT: nomor CVE/versi tidak saya verifikasi]`. Berlaku untuk seluruh `/api/*` dan `/ws`, bukan hanya fs → **usulkan sebagai WS terpisah** |
| Ukuran | Baca dicap; tulis/unggah **tidak** (M-03) | Cap + streaming (§4) |
| Tipe | `write` menolak non-string (`fsApi.ts:93`) | Pertahankan; tambahkan cek `path` string non-NUL |
| Log | Tidak log isi, hanya basename (`fsOps.ts:41,150-152`) | Pertahankan untuk verb baru; jangan log `content`/path penuh |
| Token node | `isNodeTokenPath` tidak menyertakan fs (`auth.ts:~120`) → agent tak bisa pakai fs API | Jaga: mutasi fs **tidak** boleh masuk allowlist token node |

## 6. Sinkronisasi

### 6.1 Pemantau berkas (pilihan)

| Opsi | Lisensi/versi | Catatan terverifikasi |
|---|---|---|
| `fs.watch` bawaan | — | Node docs: tidak konsisten antar platform; Linux = inotify, macOS = FSEvents untuk direktori; tak andal di NFS/SMB/Docker-host; watch mengikuti **inode** (dihapus & dibuat ulang = buta). `filename` tidak selalu ada. Diukur di macOS (§7): `recursive:true` jalan di Bun 1.4.2 dan Node 26; Bun hanya mengirim tipe `rename` (tak membedakan `change`) → perlakukan event sebagai **petunjuk "kotor"**, lalu `stat`/`readdir` ulang |
| `@parcel/watcher` 2.6.0 | MIT | Native, prebuilt macOS/Linux/Windows (optionalDependencies), engine node>=10, ±130 KB; dipakai VS Code `[BT: versi yang dipakai VS Code saat ini]`. Dependensi native: risiko di Bun `[BT]` |
| `chokidar` 6.0.0 | MIT | ESM-only, node>=22.22, 1 dep (`readdirp`); berbasis `fs.watch` jadi masalah yang sama |
| Polling (`stat` per listing tampil) | — | Fallback bagi FS tak-andal; murah bila hanya folder yang sedang terbuka |

Rekomendasi: **`fs.watch` non-recursive per direktori yang sedang dibuka** (bukan recursive seluruh pohon), dihitung referensi lintas node/klien, di balik `FsWatchHub` satu-per-proses; fallback polling 5 dtk bila `watch` melempar. Alasan: tak ada dependency baru (Rule 10), biaya sebanding jumlah folder yang dilihat, dan kebocoran tertangani oleh refcount. `@parcel/watcher` baru dipertimbangkan bila ada kebutuhan pohon-besar (Quick Open/indeks) `[opini]`.

Aturan hub (dari pelajaran `workspace-watcher.ts:59-95`): **re-arm sebelum apapun** pada tiap event (watch mengikuti inode); debounce 100–300 ms per direktori; coalesce `rename`+`change`; abaikan `.webterm-*.tmp` dan `.git/`; tutup watch saat refcount 0 dan saat proses keluar; batasi total watcher (mis. 256) agar tidak menghabiskan inotify `max_user_watches` `[BT: nilai default Linux]`.

### 6.2 Saluran event ke klien

| Opsi | Catatan |
|---|---|
| Perluas `/ws` (`ServerMsg` + `{t:'fs', dir, kind:'dirty'}`) | `shared/protocol.ts:22`; satu soket sudah ada & terautentikasi (`index.ts:151-170`); tambah `ClientMsg` `fs-watch/fs-unwatch` `{dir}`. Aditif, klien lama mengabaikan `t` tak dikenal `[BT: verifikasi klien tak crash]` |
| SSE `/api/fs/events` | Soket baru, auth via token query; tak ada keuntungan dibanding `/ws` |
| Polling dari klien | Fallback saja |

Rekomendasi: **`/ws`**. Payload hanya `{dir}` (dirty hint) — klien memutuskan `list` ulang; murah, tidak ada state yang harus dikonsistenkan. Event membawa `seq`/`ts`; saat reconnect klien memanggil `list` ulang semua folder terbuka.

### 6.3 Rekonsiliasi di klien

| Kasus | Perilaku yang benar |
|---|---|
| Listing berubah saat seleksi/rename aktif | Pertahankan seleksi per **nama** (`pendingSel` sudah begitu, `FilesNode.tsx:57,103-105`); jangan reset filter |
| Editor bersih + file berubah di disk | Reload otomatis ke model (tanpa kehilangan undo bila `pushEditOperations`), toast singkat |
| Editor **kotor** + file berubah | Jangan timpa; tampilkan bar "File changed on disk — Compare / Overwrite / Revert" (VS Code: dialog konflik; di sini bar) `[opini]`; Save mengirim `expectedVersion` → `409` memicu bar yang sama |
| File dihapus | Tandai judul tercoret + "Deleted"; Save menjadi "Save as new" (konfirmasi), bukan diam-diam membuat |
| Rename/move dari file manager | Server membalas pemetaan lama→baru; klien memperbarui `data.filePath` semua node `editor` yang cocok (awalan untuk folder) via `rf.updateNodeData`, **dan** mengubah `Uri` model Monaco (`m.editor.createModel` tak bisa rename — buat model baru dari isi yang sama + pertahankan dirty). Dependensi: efek `[]` sekali-per-node (`EditorNode.tsx:139,174,236`) harus dibuat reaktif ke `filePath` |
| Rename dari luar (terminal/agent) | Tak ada pemetaan → editor melihat "Deleted"; heuristik "inode sama muncul di tempat lain" `[opini]` ditunda |
| Dua node editor, file sama | `openEditorFor` sudah dedupe per path (`fileOpen.ts:18-20`); dua *klien* tetap bisa → `expectedVersion` yang menjaga |
| Multi-klien (dua tab) | Tiap tab langganan watch sendiri via hub; hasil mutasi tab A tiba di B lewat event dirty, bukan broadcast aplikasi |

### 6.4 Dekorasi git

Sekarang hanya `ignored` (`git check-ignore` satu proses/direktori, dilewati >2000 entry, `fsOps.ts:88-117`). Usulan: `GET /api/fs/git-status?dir=` → `git status --porcelain=v2 -z --no-optional-locks -- <dir>` (flag `--no-optional-locks` sama seperti `gitInfo.ts`), balik `{name → 'M'|'A'|'U'|'D'|'C'|'?'}` + rollup folder ("ada anak berubah"); timeout 5 dtk seperti `GIT_TIMEOUT_MS` (`gitInfo.ts`). Dipicu ulang oleh event watch (debounce 500 ms) dan setelah mutasi. Hanya baca, tak menyentuh index. Ukuran M.

## 7. Eksperimen (reproduksi)

Skrip sekali pakai di `/tmp` (Bun 1.4.2, Node 26.7, macOS 24.5 APFS case-insensitive); tidak ada file repo yang diubah.

| Uji | Hasil |
|---|---|
| `writeFileSync('Readme.md','x')` lalu `writeFileSync('readme.md','OVER')` | `readdir`=`["Readme.md"]`, isi `OVER` → M-01 |
| Body 600 KB `'é'` sekali kirim, `data += chunk` (Bun) | utuh (Bun mengantar satu chunk) |
| Body ter-stream 2 potongan, dibelah di tengah byte `é`, `data += chunk` | **CORRUPT** di Bun dan Node (U+FFFD) → M-03. Body 600 KB sekali kirim juga CORRUPT di Node |
| Symlink ke direktori, `Dirent.isDirectory()` | `false` → M-08 |
| Nama 300 byte | `ENAMETOOLONG` → M-12 |
| `café` NFC disimpan; `existsSync` dengan NFD | `true` (APFS tidak peka normalisasi); byte tersimpan NFC (`636166c3a9…`) |
| `fs.watch(recursive)` nested write/tmp+rename/mkdir/rm | Bun: 7 event semuanya `rename:*`; Node: 9 event (`change`+`rename`); keduanya melaporkan `.tmp` dan path nested → filter tmp & jadikan petunjuk |

## 8. Test: yang ada vs celah

| Ada | Celah yang harus ditutup (test nyata, bukan mock) |
|---|---|
| `fsOps.test.ts`: list urut/ignored, read cap, write+read, mkdir idempotent | `create` eksklusif (`EEXIST`, case-insensitive `Readme`/`readme` di FS yang mendukung), `write` atomic (tidak ada tmp tersisa, mode terjaga, symlink ditulis ke target), `expectedVersion` (cocok/beda/`mustExist`) |
| `fsOps.bun.test.ts`: read melempar, errno→status, list fail-open | Pemetaan errno write/rename/delete → `{code,status}`; `rename` lintas folder, case-only, `EXDEV` (simulasi), tolak move ke keturunan; `delete` trash+undo+idempotent; `copy` symlink |
| `workspacesApi.test.ts:158`/`systemLogEvents.test.ts:154` memakai `fsApiRoute` sekilas | Suite `fsApi.bun.test.ts`: body bukan-JSON, `content` non-string, path kosong/NUL, body besar terbelah di tengah karakter multibyte (regresi M-03) |
| `FilesNode.test.tsx` 2 test | `createEntry` tolak nama ada, error mapping tampil di footer, dirty-hint → list ulang, rename memperbarui node editor (`canvasHarness.tsx:191-193` perlu verb baru) |
| — | Watcher hub: refcount, bocor (`close` saat 0), re-arm, filter tmp, fallback polling |

Jalankan: `TMPDIR=/tmp/st bun test src/server/*.bun.test.ts` + `npm test` (lihat `CLAUDE.md`).

## Implikasi untuk webterm

**Rekomendasi tegas**: bangun sisi server dulu sebagai kontrak mutasi yang aman (create-eksklusif, write atomic berversi, error berkode, body streaming), baru UI mutasi dan watcher. Jangan menambah UI Delete/Rename sebelum M-01..M-03 selesai — UI baru di atas `writeFile` tanpa versi memperbanyak jalur kehilangan data.

| # | Perubahan | File yang disentuh | Ukuran | Risiko |
|---|---|---|---|---|
| 1 | **Hotfix M-01**: `create` eksklusif (`wx`) + klien memakainya untuk New File/Folder; pesan "already exists" | `fsOps.ts`, `fsApi.ts`, `fsClient.ts`, `FilesNode.tsx` | S | Rendah; ubah kontrak `write('')` untuk create |
| 2 | **M-03**: baca body dengan `Buffer.concat` + `setEncoding`/decode akhir, cap ukuran tulis; test regresi chunk terbelah | `api.ts` (readBody), `cappedRequestBody.ts` | S | Perubahan helper bersama — cek pemakai lain |
| 3 | Kontrak error berkode `{ok:false, code, error}` + status (404/403/409/413/507) untuk write/mkdir; klien mengembalikan alasan | `fsOps.ts`, `fsApi.ts`, `fsClient.ts`, `EditorNode.tsx` (pesan) | M | Klien lama mengira `ok` boolean — pertahankan field `ok` |
| 4 | `version` pada read + `expectedVersion` pada write + `mustExist`; editor menangani 409 (bar konflik) | `fsOps.ts`, `fsApi.ts`, `fsClient.ts`, `EditorNode.tsx`, `editorFile.ts` | M | TOCTOU ms tersisa; UI konflik butuh desain (topik 35) |
| 5 | Atomic write (adaptasi `nodeterm fs-atomic.ts`) dengan fallback in-place | `fsOps.ts` (+ file baru `fsAtomic.ts`) | M | Hard link/xattr/ACL `[BT]`; tmp terlihat watcher/git |
| 6 | Sniff biner/`encoding` pada read; editor menolak biner sebagai teks; jangan tulis balik file tak-lolos-decode | `fsOps.ts`, `editorFile.ts`, `EditorNode.tsx` | S–M | Beririsan topik 36 (koordinasi pemilik `editorFile.ts`) |
| 7 | Verb `rename/move/copy/duplicate/delete(trash)` + trash buatan sendiri + validasi nama di server | `fsOps.ts` (pecah: `fsMutate.ts`, `fsTrash.ts` agar <300 baris, Rule 8), `fsApi.ts`, `fsClient.ts` | L | Cross-device, case-only rename, move ke keturunan; purge trash |
| 8 | Upload/download streaming dengan Range, cap, `nosniff` | `fsApi.ts` (atau `fsTransfer.ts`), `fsClient.ts` | M–L | Koordinasi header keamanan dengan topik 36 |
| 9 | `FsWatchHub` + pesan `/ws` `fs-watch/fs-unwatch` + event dirty; FilesNode list ulang; editor bar konflik/Deleted | file baru `fsWatch.ts`, `index.ts`/handler WS, `shared/protocol.ts`, `FilesNode.tsx`, `EditorNode.tsx` | L | Kebocoran watcher, batas inotify, perilaku Bun `[BT]`; klien lama harus abai `t` baru |
| 10 | Rename/move memperbarui `filePath` node editor + model Monaco; efek `EditorNode` reaktif ke `filePath` | `EditorNode.tsx`, `fileOpen.ts`, `FilesNode.tsx` | M | Mempertahankan dirty & undo saat ganti model |
| 11 | `git-status` per-file + rollup folder, dekorasi di FilesNode | file baru `fsGitStatus.ts`, `fsApi.ts`, `fsClient.ts`, `FilesNode.tsx`, `files.css` | M | Biaya `status` pada repo besar; timeout 5 dtk |
| 12 | Flag `link`/`broken` + `dir` benar untuk symlink ke direktori di `list` (+ `size`, `mtime`) | `fsOps.ts`, `fileBrowse.ts` (tipe `DirEntry` kembar), `FilesNode.tsx` | S | Pasang bersama #7 (delete symlink) |
| 13 | Allowlist `Host` di `authorize()` (DNS rebinding) — WS terpisah, bukan scope file manager | `auth.ts`, `index.ts`, `serverConfig.ts` | S–M | Merusak akses via hostname kustom/reverse-proxy tanpa `WEBTERM_ALLOWED_HOSTS` |
| 14 | Path relatif ditolak (`400`) di `pathParam` | `fsApi.ts` | S | Mungkin ada pemanggil internal yang mengirim relatif — grep dulu |

Urutan: 1, 2 (hotfix) → 3, 4, 5, 6 (fondasi tulis) → 12, 7 (mutasi) → 9, 10 (sinkron) → 11, 8. Butir 13 jalan paralel.

**Belum terverifikasi `[BT]`**: perilaku BOM/EOL `getValue()` Monaco; xattr/ACL hilang pada `rename` macOS; kompatibilitas `trash`/`@parcel/watcher` di Bun; apakah klien lama mengabaikan `ServerMsg.t` baru; nomor CVE/versi Vite `allowedHosts`; DNS rebinding terhadap server ini belum dieksploitasi nyata; nilai default `max_user_watches` Linux; berapa sering Bun benar-benar membelah chunk pada trafik browser nyata (mekanisme terbukti, frekuensi tidak).

**Koordinasi lintas topik**: viewer/`Content-Disposition`/nosniff (topik 36), UI konflik/inline-rename/DnD upload (topik 35), fitur zip/properties/permission editor (topik 38) memakai verb di §4 — jangan didefinisikan ulang di sana.
