import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  claudeProjectsRoot,
  dropsResume,
  probeTranscript,
  resumeIsDead,
  transcriptMissingNotice,
} from './transcriptPresence'

// Gejala: node agent claude mati seketika di peluncuran dengan "No conversation found with session
// ID: <uuid>" lalu jatuh ke shell kosong.
//
// Akar: `msg.resume` hanya berarti "node ini punya sessionId tersimpan", bukan bukti transcript-nya
// masih di disk. Perilaku LAMA dibawa sebagai konstanta supaya guard di bawah terbukti menggigit:
// dulu TIDAK ADA probe sama sekali, jadi jawabannya untuk setiap id adalah "resume saja".
const OLD_NO_PROBE_DROPS_RESUME = false

const SID = '789dc5d1-a555-46bb-b23a-5fef591bf01a'

/** Root palsu di temp dir — test ini tidak pernah menyentuh `~/.claude` milik pengguna. */
const freshRoot = (): string => join(mkdtempSync(join(tmpdir(), 'wt-presence-')), 'projects')

afterEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR
})

describe('probeTranscript', () => {
  it("menjawab 'present' saat berkasnya ada di salah satu project dir", () => {
    const root = freshRoot()
    // Dua project dir, transcript-nya di yang KEDUA: inilah alasan kita memindai semua dir dan
    // tidak menghitung slug dari cwd node (cwd sesi bisa beda dari cwd node-nya).
    mkdirSync(join(root, '-Users-someone-other-project'), { recursive: true })
    const dir = join(root, '-Users-someone-webterm')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${SID}.jsonl`), '{}\n')

    expect(probeTranscript(SID, root)).toBe('present')
    expect(dropsResume(probeTranscript(SID, root))).toBe(false)
  })

  it("menjawab 'absent' saat root terbaca tapi tidak ada yang cocok", () => {
    const empty = freshRoot()
    mkdirSync(empty, { recursive: true })
    expect(probeTranscript(SID, empty)).toBe('absent')

    // Root berisi project dir dan transcript LAIN tetap 'absent' untuk id ini — yang dicari berkas
    // `<id>.jsonl`, bukan sekadar "ada transcript di mesin ini".
    const populated = freshRoot()
    const dir = join(populated, '-Users-someone-webterm')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '00000000-1111-2222-3333-444444444444.jsonl'), '{}\n')
    expect(probeTranscript(SID, populated)).toBe('absent')

    // Bukti guard menggigit: inilah jawaban yang diberikan webterm sebelum ada probe.
    expect(dropsResume(probeTranscript(SID, populated))).not.toBe(OLD_NO_PROBE_DROPS_RESUME)
  })

  it("menjawab 'unknown' saat rootnya tidak ada", () => {
    // Direktori belum pernah dibuat (claude belum pernah jalan, home lain, mount belum siap).
    // "Tidak tahu" TIDAK BOLEH menjatuhkan resume: salah menjatuhkan id hidup menelantarkan kerja.
    expect(probeTranscript(SID, join(freshRoot(), 'nope', 'still-nope'))).toBe('unknown')
    // Dan juga saat 'root'-nya ternyata berkas, bukan direktori — error apa pun = 'unknown'.
    const base = freshRoot()
    mkdirSync(base, { recursive: true })
    const notADir = join(base, 'not-a-dir')
    writeFileSync(notADir, 'x')
    expect(probeTranscript(SID, notADir)).toBe('unknown')
  })

  it("menjawab 'unknown' untuk session id yang tak sah, bukan 'absent'", () => {
    const root = freshRoot()
    mkdirSync(join(root, '-Users-someone-webterm'), { recursive: true })
    // Id ini membentuk PATH dan datang lewat WebSocket. Yang mirip-traversal/metakarakter ditolak
    // SEBELUM dipakai, dan jawabannya 'unknown' — menjatuhkan resume atas input busuk akan membuat
    // client bisa memaksa percakapan kosong.
    for (const bad of ['', '   ', '.hidden', '-evil', '../../etc/passwd', 'a b', '$(id)', 'a/b']) {
      expect(probeTranscript(bad, root)).toBe('unknown')
      expect(dropsResume(probeTranscript(bad, root))).toBe(false)
    }
    expect(probeTranscript(undefined, root)).toBe('unknown')
  })
})

describe('dropsResume', () => {
  it("hanya true untuk 'absent'", () => {
    expect(dropsResume('absent')).toBe(true)
    expect(dropsResume('present')).toBe(false)
    // Inti aturan cold-resume: salah me-resume id mati =
    // satu baris jelek, bisa dipulihkan. Salah menjatuhkan id hidup = kerja ditelantarkan diam-diam.
    expect(dropsResume('unknown')).toBe(false)
  })
})

describe('resumeIsDead', () => {
  const emptyRoot = () => {
    const root = freshRoot()
    mkdirSync(root, { recursive: true })
    return root
  }

  it('menjatuhkan resume claude yang transcript-nya terbukti hilang', () => {
    expect(resumeIsDead(SID, 'claude', emptyRoot())).toBe(true)
    expect(resumeIsDead(SID, 'claude', emptyRoot())).not.toBe(OLD_NO_PROBE_DROPS_RESUME)
  })

  it('TIDAK pernah menjatuhkan resume agent non-claude, walau transcript-nya tidak ada', () => {
    const root = emptyRoot()
    // Session id codex/gemini/cursor/copilot meleset dari resolver claude MENURUT KONSTRUKSI, jadi
    // menanyakannya menjawab 'absent' untuk sesi yang sehat. Buktinya: probe mentahnya 'absent'…
    expect(probeTranscript(SID, root)).toBe('absent')
    // …tapi gerbang kapabilitas membuat keputusannya tetap "resume" untuk semuanya.
    for (const id of ['codex', 'gemini', 'cursor', 'copilot', 'antigravity', 'custom:bare']) {
      expect(resumeIsDead(SID, id, root)).toBe(false)
    }
    // Terminal biasa (tanpa agentId) juga tidak pernah diprobe.
    expect(resumeIsDead(SID, undefined, root)).toBe(false)
  })

  it('tetap resume saat rootnya tidak terbaca', () => {
    expect(resumeIsDead(SID, 'claude', join(freshRoot(), 'nope'))).toBe(false)
  })
})

describe('claudeProjectsRoot', () => {
  it('menghormati CLAUDE_CONFIG_DIR dan jatuh ke ~/.claude', () => {
    process.env.CLAUDE_CONFIG_DIR = '/tmp/alt-claude-config'
    expect(claudeProjectsRoot()).toBe(join('/tmp/alt-claude-config', 'projects'))
    delete process.env.CLAUDE_CONFIG_DIR
    expect(claudeProjectsRoot().endsWith(join('.claude', 'projects'))).toBe(true)
  })
})

describe('transcriptMissingNotice', () => {
  it('dibungkus CRLF dan tidak pernah membocorkan session id', () => {
    expect(transcriptMissingNotice.startsWith('\r\n')).toBe(true)
    expect(transcriptMissingNotice.endsWith('\r\n')).toBe(true)
    expect(transcriptMissingNotice).toContain('[webterm]')
    expect(transcriptMissingNotice.includes(SID)).toBe(false)
  })
})
