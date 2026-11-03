# PLAN FILEMANAGER-c — Spec siap-tempel WS-FM-00..05

Lanjutan `-a.md` (kepemilikan §4.1, gelombang §4.2) dan `-b.md` (kontrak §5, tes §6, aturan §7). Setiap spec ditempel utuh ke worker. Preambul wajib untuk SEMUA worker (tempel di awal):

> Kamu worker `wkr-fm-<ws>`. Worktree/branch: dari orkestrator. DILARANG: `git commit/push/merge/checkout/stash/reset`, install dependensi, membaca `.env*`, mencetak secret, membuka browser/dev server. HANYA edit path yang tertulis di "File milik". Butuh file lain → STOP dan lapor. Aturan global: Rule 8 (batas baris), 11, 12, 15, 16, 17. Identitas protokol `nodeterm` tidak diubah. Jalankan `TMPDIR=/tmp/st npm run typecheck`, `TMPDIR=/tmp/st npm test`, `TMPDIR=/tmp/st bun test src/server/*.bun.test.ts`; lapor angka nyata. Skenario manual jangan diklaim lulus. Laporan akhir: daftar file + `wc -l` + `git status --short` + hasil tes.

---

## WS-FM-00 — Fondasi & hot spot (W0a, `feature/fm-foundation`)

**Tujuan**: pasang seluruh kabel sehingga WS lain hanya mengisi file miliknya; tutup M-03 (body).

**File milik**: `src/shared/fsContract.ts`(baru), `shared/fileKind.ts`(+`.test.ts`, baru), `shared/fsLimits.ts`, `shared/protocol.ts`, `shared/workspace.ts`, `src/client/store.ts`, `fsClient.ts`(+test), `fsEvents.ts`(+test, baru), `filesSlots.ts`(+test, baru), `nodeTypes.tsx`, `nodeList.ts` (diharapkan TIDAK berubah), `src/server/api.ts`, `index.ts`, `fsApi.ts`(+`fsApi.dispatch.test.ts`), `envRegistry.ts`, `envRegistry.files.ts`(+`envRegistry.files.test.ts`, baru), `fsOps.ts` (hanya wrapper ≤30 baris, lalu diserahkan ke WS-01). **Stub baru** (header `// STUB(WS-FM-xx)`, diserahkan): server `fsOps.write.ts`(01), `fsOps.mutate.ts`,`fsTrash.ts`(04), `fsRaw.ts`(06), `fsWatch.ts`(07), `fsGit.ts`(08), `fsSearch.ts`(09), `fsUpload.ts`(10); klien `filesSlot.mutate.tsx`(05), `filesSlot.watch.ts`(07), `filesSlot.git.tsx`(08), `filesSlot.search.tsx`,`filesSlot.dnd.ts`(09), `filesSlot.upload.tsx`(10), `viewers/ViewerHost.tsx`(06).

**Perilaku**:
1. `fsContract.ts` = blok tipe `-b.md` §5.1 (persis, ≤300 baris). `fileKind.ts`: `fileKind(name, sniff?)→'text'|'image'|'pdf'|'audio'|'video'|'markdown'|'archive'|'binary'` dari tabel ekstensi (serap `editorFile.ts:39-45` tanpa mengubah file itu — WS-02 yang menyambungkan); `sniffBinary(bytes: Uint8Array)→boolean` (NUL dalam 8 KB pertama, konstanta `SNIFF_BYTES` di `fsLimits.ts`); `decodeStrict(bytes)→string|null` (`TextDecoder` `fatal:true`).
2. `api.ts`: untuk rute `/api/fs/*` ganti `readBody` → `readCappedBody(req, FS_BODY_MAX)` (`FS_BODY_MAX` di `fsLimits.ts`, nilai = `MAX_TEXT_BYTES`+ margin JSON; baru 413 `{ok:false,code:'ETOOLARGE'}`). Pembaca lain (`gitInfo`, control) TIDAK diubah. Perbaiki akar: `data += chunk` mengubah Buffer→string per-chunk sehingga multibyte terbelah (M-03).
3. `fsApi.ts` jadi dispatcher tipis (≤150 baris): tabel `verb → {method, flag?, handler}`; menegakkan flag (501 `EDISABLED`), `path` wajib, pemetaan `FsFail`→status (§5.3), `capabilities`. Handler dipanggil dari modul bernama-tetap (stub). Verb lama (`list/read/read-binary/exists/write/mkdir`) tetap bentuk lama + field aditif; `write` memakai `writeFileChecked` dari `fsOps.write.ts` (stub = perilaku legacy `writeFile`, `version` kosong); `create` stub = cek `exists` lalu tulis (WS-01 menggantinya dengan `wx`).
4. `fsOps.ts` wrapper: ekspor `listDirV2`, `readTextMeta`, `statMeta` yang membungkus kode lama (version kosong, encoding `'utf8'`) agar dispatcher final. WS-01 menimpa isinya di W0b.
5. `protocol.ts`: tambah `ClientMsg` `fswatch|fsunwatch` & `ServerMsg` `fsdirty`; `index.ts`: cabang ws untuk dua pesan itu memanggil `fsWatchHub` stub (no-op bila flag WATCH off). Tidak ada perubahan perilaku lain.
6. `fsClient.ts`: seluruh permukaan klien (create/stat/listV2/delete/restore/rename/copy/capabilities/rawUrl/upload helper) memakai `FsResult`; `post()` mem-parse `FsFail` walau non-2xx; kontrak lama dipertahankan. `rawUrl(path)` memakai `tokenQuery()` yang sama.
7. `fsEvents.ts`, `filesSlots.ts` sesuai §5.4. `workspace.ts`+`store.ts`: `viewOpts` (P-15) di `WsNode`, `toFlow`, `toWsNode`; absen = default.
8. `envRegistry.files.ts` §5.5 (flag OFF), didaftarkan di `envRegistry.ts` `ENV_REGISTRY`.

**Tes wajib**: lihat §6 baris 00. Tambahan: tes round-trip `toFlow/toWsNode` untuk `viewOpts`; semua tes lama (termasuk `workspacesApi.test.ts`, `systemLogEvents.test.ts`) hijau tanpa diedit.

**Selesai bila**: tiga gerbang hijau; `git diff --stat` hanya path milik + stub baru; kontrak ter-commit-kan oleh orkestrator; tak ada logika fitur selain wrapper & body-fix; stub berlabel; dispatcher ≤150 baris.

---

## WS-FM-01 — Server inti (W0b, `feature/fm-server-core`)

**Tujuan**: tutup M-01, M-02 (sisi server), M-04, M-05 (sisi server), M-06, M-08, M-11, M-12 (sisi server).

**File milik**: `src/server/fsOps.ts`, `fsOps.write.ts`, `fsAtomic.ts`(baru), `fsOps.test.ts`, `fsOps.bun.test.ts`, `fsOps.write.bun.test.ts`(baru), `fsApi.bun.test.ts`(baru). Dilarang menyentuh `fsApi.ts` (jika bentuk handler perlu berubah → eskalasi).

**Perilaku**:
- `createFileExclusive(path, content='')`: `open(path,'wx')` → tulis → close; `EEXIST`→`FsFail` (kernel memutuskan).
- `writeFileChecked(path, content, {expectedVersion?, mustExist?})`: `stat` bigint → bandingkan `versionOf(stat)` (`${mtimeNs}-${size}`) → beda `EVERSION`+`current`; `mustExist` & ENOENT → `ENOENT`; tulis atomik (`.<nama>.webterm-<rand>.tmp` sedangkan dir sama → `fsync` → chmod mode asli → `rename`; symlink: `realpath` dulu, tulis di sebelah target; fallback in-place bila nlink>1, EACCES pada dir, EXDEV); balas versi baru. Sapu sisa `.webterm-*.tmp` lama (>1 jam) saat tulis di dir itu (konstanta bernama).
- `readTextMeta`: baca byte → `sniffBinary` → `binary` (konten kosong); `decodeStrict` null → `non-utf8` (konten decode lossy untuk tampilan read-only); selain itu `utf8`; sentinel too-large tetap. Pertahankan `READ_FAILURES` & sifat melempar.
- `listDirV2`: `lstat`+resolve target (symlink→dir `dir:true`,`kind`), `size`,`mtimeMs`, natural-numeric sort folder-dulu, cap `FILES_LIST_MAX` (→`truncated`), `flagIgnored` tetap dilewati >2000 tanpa gagal. `list` lama tak berubah.
- `statMeta`. Validasi nama server: NUL, ≥256 byte (`ENAMETOOLONG`), path non-absolut → `EINVAL`. `mkdir` balas `created`. Mapper errno→`FsErrCode` satu fungsi (`fsErrors` di `fsAtomic.ts` atau `fsOps.ts`, jaga Rule 8).

**Tes**: §6 baris 01 (semua). Tes FS case-insensitive dilewati bersyarat (deteksi runtime) dan dilabel.

**Selesai bila**: tiga gerbang hijau; regresi M-01 & M-02 server ada dan *gagal* bila perilaku lama dipulihkan (cantumkan bagaimana diverifikasi); tak ada file >300 baris (pecah `fsAtomic.ts`); verb lama snapshot tidak berubah.

---

## WS-FM-02 — Editor aman (W0b fase 1, W2 fase 2, `feature/fm-editor-safety`)

**Tujuan**: M-02 (klien), M-05 (klien), G-03; W2: editor ikut rename/delete, ViewerHost.

**File milik**: `src/client/EditorNode.tsx`, `editorFile.ts`(+test), `EditorNode.test.tsx`, `editor.css`, `fileOpen.ts`(+test), `fileOpenEdge.test.tsx`, `EditorConflictBar.tsx`(+test, baru). `EditorNode.tsx` sekarang 372 baris → wajib pecah komponen/hook (≤300) bila bertambah: `useEditorFile.ts` (baru, milik WS-02).

**Fase 1 (W0b)**: (1) `save()` punya guard `!dirty` (⌘S saat bersih = no-op, tak menulis). (2) `read` simpan `version`+`encoding`; `save` kirim `expectedVersion`+`mustExist:true`; sukses → perbarui `version`. (3) `EVERSION` → `EditorConflictBar` (Reload / Overwrite; Overwrite = ulang `write` dengan `expectedVersion=current`), buffer pengguna tidak hilang; `ENOENT` → bar "file terhapus" (Save As ditunda; Overwrite membuat ulang secara eksplisit). (4) `encoding:'binary'` → tidak memuat Monaco, tampilkan placeholder jujur "File biner — tidak dapat dibuka sebagai teks" + tombol Copy Path; `non-utf8` → read-only + banner (P-4). (5) `editorFileKind` memakai `fileKind()` dari WS-00: audio/video/archive tidak lagi `text`. (6) props baru opsional default ke `fsClient` sehingga `nodeTypes.tsx` tak disentuh.

**Fase 2 (W2)**: `onFsEvent` → `renamed` mengganti `filePath`+title node (lewat mekanisme update node yang ada; efek tak lagi `[]`-dep untuk path), `deleted` → bar terhapus, `written` remote → bila bersih auto-reload, bila dirty → bar konflik. Pasang `ViewerHost` (WS-06) untuk image/pdf/audio/video menggantikan cabang lama; `openEditorFor` mencocokkan path baru setelah rename (`fileOpen.ts`).

**Tes**: §6 baris 02.

**Selesai bila**: tiga gerbang hijau; tidak ada jalur ⌘S yang menimpa tanpa versi; Monaco tidak dimuat untuk biner; tes regresi gagal pada kode lama.

---

## WS-FM-03 — Shell FilesNode (W0b fase 1, W1 fase 2, `feature/fm-files-shell`)

**Tujuan**: G-01, G-04, G-17 (W0b); G-05..G-08, G-11, G-13..G-16, G-18..G-22, G-24 (W1).

**File milik**: `src/client/FilesNode.tsx`, `FilesList.tsx`, `FilesRow.tsx`, `FilesInput.tsx`, `FilesMenu.tsx`, `filesSelection.ts` (baru), `filesKeys.ts`(+test), `fileBrowse.ts`(+test), `fileIcon.ts`(+test), `files.css`, `FilesNode.test.tsx`, `files.shell.test.tsx`(baru), `canvasHarness.tsx`.

**Fase 1 (W0b, tanpa refaktor besar)**: tulis tes DOM dulu (nama ada, race loading, seleksi) lalu: `createEntry` memakai `fsClient.create` (eksklusif) dan menampilkan pesan dari `FsFail` (`EEXIST`: "Sudah ada: <nama>"); sukses → refresh + buka di editor (P-8); folder → `mkdir` (hasil `created:false` = notice "sudah ada"); sementara `loading` daftar dinonaktifkan/dikosongkan sehingga klik entri lama tak membuka path salah; seleksi disimpan per nama (NFC) bukan indeks. `window.prompt` tetap sementara.

**Fase 2 (W1)**: pecah mekanis jadi `FilesNode` (kerangka+state), `FilesList`, `FilesRow`, `FilesInput` (inline, ganti `window.prompt`; Enter/Esc/validasi), `FilesMenu`; semua ≤300. Manifest slot: render `FILES_SLOTS` (menu/key/decorate/toolbar) tanpa tahu isinya. Tambah: `role="tree"`/`aria-label`, satu model fokus (hapus model ganda), `aria-live` untuk notice dengan tombol Retry, 401 dibedakan dari "unreachable"; keyboard F2/Delete/←/→/PageUp/Down/Home/End/Shift+↑↓/⌘A/Menu key (Delete/F2 memanggil `slot.onKey`; aksi nyata diisi WS-05) dengan `stopPropagation` dipertahankan; multi-select (Set nama + anchor, Shift/⌘); header `icon="folder"` + `description={cwd}`; `title` pada nama; breadcrumb `maxVisible`; opsi tampilan hidden/sort (natural sort sudah dari server) dipersist lewat `viewOpts`; ikon: peta nama khusus + folder terbuka (set penuh tidak diambil, P-3); `content-visibility:auto` pada baris; hilangkan re-bind listener tiap render; menu: pemisah, shortcut, Reveal/Refresh/Relative Path.

**Tes**: §6 baris 03. **Selesai bila**: tiga gerbang hijau; tidak ada file >300 baris; perilaku W0b lama tetap lulus setelah pecah (tes tidak dilemahkan); Backspace tidak menghapus node (tes).

---

## WS-FM-04 — Mutasi server + trash (W1, `feature/fm-mutate-server`)

**File milik**: `src/server/fsOps.mutate.ts`, `fsTrash.ts`, `fsOps.mutate.bun.test.ts`, `fsTrash.bun.test.ts`.

**Perilaku**: `deleteEntry(path,{permanent})`: default pindahkan ke `<WEBTERM_DATA_DIR>/trash/<id>/<nama>` + `meta.json` `{origPath, deletedAt}` (rename; `EXDEV`→copy+rm), balas `trashId`; permanen `fs.rm` rekursif — tolak `/`, home, root yang tak boleh (daftar konstanta). `restoreEntry(trashId)` → `EEXIST` bila tujuan ada (tanpa menimpa). `renameEntry(from,to,{overwrite:false})`: `EEXIST` default; hanya-huruf diizinkan; folder ke dalam dirinya → `EINVAL`. `copyEntry(from,to)`: rekursif, tidak mengikuti symlink keluar, `EEXIST`. Sapu trash > retensi saat start (konstanta bernama; R-11). Semua verb dikunci flag oleh dispatcher; handler tetap defensif terhadap path kosong. Log hanya basename.

**Tes**: §6 baris 04. **Selesai bila**: tiga gerbang hijau; setiap verb punya tes `EEXIST`/traversal/permissions; tidak ada `rm` di luar trash/target yang dituju.

---

## WS-FM-05 — Mutasi UI (W2, `feature/fm-mutate-ui`)

**File milik**: `src/client/filesSlot.mutate.tsx`, `filesName.ts` (validasi nama klien: NUL, `/`, `..`, ≤255 byte, nama kosong/reserved; dibagi dengan `FilesInput`), tes (`filesSlot.mutate.test.tsx`, `filesName.test.ts`).

**Perilaku**: slot `mutate` (aktif bila `capabilities.mutate`): menu Rename (F2, inline), Delete (Delete → konfirmasi singkat → `delete` trash → toast Undo ±8 dtk → `restore`), Shift+Delete (konfirmasi permanen), Duplicate (`name copy`, `name copy 2`…), New File/Folder memakai `FilesInput`; multi-seleksi → delete/copy berkelompok sekuensial dengan ringkasan hasil; emit `fsEvents` setelah sukses; pesan error dari `FsFail.code` ke kalimat jelas (satu peta kode→teks, bukan hardcode tersebar). Tidak menyentuh `FilesNode.tsx`.

**Tes**: §6 baris 05. **Selesai bila**: tiga gerbang hijau; Undo teruji; tanpa `window.confirm/prompt`; flag mati → slot tak menambah menu apa pun (tes).
