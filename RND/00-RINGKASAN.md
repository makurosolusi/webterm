# 00 — Ringkasan

Tanggal: 2026-10-31
Status: ringkasan keputusan. Detail: `01-TEMUAN.md`, `02-KEBUTUHAN.md`, `03-RENCANA.md`.

---

## 1. Visi yang diminta

Satu agent pusat yang mengurus seluruh project dan agent di bawahnya, bisa membuat
orkestrator per project, punya memori jangka panjang terstruktur, manajemen context
dan cache yang baik, tool yang memadai, serta bisa dikendalikan dari web UI dan
kanal eksternal seperti Telegram.

---

## 2. Vonis

Layak, tetapi **bukan satu agent raksasa**. Bentuk yang benar:

- 3 peran, 2 hop komando: agent pusat (depth 0), orkestrator project (depth 1),
  worker (depth 2). Worker tidak spawn.
- Agent pusat = router + portfolio authority. Ia membuat/menutup orkestrator project,
  menetapkan prioritas dan budget dalam amplop manusia, dan menjawab status dari
  proyeksi. Ia tidak memerintah worker langsung dan tidak menulis fact/CORE.
- Orkestrator project = hub eksekusi: plan, task, spawn, verifikasi, memori project.
- State otoritatif di server: ledger SQLite + event log. Prompt bukan database.
- Memori hybrid: file+git adalah kebenaran, SQLite FTS5 adalah indeks, claim adalah
  antrean sampai dipromosikan dengan bukti.
- Omnichannel adalah adapter ingress, bukan control plane kedua.

---

## 3. Tiga hal yang menentukan

1. **Event log dan task ledger di server**, sehingga agent "ingat" tanpa mengandalkan
   context window.
2. **Subscriber model dan control API**, sehingga manusia dan agent bisa mengamati
   node yang sama tanpa saling merebut output.
3. **Blocking approval, ownership, dan audit**, sehingga kolaborasi manusia-agent
   bisa dipertanggungjawabkan.

Tanpa tiga fondasi ini, framework atau model yang lebih besar hanya memindahkan masalah.

---

## 4. Keputusan inti

| Topik | Keputusan |
|---|---|
| Agent pusat | Tipis, opsional, setelah project orchestrator stabil |
| Memory | File+git truth, SQLite FTS5 index, claim -> fact |
| Cache | Prefix-exact, sticky route, prefix hash, hit/miss accounting |
| Context | Budget per peran, compaction 80/95, summary schema |
| Tool | Catalog + deferred search, output spill, policy metadata |
| Security | Principal, scoped token, blocking approval digest, blast-radius gate |
| Omnichannel | Telegram P5, flag off, adapter + outbox + identity binding |
| Framework | Kernel sendiri; OpenAI Agents SDK JS hanya jika adopsi |
| Durability | Tanpa engine sampai ambang multi-host/HA/>1.000 run |

---

## 5. Yang tidak dibangun sekarang

- Engine durable (Temporal/Restate/DBOS).
- Vector DB atau graph DB untuk memori.
- A2A penuh, registry agent publik.
- Hierarki tiga tingkat atau spawn rekursif.
- Sandbox per agent (microVM/orb/container) dan sinkronisasi dua arah.
- Approval per aksi, LLM judge sebagai verifier utama.
- Multi-user RBAC, cloud handoff, multi-device sync.
- Slack/Discord/WhatsApp/SMS di v1.

---

## 6. Fase

```
P0 Observation seam
 -> P1 Headless control + scoped auth
 -> P2 Ledger + migration + usage + scheduler
 -> P3 Project orchestrator + verification + approval
 -> P4 Inbox + memory + central thin
 -> P5 Omnichannel (Telegram + webhook)
```

Gate: G1 seam, G2 auth, G3 data, G4 orchestrator, G5 memory, G6 central, G7 omnichannel.

---

## 7. Risiko utama

- `Session.send` satu slot: manusia dan agent tidak bisa co-observe.
- `sessions.ts` tepat 300 baris: ekstraksi wajib sebelum perubahan.
- B1 save lintas-workspace bisa menulis board salah.
- B3 `nodeId` injection ke command hook.
- B4 token root diwarisi child dan status hook fail-open.
- Approval saat ini belum blocking.
- 64 dari 167 requirement belum punya fase; cache/context/tool/routing paling besar.
- SQLite 3.43.2 di Bun berada di rentang bug WAL-reset; satu writer dan backup wajib.
