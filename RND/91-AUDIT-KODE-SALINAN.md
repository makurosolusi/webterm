# 91 — Audit kode salinan dari referensi eksternal

## Status (diperbarui)

Semua 15 file/kelompok yang ditandai audit ini kini sudah **ditulis ulang dari perilaku dan dokumentasi**:

- Gelombang pertama (tujuh): `linkNoteComposer`, `browser.discard`, `tsWorkerReaper`, `terminalKeys.mouse` (copy-on-select), `fileBrowse`, `daReplyGate`, `settings.terminal`.
- Adaptasi dekat (delapan): `fsLimits`, `themes`, `contextLinkTranscript`, `terminalConfig`, `shellQuote`, `workspace.capabilities`, `contextLinkRender`, `workspace.agents`.
- Ditambah tinjauan `agentActions`, `filesKeys`, `editorFile`, `markdownLinks`, serta tes turunan untuk `agentActions`, `editorFile`, `fileBrowse`, `filesKeys`, `themes` dan chrome-kit.

Jujur: webterm **bukan clean-room murni**. Penulis ulang membaca versi lama lebih dulu. Yang berubah nyata:
struktur, penamaan, komentar dan data tes. Sumber fakta sekarang dokumentasi resmi atau spesifikasi
(referensi CLI, pola WAI-ARIA, aturan POSIX, referensi opsi xterm, palet berlisensi terbuka). Tes policy
menjaga agar penanda "ported/copied from/verbatim" tidak kembali:
`src/shared/independentRewrite.policy.test.ts` dan `src/client/independentSource.policy.test.ts`.

Masih terbuka:

- (a) `shellQuote` sengaja mempertahankan perilaku backslash-dalam-kutip-ganda yang lama (tidak POSIX ketat) karena kontrak pemakainya.
- (b) Bentuk baris JSONL transkrip Claude Code tidak terdokumentasi rinci; pembaca transkrip diturunkan dari kode dan tes repo ini.
- (c) Palet tema: nilai bright Tokyo Night ditulis dari ingatan akan tokyonight.nvim, dan lisensi Gruvbox terkonfirmasi dari README (file LICENSE 404).
- (d) Tinjauan hukum oleh manusia disarankan bila kepastian lisensi penting.

Rename protokol `nodeterm` -> `webterm` tidak mengubah status ini; nama lama hanya diterima
sementara sebagai fallback (batas 0.10.0), tanpa migrasi data dir.

---

Status: audit baca-saja, 2026-11-16. Tidak ada kode yang diubah. Referensi = repo terminal manager berlisensi BUSL-1.1 yang dipakai sebagai bahan studi (disebut "referensi eksternal"). Tidak ada kode referensi yang ditempel di dokumen ini.

## Metode

1. `git grep -niE "nodeterm|BUSL|adapted|attribution|salin|ported|copied"` pada `src/` dan `scripts/` (154 file memuat sebutan; sebagian besar hanya nama env/protokol atau komentar "mirip", bukan salinan).
2. Penanda provenance di komentar: "Port/Diporting/Diadaptasi/disalin/copied/verbatim".
3. Pengukuran bukti: untuk tiap file non-tes di `src/` dan `scripts/`, baris kode ternormalisasi (spasi dirapikan, tanpa komentar/import, panjang >= 24 karakter) dicocokkan persis terhadap seluruh file `.ts/.tsx/.css` repo referensi lokal. Hasil = persentase baris webterm yang identik dengan baris di satu file referensi (kolom "Overlap"). Ini ukuran kasar: angka tinggi = bukti kuat salinan; angka rendah dengan penanda "port" = struktur/ide dipakai tetapi ditulis ulang.

Tingkat: **A** salinan (overlap >= 0.85 atau penanda "verbatim"), **B** adaptasi dekat (0.5-0.85), **C** adaptasi/turunan struktural (0.2-0.5), **D** terinspirasi/ditulis ulang (< 0.2 atau tanpa kecocokan baris; hanya ide/konstanta/perilaku).

Rekomendasi: **ULANG** = tulis ulang dari spesifikasi perilaku (clean room: satu orang menulis spek perilaku, orang lain menulis kode tanpa melihat sumber); **TINJAU** = bandingkan manual lalu tulis ulang bagian yang identik; **OK** = ide/konstanta umum, tidak perlu tindakan selain menghapus atribusi nama di komentar.

## A. Salinan (prioritas tulis-ulang)

| File | Bukti | Overlap | Rekomendasi |
|---|---|---|---|
| `src/server/daReplyGate.ts` | Header: "Ported verbatim"; 29/29 baris identik dengan satu file referensi | 1.00 | ULANG |
| `src/client/tsWorkerReaper.ts` | TANPA penanda; 22 dari 23 baris kode cocok dengan satu file referensi bernama sama (komentar webterm menjelaskan temuan sendiri, tetapi kodenya sama) | 0.96 | ULANG; tambah penanda bila tetap dipakai sementara |
| `src/client/terminalKeys.mouse.ts` | Penanda hanya menyebut zoom, tetapi bagian copy-on-select cocok 38 baris dengan file copy-on-select referensi; TANPA penanda untuk bagian itu | 0.94 | ULANG bagian mouse/copy-on-select |
| `src/server/linkNoteComposer.ts` | Header: "PORTED" dari modul layar Claude referensi (`readClaudeScreen` dan pasangannya) | 0.88 | ULANG |
| `src/shared/settings.terminal.ts` | 10 dari 12 baris cocok dengan tipe Settings referensi (nilai default/rentang terminal) | 0.83 | TINJAU (sebagian besar konstanta; ganti nama/struktur) |
| `src/client/fileBrowse.ts` | Header: "Porting"; 59 dari 73 baris cocok dengan modul file-tree referensi | 0.81 | ULANG |

## B. Adaptasi dekat

| File | Bukti | Overlap | Rekomendasi |
|---|---|---|---|
| `src/shared/fsLimits.ts` | Prefiks sentinel too-large berasal dari referensi; 13 baris cocok (kini diganti ke `webterm:` oleh worker kode) | 0.76 | TINJAU setelah rename |
| `src/client/themes.ts` | Header: "Port"; 45 baris cocok dengan tabel tema referensi (palet warna) | 0.73 | ULANG palet (pilih warna sendiri / tema terbuka berlisensi permisif) |
| `src/server/contextLinkTranscript.ts` | Komentar: "ported verbatim" untuk parser transkrip Claude | 0.67 | ULANG (tulis dari format JSONL Claude Code yang terdokumentasi) |
| `src/client/terminalConfig.ts` | Header: "port"; 47 baris cocok dengan konfigurasi terminal referensi | 0.62 | ULANG |
| `src/shared/claudeLaunch/shellQuote.ts` | Header: "copied"; tokenizer + quoter POSIX | 0.62 | ULANG (fungsi kecil dan baku; atau pakai pustaka shell-quote berlisensi permisif bila lolos Rule 10) |
| `src/shared/workspace.capabilities.ts` | TANPA penanda; 18 baris cocok dengan konfigurasi agent referensi (tabel kapabilitas per agent) | 0.60 | TINJAU (data fakta tentang CLI agent, struktur ditulis ulang) |
| `src/server/contextLinkRender.ts` | TANPA penanda; 16 baris cocok dengan render context-link referensi | 0.53 | TINJAU, tulis ulang format keluaran |
| `src/shared/workspace.agents.ts` | Header: "Porting ramping" dari konfigurasi agent referensi | 0.50 | TINJAU |

## C. Adaptasi struktural (kemiripan sebagian)

| File | Penanda / bukti | Overlap | Rekomendasi |
|---|---|---|---|
| `src/shared/agentStale.ts` | "Porting" predikat basi + konstanta jendela waktu | 0.50 (file kecil) | TINJAU |
| `src/client/terminalKeys.ts` | "Port" chord copy/paste/Shift+Enter; sebagian kecocokan dengan file zoom font referensi | 0.42 | TINJAU |
| `src/server/workspaceCreate/cloneUrl.ts` | "copied ... verbatim" untuk beberapa fungsi (parse progress clone, derive nama repo) | 0.38 | ULANG fungsi bertanda verbatim |
| `src/shared/settings.agent.ts` | Tipe settings agent, dekat dengan tipe referensi | 0.36 | TINJAU |
| `src/client/chat/chatAttach.ts` | "copied" pembaca clipboard/drop | 0.34 | ULANG (API DOM baku; mudah ditulis ulang) |
| `src/client/paletteTargets.ts` | "Ported" logika pencarian palet | 0.30 | TINJAU |
| `src/client/filesKeys.ts` | "Diport" interaksi keyboard file tree | 0.30 | TINJAU |
| `src/client/sessionList.ts` | "Porting" pengelompokan + filter sesi | 0.26 | TINJAU |
| `src/client/agentChat/composerCompletion.ts` | "ported" logika menu completion | 0.22 | TINJAU |
| `src/client/agentActions.ts` | "Diporting" urutan keluar/restart agent; angka (jumlah Ctrl-C, tabel exit) berasal dari pengukuran referensi | 0.20 | TINJAU: ukur ulang sendiri dan tulis ulang |
| `src/client/editorFile.ts`, `src/client/markdown.ts`, `src/client/markdownLinks.ts`, `src/client/useEditorFile.ts` | "Port" dari util preview markdown/file lokal | 0.07-0.24 | TINJAU markdownLinks dan editorFile; sisanya OK |
| `src/server/fsOps.ts` | "Diadaptasi"; 16 baris cocok (rantai baca/tulis fs) | 0.15 | TINJAU |
| `src/server/workspaceCreate/workspaceCreate.ts`, `src/client/workspaceCreate/CloneRepoDialog.tsx` | "copies ... clone()" / "after ... CloneRepoDialog" | 0.15 | TINJAU |

## D. Terinspirasi / ditulis ulang (tanpa kecocokan baris berarti)

Penanda menyebut referensi (sering sebagai "pola", "aturan yang sama", "beda dari ..."), tetapi kode webterm tidak identik. Tindakan: hapus nama referensi dari komentar (dilakukan worker kode) dan pertahankan alasan perilaku.

- Server: `agentSubmit.ts`, `hookStatus.ts`, `hooksSettings.ts`, `hooksTokens.ts`, `transcriptPresence.ts`, `ptySupervisor.ts` (pola satu sesi tmux per node; periksa bahwa nama socket/opsi tmux bukan salinan literal), `pty.ts`, `ptyShell.ts`, `terminalSocket.ts` (konstanta water-mark backpressure; angka saja), `uiSession.ts`, `wsOrigin.ts`, `auth.ts`, `approvalAuth.ts` (same-origin), `linkNote.ts`, `linkNoteDelivery.ts`, `linkNoteScreen.ts`, `settingsStore.ts`, `launchLine.ts`, `nameGen.ts`, `browser/navigation.guard.ts`, `browser/browser.agentOpen.ts`, `browser/browser.linkedTarget.ts`, `central/work/workEscalation.ts`, `outbox/outboxDelivery.ts`, `workspaceCreate/projectsFolder.ts`, `workspaceCreate/workspaceCreate.route.ts`.
- Shared: `browser.discard.ts` (predikat satu ekspresi `!loading && !driven && hiddenMs >= discardMs`; berbeda dari sumber di operator dan parameter, bukan kecocokan baris; header mengutip "fork BUSL-1.1" yang kini salah, lihat catatan), `workspace.commands.ts`, `settings.ts`.
- Client: `AgentNode.tsx`, `App.*`, `BrowserLeaseChip.tsx`, `Dock.*`, `EditorNode.tsx`, `FilesNode.tsx`, `NodeChrome.tsx`, `SessionRow.tsx`, `SettingsAgents.tsx`, `TerminalCore.tsx`, `WorkspaceBar.tsx`, `agentChat/*`, `browser.keys.ts`, `browser.noticeAction.tsx`, `browser.status.ts` (`webviewError` sebagai ide: pesan galat navigasi per nama), `canvasMenu.model.ts`, `closedHistory.ts`, `fileOpen.ts`, `filesTree.ts`, `floatingEdge.ts`, `nodeCloseConfirm.tsx`, `unread.ts`, `useFilesTree.ts`, `useSettings.ts`, `workspaceMenu.ts`.
- CSS: `node-chrome.css` mempertahankan nama animasi berawalan `nt-*` "supaya cocok" dengan referensi (komentar eksplisit); selain itu `styles.css`, `sessions-panel.css`, `chat.css`, dll. memakai nama kelas umum dengan overlap 0.09-0.13 (pola utilitas, bukan salinan).

Item daftar "salin-dan-adaptasi" di dokumen rencana yang diminta:

| Item | Temuan |
|---|---|
| `shouldDiscard` / `browser.discard` | Ada di `src/shared/browser.discard.ts`; tingkat D (predikat satu ekspresi). Header perlu dibersihkan dari klaim "fork" |
| `quickOpenSearch`, `listQuickOpenFiles` | TIDAK ada di `src/` (Quick Open sengaja tidak diport; lihat `RND/38-FILEMANAGER-FITUR-BENCHMARK.md`). Tidak ada tindakan |
| `webviewError` | Ide dipakai di `src/client/browser.status.ts` (pemetaan error navigasi); tingkat D |
| `browserUrl` | Ide dipakai di `src/server/browser/navigation.guard.ts` (aturan localhost); tingkat D |
| `linkNoteComposer` | `src/server/linkNoteComposer.ts`, tingkat A (0.88). ULANG |
| `BrowserDrivingChip` | Ide aturan "selalu terlihat saat disetir" di `src/client/BrowserLeaseChip.tsx`; tingkat D |

## Catatan lintas file

- Atribusi/lisensi: header `src/shared/browser.discard.ts` dan baris `PLAN/BROWSER-CANVAS-c.md` (sudah dikoreksi di dokumen) menyebut "fork BUSL-1.1 + atribusi"; ini bertentangan dengan fakta bahwa webterm dibuat dari nol. Selama file tingkat A/B masih ada, klaim "tidak ada kode disalin" di `CLAUDE.md` dan `RND/31-BROWSER-REFERENSI-ANALISIS.md` belum akurat. Urutan yang benar: tulis ulang tingkat A dan B dulu, baru hapus penanda.
- Tes: berkas tes yang mengutip tabel/perilaku referensi (`agentActions.test.ts`, `editorFile.test.ts`, `fileBrowse.test.ts`, `filesKeys.test.ts`, `themes.test.ts`, `chrome-kit.test.ts`) ikut berasal dari tes referensi ("Diadaptasi dari ... test"). Tulis ulang bersama kodenya.
- Fixture/nama di tes (`central/*.test.*` memakai nama workspace contoh yang menyebut referensi) hanya string contoh, bukan salinan.
- Batas metode: kecocokan baris persis tidak menangkap penggantian nama variabel; file berpenanda "port" dengan overlap rendah tetap perlu tinjauan manusia bila ada kekhawatiran lisensi. Repo referensi hanya dibaca; tidak ada isinya yang disalin ke sini.
- Urutan kerja yang disarankan (satu gelombang): (1) daReplyGate, tsWorkerReaper, terminalKeys.mouse, linkNoteComposer, fileBrowse, themes; (2) contextLinkTranscript, terminalConfig, shellQuote, cloneUrl, chatAttach; (3) sisanya tingkat B/C; (4) setelah itu bersihkan komentar penyebut referensi.
