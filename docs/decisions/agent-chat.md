# Agent Chat: keputusan desain (D1-D12)

Sumber lengkap: `PLAN/AGENT-CHAT.md`. Dokumen ini merangkum *kenapa* node `agentChat` dirakit begini.
Kode: `src/server/agentChat/*`, `src/client/agentChat/*`, `src/shared/agentChat.*`.

## Kenapa node chat SDK di samping agent terminal

Node agent terminal menjalankan `claude` interaktif di PTY/tmux; itu tetap ada dan perilakunya tidak
diubah. Node Agent Chat menjalankan Claude Code yang sama lewat Claude Agent SDK tanpa terminal, supaya
hasilnya bisa dirender sebagai chat: Markdown, kartu tool, kartu izin, form pertanyaan, review plan,
Stop, cost dan context. Hanya SDK yang mendokumentasikan izin interaktif (`canUseTool`),
`interrupt()`, `setPermissionMode()`, antrean prioritas, dan `getSessionMessages()`; menulis ulang
protokol `control_request` CLI sendiri ditolak (D2).

nodeterm pernah membuang node chat SDK karena binary native ratusan MB per installer Electron
dan permission mode yang diabaikan (D3). webterm server Bun memakai CLI terpasang lewat
`spawnClaudeCodeProcess` (launch profile dan wrapper seperti envman tetap dihormati), dan mode awal =
`settings.claudePermissionMode` seperti terminal (`manual` dipetakan ke `default`).

## Model proses (D4, D5)

- Server pemilik proses, bukan klien. Satu `AgentChatSession` per node di `AgentChatPool`, dibuat saat
  rute pertama dipakai. `Query` (satu proses Claude) dibuka lazily pada pesan pertama dan tetap hidup
  walau tab atau stream putus.
- Idle `AGENT_CHAT_IDLE_CLOSE_MS` (10 menit) tanpa turn: `Query` ditutup; pesan berikutnya membuka
  ulang dengan `resume`. Paling banyak `AGENT_CHAT_MAX_LIVE` (3) proses hidup; lewat batas, yang idle
  paling lama di-suspend (bisa di-resume), tidak pernah yang sedang turn.
- Node dihapus atau workspace dihapus: `closeRemovedAgentChats` / `closeWorkspaceAgentChats` menutup
  session (abort, izin pending jadi `expired`), tanpa proses yatim. Shutdown server sama.
- Restart server: proses tidak di-adopt. Riwayat dimuat dari transcript Claude (`getSessionMessages()`,
  tanpa tabel DB, nol migration); log event in-memory hanya untuk replay reconnect (`seq`,
  `?after=` / `Last-Event-ID`, batas `AGENT_CHAT_EVENT_LOG_MAX`). `seq` mulai lagi dari 1 setelah
  restart, jadi stream yang datang dengan cursor di depan log melanjutkan penomoran setelah cursor itu
  (`resumeAfter`); tanpa itu halaman yang tetap terbuka membuang semua event baru.
- Satu pemilik per session id (`AgentChatLock`): dua penulis pada satu transcript merusaknya. Node chat
  lain, atau node agent terminal di workspace yang sama dengan session id itu, membuat resume ditolak
  dengan notice yang menyebut alasannya.

## Alur izin (D7, D8)

`canUseTool` dari SDK masuk ke session: status jadi `awaiting`, event `permission` dikirim ke klien
(dan di-replay saat reconnect), jawaban ditunggu di `AgentChatBroker`. Jawaban: Allow once (selalu
echo `updatedInput`, CLI lama menolak allow tanpa itu), Always allow (`updatedPermissions` dari
`suggestions`), Deny dengan pesan. Signal abort (Stop, tutup) menyelesaikan kartu sebagai `cancelled`;
tutup Query menyelesaikannya sebagai `expired`. Callback tidak pernah menjawab `null`. Status
`awaiting` dipertahankan selama ada prompt terbuka, karena SDK sering memanggil `canUseTool` sebelum
`tool_use`-nya selesai dipetakan. `AskUserQuestion` dijawab lewat `updatedInput.answers`;
`ExitPlanMode` jadi kartu plan (Approve dengan mode lanjutan, atau Keep planning).

## Gerbang uiOnly (D10, D12)

Rute `/api/agent-chat/:nodeId/{stream,send,interrupt,permission,mode,history}` dibungkus `uiOnly`
(`routes/agentChat.routes.ts`) dan tidak ada di `isNodeTokenPath`: hanya halaman webterm di browser
(`sec-fetch-site: same-origin`) yang boleh memakainya. Token node agent ditolak, jadi agent tidak bisa
mengirim pesan atau menyetujui izinnya sendiri lewat chat (pola sama `approval-ui-origin.md`). Prompt,
output, dan input tool tidak dilog; error dilog dengan operasi + nodeId saja.

## Klien

Node baru belum ada di server sampai board tersimpan (debounce), jadi stream pertama bisa 404 dan
mencoba lagi. Riwayat pertama baru dimuat setelah stream pertama terbuka; sebelum itu node menampilkan
"Connecting to Claude…", bukan error. Badge "streaming" hanya tampil selama turn berjalan, karena turn
yang di-Stop atau crash di tengah teks tidak pernah mengirim pesan final.

## Belum didukung

- Menu `/` dari `supportedCommands()`, paste gambar, picker/rename sesi, "Open in terminal" (SHOULD).
- Rewind/fork, @-mention file, komentar inline di plan, pre-warm proses (LATER).
- Provider non-Claude. Node ini juga bukan pengganti Central: Central memakai SDK yang sama, tapi satu `query()` sekali jalan per turn (bukan sesi hidup), dan spawn hook profil + drain stderr dibagi lewat `claudeLauncher/claudeSdkSpawn.ts`.
- Proses yang sedang turn tidak bertahan lewat restart server (tidak ada tmux): turn itu terpotong,
  izin pending hilang, pesan berikutnya me-resume session.
