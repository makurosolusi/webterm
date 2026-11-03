# 37-a — File manager: kebenaran mutasi & sinkronisasi (bagian 1: §0-3)

Topik 3 R&D file manager. Basis: worktree `rnd-files` (HEAD `fdaf2b4`). Bukti = `file:baris` di `src/`; eksperimen kecil dijalankan di `/tmp` (bukan dev server, bukan browser). `[BT]` = belum terverifikasi, `[opini]` = penilaian saya.

## 0. Ringkasan (3 temuan terpenting)

1. **"New File…" menimpa file yang sudah ada dengan kosong** (P0). `createEntry` langsung `write(target,'')` tanpa cek ada (`FilesNode.tsx:204`), dan `writeText` memakai `fs.writeFile` flag `w` = truncate (`fsOps.ts:211`). Di macOS (APFS case-insensitive) cukup mengetik `readme.md` saat `Readme.md` ada. Direproduksi (§7).
2. **Seluruh sisi mutasi hampir tidak ada**: server hanya punya 6 verb (`list/read/read-binary/exists/write/mkdir`, `fsApi.ts:57-97`). Tidak ada delete, rename, move, copy, duplicate, upload, download. Yang ada pun tanpa versi/konflik: `write` = last-writer-wins, non-atomik, error-nya hanya `{ok:false}`.
3. **Tidak ada sinkronisasi**: tanpa watcher (disengaja, `FilesNode.tsx:5-7`), editor tidak tahu file diubah/dihapus/di-rename (`EditorNode.tsx:139,174,236` "path node tidak berubah"), dan ⌘S pada file yang sudah dihapus **membuat ulang** file itu diam-diam.

## 1. Inventaris permukaan sekarang

| Kemampuan | Ada? | Bukti |
|---|---|---|
| list (folder dulu, `.git` disembunyikan, flag ignored) | ya, fail-open | `fsOps.ts:124-140` |
| read teks (cap 10 MiB, sentinel) / biner base64 (cap 24 MiB) | ya, melempar | `fsOps.ts:184-206`, `shared/fsLimits.ts:11-12` |
| write teks UTF-8 | ya, `true/false` | `fsOps.ts:209-217` |
| mkdir -p | ya | `fsOps.ts:220-228` |
| exists | ya (`stat`, ikut symlink) | `fsOps.ts:231-238` |
| delete / rename / move / copy / duplicate | **tidak** | `fsApi.ts:81` hanya `write\|mkdir` |
| upload / download (stream, `Content-Disposition`) | **tidak** | — |
| stat (size/mtime/mode/symlink) | **tidak**; `DirEntry` = `{name,dir,ignored}` | `fsOps.ts:59-64` |
| versi/ETag/`expectedVersion` | **tidak** | `fsApi.ts:93-96` |
| watcher / event push | **tidak**; `ServerMsg` hanya `output\|exit\|status` | `shared/protocol.ts:22` |
| git per-file (M/A/U) | **tidak**; hanya flag `ignored` dan info repo per-cwd | `fsOps.ts:92-117`, `shared/gitInfo.ts`; klien tidak memanggil `/api/git/info` dari FilesNode |
| menu konteks | Open, Open in Terminal, New File, New Folder, Copy Path | `FilesNode.tsx:259-279` |

Paritas nodeterm: `nodeterm-web/src/core/fs-handlers.ts` juga hanya 6 method — jadi menambah mutasi adalah **fitur baru webterm**, bukan regresi. Yang bisa ditiru dari nodeterm: `fs-atomic.ts` (`writeFileAtomic` :373, `tempNameFor` :354, `renameAtomic` retry :81, `sweepStaleTempFiles` :178) dan pola re-arm watcher di `workspace-watcher.ts:59-95`.

## 2. Tabel celah (severity + bukti)

P0 = kehilangan/korupsi data tanpa peringatan pada alur normal; P1 = fitur mutasi hilang / risiko nyata bersyarat; P2 = kerapian.

| ID | Sev | Celah | Bukti |
|---|---|---|---|
| M-01 | P0 | New File menimpa file ada (truncate); case-insensitive FS memperparah | `FilesNode.tsx:196-208`, `fsOps.ts:211`; repro §7 |
| M-02 | P0 | Save tanpa deteksi konflik: perubahan eksternal/node lain ditimpa; file terhapus dibuat ulang; path editor tak ikut rename | `EditorNode.tsx:99-103`, `fsOps.ts:211`, `EditorNode.tsx:139,174,236`; `openEditorFor` cocok `filePath` string (`fileOpen.ts:18-20`) |
| M-03 | P1 | Body POST dibaca `data += chunk` (Buffer → string per chunk) → karakter multibyte yang terbelah batas chunk jadi U+FFFD **tersimpan ke file**. Direproduksi di Bun 1.4.2 dan Node 26.7 dengan body ter-stream. Tanpa cap ukuran | `api.ts:38-45`, `api.ts:74` ("TANPA cap") |
| M-04 | P1 | Write non-atomik (truncate lalu tulis): crash/ENOSPC di tengah = file terpotong; pembaca lain (git, Vite HMR, build) melihat separuh isi | `fsOps.ts:211` |
| M-05 | P1 | Decode `utf-8` lossy: byte tak sah → U+FFFD, lalu Save menulis balik = korupsi file Latin-1/biner. `editorFileKind` menganggap SEMUA selain gambar/pdf sebagai `text` (zip/mp4 kecil terbuka di Monaco). BOM/EOL: [BT] perilaku Monaco `getValue()` | `fsOps.ts:189`, `editorFile.ts:39-45` |
| M-06 | P1 | Kontrak error mutasi miskin: `write` → HTTP 200 `{ok:false}` tanpa kode (EACCES/ENOSPC/EISDIR/EROFS/ENOENT semua sama); klien `post()` membuang alasan | `fsOps.ts:209-217`, `fsApi.ts:94-96`, `fsClient.ts:60-73`; bandingkan `READ_FAILURES` `fsOps.ts:162-168` |
| M-07 | P1 | Delete/rename/move/copy/duplicate/upload/download tidak ada | §1 |
| M-08 | P1 | Symlink ke direktori dilaporkan `dir:false` → dobel-klik membuka editor → `EISDIR` 400. Tak ada penanda symlink/broken link. Direproduksi | `fsOps.ts:134-136` |
| M-09 | P1 | Tanpa watcher/event: listing & editor basi; tidak ada multi-klien sync | `FilesNode.tsx:5-7` |
| M-10 | P1 | Proteksi transport lemah terhadap DNS rebinding: `sameOrigin` membandingkan `Origin.host` dengan header `Host`; keduanya dikontrol penyerang saat rebinding, dan loopback tanpa token. Tak ada allowlist Host (grep `allowedHosts`/`rebind` nihil). `[BT]` belum dieksploitasi | `auth.ts:95-107`, `auth.ts:11-12`, `fsOps.ts:32-39` (asumsi "ada Origin+token") |
| M-11 | P2 | Path relatif diterima dan di-resolve terhadap cwd proses server | `fsApi.ts:25-30`, `fsOps.ts:77-79` |
| M-12 | P2 | Validasi nama klien-saja & tipis: tak ada cek NUL, `NAME_MAX` (ENAMETOOLONG pada 300 byte, direproduksi), tabrakan huruf-besar-kecil, normalisasi Unicode (APFS: `café` NFC ditemukan via NFD, tapi `findIndex(e.name===want)` `FilesNode.tsx:105` bisa meleset) | `fileBrowse.ts:59-67` |
| M-13 | P2 | `ancestorDirs` → hasil `mkdir` tiap segmen diabaikan; file menghalangi folder → pesan generik "Could not create" | `FilesNode.tsx:203` |
| M-14 | P2 | `flagIgnored` dilewati >2000 entry; hanya `ignored`, tak ada M/A/U/conflict, tak ada rollup folder | `fsOps.ts:88-93` |
| M-15 | P2 | Test: `fsOps.test.ts` (195 baris) + `fsOps.bun.test.ts` (96) menutup list/read/write dasar; `fsApi.ts` tak punya suite sendiri (hanya dipakai `workspacesApi.test.ts:158`, `systemLogEvents.test.ts:154`); `FilesNode.test.tsx` hanya 2 test (ikon, welcome) → `createEntry` tanpa test | §6 |

## 3. Semantik tulis yang benar

### 3.1 Versi & konflik (`expectedVersion`)

Rancangan: `read` mengembalikan `{content, version}` dan `write` menerima `expectedVersion?`. `version` = opaque string dari `stat` bigint: `mtimeNs` + `size` (+ `ino` bila perlu) — **jangan** `mtimeMs` float (kehilangan presisi). Tulis: `stat` → bandingkan → bila beda `409 {code:'EVERSION', current}`; sukses → balas `version` baru. Kompatibel mundur: field tambahan, `expectedVersion` opsional (nodeterm-style klien lama tetap jalan).

Referensi VS Code (diverifikasi dari sumber): `etag = mtime.toString(29)+size.toString(31)` (`src/vs/platform/files/common/files.ts:1575`); `FileService.writeFile` melempar `FILE_MODIFIED_SINCE` bila mtime+etag berubah dan hanya sekali membandingkan isi buffer sebelum menyerah (`fileService.ts:503-536`).

Batas jujur: cek-lalu-tulis **tidak atomik** (jendela TOCTOU ms) — cukup untuk kasus manusia, bukan kunci. Pilihan dengan `rename`+`link` bisa lebih ketat tapi mahal `[opini]`: tidak diambil.

### 3.2 Atomic write (temp + rename)

| Aspek | Keputusan |
|---|---|
| Pola | Tulis ke `.<nama>.webterm-<rand>.tmp` di **direktori yang sama** → `fsync` → `chmod` ke mode asli → `rename`. Tiru `nodeterm fs-atomic.ts:373` (`writeFileAtomic`) + `sweepStaleTempFiles` untuk sisa tmp |
| Symlink | **Resolve `realpath` dulu, tulis di sebelah target** — atau jatuh ke in-place bila target lintas-volume. VS Code menolak atomic untuk symlink (`diskFileSystemProvider.ts:272-286`) |
| Hard link, owner, ACL, xattr (Finder tags/quarantine) | `rename` mengganti inode → hilang/berubah. `[BT]` xattr macOS. Fallback in-place bila `nlink>1` atau `uid` beda |
| Direktori tak writable tapi file writable | Pembuatan tmp gagal `EACCES` → fallback in-place (sama seperti VS Code `canWriteFileAtomic`) |
| Watcher/git | tmp akan terlihat sebentar (Bun mengirim `rename:*.tmp`, §7) → filter pola `.webterm-*.tmp` di watcher; git melihat untracked sesaat |
| Windows | `EPERM` retry sudah ada di `renameAtomic` nodeterm :81 (webterm hanya macOS/Linux dev — rendah) |

Rekomendasi: atomic **default untuk file reguler non-symlink dengan nlink=1**, in-place fallback otomatis. `[opini]` ini lebih aman daripada VS Code (opt-in) karena webterm dipakai dengan agent yang membaca file bersamaan.

### 3.3 Create eksklusif

`create` = `open(path,'wx')` → `EEXIST` → `409 {code:'EEXIST'}`. Ini satu-satunya perbaikan M-01 yang benar di FS case-insensitive (kernel yang memutuskan, bukan `pathExists` lalu tulis = race). `mkdir` biarkan idempotent tetapi balas `{created:boolean}`.

### 3.4 Encoding

Minimal (S): `read` mengembalikan `encoding:'utf8'|'binary'` hasil sniff (NUL dalam 8 KB pertama atau decode `fatal:true` gagal → `binary`) sehingga editor menolak membuka biner sebagai teks (menutup M-05). Deteksi Latin-1/UTF-16/BOM-preserve = fitur tersendiri (M), diserahkan ke topik 36 untuk viewer; di sini cukup **jangan tulis balik** file yang tidak lolos decode ketat.


Bagian 2 (§4-8 kontrak operasi baru, keamanan, sinkronisasi, eksperimen, test, **Implikasi untuk webterm**): `37-FILEMANAGER-MUTASI-SINKRONISASI-b.md`.
