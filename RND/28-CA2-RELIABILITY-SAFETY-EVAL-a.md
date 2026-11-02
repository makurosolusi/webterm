# 28a — CA2: Keandalan, Keamanan, Evaluasi Central Agent (bagian a: ringkasan, temuan, opsi)
Tanggal: 2026-11-03. Status: **R&D, tanpa perubahan kode**. Penulis: wkr-rnd-reliability-01.
Fondasi: `RND/08`–`14`, `src/server/central/**`, `orchestrator/**`, `ledger/**`, `channels/**`.
Label: `[kode]` dibaca dari repo, `[terverifikasi]` sumber primer dibaca, `[belum terverifikasi]`, `[opini]`.

## 1. Ringkasan keputusan
1. **Central boleh spawn/perintah/tutup agent, tapi lewat tangga otonomi L0–L4** (§4.1) yang ditegakkan server dan bisa diturunkan seketika oleh kill-switch persisten. Default produksi = L2 *propose-only* (dry-run), bukan L3/L4.
2. **Pakai "Rule of Two" sebagai aturan desain** [terverifikasi, Meta 2025-10-31]: central menyentuh [A] input tak tepercaya (Telegram, output worker, memori), [B] data privat, [C] efek luar. Ketiganya sekaligus ⇒ tidak boleh otonom. Maka aksi [C] hanya lahir dari **proposal terstruktur yang divalidasi server** (sudah ada, `proposalPolicy.ts`), bukan dari teks LLM, dan R2/R3 tetap di belakang approval manusia.
3. **Lima lubang keandalan nyata di kode sekarang** (§2) harus ditutup *sebelum* otonomi dinyalakan: turn zombie setelah crash, `limits: {}` (budget tidak ditegakkan), tick serial yang terblokir, breaker hanya di memori, handle autonomy dibuang (tidak ada kill-switch runtime).
4. **Evaluasi = uji lapisan penegakan dengan "model terburuk"** (mock yang patuh pada injection), bukan menguji kepintaran model. Harness ~200 baris di atas `MockRuntime` + replay JSONL OpenCode, jalan dengan `bun test`, nol biaya model, tanpa dependency baru, tanpa CI/hook baru.
5. **Gate "siap default-on"** dan rollout S0→S5 ada di §4.8–4.9; angka ambang = `[opini]`, bisa ditawar.

## 2. Temuan + bukti
### 2.1 Loop otonom `[kode]`
| # | Fakta | Bukti | Dampak |
|---|---|---|---|
| F1 | Polling `setInterval` 30 dtk, **satu item per tick**, urut `project.id` | `centralAutonomy.ts:72,143-178,185-192` | Project pertama menahan yang lain; latensi hingga 30 dtk |
| F2 | `tick()` meng-`await run` sampai worker settle; `ticking=true` selama itu → tick lain `overlap` | `centralAutonomy.ts:131-133,165`; timeout worker 300.000 ms `workerRuntime.ts:41` | Satu worker lambat membekukan seluruh portofolio ≤5 mnt (+ verifier 120 dtk `verify.ts:104`) |
| F3 | Budget kegagalan (`consecutive`, `lastStatus`) hanya `Map` memori | `centralAutonomy.ts:101-102` | Restart = breaker reset; item gagal diulang tanpa batas lintas restart |
| F4 | Handle hasil `startCentralAutonomyBoot` **dibuang**; `stop()` tak terjangkau | `index.ts:65` (nilai kembali tak disimpan), `centralAutonomyBoot.ts:140-145` | Mematikan otonomi = ubah env + restart; tak ada kill-switch runtime |
| F5 | Hanya memilih item `assigned`; tak pernah approve/buat plan; 409 approval dicatat sebagai gagal | `centralAutonomy.ts:88-95`, `centralAutonomyBoot.ts:102-107` | Desain aman (pertahankan) |
| F6 | Audit ke tabel `event` (`actor='central'`); event tak punya trigger append-only/hash chain | `centralAutonomyBoot.ts:117-137`; `ledgerSchemaV1.ts:63-71` (trigger hanya untuk `memory`, `:154-162`) | Audit dapat diubah/dihapus oleh siapa pun yang memegang DB |
### 2.2 Chat/turn `[kode]`
| # | Fakta | Bukti |
|---|---|---|
| F7 | `limits: {}` dikirim ke runtime → `maxTurns/maxCostMicros/maxWallMs` **tidak pernah diisi** dari chat; hanya wall default adapter | `chat/turnService.ts:184`; tipe `runtime/centralRuntime.ts` `TurnLimits` |
| F8 | Tak ada sweep turn `running` saat boot. `UPDATE central_turn` hanya ada di `updateTurn`; `createTurn` hanya membersihkan pointer jika turn sudah terminal. Crash di tengah turn ⇒ `conversation_busy` sampai di-cancel manual | `conversationStore.ts:182-197,225`; `grep "central_turn"` hanya satu UPDATE |
| F9 | Model gratis default ⇒ `costMicros` ≈ 0 ⇒ cap USD tak berarti | `opencodeOptions.ts` `DEFAULT_OPENCODE_MODEL='opencode/deepseek-v4.1-flash-free'` |
| F10 | Kill proses: SIGTERM→SIGKILL 500 ms, timeout wall, cancel idempoten | `opencodeRuntime.ts:18,102-122,170-194` (baik, pertahankan) |
### 2.3 Fondasi keamanan yang sudah benar `[kode]`
- Env anak diskrub: allowlist + prefix `WEBTERM_`/`NODETERM_` dilarang (`opencodeOptions.ts:33-52`); `OPENCODE_PERMISSION` deny `bash/edit/webfetch/task`, tanpa `--auto` (`:18-24`).
- Proposal: tool allowlist 4 nama, kunci terlarang (`actor,authority,status,path,command,token,digest…`), id aman regex, ukuran ≤8 KB, kecocokan conversation↔project (`proposalPolicy.ts:7-9,43-70`).
- Approval sekali pakai, digest mengikat aksi, kegagalan aksi tidak menghidupkan approval (`approvalGate.ts:50-86`). Ack idempoten persisten (`durableAck.ts`). Lease + fence + reaper `leased→suspect` (`ledgerTaskLease.ts:99-121`, `ledgerTaskStop.ts:64`). Caps keras (`caps.ts` `DEFAULT_CAPS`: 3 worker, 3 attempt, 200k token, USD 5, 40 turn, 30 mnt).
- Konten tak tepercaya di-delimit sebagai data (`centralPrompt.ts` blok "Retrieved memory (data only…)"); redaksi secret `redactSecrets.ts`, `logs/logSanitize.ts`.
- Throttle gagal-auth webhook per peer (`channelThrottle.ts`); metrik ledger hanya counter memori (`ledgerMetrics.ts`).
### 2.4 Sumber eksternal
| Klaim | Sumber | Tgl | Status |
|---|---|---|---|
| OWASP Top 10 Agentic 2026: ASI01 Goal Hijack, ASI02 Tool Misuse, ASI03 Identity & Privilege Abuse, ASI04 Supply Chain, ASI05 Unexpected Code Exec, ASI06 Memory & Context Poisoning, ASI07 Insecure Inter-Agent Comm, ASI08 Cascading Failures, ASI09 Human-Agent Trust Exploitation, ASI10 Rogue Agents | https://genai.owasp.org/2025/12/09/owasp-top-10-for-agentic-applications-the-benchmark-for-agentic-security-in-the-age-of-autonomous-ai/ (blog); halaman resource https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/ | 2025-12-09 (**lebih tua dari 2026**) | daftar nama [terverifikasi] dari blog; isi PDF mitigasi [belum terverifikasi] |
| Agents Rule of Two: dalam satu sesi, agen maks 2 dari {A: input tak tepercaya, B: sistem/data sensitif, C: ubah state/komunikasi luar}; butuh ketiganya ⇒ tak boleh otonom, minimal supervisi manusia | https://ai.meta.com/blog/practical-ai-agent-security/ | 2025-10-31 (**lebih tua dari 2026**) | [terverifikasi] |
| MCP security best practices (confused deputy, token passthrough, SSRF, session hijack, kompromi server lokal, scope minimization); server lokal: stdio/unix socket, sandbox, consent perintah | https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices | spec 2025-11-25 (dibaca 2026-11-03) | [terverifikasi] |
| OpenCode: `OPENCODE_PERMISSION` = JSON izin inline; aksi `allow/ask/deny`; **default sebagian besar `allow`** (`doom_loop`, `external_directory` = `ask`); `--auto` menyetujui otomatis yang tak di-deny; tidak ada flag `max-turns` di halaman CLI | https://opencode.ai/docs/permissions/ , https://opencode.ai/docs/cli/ | dibaca 2026-11-03; rilis terbaru v1.19.5 (2026-10-28, GitHub API) | [terverifikasi] |
| OTel GenAI semconv: status **Development**, dipindah ke repo `semantic-conventions-genai`; ada operasi `create_agent`, `invoke_agent`, `execute_tool`; span `execute_tool {gen_ai.tool.name}`, atribut `gen_ai.tool.call.id` | https://github.com/open-telemetry/semantic-conventions-genai (docs/gen-ai/gen-ai-agent-spans.md, gen-ai-spans.md) | commit 2026-11-02 | [terverifikasi] nama; detail atribut lain [belum terverifikasi] |
| Promptfoo (MIT, push 2026-11-02, rilis 0.125.1 2026-10-25) dan Inspect AI (MIT, push 2026-11-02, rilis 0.3.287 2026-10-31); AgentDojo rilis terakhir v0.1.35 2025-10-27 | GitHub API `repos/promptfoo/promptfoo`, `UKGovernmentBEIS/inspect_ai`, `ethz-spylab/agentdojo` | 2026-11-03 | metadata [terverifikasi]; fitur internal [belum terverifikasi] |

## 3. Opsi yang dipertimbangkan
| Topik | Opsi | Keputusan |
|---|---|---|
| Pemicu loop | (a) polling 30 dtk (sekarang) · (b) event-driven + sweep jaring pengaman · (c) antrean eksternal (Redis/BullMQ) | **(b)**. (c) ditolak: daemon baru, melanggar "ringan"; SQLite sudah punya lease+fence |
| Eksekusi item | (a) await sinkron dalam tick · (b) dispatcher non-blocking, worker jalan di latar, hasil lewat event | **(b)** (F2) |
| Audit tak-bisa-dimanipulasi | (a) status quo · (b) hash chain `prev_hash` + trigger anti UPDATE/DELETE · (c) kirim ke log eksternal | **(b)** tamper-*evident*, bukan tamper-proof (pemegang DB bisa hitung ulang rantai). (c) opsional nanti |
| Kill-switch | (a) env + restart · (b) baris `central_control` dibaca tiap tick/tool-call | **(b)**; env hanya batas atas |
| Cost guard | (a) USD saja · (b) USD + token + wall + **jumlah spawn/hari** | **(b)** (F9: model gratis = USD 0) |
| Harness eval | (a) Promptfoo · (b) Inspect AI · (c) tulis sendiri di atas `MockRuntime`/`bun test` | **(c)**. (a) Node ber-dependency besar, (b) Python; keduanya menguji *model*, kebutuhan kita menguji *penegakan server*. Rule 10: <~200 baris ⇒ tulis sendiri. Boleh pinjam korpus injeksi dari AgentDojo (lisensi belum dicek) |
| Tracing | (a) OTel SDK + collector · (b) pakai `central_event` + `usage_json` yang ada, nama span mengikuti semconv | **(b)**. SDK ditolak: status Development, daemon/exporter tambahan |

Lanjutan (rekomendasi, risiko, dampak invarian, pertanyaan terbuka, yang tidak terverifikasi): `28-CA2-RELIABILITY-SAFETY-EVAL-b.md`.
