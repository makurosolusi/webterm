# R&D 05: Paritas IDE harian (webterm vs Orca, VS Code, Cursor)

Worker: wkr-rnd-ideparity-45 · 2026-11-04 · read-only. Riset web dilakukan lewat ego-browser (berhasil, tanpa fallback). Sumber: kode webterm `main` (6cf021b), clone Orca `/tmp/st/orca-src` (v1.4.214), rilis VS Code 1.144 (28 Okt 2026), changelog Cursor (Sep–Okt 2026), README monaco-languageclient, dokumentasi code-server.

Prinsip yang dipakai: perkaya fitur (feedback-perkaya-fitur), tiru yang sudah terbukti jalan (feedback-tiru-referensi), zero-config (feedback-zero-config).

---

## 1. Inventaris: yang sudah dimiliki webterm untuk kerja dev harian

| Area | Status | Bukti |
|---|---|---|
| Terminal nyata, persist lintas reload/restart, split pane | ADA, kuat | `src/server/pty.ts`, `sessions.ts` (scrollback 256 KB), `src/client/paneTree.ts` (split ala Ghostty/tmux) |
| Agent node (Claude/Codex/Gemini), status hook working/waiting/blocked/done, resume `--session-id` | ADA | `src/server/hooks*.ts`, `hookStatus.ts`, README "How it works" |
| Context-link antar agent, catatan otomatis saat kabel berubah | ADA | `contextLink*.ts`, `linkNote*.ts`, `linkAwareness.ts` |
| Editor | ADA (Monaco) | `EditorNode.tsx`, `lazyMonaco.tsx` (worker json/css/html/ts), save atomik + version check, conflict bar (`EditorConflictBar.tsx`), preview Markdown Mod+M |
| Viewer | ADA | `src/client/viewers/` (image, media, PDF) |
| File manager | ADA, kuat | `FilesNode.tsx`, watch (`fsWatch.ts`), trash + undo (`fsTrash.ts`), upload/download |
| Quick open file | ADA, terbatas | `fsSearch.ts` (rg → git → walk), hanya saat files node fokus (`WEBTERM_FILES_QUICK_OPEN`) |
| Git | SEBAGIAN: hanya baca | `gitInfo.ts` (branch, dirty, ahead/behind), `filesSlot.git.tsx` (huruf M/A/D/U). Tidak ada diff, stage, commit, push, PR |
| Diff / review perubahan agent | TIDAK ADA | grep `DiffEditor\|createDiffEditor` di `src/` = nol |
| Cari isi file (global search) | TIDAK ADA | `fsSearch.ts` hanya nama file; `FindBar.tsx` hanya cari di terminal |
| LSP / Problems panel | TIDAK ADA | hanya worker TS Monaco per-model, tanpa proyek; `tsWorkerReaper.ts` malah mematikan worker |
| Debugger | TIDAK ADA | |
| Port / preview | SEBAGIAN | Browser node (CDP screencast) + buka URL dari link terminal (`terminalLinks.ts`, `browser.open.plan.ts`). Tidak ada deteksi port |
| Worktree per tugas | ADA tapi tersembunyi | `src/server/orchestrator/worktree.ts` hanya dipakai worker run orkestrator, tidak ada di UI workspace |
| Task runner / test explorer | TIDAK ADA | `knowledgeDocs.ts` membaca scripts untuk brief, tidak menjalankan |
| Notifikasi | SEBAGIAN | unread per node (`unread.ts`), Inbox, toast in-app (`vscodeNotification.tsx`), Telegram. Tidak ada notifikasi OS, suara, badge judul tab |
| Command palette | SEBAGIAN | Mod+K = cari node saja (`HelpOverlay.tsx`), QuickPick Output commands. Belum palette semua perintah |
| Keybinding kustom | TIDAK ADA | daftar shortcut statis di `HelpOverlay.tsx` (9 baris) |
| Akses remote / mobile | SEBAGIAN | token akses + bind non-loopback, Telegram (central chat, approval), viewport meta. Belum PWA, belum layout mobile |
| Riwayat sesi | SEBAGIAN | `closedHistory.ts` in-memory (hilang saat reload) |
| Usage | SEBAGIAN | `UsagePill.tsx` = konteks terpakai, bukan kuota plan |
| Komentar per node | ADA | `NodeComments.tsx` (bukan sticky note kanvas; `WsNodeKind` hanya terminal/agent/files/editor/browser) |
| Agen pusat, memory, skill store, knowledge base | ADA (unik, melebihi Orca/Cursor lokal) | `src/server/central/`, `knowledge/`, `memory/` |
| Dikte suara | ADA | `useSpeechInput.ts` |

Ringkasnya: webterm sudah unggul di terminal, orkestrasi, dan kanvas. Yang kosong justru lingkaran "agent menulis kode, saya review, saya commit". Itu loop yang paling sering dijalankan solo dev setiap hari.

---

## 2. Yang ditawarkan Orca, VS Code, Cursor (dipakai harian)

### Orca (v1.4.214, MIT, Electron) — pesaing paling dekat
- Worktree-native: tiap tugas = git worktree + branch + terminal + tab editor + tab browser sendiri. `orca.yaml` berisi `scripts.setup` (mis. `pnpm install`), dan `.worktreeinclude` menyalin file ignored seperti `.env` ke worktree baru (`docs/site/content/docs/model/worktrees.mdx`, `orca-yaml.mdx`).
- Diff viewer gabungan staged/unstaged/untracked terhadap start-from ref, image diff, merge 3-way, Changes view mode di tab editor (`review/diff-viewer.mdx`, `editing/monaco.mdx`).
- Annotate AI Diff: tombol + di gutter, komentar per baris, lalu kirim satu batch ke agent (`review/annotate-ai-diff.mdx`; kode `src/renderer/src/components/diff-comments/`).
- Attribution baris AI vs manusia di gutter (`review/attribution.mdx`).
- Source Control: stage, commit (Cmd-Enter), "Generate with AI" untuk pesan commit, "Fix with AI" saat hook pre-commit gagal, push (force-with-lease harus eksplisit), create PR, status checks/review inline (`review/commit-push.mdx`, `review/github.mdx`; kode `src/main/git/`).
- Notifikasi saat agent working→idle: notifikasi OS, suara, chip, bell persisten, badge Dock (`notifications.mdx`; `src/main/notifications/`).
- Port scanner per workspace (`src/main/ports/darwin-netstat-listeners.ts`, `local-workspace-port-scanner.ts`, `components/ports/WorkspacePortScanner.tsx`).
- Quick Open Cmd-P (recency + skor), omnibox tab+file+URL+agent, Jump Palette Cmd-J lintas worktree (`model/quick-open.mdx`).
- Agent Session History: memindai transcript CLI di disk, bisa dicari, tombol Resume (`agents/session-history.mdx`).
- Usage dan rate-limit per provider di status bar, chip peringatan di 80% (`agents/usage-tracking.mdx`).
- Design Mode: klik elemen di Chromium, HTML+CSS+crop screenshot masuk ke prompt agent.
- Drag file/gambar ke prompt agent, editor Markdown kaya, Mermaid, automations terjadwal (`cli/automations.mdx`), worktree checkpoint comment (`cli/worktree-checkpoints.mdx`), mobile companion iOS/Android, SSH worktree + port forwarding.

### VS Code 1.144 (28 Okt 2026)
- Agent Host + Agent Host Protocol: sesi agent tetap hidup walau klien ditutup, lanjut lintas VS Code / CLI / github.com.
- Agents window: kelola agent lintas workspace. Nested session bisa memakai "New Worktree" untuk mengisolasi perubahan.
- Working set (eksperimental): Keep/Undo inline per hunk untuk edit agent, plus daftar semua perubahan tertunda di atas input chat. Edit lewat terminal tidak tercatat.
- Assisted permissions: tool call yang lolos cek risiko disetujui otomatis.
- Model comparison ("Agent Bake-Off"): satu prompt ke beberapa model/harness sekaligus.
- Cloud sessions dan Cloud Automations (jadwal atau event repo), Remote Environments dialog (SSH, tunnel, WSL), computer use, canvas UI dari agent, editor Markdown WYSIWYG.
- Fitur dasar yang dipakai tiap hari: Search view (ripgrep), Problems panel (LSP + problem matcher task), SCM view, Ports view (auto-forward), Testing view, Tasks (`tasks.json`, npm scripts), Settings Sync, Notebook.

### Cursor (Sep–Okt 2026)
- Remote Control: lihat dan balas agent lokal dari app iOS, ada opsi "Keep this computer awake" (6 Okt).
- Bot PR: Bugbot, Security Review (temuan + attack path + usulan fix), Rollouts (memantau deploy per PR) (23 Sep).
- Cloud agent canvas, Environments API (16 Okt), Agent SDK: agent sebagai folder (`instructions.md`, `tools/`, `skills/`, `channels/`, evals) (20 Okt).

### Pola 2026 yang konsisten di ketiganya
1. Perubahan agent dimodelkan sebagai unit yang bisa direview: working set, diff + anotasi, keep/undo.
2. Isolasi lewat worktree per tugas, lalu bandingkan dan merge.
3. Sesi agent dipisah dari klien, dan bisa dipantau/dibalas dari HP.
4. Notifikasi berbasis status agent, bukan sekadar output terminal.
5. Bot review PR dan automations terjadwal.

webterm sudah punya nomor 3 secara arsitektur (PTY server-side, Telegram) dan sebagian nomor 5 (central autonomy). Nomor 1, 2, dan 4 yang kosong.

---

## 3. Daftar gap, diurutkan menurut dampak harian (satu pengguna)

Skor dampak: H = dipakai berkali-kali per hari, M = harian, L = mingguan atau jarang.

### G1 (H). Review diff perubahan agent + anotasi yang dikirim balik ke agent
- Kenapa nomor 1: tanpa ini user tetap harus membuka VS Code/Cursor untuk melihat apa yang ditulis agent. Inilah alasan utama aplikasi lain masih dibuka.
- Tiru: Orca Annotate AI Diff (`src/renderer/src/components/diff-comments/`, `editor/DiffSectionItem.tsx`, `ChangesModeView.tsx`) dan Working set VS Code (Keep/Undo per hunk).
- Implementasi: node baru `diff` (atau mode "Changes" di EditorNode) memakai `monaco.editor.createDiffEditor`. Monaco sudah terpasang, jadi tidak perlu dependency baru. Endpoint server `GET /api/git/diff?root=&ref=` memanggil `git diff --no-color` dan `git show <ref>:<path>`, dengan pola eksekusi argumen-array yang sama seperti `gitInfo.ts`. Komentar per baris disimpan seperti `Comment` di `shared/workspace.ts`, lalu "Send to agent" mengirim satu batch lewat jalur `linkNoteDelivery.ts` yang sudah bisa mengetik ke sesi Claude yang idle. Keep/Undo per hunk = `git apply -R` untuk hunk itu.
- Bonus cerdas: tarik kabel dari agent node ke diff node, maka diff otomatis memakai cwd/worktree agent itu dan otomatis refresh saat status hook menjadi `done`.

### G2 (H). Source control: stage, commit, push, PR, dengan bantuan AI
- Tiru: Orca `review/commit-push.mdx` + `src/main/git/source-control` (Generate with AI, Fix with AI saat hook gagal, force-with-lease hanya sebagai aksi terpisah); VS Code SCM view.
- Implementasi: panel SCM di sidebar memakai daftar perubahan dari `status --porcelain=v2` yang sudah diparse `gitInfo.ts`. Tambah verb POST `stage|unstage|commit|push`. Pesan commit dibuat dengan pola `nameGen.ts` (claude print mode atas `git diff --staged`) dan dipandu konvensi Rule 9. PR: `gh pr create` jika `gh` ada di PATH (deteksi seperti `binaryOnPath.ts`). Kegagalan hook ditampilkan inline, dengan tombol untuk menyerahkan output ke agent node terhubung.
- Keamanan: commit/push lewat UI human-only, dengan gerbang `approvalAuth.ts` (same-origin, bukan kredensial agent), sama seperti approval.

### G3 (H). Worktree per tugas sebagai warga kelas satu workspace
- Tiru: Orca `model/worktrees.mdx` + `orca.yaml scripts.setup` + `.worktreeinclude`; VS Code nested session "New Worktree"; fitur Orca "fan one prompt across five agents, compare, merge the winner".
- Implementasi: dialog "New workspace" mendapat opsi "dari branch baru (worktree)". Gunakan ulang `src/server/orchestrator/worktree.ts` yang sudah teruji, bukan menulis baru. Setup script dibaca dari `orca.yaml` bila ada (kompat gratis dengan repo yang sudah memakai Orca), dengan fallback deteksi lockfile (`bun.lock` → `bun install`). Salin file `.worktreeinclude`. Hapus workspace = tawarkan hapus worktree + branch, dengan konfirmasi. Tombol "Bandingkan" membuka G1 antar dua worktree.

### G4 (H). Notifikasi saat agent selesai atau butuh input
- Tiru: Orca `notifications.mdx` (OS + suara + chip + bell + badge), `src/main/notifications/desktop-away-state.ts` (hanya memberi tahu saat user tidak sedang melihat).
- Implementasi: event status sudah ada (`StatusMsg`, `unread.ts`). Tambahkan Web Notifications API (izin diminta sekali lewat sakelar di Settings, zero-config), suara pendek, `document.title` dengan jumlah unread, dan favicon badge. Kalau tab tersembunyi lebih dari N menit, teruskan ke Telegram (outbox sudah ada). Klik notifikasi membawa fokus ke node tersebut (`canvasViewport.ts`).
- Murah dan berdampak langsung. Cocok sebagai quick win pertama.

### G5 (H). Cari isi di seluruh proyek (Cmd+Shift+F) + Quick Open global
- Tiru: VS Code Search view (ripgrep `--json`); Orca bundled ripgrep (`src/main/ripgrep/`) + Quick Open berbasis recency + Jump Palette Cmd-J.
- Implementasi: `fsSearch.ts` sudah men-spawn `rg` dengan argumen array. Tambahkan verb `grep` yang memakai `rg --json -n --max-count`, dengan limit dan paginasi (Rule 13). Hasil dibuka di EditorNode pada baris yang dicari. Cmd+P dibuat global (tidak perlu files node fokus) dengan skor recency. Cmd+K diperluas menjadi omnibox: node, file, URL, agent, dan perintah.

### G6 (M-H). Deteksi port + preview otomatis di Browser node
- Tiru: Orca `src/main/ports/darwin-netstat-listeners.ts` + `local-workspace-port-attribution.ts` (port dikaitkan ke PID turunan PTY); VS Code Ports view (auto-forward); code-server `/proxy/<port>` dan `/absproxy/<port>` untuk akses remote.
- Implementasi: server memindai listener (`lsof -iTCP -sTCP:LISTEN -nP` di macOS, `/proc/net/tcp` di Linux) secara berkala, lalu mencocokkannya dengan pohon PID tiap sesi PTY. Chip "localhost:5173" muncul di chrome node terminal, sekali klik membuka Browser node di sebelahnya (`browser.open.place.ts` sudah ada). Allow-list loopback untuk Browser node sudah ada. Untuk akses dari HP, proxy `/proxy/<port>` di belakang gerbang token.

### G7 (M). Riwayat sesi agent yang persist + resume
- Tiru: Orca `agents/session-history.mdx` (memindai transcript CLI, filter per workspace/proyek, Resume).
- Implementasi: `transcriptPath.ts` dan `transcriptPresence.ts` sudah tahu lokasi transcript Claude. Indeks `~/.claude/projects/*/*.jsonl` (judul, cwd, branch, waktu, preview), panel "History" di sidebar Sessions, Resume membuka agent node dengan `--resume <id>`. `closedHistory.ts` dipersist ke SQLite agar tidak hilang saat reload.

### G8 (M). Command palette lengkap + keybinding kustom
- Tiru: VS Code Command Palette + `keybindings.json`; Orca `ButtonKeyHint.tsx` (hint shortcut di tombol).
- Implementasi: satu registry perintah (id, label, handler, default key) yang dipakai oleh dock, menu, context menu, dan QuickPick yang sudah ada (`vscodeQuickPick.tsx`). Override keybinding disimpan di `settingsStore.ts`. `HelpOverlay.tsx` dibangkitkan dari registry, sehingga daftar shortcut tidak pernah basi.

### G9 (M). Problems panel / diagnostik, lalu LSP
- Tiru: tangga dua langkah. Langkah 1 adalah problem matcher VS Code: jalankan `tsc --noEmit --watch` / `eslint -f json` di latar dan parse outputnya (persis yang dilakukan VS Code tasks). Langkah 2 adalah `monaco-languageclient` 11.0.3 (TypeFox, rilis 2026-10-15) + `vscode-ws-jsonrpc` 4.0.3 yang menyambungkan `typescript-language-server` lewat WebSocket, untuk go-to-definition lintas file, hover, dan rename.
- Implementasi: langkah 1 tanpa dependency baru. Hasilnya tampil di panel bawah (tab di samping Output) dan sebagai marker Monaco, plus penghitung di status bar. Bonus: "Fix with agent" mengirim daftar error ke agent terhubung. Langkah 2 baru dikerjakan bila langkah 1 terasa kurang. Verifikasi kompat versi `monaco-editor` yang terpasang dengan `@codingame/monaco-vscode-api` sebelum mulai.

### G10 (M). Task runner dari `package.json` / `orca.yaml`
- Tiru: VS Code NPM Scripts explorer; Orca `orca.yaml` scripts.
- Implementasi: baca `scripts` (sudah dibaca `knowledgeDocs.ts`), tampilkan di dock atau palette, lalu klik untuk membuka terminal node yang menjalankan `bun run <x>`. Status exit code ditampilkan di chrome node. Hasil test gagal bisa diumpankan ke G9. Test explorer penuh: L, lewati dulu.

### G11 (M). Design Mode di Browser node
- Tiru: Orca `docs/browser/design-mode.mdx`.
- Implementasi: Browser node sudah memakai CDP. Tambahkan mode pilih elemen (`Overlay.setInspectMode` / `DOM.getNodeForLocation`), ambil outerHTML + computed style + crop `Page.captureScreenshot` dengan clip, lalu kirim ke agent yang terhubung kabel lewat `linkNoteDelivery.ts`. Izin akses tetap memakai model "kabel adalah izin" yang sudah ada.

### G12 (M). Mobile companion: PWA + layout ringkas
- Tiru: Cursor Remote Control (lihat dan balas agent lokal dari HP); Orca mobile companion; skill `cupertino-pwa` yang sudah terpasang.
- Implementasi: `manifest.webmanifest` + service worker (belum ada) + Web Push untuk G4. Route `/m` menampilkan daftar sesi + status + input balas, karena kanvas pan/zoom tidak nyaman di HP. Telegram tetap jadi jalur cadangan.

### G13 (L-M). Usage dan rate-limit plan
- Tiru: Orca `agents/usage-tracking.mdx` (Claude: `api.anthropic.com/api/oauth/usage` memakai login Claude Code yang sudah ada, polling sekitar 15 menit, chip 80%).
- Catatan: endpoint OAuth itu tidak terdokumentasi resmi. Tandai sebagai best-effort, dan jangan mencetak token (Rule 7).

### G14 (L). Lainnya, ditunda dengan alasan
- Sticky note / whiteboard di kanvas: murah dan cocok dengan kanvas, tapi dampak kerja kode kecil. `NodeComments` sudah menutupi sebagian.
- Editor Markdown WYSIWYG + Mermaid (Orca, VS Code 1.144): bagus untuk docs, tapi preview Mod+M sudah ada.
- Automations terjadwal (Orca `cli/automations.mdx`, VS Code Cloud Automations): webterm sudah punya `WEBTERM_CENTRAL_AUTONOMY`. Tinggal ditambah pemicu cron untuk prompt.
- Bot review PR (Cursor Bugbot/Security Review): bisa dibuat sebagai skill central yang berjalan saat G2 membuat PR. Tunggu G1 dan G2 selesai.
- Model bake-off (VS Code): versi webterm = G3 (fan-out ke beberapa worktree), lalu bandingkan dengan G1.
- Debugger (DAP): biaya besar, pemakaian harian rendah untuk alur yang berpusat pada agent. Alternatif sekarang: `bun --inspect` + DevTools di Browser node.
- Notebook, Settings Sync: tidak relevan untuk satu mesin dan satu pengguna.

---

## 4. Urutan rekomendasi

1. Gelombang A (quick win, 1–2 hari, tanpa dependency baru): G4 notifikasi, G5 global search, G8 registry perintah.
2. Gelombang B (inti pengganti IDE): G1 diff + anotasi, lalu G2 SCM. Keduanya berbagi endpoint `git diff` dan dikerjakan berurutan.
3. Gelombang C: G3 worktree workspace (memakai ulang `orchestrator/worktree.ts`), G6 port + preview, G7 riwayat sesi.
4. Gelombang D: G9 langkah 1, G10, G11, G12.

Risiko yang perlu dicatat:
- G2 dan G3 menyentuh mutasi git. Butuh gerbang human-only dan konfirmasi sebelum menghapus branch.
- G6 menambah proxy port, sehingga permukaan SSRF bertambah. Pakai ulang `browser/ssrf.proxy.ts` dan allow-list yang sudah ada.
- G9 langkah 2 dan G13 bergantung pada dependency atau API eksternal. Verifikasi versi saat implementasi (Rule 20).
