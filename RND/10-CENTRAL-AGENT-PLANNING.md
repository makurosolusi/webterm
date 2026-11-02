# 10 — Central Agent Planning: Goal, Plan, Tool, Safety

Tanggal: 2026-11-01 (+08:00). Riset dan desain, **tanpa perubahan kode**.
Induk: `03-RENCANA.md` §7, `07-IMPLEMENTASI-P3-P5.md` §4b/§4c, `04-OMNICHANNEL.md` §6.
Pertanyaan: bagaimana agen LLM pusat memilih goal, memecah plan, menugaskan task, dan tetap aman pada November 2026 — di atas ledger/plan/caps yang ada, tanpa rewrite.

## 0. Keputusan inti

1. **Goal adalah baris berversi di SQLite**, bukan prompt, file markdown, atau memori: MVP `project.goal_json` (migrasi v4 aditif); tabel `goal` hanya bila >1 goal/project.
2. **Success criteria harus machine-checkable** (command allowlist, scope, evidence wajib); prosa hanya untuk manusia dan digest approval.
3. **Central hanya mengusulkan** goal/plan; aktivasi tetap milik manusia.
4. **Loop = propose → act → observe → verify → replan.** LLM hanya di propose/replan; batas, transisi, dan kuota ditegakkan server secara deterministik.
5. **Setiap tool = proposal + idempotency key**; server memvalidasi dan menulis, prompt bukan otoritas.
6. **Approval plane terpisah dari agent plane**: central tidak memegang root token atau capability untuk `decide`.
7. **Replan dibatasi** (2 revisi/item), lalu `blocked` menunggu manusia.
8. **Batas keras tetap:** depth ≤2, worker 3/project, attempt 3, WIP goal = 1.

## 1. Posisi terhadap pola 2026

| Sumber | Pola | Konsekuensi untuk webterm |
|---|---|---|
| Anthropic, *Building effective agents* | orchestrator-workers + evaluator-optimizer; mulai sederhana | planner satu node LLM; verifier terpisah |
| Anthropic, *Effective harnesses for long-running agents* (2025-11-26) | feature list JSON + progress notes, satu fitur/sesi | plan item = unit kecil berstatus mesin, bukan prosa |
| Anthropic, *Scaling Managed Agents* (2026-04-08) | session log di luar context window; kredensial tidak masuk sandbox | ledger = session log; token tidak di env PTY |
| OpenAI Agents SDK, HITL | state approval di server; klien hanya id opaque; approve ≠ exactly-once | `approval` row + digest + nonce tetap sumber kebenaran |
| LangGraph interrupts | pause durable, resume by id, side effect pasca-interrupt idempoten | approval blocking cocok; replay lewat ack store |
| MCP security spec + Invariant | deskripsi tool = input tak tepercaya, bisa rug-pull | pin `tools_hash`, allowlist server MCP |
| OWASP Agentic Top 10 2026 | goal hijack, tool misuse, privilege abuse, memory poisoning, cascading failure | dipetakan ke §5 (risiko) dan §8 (anti-pattern) |

Yang mahal bukan "LLM bisa planning", tapi **state, otoritas, dan bukti**: ketiganya sudah ada di repo; yang belum adalah model goal dan loop yang membacanya.

## 2. Goal model

| Kandidat | Verdict | Alasan |
|---|---|---|
| Prompt / system message | ❌ | hilang saat restart, tak bisa diaudit/di-diff |
| File markdown (`GOAL.md`) | ❌ MVP | tidak atomik dengan plan/task, rawan dual-write |
| `memory` claim/fact | ❌ | bisa di-supersede worker; memori = pengetahuan, bukan kontrak |
| `project` + `goal_json` | ✅ MVP | project sudah 1:1 workspace, punya `status`, `priority`, `budget_json` |
| tabel `goal` | ⏳ fase C | perlu saat ada beberapa goal/milestone atau goal lintas project |

```jsonc
{ "statement": "…",              // ≤500 char, satu outcome
  "successCriteria": [           // ≥1, semua harus dievaluasi mesin
    { "kind": "command", "command": "npm test" },
    { "kind": "scope", "paths": ["src/server/orchestrator"] },
    { "kind": "review", "by": "human" } ],
  "owner": "human:root", "horizon": "2026-11-30",
  "envelope": { "maxCostMicros": 5000000, "maxWallMs": 1800000, "maxItems": 40 } }
```

`kind:'command'` hanya dari **allowlist verifier** (`verifyCommands.ts`); `kind:'review'` wajib
bila goal menyentuh schema, kredensial, deploy, atau hapus data.

| Transisi | Aktor sah | Syarat |
|---|---|---|
| `proposed → active` | human (root token) | goal valid + envelope dalam batas global |
| `active → achieved` | server | semua criteria mesin lulus **dan** review manusia |
| `active → abandoned`/`superseded` | human | alasan wajib; item hidup `cancelled` |
| `proposed` | central | hanya usul; tidak boleh menaikkan envelope |

Owner = manusia; central adalah *steward* (memilih urutan, memecah item, menandai `blocked`), bukan pemilik "done". `achieved` tidak boleh berasal dari teks LLM: bukti = evidence server (`verifiedBy:'server-verifier'`) + task `verified` + review.

## 3. Planning loop

```
observe/select : portfolio + goal + plan(version) + task/evidence + usage; goal aktif, tidak paused, budget > 0
propose  : LLM → item {title, scope, acceptance, dependsOn?}   (maks 10/tick)
validate : server: scope relatif, ≤50 item, criteria dikenal, WIP, envelope, depth
commit   : plan.replace(expectedVersion) atau plan.assign(itemId, taskId)
act      : POST /api/orchestrator/run (approvalId bila risiko R2/R3)
observe  : evidence server, usage, fence        replan: hanya bila pemicu di bawah
```

Output model = **proposal JSON** yang divalidasi `planModel.ts` (`validateScope`,
`normalizeItems`, `ITEM_TRANSITIONS`). Validasi gagal → tidak ada tulisan, hanya event
`plan.rejected` + `code`.

**Task graph.** `plan_item` hari ini hanya punya `seq` + `scope_json` (`task.parent_id` = hierarki, bukan dependency), jadi **MVP: urutan = dependency** (satu lane). Fase C menambah `depends_on_json` (≤5) + readiness `pending AND NOT EXISTS(dependency non-done)`. Paralel nyata baru boleh setelah readiness deterministik: `checkCaps` menghitung jumlah worker, bukan konflik scope, jadi dua item beririsan tetap diserialkan.

| Pemicu replan | Tindakan | Batas |
|---|---|---|
| verify gagal | revisi item, attempt+1 | attempt ≤3 |
| item `blocked` | parkir, kerjakan item lain | bukan replan |
| scope drift | fail item, replan | 1x/item |
| budget habis | `budget_exhausted`, pause goal | tanpa retry |
| approval ditolak | `cancelled` + alasan jadi konteks | 2x/item lalu `blocked` |
| plan version stale | baca ulang, jangan tulis | 3 konflik/10 mnt → backoff |

Anti-loop: maks **2 revisi plan/10 menit/project** dan 2 replan/item; lalu audit
`autonomy.replan_exhausted` dan berhenti. Ini menutup "retry akar sama >3x".

| Batas | Nilai | Sumber |
|---|---|---|
| goal aktif/project · project aktif | 1 · 3 | baru (keputusan produk) |
| worker paralel · depth | 3 · 2 | `DEFAULT_CAPS`, `MAX_SPAWN_DEPTH` |
| attempt · lease · wall | 3 · 10 mnt · 30 mnt | `DEFAULT_CAPS` |
| token · cost · turn · item/plan | 200k · 5 jt micros · 40 · 50 | `DEFAULT_CAPS`, `MAX_PLAN_ITEMS` |

WIP goal = 1 bukan teknik: dua goal aktif di satu repo hampir selalu berarti dua definisi "done".

## 4. Tool contract

Semua tool: idempoten via `requestId` → `request_ack` v3; menolak `actor`/`authority`/`status`/
`projectId` yang bisa diturunkan server; balasan typed `{ok:true,…}` atau `{ok:false, code}`;
satu baris audit per efek.

| Tool | Otoritas | Risiko | Gate / catatan |
|---|---|---|---|
| `goal.get`, `task.status` | baca | R0 | `WEBTERM_CENTRAL` |
| `goal.propose` | central | R1 | draft saja; envelope ≤ global |
| `goal.activate` | human | R2 | root token |
| `plan.propose` | central | R1 | create/replace via `expectedVersion` + WIP + budget |
| `plan.update` | assignee | R1 | status item saja; `ITEM_TRANSITIONS`, bukan central |
| `plan.assign` | orchestrator | R1 | item & task harus `pending` |
| `task.run` | orchestrator | R2/R3 | `WEBTERM_ORCHESTRATOR_RUN`, `…RUN_REQUIRE_APPROVAL` |
| `project.pause`/`resume` | human | R2 | root token; event `project.paused` |
| `approval.request` | agent | R1 | tidak boleh `decide` |
| `approval.decide` | **human only** | R3 | root token / opt-in loopback |
| `memory.claim` / `promote` | agent / orchestrator+ | R1/R2 | claim selalu `claim`; promote butuh evidence |

- Deskripsi tool = bagian ACI (contoh, edge case, batas); tool tak dikenal → error, bukan tebakan.
- Tool tulis tidak menerima path absolut, repo, atau command dari klien (`run` sudah menolak).
- `goal.propose` menyimpan draft; efek nol sampai `goal.activate`. Central tidak punya tool `spawn`; ia memakai `plan.assign` + `task.run` (spawn tetap orchestrator).
- `code` harus stabil dan terklasifikasi (pola `approvalFailures.classifyLedgerError`), karena LLM memilih langkah berikutnya dari `code`, bukan pesan bebas.

## 5. Safety

| Principal | Bisa | Tidak bisa |
|---|---|---|
| root token | approve/deny, activate goal, pause project | masuk env PTY/agent |
| central (`wcap_*`) | goal/plan propose, assign, status | `decide`, pause, naikkan envelope |
| orchestrator | assign, run, request approval | approve, ubah goal |
| worker | claim memory, edit worktree | spawn, promote, run task lain |

Yang sudah berlaku dan wajib dipertahankan: `/api/approvals/*` bukan capability plane; tanpa token
`403 approval_requires_token`; node token tidak membukanya; aktor audit dari transport
(`human:root`/`human:loopback`), bukan body. Central tidak bisa approve aksinya sendiri **bukan
karena prompt, tapi karena tidak memegang kunci**.

| Kelas | Contoh | Gate |
|---|---|---|
| R0 baca | portfolio, evidence | — |
| R1 tulis terbatas | plan draft, memory claim, edit worktree | flag + validasi |
| R2 mutasi bersama | assign, run, pause | approval bila `WEBTERM_RUN_REQUIRE_APPROVAL=on` |
| R3 ireversibel | push/merge, hapus branch, migrasi schema, kirim eksternal, naikkan budget | **selalu** approval + typed confirm |

R3 tidak punya jalur "flag off = bebas"; approver tidak ada → **parkir**. Expiry tidak pernah
auto-approve (sudah benar di `ledgerApproval.ts`).

**Digest & exactly-once.** Digest mengikat `goalId`, `goalVersion`, `planVersion`, `itemId`, `taskId`, `scope[]`, allowlist command, risk class. `consumeApproval` single-use sudah atomik, tetapi **approve ≠ exactly-once**: proses bisa mati setelah consume sebelum efek. Mitigasi: idempotency key = `requestId` + cek state sebelum efek (worktree lock, fence, `run` existing); approval gagal tetap hangus (by design), pemulihan lewat approved-unconsumed. Tanpa sticky "always approve".

**Audit.** `event` append-only; payload terklasifikasi `goalId`, `planVersion`, `itemId`, `riskClass`, `decisionId`, `digest` (hash), `outcome`. Tanpa path, stack, token, isi prompt; jangan kirim transcript/diff besar ke chat (`04-OMNICHANNEL.md` §9).

| Kill switch | Efek | Tidak menghapus |
|---|---|---|
| `WEBTERM_CENTRAL_AUTONOMY=off` | tick berhenti | plan, goal, event |
| `WEBTERM_CENTRAL_PLANNER=off` (baru) | propose dilarang | draft |
| `WEBTERM_ORCHESTRATOR_RUN=off` | run baru ditolak | task hidup |
| `project.status='paused'` | project dilewati | apa pun |
| `WEBTERM_CHANNELS=off` | ingress/egress mati | ledger |
| revoke capability | tool hilang | audit |

Budget dicek **sebelum** assign (dari `budget` + `usage`), bukan setelah run. Habis → goal `paused` + `autonomy.budget_exhausted`. Jangan turunkan cap diam-diam: berhenti atau minta manusia menaikkan envelope.

**Konten tak tepercaya.** Output worker, `task.spec`, hasil tool MCP, isi memori = **data**, bukan instruksi; bungkus eksplisit, jangan eksekusi command dari teks bebas. Pin deskripsi tool (`run.tools_hash`); hash berubah tanpa approval = tolak (rug pull); server MCP baru = keputusan manusia. Memori worker hanya `claim`, tidak boleh menyalakan goal/mengubah priority. Redaksi egress: token, `wcap_`, `sk-`, home path, base64 panjang.

## 6. Human-in-the-loop

| Situasi | Mode | UX |
|---|---|---|
| R3 ireversibel | **blocking** | kartu + typed confirm objek ("Push to main"); expiry 15 mnt; deny wajib alasan |
| R2 run (gate on) | blocking | item, scope, evidence terakhir, biaya estimasi |
| Plan/goal proposal | async | inbox, TTL 24 jam; kedaluwarsa = tidak aktif, bukan approve |
| Review `claimed_done` | async | tombol Review/Consent yang ada; verify setelah consume |
| Budget exception | blocking | manusia saja; tanpa auto-raise |

Kartu minimal: project, goal (1 baris), plan version, item, aksi, scope, command, digest pendek, risk class, expiry, biaya, tombol Deny beralasan. Teks agen tidak pernah approve; "yes" di chat bukan consent; grup tidak boleh approve.

Penolakan → kontrak replan: `decision.rationale` jadi konteks **terbatas** (≤1 KiB, di-escape), item `cancelled`, maks 2 percobaan ulang, lalu `blocked`. Manusia memilih: ubah criteria, scope, atau `abandoned`; penolakan tidak boleh memicu loop proposal tanpa batas.

## 7. Yang realistis di kode sekarang

| Kebutuhan | Seam | Ukuran | Catatan |
|---|---|---|---|
| goal + criteria | `project` row, migrasi v4 | S | `goal_json` + validasi murni |
| plan usul/versi | `plan.ts` | S | sudah optimistic `version`, `ITEM_TRANSITIONS` |
| assign + task | `orchestratorAssign.ts`, `ledgerTaskCreate.ts` | S | task dibuat sebelum assign |
| run + approval | `orchestratorRunApi.ts`, `approvalGate.ts` | S | gate opt-in; tambah risk class |
| caps/WIP · audit | `caps.ts` · `event` | S | WIP goal dicek planner, bukan caps |
| dependency | `plan_item` (hanya `seq`) | **M** | kolom + readiness query |
| budget precheck | `budget`, `usage` | M | enforcement belum di jalur assign |
| loop LLM · tool surface | `centralAutonomy.ts` · route HTTP | M · S/M | planner menggantikan "seq terkecil" |

Yang **tidak** perlu: framework agent, message bus, vector DB, state machine baru. Ledger + plan +
caps sudah cukup; yang hilang hanya goal, readiness, dan anggaran.

## 8. MVP bertahap dan anti-pattern

| Fase | Isi | Gate | Rollback |
|---|---|---|---|
| A | `goal_json` + criteria + risk class; central belum jalan | goal invalid ditolak; `achieved` butuh evidence+review | flag off, kolom diabaikan |
| B | planner read-only: draft, assign item existing, WIP 1, tick 30 s | 0 tulisan tanpa validasi; replan ≤2 | `WEBTERM_CENTRAL_PLANNER=off` |
| C | `depends_on` + readiness + budget precheck + reconciliation pasca-consume | DAG benar; budget menolak sebelum worktree | migrasi aditif |
| D | multi-goal/project + portfolio WIP 3 + soak 2×2 minggu | verified rate ambang, 0 self-approval | pause, revoke capability |

Fase B sengaja tidak membuat task baru: menciptakan task adalah perubahan otoritas, bukan fitur.

Anti-pattern: (1) goal di prompt/markdown sebagai kebenaran; (2) LLM memegang root token/capability approval; (3) self-approval lewat loopback; (4) approval sebagai satu-satunya kontrol; (5) replan tanpa batas; (6) rewrite plan tiap tick → version churn; (7) sticky always-approve; (8) menganggap approval = exactly-once; (9) central spawn worker langsung; (10) percaya deskripsi tool MCP tanpa pin hash; (11) worker promote memory/ubah priority; (12) state eksekusi di prompt/snapshot sebagai otoritas.

## 9. Pertanyaan terbuka

1. Kriteria mesin mana yang masuk allowlist verifier, dan siapa yang boleh mengubahnya?
2. `goal_json` di `project` atau tabel `goal` sejak fase A? Batas replan 2/item cukup, atau perlu per goal?
3. Budget habis: pause goal, atau turunkan WIP/model lebih dulu?
4. Central boleh `project.pause` project lain? Siapa owner bila satu workspace dipakai dua manusia?

## 10. Referensi (diakses 2026-11-01)

- Anthropic, *Building effective agents*: https://www.anthropic.com/engineering/building-effective-agents
- Anthropic, *Effective harnesses for long-running agents* (2025-11-26): https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- Anthropic, *Scaling Managed Agents* (2026-04-08): https://www.anthropic.com/engineering/managed-agents
- OpenAI Agents SDK, *Human-in-the-loop*: https://openai.github.io/openai-agents-python/human_in_the_loop/
- LangChain, *LangGraph interrupts*: https://docs.langchain.com/oss/python/langgraph/interrupts
- MCP, *Security Best Practices*: https://modelcontextprotocol.io/specification/2025-06-18/basic/security_best_practices
- Invariant Labs, *MCP Tool Poisoning Attacks* (2025-04-01): https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks
- OWASP, *Top 10 for Agentic Applications 2026* (2025-12-09): https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/
- Claude Agent SDK, *Configure permissions*: https://docs.claude.com/en/docs/agent-sdk/permissions
