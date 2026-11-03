# PLAN FILEMANAGER-b — Kontrak lintas-WS, rencana tes, keamanan & aturan global, rollout, risiko

Lanjutan `FILEMANAGER-a.md` (tujuan, arsitektur, P-n, WS, gelombang). Spec siap-tempel: `-c.md` (WS-00..05), `-d.md` (WS-06..11).

## 5. Kontrak lintas-WS (satu file: `src/shared/fsContract.ts`, dibuat WS-00 di W0a, read-only setelahnya)

Perubahan kontrak setelah W0a = eskalasi ke orkestrator (kontrak berubah → WS terkait dirilis ulang).

### 5.1 Tipe (isi minimum `fsContract.ts`, ≤300 baris)

```ts
export type FsErrCode = 'ENOENT'|'EEXIST'|'EACCES'|'EISDIR'|'ENOTDIR'|'EINVAL'|'ENAMETOOLONG'
  |'ENOSPC'|'EROFS'|'ENOTEMPTY'|'EXDEV'|'EVERSION'|'ETOOLARGE'|'EBINARY'|'EDISABLED'|'EIO'
export type FsVersion = string                       // opaque: `${mtimeNs}-${size}`; klien TIDAK mem-parse
export interface FsFail { ok: false; code: FsErrCode; error: string; current?: FsVersion }
export interface FsOk { ok: true; version?: FsVersion }
export type FsResult<T = object> = (FsOk & T) | FsFail
export type EntryKind = 'file'|'dir'|'symlink-file'|'symlink-dir'|'symlink-broken'|'other'
export type GitMark = 'M'|'A'|'D'|'U'|'R'|'C'          // C = conflict; rollup folder = mark terkuat anak
export interface FileMeta {                             // superset DirEntry lama {name,dir,ignored}
  name: string; dir: boolean; ignored: boolean         // `dir` = hasil resolve target (symlink→dir = true)
  kind?: EntryKind; size?: number; mtimeMs?: number   // opsional: list lama tetap valid
  git?: GitMark
}
export interface ListV2 { entries: FileMeta[]; truncated: boolean }
export type ReadEncoding = 'utf8' | 'non-utf8' | 'binary'
export interface ReadMeta { content: string; version: FsVersion; encoding: ReadEncoding }
export interface FsCapabilities { mutate: boolean; viewers: boolean; watch: boolean; git: boolean;
  quickOpen: boolean; upload: boolean; listMax: number }
// WebSocket (protocol.ts): client→server {t:'fswatch',dir} | {t:'fsunwatch',dir}; server→client {t:'fsdirty',dir}
export type FsEventKind = 'created'|'deleted'|'renamed'|'written'|'dirty'
export interface FsEvent { kind: FsEventKind; path: string; from?: string; origin: 'local'|'remote' }
```

### 5.2 Verb HTTP (`/api/fs/<verb>`; auth gate `authorize()` di `/api/*` TIDAK diubah)

| Verb | Metode | Masuk | Keluar (sukses) | Gagal | Pemilik handler | Flag |
|---|---|---|---|---|---|---|
| `list` | GET | `path` | `DirEntry[]` (lama, tak berubah) | fail-open `[]` di klien | WS-01 (`fsOps.ts`) | — |
| `list-v2` | GET | `path`,`limit?` | `ListV2` | `FsFail` | WS-01 | — |
| `read` | GET | `path` | `{content}` (lama) + `version`,`encoding` (aditif) | melempar di klien (kontrak 2 dipertahankan) | WS-01 | — |
| `read-binary` | GET | `path` | `{base64}` | melempar | WS-01 | — |
| `exists` | GET | `path` | `{exists}` | — | WS-01 | — |
| `stat` | GET | `path` | `{ok:true,meta:FileMeta,version}` | `FsFail` | WS-01 | — |
| `create` | POST | `{path,content?}` | `{ok:true,version}` | `EEXIST` 409 | WS-01 (`fsOps.write.ts`) | — |
| `write` | POST | `{path,content,expectedVersion?,mustExist?}` | `{ok:true,version}` | `EVERSION` 409 + `current`; `ENOENT` bila `mustExist` | WS-01 | — |
| `mkdir` | POST | `{path}` | `{ok:true,created:boolean}` | `FsFail` | WS-01 | — |
| `delete` | POST | `{path,permanent?}` | `{ok:true,trashId?}` | `FsFail` | WS-04 | MUTATE |
| `restore` | POST | `{trashId}` | `{ok:true,path}` | `EEXIST`/`ENOENT` | WS-04 | MUTATE |
| `rename` | POST | `{from,to,overwrite?:false}` | `{ok:true,version?}` | `EEXIST` | WS-04 | MUTATE |
| `copy` | POST | `{from,to}` | `{ok:true}` | `EEXIST` | WS-04 | MUTATE |
| `raw` | GET | `path` (+`Range`) | bytes, `ETag`,`Accept-Ranges`,`Content-Type` | status HTTP | WS-06 | VIEWERS |
| `git-status` | GET | `path` (dir) | `{ok:true,marks:Record<string,GitMark>}` | `FsFail` | WS-08 | GIT_STATUS |
| `search` | GET | `root`,`q`,`limit?` | `{ok:true,files:string[],truncated}` | `FsFail` | WS-09 | QUICK_OPEN |
| `upload` | POST (stream) | `dir`,`name` (query) body bytes | `{ok:true,version}` | `ETOOLARGE` 413,`EEXIST` | WS-10 | UPLOAD |
| `capabilities` | GET | — | `FsCapabilities` | — | WS-00 | — |

Flag mati → verb terkait membalas `501 {ok:false,code:'EDISABLED'}`. Dispatcher (WS-00) menegakkannya SEBELUM memanggil handler.

### 5.3 Status HTTP ↔ kode

| code | HTTP | | code | HTTP |
|---|---|---|---|---|
| EEXIST, EVERSION, ENOTEMPTY | 409 | | ETOOLARGE | 413 |
| ENOENT | 404 | | EBINARY | 415 |
| EACCES, EROFS | 403 | | ENOSPC | 507 |
| EISDIR, ENOTDIR, EINVAL, ENAMETOOLONG, EXDEV(fallback gagal) | 400 | | EDISABLED | 501 |
| EIO / tak dikenal | 500 | | | |

`fsClient` (WS-00) mem-parse body `FsFail` walau status non-2xx; verb lama (`write`/`mkdir`) tetap menyertakan `ok`. Kontrak lama dipertahankan: `list`/`exists` fail-open, `read`/`read-binary` melempar (mencegah ⌘S menimpa dengan buffer kosong).

### 5.4 Bus & slot klien

| Kontrak | Isi | Pemilik |
|---|---|---|
| `fsEvents.ts` | `emitFsEvent(e: FsEvent)`, `onFsEvent(cb): off`; mutasi lokal `emit` setelah sukses; watcher `emit(origin:'remote')`. Konsumen: FilesNode (refresh), EditorNode (rename/delete/modifikasi), dekorasi git | WS-00 |
| `filesSlots.ts` | `interface FilesSlot { id; menu?(ctx):MenuRow[]; onKey?(e,ctx):boolean; decorate?(entry,ctx):Decoration\|undefined; toolbar?(ctx):ReactNode; useSlot?(ctx):void }`; `FILES_SLOTS: FilesSlot[]` (urutan tetap: mutate, git, watch, search, dnd, upload; tiap slot menyaring sendiri via `capabilities`). `ctx = {cwd, dir, entries, selection, refresh(), open(entry), nodeId}` | WS-00 (tipe+daftar); isi tiap slot oleh pemilik fitur |
| Props EditorNode baru (opsional, default = `fsClient`) | `read/write/readBinary` sudah ada; tambah `onConflict?`, `viewerHost?` | WS-02 |
| Drag MIME | `application/x-webterm-path` (JSON `string[]`) + `text/plain` (dikutip shell) | WS-09 |
| Persist | `WsNode.viewOpts?: {hidden:boolean; sortKey:'name'\|'size'\|'mtime'; sortDir:'asc'\|'desc'}` di `workspace.ts`; dipetakan `store.toFlow/toWsNode` | WS-00 |

### 5.5 Flag env (`envRegistry.files.ts`, WS-00; semua OFF, gaya `flag()`/`num()` seperti `envRegistry.platform.ts`)

| Key | Tipe/default | Mengunci |
|---|---|---|
| `WEBTERM_FILES_MUTATE` | flag OFF | delete/restore/rename/copy + UI-nya |
| `WEBTERM_FILES_VIEWERS` | flag OFF | `raw` + ViewerHost (tanpa ini: biner → placeholder, tetap aman) |
| `WEBTERM_FILES_WATCH` | flag OFF | `fswatch`/`fsdirty` |
| `WEBTERM_FILES_GIT_STATUS` | flag OFF | `git-status` + dekorasi |
| `WEBTERM_FILES_QUICK_OPEN` | flag OFF | `search` + Ctrl+P |
| `WEBTERM_FILES_UPLOAD` | flag OFF | `upload`/download |
| `WEBTERM_FILES_LIST_MAX` | num 5000 | cap `list-v2` (`truncated`) |
| `WEBTERM_FILES_UPLOAD_MAX_MB` | num 100 | cap upload (Rule 15) |

Perbaikan P0 (create-eksklusif, versi/konflik, body fix, penolakan biner) **tidak** di balik flag.

## 6. Rencana tes per WS

Perintah standar (macOS: `TMPDIR=/tmp/st` wajib): `TMPDIR=/tmp/st npm run typecheck` · `TMPDIR=/tmp/st npm test` · `TMPDIR=/tmp/st bun test src/server/*.bun.test.ts`. Tiap WS menjalankan ketiganya sebelum lapor; lapor hasil nyata (jumlah lulus/gagal), bukan klaim.

| WS | Tes otomatis wajib (nama = assertion nyata) | Skenario manual (TIDAK diklaim lulus oleh worker) |
|---|---|---|
| 00 | `fsApi.dispatch.test.ts`: flag mati→501 `EDISABLED`; path kosong→400; verb tak dikenal→404; `capabilities` mencerminkan env. `api` body: chunk multibyte terbelah (€ 3 byte dibelah antar chunk) tersimpan utuh; body >cap→413. `fsClient.test.ts`: `FsFail` ter-parse pada 409; `list`/`exists` fail-open, `read` melempar. `fileKind.test.ts`: tabel ekstensi+sniff NUL. `envRegistry.files.test.ts`: semua flag OFF default | restart server, workspace lama termuat |
| 01 | create `wx`: ada→`EEXIST` & isi lama utuh (regresi M-01); beda-huruf pada FS case-insens. → `EEXIST` (skip bersyarat bila FS case-sens.). write: `expectedVersion` basi→`EVERSION`+`current`; `mustExist` pada file terhapus→`ENOENT` (M-02); atomik: tmp tidak tersisa, mode terjaga; fallback in-place nlink>1; symlink ditulis di target. read: NUL→`binary`, byte tak sah→`non-utf8`; >10MiB sentinel tetap. list-v2: symlink→dir `dir:true`,`kind:'symlink-dir'`; broken→`symlink-broken`; `truncated` di atas `listMax`; >2000 entri tidak crash `flagIgnored`. Verb lama tidak berubah bentuknya (snapshot) | File dgn xattr/hardlink di Finder (`[BT]`) |
| 02 | `EditorNode.test.tsx`: ⌘S saat tidak dirty = tidak memanggil `write`; save kirim `expectedVersion`; `EVERSION`→banner Reload/Overwrite & buffer tak hilang; `ENOENT`→banner "terhapus", tidak dibuat ulang; encoding `binary`→tidak memuat Monaco, tidak ada Save; `non-utf8`→read-only. `editorFile.test.ts`: audio/video/zip bukan `text`. W2: rename event→`filePath` & title ikut; delete event→banner | Monaco nyata di Chrome |
| 03 | `FilesNode.test.tsx`/`files.shell.test.tsx` (jsdom): New File ke nama ada→notice error, **tidak** memanggil overwrite; file baru dibuka; klik saat loading tak membuka path lama (G-04); seleksi per-nama bertahan setelah refresh (G-17); role/aria pada kontainer; F2/Delete/Shift+↑↓/⌘A/PageUp-Down memanggil handler yang benar dan `stopPropagation` (Backspace tak menghapus node); multi-select; input inline Enter/Esc/validasi; `filesKeys.test.ts` & `fileBrowse.test.ts` diperluas (natural sort, nama NUL/panjang) | Touch iOS, 5k entri di Chrome (`content-visibility`) |
| 04 | `*.bun.test.ts` di `TMPDIR=/tmp/st`: delete→masuk trash & `restore` kembali; `restore` ke nama ada→`EEXIST`; permanen hilang; rename `EEXIST` tanpa `overwrite`; rename hanya-huruf lolos; rename folder ke dalam dirinya→`EINVAL`; copy rekursif + tak mengikuti symlink keluar; `EXDEV`→fallback copy+rm; semua path ditolak di luar root yang diizinkan resolve (`resolveFsPath`) | Trash lintas-volume nyata |
| 05 | Tes DOM: Delete→konfirmasi→panggil `delete`→toast Undo→`restore`; Shift+Delete→konfirmasi permanen; rename inline→`rename`; duplikat memilih nama bebas (`copy 2`); error `FsFail` tampil bahasa jelas (bukan "unreachable") | alur dgn agent aktif menulis |
| 06 | `fsRaw.bun.test.ts`: `Range: bytes=0-9`→206 + `Content-Range`; `If-None-Match`→304; header `X-Content-Type-Options: nosniff`, CSP `sandbox` untuk HTML/SVG; MIME tak dipercaya→`application/octet-stream` untuk tak dikenal; file >limit tetap streaming; path luar→ditolak. Klien: registry memilih viewer per `fileKind`; `ViewerHost` fallback placeholder bila flag mati | Putar mp4/mp3, PDF di Chrome |
| 07 | `fsWatch.bun.test.ts`: tulis file→`fsdirty` ≤ debounce; refcount: watcher dilepas saat klien terakhir pergi/WS tutup; filter `.webterm-*.tmp`; direktori dihapus→re-arm/err tanpa crash; fallback polling bila `fs.watch` error | Banyak klien, direktori besar |
| 08 | `fsGit.bun.test.ts` (repo temp di `/tmp/st`): M/A/U/D/R/C terparse dari porcelain v2 `-z`; spasi/unicode di nama; rollup folder; bukan repo→`marks:{}` tanpa error; cap entri | Repo besar |
| 09 | `fsSearch.bun.test.ts`: urutan fallback rg→git→Glob (rg tak ada→lanjut); cap 50.000; `.gitignore` dihormati; sanitasi `q`. Klien: quoting shell (`'` dan spasi) tanpa newline akhir; DnD MIME benar | Ctrl+P bentrok browser |
| 10 | `fsUpload.bun.test.ts`: stream tulis ke tmp lalu `rename`; >cap→413 & tmp dibersihkan; `EEXIST` tanpa overwrite; nama berisi `/`,`..`,NUL ditolak; download pakai `Content-Disposition` aman (RFC 5987) | Upload 100MB nyata |
| 11 | `fileManager.integration.bun.test.ts`: create→write(versi)→konflik→rename→delete→restore→raw berurutan pada server uji | Pre-deploy checklist (Rule 6) |

## 7. Keamanan & aturan global

| Rule | Penegakan |
|---|---|
| **7** Credential | Tidak ada nilai secret di log/tes/spec; `WEBTERM_TOKEN` tidak dicetak. Raw/upload via `authorize()` yang sama. Worker dilarang membaca `.env*`. `raw` dgn token-in-query: `Referrer-Policy: no-referrer`, `Cache-Control: private, no-store` untuk respons terautentikasi `[opini: P-5]` |
| **10** Dependensi | Nol baru (P-3). Tambahan apa pun → berhenti & lapor nama+alasan+alternatif+lisensi |
| **11** Error | Tidak ada `catch {}` kosong baru; tiap re-throw menyebut operasi+path+penyebab (pola `getStrict`). Pengecualian terdokumentasi: fail-open `list`/`exists` (kontrak 1) tetap dengan komentar alasan. Fix harus menyebut akar penyebab |
| **12** Log | Log hanya `basename` + ukuran/ok (pola `fsApi.ts`), bukan isi file, bukan path penuh bila memuat nama pengguna `[opini]`, bukan token. Hapus debug log sebelum selesai |
| **13** Performa | `list-v2` ber-cap (`FILES_LIST_MAX`), `search` ber-cap, `git-status` satu proses per direktori, tidak ada query-per-entri; stream untuk `raw`/`upload`/`copy` besar (tidak memuat penuh ke memori); `content-visibility:auto` dulu sebelum virtualisasi |
| **15** Hardcode | Cap/limit lewat `shared/fsLimits.ts` atau env (§5.5); nama folder trash, debounce 150 ms, 8 KB sniff = konstanta bernama; pesan UI di satu modul per komponen |
| **16** Docs | Docstring 1 baris tiap symbol publik baru; README terbatas (hanya bagian env/endpoint yang berubah) oleh WS-11; keputusan non-obvious → `docs/decisions/files-manager.md` |
| **17** Hutang | `TODO(files): … — issue #?` bergantung konteks; stub W0a yang belum diisi diberi tanda eksplisit `// STUB(WS-FM-xx): … belum diimplementasi` dan ditutup oleh pemilik; tidak ada kode mati/comment-out |
| **8** File health | Batas per tipe (a §4.1); `index` re-export saja |
| Identitas | Tidak mengubah `NODETERM_*`, `x-nodeterm-node-token`, `nodeterm:` atau sentinel `\u0000nodeterm:too-large:` |

Path & traversal: semua verb melewati `resolveFsPath` (relatif ditolak, M-11 dipersempit di W0b oleh WS-01: path non-absolut → `EINVAL`). `rename/copy/delete` menolak root `/` dan home; nama entri divalidasi di server (NUL, `/`, `..`, panjang ≤255 byte) — validasi klien tetap hanya UX. Kelemahan DNS-rebinding (M-10) **tidak** ditutup di sini (P-6) dan WS-11 mencatatnya di docs.

## 8. Rollout bertahap (S0..S5)

| Tahap | Isi | Masuk | Keluar | Rollback |
|---|---|---|---|---|
| **S0** | W0a+W0b ter-merge ke integrasi (4 P0 hidup, flag semua OFF) | tes 3 gerbang hijau | regresi P0 hijau; manual: buat file ber-nama ada, edit di 2 tab, buka mp4 — dilakukan user | revert merge W0b; stub legacy menjaga perilaku lama |
| **S1** | W1: shell terpecah + a11y/keyboard + viewers/raw (flag VIEWERS ON di dev) | S0 + tes DOM hijau | FilesNode tiap file ≤300; Chrome manual 5k entri diukur oleh user | matikan flag VIEWERS; revert shell |
| **S2** | W2: MUTATE ON di dev; WATCH/GIT ON di dev | S1; trash teruji | alur Delete→Undo manual lulus oleh user | matikan MUTATE (verb → 501); data trash tetap di `trash/` |
| **S3** | W3: QUICK_OPEN, UPLOAD ON di dev | S2 | cap & traversal teruji | matikan flag |
| **S4** | W4: docs+CHANGELOG+checklist Rule 6/18 | S3 | semua ✅ pada checklist | — |
| **S5** | Keputusan user: flip default flag → ON, merge ke `main` | perintah eksplisit user | — | flip default kembali OFF |

**Tidak boleh diklaim tanpa bukti**: "tidak ada data hilang" (hanya tes yang ada); perilaku xattr/hardlink/ACL macOS; kinerja 5k+ entri; iOS/touch; Range/seek media di Chrome nyata; ketahanan watcher pada pohon besar; keamanan terhadap DNS-rebinding; kompat Safari/Firefox; "selesai" tanpa tiga gerbang hijau.

## 9. Risiko & pertanyaan terbuka

| ID | Risiko / pertanyaan | Dampak | Mitigasi / keputusan |
|---|---|---|---|
| R-01 | Semua WS bergantung pada W0a; bila telat, semua idle | jadwal | WS-00 dibatasi ke kontrak+kabel+stub; tidak memuat logika fitur; ±½-1 hari |
| R-02 | Verb lama `write` mengubah status HTTP (200→409) memecah tes lain (`workspacesApi.test.ts:158`, `systemLogEvents.test.ts:154`) | tes merah | WS-00 menjalankannya di W0a; kegagalan di sini milik WS-00; WS lain dilarang mengedit tes itu |
| R-03 | Atomic rename mengubah inode: hardlink/xattr/ACL/Finder tag hilang `[BT]` | data meta hilang | fallback in-place bila nlink>1/uid beda; uji manual oleh user |
| R-04 | TOCTOU pada cek-versi (jendela ms) | konflik sangat langka terlewat | diterima & didokumentasikan (RND/37 §3.1); bukan kunci |
| R-05 | `fs.watch` macOS: event ganda/rename-tmp, batas descriptor | listing berkedip/banjir | debounce, filter tmp, refcount, cap watcher, fallback polling; flag OFF |
| R-06 | Raw endpoint + token-in-query bocor lewat Referer/log | kebocoran token | `no-referrer`, tak log query (`log` hanya basename), ticket ditunda (P-5) |
| R-07 | SVG/HTML via `raw` jalankan script origin sama | XSS | CSP `sandbox`, `nosniff`, `<img>` untuk SVG (bukan iframe); HTML tidak dirender (teks) di v1 |
| R-08 | Refaktor shell (W1) merusak handler capture shadow-DOM `vscode-tree` 2.5.1 | regresi keyboard | tes DOM dulu sebelum pecah (W0b menambah tes), pecah mekanis tanpa ubah perilaku, lalu fitur |
| R-09 | DnD/“Insert path” ke terminal butuh jalur kirim-input ke sesi terminal; belum diverifikasi apakah ada API klien selain WS `input` `[BT]` | WS-09 terblok | WS-09 memverifikasi dulu; bila perlu sentuh `TerminalNode` → eskalasi, v1 cukup Copy Path/Insert via clipboard |
| R-10 | Worker melapor selesai tanpa perubahan (memori: laporan fiktif) | klaim palsu | orkestrator verifikasi `git diff --stat` per WS sebelum menerima |
| R-11 | Trash tumbuh tak terbatas | disk | retensi: sapu saat start (>30 hari, konstanta bernama) — WS-04; ukuran dilaporkan di `capabilities` tidak perlu |
| R-12 | Case-insensitive FS: rename hanya-huruf lewat `rename` langsung bisa gagal di sebagian FS `[BT]` | rename gagal | uji pada APFS; fallback via nama sementara |
| R-13 | Normalisasi Unicode (NFC/NFD) membuat `findIndex(name===want)` meleset (M-12) | seleksi salah | seleksi/reveal membandingkan `normalize('NFC')` (WS-03) |
| R-14 | DNS-rebinding transport (M-10) | akses fs dari web luar | P-6: tandai, usulkan WS keamanan terpisah di `auth.ts`; jangan klaim aman |

Pertanyaan terbuka untuk user: P-1, P-2, P-6 (utama); P-5 (ticket vs query), P-9 (hidden), P-12 (tanpa diff 3-arah).

## 10. Definisi selesai (semua WS)

1. Tiga gerbang hijau dengan angka nyata dilaporkan. 2. `git status --short` hanya berisi path miliknya. 3. Tidak ada file > batas Rule 8. 4. Tidak ada TODO tanpa konteks, `catch{}` kosong, debug log, atau hardcode baru. 5. Docstring 1 baris untuk symbol publik baru. 6. Tidak ada `commit/push/merge`.
