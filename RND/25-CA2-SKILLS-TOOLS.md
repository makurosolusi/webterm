# 25 - CA2: Skill & Tool Central Agent v2

Penulis: wkr-rnd-skills-01 - 2026-11-03 - R&D saja, tidak ada kode diubah.
Tag: `[V]` = terverifikasi (sumber primer dibaca 2026-11-03), `[BV]` = belum terverifikasi.
Fondasi: RND/08-14 (I1-I14, D1-D12). Rujukan silang: 22 (control plane), 28 (keamanan/eval).

## 1. Ringkasan & rekomendasi tegas

1. **Satu tool registry bertipe di server** (`central/tools/registry.ts`) = sumber kebenaran. Dari situ dihasilkan: (a) jembatan tool OpenCode, (b) fallback teks `<webterm-proposal>` untuk model lemah/gratis, (c) MCP server opsional fase 2. Tanpa dependency baru di fase 1.
2. **Prompt ringan lewat `tool.search` + `tool.call`**: hanya ~6 tool inti terlihat; sisanya katalog 1 baris, dicari BM25-lite (<20 baris, tulis sendiri). `defer_loading` Anthropic itu fitur server-side Anthropic saja, tidak jalan di OpenCode/model lain [V].
3. **Skill = subset ketat standar Agent Skills** (SKILL.md), ekstra webterm di `metadata`. File = sumber kebenaran, SQLite = indeks yang bisa dibangun ulang. Central boleh **mengusulkan** skill (`skill.propose`), tidak pernah mengaktifkannya sendiri: karantina -> lint -> eval -> approval manusia -> versi terkunci hash -> rollback.
4. **Tutup kebocoran sekarang (bug nyata)**: child OpenCode central mewarisi `HOME`/`XDG_*` sehingga memuat ~66 skill milik user + `~/.claude`. Tambah `permission.skill = {"*":"deny","webterm-*":"allow"}` lewat `OPENCODE_CONFIG_CONTENT`. Ini prasyarat sebelum skill/tool apa pun ditambah.
5. **`scripts/` dalam skill: OFF default.** Skill yang dibuat central hanya instruksi + referensi. Skrip hanya untuk skill builtin/ditandatangani user, dan lewat tool terdaftar, bukan shell bebas.

## 2. Temuan + bukti

### 2.1 Kondisi kode (fakta, dibaca)
- Central hari ini **tidak punya registry/MCP**: hanya `portfolio.read`; `DEFAULT_CENTRAL_TOOLS = ['portfolio.read']` (`src/server/central/chat/toolExecutors.ts:13-15`). Satu event audit `central.tool` per panggilan, digest argumen sha256/16 hex (file sama).
- Protokol tool = teks tulis-tangan `<webterm-proposal>`, 4 tool, prompt maks 8192 char, portfolio JSON 4096 (`central/proposal/centralPrompt.ts`); parser validasi manual, blok maks 16 KiB, 4 blok, guard prototype-key (`proposalParser.ts`).
- RND/09 merencanakan `centralMcpServer.ts`; **file itu tidak ada** di kode. RND/08:103 merencanakan pin `tools_hash` (rug-pull); kolom `tools_hash` hanya ada di skema ledger (`ledger/ledgerSchemaV1.ts:56`), belum ada pengisinya dari registry.
- Zod disebut di RND, tapi `package.json` tidak punya zod, MCP SDK, maupun yaml; tidak ada OpenAPI; ~90 route `/api/*` manual. "Tool dari OpenAPI/Zod" butuh dependency atau skema tulis-tangan.
- OpenCode: `OPENCODE_PERMISSION_DENY` menolak bash/edit/webfetch/task (`runtime/opencodeOptions.ts:21`); `WEBTERM_OPENCODE_ALLOW_TOOLS=on` membalik keempatnya ke allow (`:66`, `:124`) - saklar kasar semua-atau-tidak. Allowlist env membawa `HOME`, `XDG_*`, `OPENCODE_CONFIG(_CONTENT)` (`:30-32`). Argv: `run --format json --model ... prompt`; tidak ada `--standalone`/`--agent` (`opencodeRuntime.ts` ~100-145). Model default `opencode/deepseek-v4.1-flash-free`.
- Capability control-plane sudah ada: verb `node.spawn|prompt|wait|close|read`, `plan.read`, `approval.*`, TTL default 15 menit/maks 60, token di-hash sha256 (`control/capabilities.ts`). Dipakai ulang untuk allowlist skill.
- `contextLinkSkill.ts`: `SKILL_NAME='webterm-linked-context'` (:53); shim POSIX tanpa token, token diexpand dari env child (:23-48); `installContextLink` menimpa `~/.claude/skills/webterm-linked-context/SKILL.md` **tiap boot** (:113-125) - satu-satunya tulisan di luar data dir; hanya terlihat oleh Claude/agen yang membaca `~/.claude/skills`.
- Mesin user (hitungan saja): `~/.claude/skills` 46 entri (deskripsi total ~4,3k token; 17 symlink; 4 body >20k char), `~/.agents/skills` 18, `~/.config/opencode/skills` 5. `opencode` v2.0.26.

### 2.2 Sumber eksternal (2026)
- **Agent Skills** (agentskills.io/specification, 2026-11-03) [V]: `SKILL.md` dengan frontmatter `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`(eksperimental); progressive disclosure 3 tingkat (katalog ~100 token / body <5k token / resources); folder `.agents/skills/`. Panduan klien: agentskills.io/client-implementation/adding-skills-support (2026-11-03) [V] - validasi lenient, gerbang trust untuk skill level-proyek. Evaluasi skill: agentskills.io/skill-creation/evaluating-skills [V].
- **OpenCode skills** (opencode.ai/docs/skills, "Last updated Nov 2, 2026") [V]: tool native `skill`; lokasi `.opencode/`, `~/.config/opencode/`, `.claude/skills`, `~/.claude/skills`, `.agents/skills`, `~/.agents/skills` (jadi **semua ikut dimuat**); `name` regex `^[a-z0-9]+(-[a-z0-9]+)*$` 1-64, harus sama dengan nama folder; `description` 1-1024; field tak dikenal diabaikan; `metadata` string->string; **`permission.skill` pola wildcard `allow|deny|ask`, `deny` = skill disembunyikan dari agen**; dapat dimatikan per agen (`tools: {skill:false}`). Docs agents/commands/custom-tools/plugins/mcp-servers/permissions (2026-11-03) [V]: agen = markdown, tool kustom `.opencode/tools`, hook plugin `tool.execute.before`, MCP local/remote.
- **Claude Code skills** (code.claude.com/docs, 2026-11-03) [V]: ekstensi vendor (`disable-model-invocation`, `allowed-tools`, `context: fork`, injeksi `!`cmd``) bukan standar - jangan diandalkan.
- **MCP** spec 2026-07-28 (modelcontextprotocol.io/specification/2026-07-28) [V]: stateless, `server/discover`, tasks sebagai extension, urutan tool deterministik. Security best practices (modelcontextprotocol.io, 2026-11-03) [V]: confused deputy, token passthrough, SSRF, session hijack; anotasi tool = **tidak tepercaya** kecuali server tepercaya. SDK: `@modelcontextprotocol/server` 2.4.0 (v2) vs `@modelcontextprotocol/sdk` 1.32.2 (v1) via `npm view` 2026-11-03 [V]. Registry masih preview [V]. Versi protokol yang dipakai klien MCP OpenCode v2.0.26: [BV].
- **Tool search** (platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool, 2026-11-03) [V]: server-side Anthropic, `defer_loading`, ribuan tool; tidak portabel -> `tool.search` sendiri. anthropic.com/research/advanced-tool-use & anthropic.com/engineering/code-execution-with-mcp (2026-11-03) [V]: muat tool just-in-time, hasil besar tidak lewat context.
- **Skill buatan agen**: Anthropic `skill-creator` (github.com/anthropics/claude-plugins-official/tree/main/plugins/skill-creator; claude.com/blog/improving-skill-creator-test-measure-and-refine-agent-skills, 2026) [V]: tulis -> uji with/without skill -> ukur -> perbaiki. Hermes Agent (hermes-agent.nousresearch.com/docs/user-guide/features/skills, 2026-11-03) [V]: agen mengelola skill lewat `skill_manage`, ada karantina, `lock.json`, `audit.log`, gerbang approval tulis, trust proyek. Detail internal Hermes selebihnya: [BV]. Pemindai skill berbahaya: `snyk/agent-scan` (github.com/snyk/agent-scan) [BV: hanya README/ringkasan, tidak dijalankan].

## 3. Opsi dipertimbangkan

| Opsi | Keputusan | Alasan |
|---|---|---|
| Tool dari OpenAPI auto-generate | Tolak | Tidak ada OpenAPI; ~90 route manual; membuka semua route ke LLM melanggar least privilege. |
| Zod untuk skema tool | Tunda | Tidak terpasang; perbandingan lisensi/ukuran Zod vs valibot vs TypeBox belum dilakukan [BV]. Mulai dengan JSON Schema literal + validator subset datar (~30 baris, pola `proposalParser.ts`). Tinjau ulang bila skema bersarang >10 tool. |
| MCP SDK v2 / v1 | Fase 2, opsional | v2 baru, protokol 2026-07-28 stateless; klien OpenCode mungkin masih protokol lama [BV]. Fase 1 pakai jembatan tool kustom OpenCode (HTTP ke webterm) - nol dependency. |
| MCP server tulis-tangan (stdio) | Cadangan | ~80 baris, tapi mengejar dua versi protokol = hutang. |
| Muat semua tool + skill ke prompt | Tolak | Model gratis lemah memilih dari daftar panjang; prompt 8192 char ketat. |
| `defer_loading` Anthropic | Tolak sebagai inti | Vendor-locked; opsional bila provider = Anthropic. |
| Skill diaktifkan otomatis oleh central | Tolak | Prompt bukan otoritas (I6); skill = injeksi persisten. Wajib approval manusia. |
| Skill di DB saja | Tolak | Loader OpenCode/Claude baca file; tak bisa di-diff. File + indeks SQLite. |
| Impor `~/.claude/skills` user otomatis | Tolak default | 46 skill, 4 body >20k char, 17 symlink (jalur keluar sandbox); beban + risiko injeksi. Impor per skill, eksplisit. |
| Sandbox skrip via `sandbox-exec`/srt | Fase 3, ditunda | `sandbox-exec` deprecated di macOS; srt + Bun macOS belum diuji [BV]. |

## 4. Rekomendasi konkret

### 4.1 Tool registry (`src/server/central/tools/`)
```
ToolDef { name:'node.spawn', summary(<=120c), description, tags[], tier:'R0'|'R1'|'R2'|'R3',
          cap: CapabilityVerb|null, input: JsonSchemaSubset, output: 'inline'|'ref', run(ctx,args) }
```
- File: `registry.ts` (daftar), `validate.ts` (subset: type/required/enum/maxLength/additionalProperties=false), `bridge.opencode.ts`, `bridge.text.ts`, `search.ts`. Maks 300 baris/file (Rule 8).
- Satu pintu eksekusi `execTool(ctx,name,args)`: validasi skema -> cek `cap` terhadap capability turn (`control/capabilities.ts`) -> tier R2/R3 membuat entri `/api/approvals` dan **mengembalikan `pending`**, tidak memblokir turn -> jalankan -> `central.tool` ledger (digest, tier, hasil ok/err, `tools_hash`). Hasil >2 KB disimpan, dikembalikan sebagai `ref` + ringkasan 300 char (hasil besar tak masuk context).
- `tools_hash` = sha256(JSON kanonik semua `{name,input,tier}` aktif) diisi per turn; berubah di tengah sesi tanpa approval = tolak turn (menutup rug-pull RND/08:103).
- Katalog awal (nama pasti di RND/22): inti terlihat = `tool.search`, `tool.call`, `portfolio.read`, `project.get`, `skill.load`, `approval.request`. Ditunda (dicari): `node.list|read|spawn|prompt|wait|close` (R0/R1/R2), `plan.read`, `task.assign`, `memory.*`, `skill.propose|list|diff`, `channel.send` (R2).

### 4.2 Jembatan ke OpenCode (dan fallback)
- Per turn, webterm menulis direktori sementara `<dataDir>/central/run/<turnId>/` berisi `opencode.json` + `tools/*.ts` (tool kustom OpenCode `tool_search`, `tool_call`, `skill_load` yang hanya `fetch` ke `127.0.0.1:PORT/api/central/tool` dengan **token capability turn** dari env - bukan token root). Diaktifkan lewat `OPENCODE_CONFIG_DIR` [BV: semantik di v2.0.26 belum dites] atau `OPENCODE_CONFIG_CONTENT` (sudah di allowlist env, `opencodeOptions.ts:30-32`).
- Hanya 3 tool dikenalkan ke model; skema asli dikembalikan `tool_search` -> prompt kecil dan identik antar turn (prefix cache stabil, RND/23).
- `OPENCODE_PERMISSION_DENY` tetap, tapi **ganti saklar `ALLOW_TOOLS` kasar** dengan allow granular: hanya 3 tool jembatan + `skill`.
- Fallback model tanpa tool-calling andal: `bridge.text.ts` merender tool terpilih ke `<webterm-proposal>` (jalur sekarang). Registry yang sama menghasilkan validasi dan ledger yang sama.
- E1 (wajib sebelum klaim jalan): `opencode run` mungkin memakai background service bersama sehingga env/permission per turn tidak berlaku. Uji `--standalone`/`--server` khusus central [BV].

### 4.3 `tool.search`
BM25-lite atas `name + summary + tags` (k1=1,2, b=0,75), top 5, tiap hasil `{name, summary, tier, input schema}` (~150 token). Indeks dibangun saat boot (<=60 tool, tanpa embedding/dependency). FTS5 hanya bila >200 tool/skill. Metrik: hit@3 pada set golden (RND/28).

### 4.4 Format skill webterm
Subset ketat Agent Skills, valid di OpenCode, Claude Code, dan agentskills.io:
```
---
name: webterm-<slug>                 # regex OpenCode, == nama folder, prefix wajib webterm-
description: <=300 char, "apa + kapan dipakai"   # batas kita < batas standar 1024
license: LicenseRef-user
metadata:                            # string->string (syarat OpenCode)
  webterm.version: "3"
  webterm.origin: builtin|user|proposed
  webterm.caps: "node.read,plan.read"   # allowlist verb; dipotong dengan capability turn
  webterm.tier: R1
  webterm.triggers: "status project, laporan harian"   # kata kunci + slash /skill nama
---
body Markdown <= 4000 char (~1k token); detail panjang -> references/*.md
```
- Dilarang di skill buatan central: `allowed-tools`, `!`cmd``, `scripts/`, symlink, file non-teks, path keluar folder. Field tak dikenal ditolak lint (OpenCode mengabaikannya diam-diam).
- **Penyimpanan**: `<dataDir>/central/skills/{builtin,active,proposed,archive}/<name>/<version>/` ; `active/<name>` = symlink relatif ke versi. Builtin dikirim di repo (`src/server/central/skills/builtin/`), disalin saat boot. Indeks SQLite `central_skill(name, version, sha256, status, origin, caps, created_at, proposed_by, approved_by, approved_at, eval_score)` + `central_skill_event` (append-only); indeks dibangun ulang dengan memindai folder (tahan perubahan, selaras RND/24).
- **Discovery**: katalog = `name + description` skill `active` (maks 20 entri / 1,5k token); selebihnya via `tool.search`. `skill.load(name)` mengembalikan body (cache per sesi). **Trigger**: dipilih model (deskripsi) atau deterministik (`triggers`, `/skill nama` dari chat/Telegram). Skill tidak mengeksekusi sendiri; aksi tetap lewat tool terdaftar + capability.
- **Isolasi dari skill user**: child central diberi `permission.skill = {"*":"deny","webterm-*":"allow"}` [V mekanisme, BV efek runtime] + flag `OPENCODE_DISABLE_*` bila ada di v2.0.26 [BV: nama persis belum dicek]. `HOME` tidak diubah (auth OpenCode butuh), jadi **izin yang menyaring**.
- **`webterm-linked-context`**: tetap apa adanya (untuk agen-node, bukan central; lolos allowlist `webterm-*` tapi tak relevan bagi central). Usul: tulis juga ke `.agents/skills` supaya agen OpenCode ikut melihat [BV: Codex/Gemini membaca `.agents/skills`?]. Wire-protocol `WEBTERM_*` tidak berubah.

### 4.5 Alur skill buatan central (draf -> rollback)
1. `skill.propose({name, description, body, caps})` (R1, cap `skill.propose`): tulis ke `proposed/<name>/<v>/` saja; tidak pernah ke `active`. Batas: 3 proposal/hari, 4 KB body, 1 proposal terbuka per nama.
2. **Lint statis** (`skillLint.ts`, kode sendiri): skema frontmatter, panjang, regex nama, larangan field/file (4.4), `caps` subset dari verb yang dimiliki central (tak boleh meminta `node.spawn` bila turn tak punya), pola injeksi di body (instruksi "abaikan aturan", "kirim ke URL", base64 panjang, Unicode tersembunyi/bidi, URL eksternal tak di allowlist), tautan keluar folder. Gagal = status `rejected`, tak sampai ke manusia.
3. **Eval** (`skillEval.ts`): 3-5 kasus uji dalam `evals/cases.json` (prompt + ekspektasi tool yang dipanggil/tidak boleh dipanggil), dijalankan di runtime mock/replay (RND/28) dengan dan tanpa skill; lulus bila tool yang dilarang tidak dipanggil dan skor >= baseline. Berjalan tanpa model berbayar.
4. **Approval manusia**: `/api/approvals` tier R2 menampilkan diff + hasil lint/eval + `caps`. Tidak ada auto-approve, tidak lewat channel Telegram untuk skill dengan `caps` R2+ (hanya di UI web).
5. **Aktivasi**: hash isi dikunci (`sha256` seluruh folder) di `central_skill`; tiap `skill.load` memverifikasi hash, mismatch = skill dinonaktifkan + event. Versi baru = folder baru; `active` dialihkan atomik.
6. **Rollback**: `skill.rollback(name)` (R2) mengalihkan symlink ke versi sebelumnya; versi tak pernah dihapus (`archive/`), kill-switch `WEBTERM_CENTRAL_SKILLS=off` mematikan semua skill non-builtin sekaligus.
- Deteksi berbahaya: lint di atas + re-scan tiap `skill.load` non-builtin; `snyk/agent-scan` hanya opsi manual user, bukan dependensi [BV].

### 4.6 Flag & batas (envRegistry, gaya `envRegistry.central.ts`)
`WEBTERM_CENTRAL_SKILLS` = `off|builtin|on` (default `builtin`); `WEBTERM_CENTRAL_SKILL_PROPOSE` = flag (default off); `WEBTERM_CENTRAL_TOOL_BRIDGE` = `off|opencode|text` (default `text` sampai E1 lulus). Batas: skill aktif <=20, body <=4000 char, katalog <=1,5k token, hasil tool inline <=2 KB, `tool.search` <=5 hasil, <=8 panggilan tool/turn (angka awal, dikalibrasi lewat metrik RND/23).

### 4.7 Urutan kerja
(1) Tutup kebocoran skill + test argv/env. (2) Registry + `execTool` + `tools_hash` dengan `portfolio.read`. (3) `tool.search` + jembatan teks. (4) Skill builtin + `skill.load`. (5) E1 + jembatan OpenCode. (6) `skill.propose` + lint + eval + approval. (7) MCP bila ada klien eksternal.

## 5. Risiko & mitigasi

| Risiko | Mitigasi |
|---|---|
| Skill buatan central = injeksi persisten (I10) | Karantina, lint, eval, approval manusia, hash terkunci, kill-switch, versi tak dihapus. |
| Tool poisoning / rug pull (deskripsi tool berubah) | Registry milik server, bukan pihak ketiga; `tools_hash` per turn; anotasi MCP eksternal diperlakukan tak tepercaya [V]. |
| Confused deputy (central bertindak atas otoritas lebih besar dari pemanggil) | Token capability per turn, bukan root; `caps` skill diintersect dengan capability turn; tier R2/R3 lewat approval. |
| Kebocoran skill/config user ke child OpenCode | `permission.skill` allowlist `webterm-*`; uji: daftar skill yang terlihat child == builtin. |
| Model gratis salah memilih/menyusun argumen tool | Validasi skema + pesan error terstruktur (1 retry), fallback teks, batas panggilan/turn, set golden di RND/28. |

## 6. Dampak ke invarian/keputusan lama

- **I5 (central tidak spawn)**: `node.spawn` menjadi tool R2 yang dieksekusi **server** lewat capability, bukan oleh child OpenCode; I5 direvisi: "central tidak spawn langsung; hanya via `execTool` + approval + budget" (detail RND/22).
- **I6/I10**: dipertegas - skill dan hasil tool adalah data tak tepercaya sampai lolos approval; body skill aktif diperlakukan seperti kode yang di-review.
- **`task.run`**: tidak dibahas di sini; tool ini hanya akan hadir sebagai entri registry setelah RND/22 menetapkan kontraknya.
- **MVP read-only**: `WEBTERM_CENTRAL_TOOLS=read|write` tetap batas atas tier; `write` membuka R1+, R2/R3 selalu approval.
- **RND/08:103 `tools_hash`**: jadi diimplementasikan nyata (kini hanya kolom skema).
- **RND/09 `centralMcpServer.ts`**: diubah dari "MCP dulu" menjadi "registry dulu, MCP adapter fase 2".

## 7. Pertanyaan terbuka (butuh keputusan user)

1. Setuju fase 1 **tanpa MCP** (jembatan tool kustom OpenCode + fallback teks)? Atau MCP SDK v2 sejak awal (dependency baru; perlu bandingkan lisensi/ukuran/rilis dengan v1 dan hand-written)?
2. Izinkan `scripts/` pada skill sama sekali (hanya builtin/ditandatangani user)?
3. Impor skill dari `~/.claude/skills` user: tidak sama sekali, atau per skill dengan lint?
4. Approval skill hanya di UI web (usul), atau boleh juga via Telegram untuk skill tier R1?
5. Boleh central mengusulkan skill secara proaktif, atau hanya atas permintaan user?
6. Tulis skill node ke `.agents/skills` (tambahan tulisan di luar data dir): diizinkan?
7. Zod untuk skema tool, atau cukup validator subset sendiri?

## 8. Yang TIDAK terverifikasi

- Perilaku `opencode run` v2.0.26 terhadap env/permission per turn bila memakai background service vs `--standalone`/`--server` (E1).
- Semantik `OPENCODE_CONFIG_DIR` dan apakah tool kustom `.opencode/tools` dimuat dari direktori itu; nama persis flag `OPENCODE_DISABLE_*` (halaman skills/permissions/custom-tools yang dibaca tidak menyebutnya).
- Versi protokol MCP yang dipahami klien MCP OpenCode; stabilitas SDK v2 2.4.0 (hanya metadata `npm view`, tidak dipasang/dijalankan).
- Apakah child OpenCode benar-benar memuat `~/.claude/CLAUDE.md`; jumlah ~66 skill = hitungan dari docs + direktori, belum diukur dari dalam proses.
- Detail internal Hermes (quarantine/lock/audit) selain halaman docs; `snyk/agent-scan` tidak dijalankan.
- srt/`sandbox-exec` di macOS dengan Bun; Codex/Gemini CLI membaca `.agents/skills`.
- Tool-calling model gratis (`deepseek-v4.1-flash-free`) untuk jembatan 3-tool: perlu eval nyata (RND/28).
- Perbandingan Zod vs valibot vs TypeBox (lisensi/rilis/ukuran) belum dilakukan.
- Angka batas di 4.6 = titik awal tebakan, bukan hasil ukur. Tidak ada klaim "sudah dites": semua hanya dibaca.
