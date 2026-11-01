# RND — Agent Pusat webterm

Status: riset dan perencanaan. **Belum ada kode implementasi.**
Tanggal: 2026-10-31.
Semua dokumen di folder ini adalah bahan keputusan sebelum implementasi.

---

## 1. Mulai dari sini

Urutan baca untuk agent berikutnya:

1. `00-RINGKASAN.md` — vonis, prinsip, keputusan inti.
2. `01-TEMUAN.md` — temuan project dan riset.
3. `02-KEBUTUHAN.md` — requirement per domain (K/S/M/C/X/T/R/A/I/E/U/D/O).
4. `03-RENCANA.md` — fase P0-P5, gate, rollback, mitigasi.
5. `04-OMNICHANNEL.md` — Telegram/webhook, identitas, approval chat.
6. `05-TRACEABILITY.md` — coverage dan gap.
7. `06-BUG-RISK.md` — bug B1-B12 dan deteksi dini.
8. `90-REFERENSI/AGENT_PUSAT.md` — bukti detail, URL, insiden.
9. `90-REFERENSI/BUKTI.md` — artefak riset dan clone Jcode.

---

## 2. Struktur

```
RND/
  README.md
  00-RINGKASAN.md
  01-TEMUAN.md
  02-KEBUTUHAN.md
  03-RENCANA.md
  04-OMNICHANNEL.md
  05-TRACEABILITY.md
  06-BUG-RISK.md
  90-REFERENSI/
    AGENT_PUSAT.md
    BUKTI.md
```

---

## 3. Keputusan yang sudah diambil

| Topik | Keputusan |
|---|---|
| Bentuk | 3 peran, 2 hop komando: agent pusat (depth 0), orkestrator project (1), worker (2) |
| Agent pusat | Router + portfolio authority, bukan eksekutor; opsional setelah project orchestrator stabil |
| State | Ledger SQLite + event log; task row = state, event = audit |
| Memory | File+git truth, SQLite FTS5 index, claim -> fact; P4a lalu P4b |
| Cache | Prefix-exact, sticky route, prefix hash, hit/miss accounting |
| Context | Budget per peran, compaction 80/95, summary schema, cross-agent ledger |
| Tool | Catalog + deferred search, output spill, policy, untrusted result |
| Security | Principal, scoped token, blocking approval digest, blast-radius gate |
| Omnichannel | Adapter ingress, bukan control plane; Telegram P5, flag off |
| Framework | Kernel sendiri; OpenAI Agents SDK JS hanya jika adopsi |
| Durability | Tanpa engine sampai ambang multi-host/HA/>1.000 run |
| Docs | RND adalah sumber perencanaan; kode belum disentuh |

---

## 4. Fase

```
P0 Observation seam
 -> P1 Headless control + scoped auth
 -> P2 Ledger + migration + usage + scheduler
 -> P3 Project orchestrator + verification + approval
 -> P4 Inbox + memory + central thin
 -> P5 Omnichannel (Telegram + webhook)
```

Gate: G1 seam, G2 auth, G3 data, G4 orchestrator, G5 memory, G6 central, G7 omnichannel.
Detail di `03-RENCANA.md` dan `06-BUG-RISK.md`.

---

## 5. Cara melanjutkan

1. Baca `00-RINGKASAN.md` dan `03-RENCANA.md`.
2. Pilih fase yang belum selesai; jangan lompat.
3. Branch baru per concern (`feature/`, `fix/`, `chore/`).
4. Sebelum kode: cek `02-KEBUTUHAN.md` untuk ID requirement dan `05-TRACEABILITY.md` untuk gap.
5. Sebelum merge: jalankan gate di `03-RENCANA.md`, Update CHANGELOG jika perilaku publik berubah.
6. Jangan push/deploy/merge tanpa perintah eksplisit.

---

## 6. Aturan dokumen

- Satu dokumen satu tanggung jawab.
- Jangan menduplikasi tabel besar; tautkan file.
- Setiap requirement punya ID, fase, file, test, evidence.
- Angka vendor dan klaim belum terverifikasi tetap di `90-REFERENSI/AGENT_PUSAT.md`.
- Jika dokumen melewati batas sehat, pecah ke file baru dan update README.
- Bahasa: Indonesia; istilah teknis tetap Inggris bila lebih tepat.

---

## 7. Status singkat

- Riset: 46 worker wave 1-4, 13 worker wave 5 (implementasi), 12 worker wave 6 (omnichannel).
- Kode: belum ada perubahan.
- Dokumen: siap dipakai sebagai bahan implementasi dan review.
- Risiko terbesar: B1 save lintas-workspace, B3 nodeId injection, B4 token inheritance,
  single-subscriber PTY, dan approval yang belum blocking.
