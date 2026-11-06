# Agent Chat node — spec (feature/agent-chat-view)

Status: DRAFT menunggu persetujuan user. Basis: main `ce20281`. Bukti riset: `/tmp/st/agent-chat-ref.md`
(referensi produksi + API SDK, diakses 2026-11-06) dan `/tmp/st/agent-chat-map.md` (peta kode, sitasi path:line).

## 1. Tujuan

Node canvas BARU `agentChat`: Claude Code dijalankan tanpa terminal dan ditampilkan sebagai chat yang rapi
(streaming, Markdown, kartu tool, kartu izin, form pertanyaan, review plan). Kualitas target = Claude Code
di VS Code (referensi resmi yang terbukti di produksi).

Non-tujuan:
- Node agent terminal (`AgentNode`, `sessions.ts`, PTY/tmux, `applyNodeClaudeProfile`) TIDAK diubah perilakunya.
  Satu-satunya sentuhan di jalur terminal: tidak ada. Bila sebuah seam bersama harus diubah, perubahannya
  wajib nol-perilaku untuk terminal dan dibuktikan oleh test terminal yang sudah ada tetap hijau.
- Bukan pengganti Central (Central tetap `claude -p` steward per turn).
- Tanpa provider non-Claude.

## 2. Keputusan (dengan bukti)

**D1. Node baru, data minimal.** `WsNodeKind` + `'agentChat'` (blob JSON, nol migration;
`workspace.shape.ts:99-100`). Data: `agentId:'claude'` (otomatis ikut context-link/kanban/usage lewat
capability berbasis agentId, `workspace.capabilities.ts`), `claudeProfileId`, `chatSessionId?` (dicetak dari
`system/init`, bukan saat create — pola `AgentNode.tsx:73,83`), `permissionMode?`. Semua field masuk
`toFlow`/`toWsNode` (`store.ts:6-46`, daftar eksplisit).

**D2. Transport = Claude Agent SDK, versi pinned exact `0.3.318`, mode streaming-input, satu `Query` hidup
per node, dijalankan di server Bun.**
- Alasan: hanya SDK yang mendokumentasikan izin interaktif (`canUseTool`), `AskUserQuestion`, persetujuan
  plan, `interrupt()`, `setPermissionMode()`, antrean prioritas, `getSessionMessages()`. Protokol
  `control_request` CLI mentah tidak didokumentasikan (docs headless mengarahkan ke SDK). Menulis ulang
  protokol itu sendiri = tambal-menambal yang dilarang.
- Launch profile & proxy tetap dihormati lewat `spawnClaudeCodeProcess`: `command = argv[0]`,
  `args = argv.slice(1) ++ argsDariSDK`, env = merge (D9). Pola sama dengan `claudeProcessWrapper` VS Code.
  Profil user (wrapper envman 5 token) menjadi kasus test wajib.
- CLI yang dipakai = CLI terpasang (sekarang 2.1.318, cocok dengan SDK 0.3.318). Feature-detect lewat
  `system/init.capabilities`, bukan string versi.
- Dependency baru (Rule 10): `@anthropic-ai/claude-agent-sdk` (ketentuan komersial Anthropic; dependency,
  bukan vendoring) + peer `zod@^4`, `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk` (MIT). Semua pinned.
- **Fallback yang sudah diputuskan** bila Spike S0 gagal: CLI terdokumentasi
  `--input-format stream-json --output-format stream-json` + `--permission-prompt-tool` (tool MCP webterm
  yang menahan jawaban sampai user klik), Stop = tutup proses + `--resume`. Tidak ada improvisasi ketiga.

**D3. Mitigasi alasan upstream membuang node chat SDK** (`nodeterm-web/CLAUDE.md.bak:2596`, 2026-07):
1. *Binary native ~240–320 MB per platform*: upstream adalah app Electron yang mengemas binary itu ke
   installer. webterm server Bun yang memakai CLI terpasang lewat `spawnClaudeCodeProcess`, jadi binary
   bundled tidak dipakai dan tidak dikirim ke siapa pun. S0 membuktikan SDK jalan tanpa binary bundled; bila
   paket optional tetap terunduh, biayanya hanya disk `node_modules` (dicatat di docs).
2. *Node chat tidak menghormati permission mode*: di sini mode awal = `settings.claudePermissionMode`
   (`settings.ts:120`, sama dengan terminal), dipetakan `manual→default`, lainnya identik; bisa diganti per
   node lewat mode picker (`setPermissionMode`). `bypassPermissions` hanya bila setting user memang begitu
   (`allowDangerouslySkipPermissions` diset hanya pada kasus itu). Test wajib untuk tiap mode.

**D4. Siklus hidup proses (server pemilik, bukan klien).**
- `Query` dibuka lazily saat pesan pertama / resume; tetap hidup walau tab/WS putus.
- Idle `AGENT_CHAT_IDLE_CLOSE_MS` (konstanta bernama) tanpa turn → `close()`; pesan berikutnya membuka ulang
  dengan `resume: chatSessionId`. Batas proses hidup `AGENT_CHAT_MAX_LIVE` (pola `maxLive` browser); lewat
  batas → tutup yang idle paling lama, tidak pernah yang sedang turn.
- Node dihapus / workspace dihapus / shutdown server → `close()` (abortController), tanpa proses yatim.
  Test: tidak ada child tersisa setelah close/hapus/shutdown.
- Server restart: proses tidak di-adopt (tidak ada tmux). Riwayat dimuat dari `getSessionMessages()`; turn
  yang terpotong ditandai "interrupted by restart"; pesan berikutnya resume. Izin pending hilang secara
  eksplisit (kartu menjadi "expired"), bukan menggantung.

**D5. Satu pemilik per sesi.** Lock per `chatSessionId` di server. "Open in terminal" (SHOULD): tutup
`Query` dulu, lalu buat node agent terminal `claude --resume <id>`; selama node terminal dengan sessionId
sama ada di workspace, chat menolak resume dan menampilkan alasannya (meniru notice "Open here anyway").

**D6. Sumber kebenaran riwayat = transcript Claude via `getSessionMessages()`.** Tidak parse JSONL sendiri,
tidak tabel DB baru (nol migration). Turn yang sedang jalan: log event in-memory per node dengan `seq`
monoton untuk replay saat reconnect (`after=<seq>`), dibatasi `AGENT_CHAT_EVENT_LOG_MAX`.

**D7. Izin.** `canUseTool` → permintaan pending disimpan di broker server (id, tool, input, suggestions),
di-push ke klien, dikirim ulang saat reconnect. Jawaban: allow-once (selalu echo `updatedInput`),
always (`updatedPermissions` dari `suggestions`), deny + pesan. `signal` abort → kartu "cancelled". Tidak
pernah return `null`. Tool yang di-approve rule/mode dirender dari message stream (`tool_use`), bukan dari
callback.

**D8. Pertanyaan & plan.** `AskUserQuestion` (1–4 pertanyaan, 2–4 opsi, single/multi + Other) dijawab
lewat `updatedInput.answers`. `ExitPlanMode` → kartu plan Markdown, Approve (pilih mode lanjutan) / Keep
planning + feedback.

**D9. Env & identitas node.** Env anak = `claudeChildEnv` (allowlist, `claudeOptions.ts`) + env profil +
`NODETERM_NODE_ID`, `NODETERM_PORT`, token node (nama protokol tetap `nodeterm`), supaya skill
webterm-browser, linked-context, dan hook status jalan sama seperti terminal. `settingSources`
`['user','project','local']` (CLAUDE.md, skills, hooks seperti terminal) + settings hook status webterm
(`hooksSettings.ts`). cwd = cwd workspace/node seperti agent terminal.

**D10. Transport ke klien.** Rute `/api/agent-chat/:nodeId/{stream,send,interrupt,permission,mode,history}`;
auth & origin sama dengan rute root lain. Stream memakai pola SSE `chatStream.ts` (`after=<seq>`, backoff).
`chatTransport.ts` diparameterkan path-nya (nol perilaku untuk Central, dibuktikan test Central).

**D11. UI.** Pakai ulang `src/client/chat/*` (markdown, code block, composer, reducer). Baru: kartu tool per
tipe (Bash, Edit/Write diff dari `structuredPatch`, Read, TodoWrite, Task/subagent via
`parent_tool_use_id`, generic), kartu izin, form pertanyaan, kartu plan, mode picker, Stop, indikator
status (thinking/running tool/awaiting you/api retry/error), cost & context. Teks produk Inggris.
Policy: IconButton/IconTooltip, shadcn, NodeResizer hanya lewat `NodeLayoutResizer`.

**D12. Keamanan & privasi.** Tidak log prompt/output/input tool (pola `claudeEvents.ts:6-7`); error dilog
dengan konteks (operasi + nodeId), bukan payload. Token tidak pernah dicetak. Test tidak menyentuh
`~/.claude` asli (`CLAUDE_CONFIG_DIR` tmp + `persistSession:false` + spawn/query palsu).

## 3. Lingkup

MUST (rilis pertama): D1–D12; streaming teks/thinking; kartu tool inti; izin; AskUserQuestion; plan;
mode picker; Stop; kirim saat turn berjalan (antre `priority:'next'`); resume setelah idle/restart;
status `api_retry`/error; cost (`total_cost_usd` terakhir, bukan dijumlah) & context; buat node dari Dock,
menu canvas, ⌘K, tab layout.
SHOULD: menu `/` dari `supportedCommands()`; paste gambar; picker/rename sesi; "Open in terminal".
LATER: rewind/fork, @-mention file, komentar inline di plan, pre-warm.

## 4. Kontrak event server → klien (sketsa, difinalkan W1)

`{seq, t}` dengan `t` ∈ `status` (idle|starting|thinking|tool|awaiting|retry|error|closed),
`init` (sessionId, model, mode, commands, capabilities), `delta` (messageId, text|thinking),
`message` (final assistant/user, parts), `tool` (id, name, input ringkas, state, result ringkas, parentId),
`permission` (requestId, kind tool|question|plan, payload) / `permissionResolved`, `result`
(usage, costUsd, durationMs, isError), `notice` (profil hilang, lock sesi, restart). Payload besar
(output tool) dipotong di server dengan konstanta + "show full" via `history`.

## 5. Risiko → mitigasi

| Risiko | Mitigasi | Bukti test |
|---|---|---|
| Paritas fitur setengah (penyebab dugaan upstream) | Lingkup MUST di §3 = paritas inti VS Code; SHOULD dijadwalkan, bukan dilupakan | checklist W3 |
| `env` SDK mengganti env → PATH/auth hilang | builder merge `process.env`+profil+identitas | unit builder |
| Profil wrapper (envman) rusak oleh argv SDK | spawn hook; argv profil di depan | unit + S0 nyata |
| `canUseTool` menggantung (WS putus) | broker server + replay + abort; restart → expired | bun test broker |
| Allow tanpa `updatedInput` ditolak | selalu echo | unit |
| Cost dobel | ambil kumulatif terakhir | unit reducer |
| Dua proses satu sesi | lock D5 | bun test lock |
| Proses yatim | close di hapus/shutdown/idle, SIGINT bukan SIGTERM | bun test child count |
| Resume kehilangan settings/mcp | options dibangun ulang dari profil tiap open | unit |
| Drift versi CLI | `capabilities`, SDK pinned exact, notice bila CLI < SDK | unit |
| Parse transcript rusak saat rilis | hanya `getSessionMessages()` | — |
| Output tool raksasa beku UI | potong di server + virtualisasi sederhana per pesan | test DOM |
| Touchpoint kind node terlewat (§1 peta, ~15 titik, sebagian non-exhaustive) | test yang mengiterasi semua `WsNodeKind` di titik non-exhaustive | vitest |
| Field node hilang saat save | test round-trip `toFlow`/`toWsNode` | vitest |
| App.tsx 17.342/20.000 char | wiring maks 1 baris; logika di file baru | gate char |
| Menyentuh `~/.claude` asli di test | CLAUDE_CONFIG_DIR tmp, query palsu | review |
| Lisensi | SDK dependency; tidak salin kode AGPL (claudecodeui/opcode) | review |

## 6. Spike S0 (gerbang sebelum W1, di folder scratch, dibuang)

Lulus semua → D2 SDK. Satu gagal → fallback D2, tanpa improvisasi.
1. `query()` streaming-input jalan di Bun (bukan Node) dua turn berturut-turut.
2. `spawnClaudeCodeProcess` dengan argv profil user (wrapper) + CLI 2.1.318 terpasang; init diterima.
3. SDK jalan tanpa binary bundled (`pathToClaudeCodeExecutable` / spawn hook saja).
4. `canUseTool` terpanggil untuk Bash pada mode `default`, allow/deny bekerja; `interrupt()` menghentikan turn.
5. `resume: id` melanjutkan sesi; `getSessionMessages()` mengembalikan riwayatnya.
Lingkungan: `CLAUDE_CONFIG_DIR` dan cwd sementara. Butuh izin user karena memanggil model sungguhan
(biaya token kecil) dan auth lewat profil user — lihat §9.

## 7. Gelombang & kepemilikan file

- **W0** `wkr-chatspike-*`: S0, laporan + bukti log. Tidak ada kode produksi.
- **W1 (paralel)**
  - server-core: `src/server/agentChat/agentChat.{options,env,process,events}.ts` + test.
  - server-io: `agentChat.{broker,lock,route,history}.ts` + wiring rute di server (1 baris) + test.
  - shared+registry: `src/shared/agentChat.shape.ts`, `WsNodeKind`, `store.ts` toFlow/toWsNode, semua
    touchpoint §1 peta (menu, Dock, ⌘K, ikon, nodeList, template, awareness) + test kelengkapan kind.
- **W2 (paralel, setelah kontrak W1 beku)**
  - client-core: `AgentChatNode.tsx`, `agentChat/{agentChatView,agentChatTransport,agentChatStore}.ts(x)`,
    parameterisasi `chatTransport.ts`.
  - client-cards: `agentChat/{toolCards,permissionCard,questionCard,planCard,modePicker}.tsx` + test DOM.
- **W3**: integrasi bun test end-to-end dengan query palsu; verifikasi browser nyata di server terisolasi
  (port & `WEBTERM_DATA_DIR` sementara); docs `docs/decisions/agent-chat.md` + README bagian terkait +
  CHANGELOG — sekali, satu worker, di akhir.

File ≤ batas Rule 8; tiap worker eksklusif; tidak commit/push/ganti branch.

## 8. Gerbang

Per gelombang: `npm run typecheck`, vitest penuh, `npm run test:bun`, `vite build`, policy tests hijau,
test terminal agent tidak berubah. Sebelum merge: verifikasi browser (W3) dengan screenshot, checklist §3
MUST semua ✅.

## 9. Butuh keputusan user

1. S0 dan verifikasi W3 memanggil Claude sungguhan lewat profil user (biaya token kecil; transcript ditulis
   ke `CLAUDE_CONFIG_DIR` sementara, bukan `~/.claude`). Boleh?
