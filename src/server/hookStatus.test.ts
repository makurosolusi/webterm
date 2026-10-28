import { describe, expect, it } from 'vitest'

import type { AgentStatus } from '../shared/workspace'
import { CLAUDE_HOOK_EVENTS, hookEventName } from './hooks'
import { hookStatus } from './hookStatus'

describe('hookStatus', () => {
  // Tabel LENGKAP event→status, satu baris per event yang dilanggani. Ditulis eksplisit supaya
  // setiap perubahan pemetaan harus melewati test ini, bukan lewat diam-diam.
  const TABLE: Record<string, AgentStatus | null> = {
    // Start-of-work yang jujur: ada pekerjaan karena ada yang memintanya.
    UserPromptSubmit: 'working',
    // Penjaga turn tetap hidup di tengah jalan.
    PreToolUse: 'working',
    PostToolUse: 'working',
    // Setiap jalur yang mengakhiri sebuah turn.
    Stop: 'waiting',
    StopFailure: 'waiting',
    Notification: 'waiting',
    PermissionRequest: 'blocked',
    SessionEnd: 'done',
    // Batas siklus hidup, BUKAN perubahan state (lihat doc `hookStatus`).
    SessionStart: null,
    // Siklus hidup ANAK, bukan state induk (lihat doc `hookStatus`).
    SubagentStart: null,
    SubagentStop: null,
  }

  it('maps every subscribed event exactly as the table says', () => {
    for (const [event, want] of Object.entries(TABLE)) {
      expect(hookStatus({ hook_event_name: event })).toBe(want)
    }
  })

  it('covers every subscribed event and nothing it does not subscribe', () => {
    expect(Object.keys(TABLE).sort()).toEqual(CLAUDE_HOOK_EVENTS.map(hookEventName).sort())
  })

  it('does NOT report working for a session that has only just started (regression)', () => {
    // Bug nyata: node claude yang baru di-spawn, masih memperlihatkan banner sambutan dan belum
    // pernah diberi prompt, terbaca RUNNING di chrome node dan terhitung di seksi Running sidebar.
    // SessionStart menyala saat CLI start, jadi memetakannya ke 'working' adalah klaim tanpa bukti.
    expect(hookStatus({ hook_event_name: 'SessionStart' })).toBeNull()
    // Dan sinyal yang BOLEH menyatakan kerja tetap menyatakannya — jadi perbaikan ini tidak
    // sekadar membungkam badge.
    expect(hookStatus({ hook_event_name: 'UserPromptSubmit' })).toBe('working')
  })

  it('keeps SessionStart subscribed even though it carries no status', () => {
    // Ia hook pertama yang menyala, jadi ia pemasok `transcript_path` paling awal (api.ts memanen
    // field itu TERPISAH dari status). Mencabut langganannya membutakan konteks-tertaut sampai
    // prompt pertama.
    expect(CLAUDE_HOOK_EVENTS.map(hookEventName)).toContain('SessionStart')
  })

  it('no longer sniffs Notification text for permission wording', () => {
    // Heuristik lama memetakan ini ke 'blocked'; PermissionRequest sekarang satu-satunya sumber.
    const body = { hook_event_name: 'Notification', message: 'Claude needs your permission to run Bash' }
    expect(hookStatus(body as { hook_event_name?: string })).toBe('waiting')
  })

  it('returns null for an unknown event', () => {
    expect(hookStatus({ hook_event_name: 'Nope' })).toBeNull()
  })
})

// -----------------------------------------------------------------------------------------------
// Regresi badge yang tersangkut RUNNING pada node yang sudah diam.
//
// Gejala yang dilaporkan: sebuah node agent jelas idle (agent duduk di input box-nya) tapi ditandai
// RUNNING; ia PERNAH benar-benar running, lalu berhenti, dan badge-nya tidak pernah turun.
//
// Akar: status webterm hanya bisa turun kalau ada hook yang menyuruhnya turun — tidak ada sweep,
// tidak ada jam — jadi status yang ditulis TERAKHIR bertahan selamanya. Dan event SUBAGENT bisa
// menyala setelah turn induknya berakhir (anak latar), sehingga event terakhir yang pernah diterima
// node adalah event anak. Selama event anak memetakan ke 'working', tulisan terakhir itu 'working'.
//
// Pemetaan LAMA dibawa sebagai konstanta supaya guard di bawah terbukti menggigit.
const OLD_SUBAGENT_STATUS: Record<string, AgentStatus> = {
  SubagentStart: 'working',
  SubagentStop: 'working',
}

describe('aktivitas anak tidak menggerakkan status induk', () => {
  it('SubagentStop tidak lagi menaikkan induknya ke working', () => {
    // Urutan nyata sebuah turn yang meluncurkan subagent LATAR: induk selesai, lalu anaknya
    // berhenti belakangan. Status akhir yang benar adalah yang ditulis `Stop`.
    expect(hookStatus({ hook_event_name: 'PreToolUse' })).toBe('working')
    expect(hookStatus({ hook_event_name: 'Stop' })).toBe('waiting')
    expect(hookStatus({ hook_event_name: 'SubagentStop', agent_id: 'child-1' })).toBeNull()
    expect(hookStatus({ hook_event_name: 'SubagentStart', agent_id: 'child-1' })).toBeNull()
    // Dan tanpa `agent_id` pun tetap null: yang menentukan adalah NAMA event-nya.
    expect(hookStatus({ hook_event_name: 'SubagentStop' })).toBeNull()
  })

  it('tool-use milik anak tidak menggerakkan induknya, tapi tool-use induk tetap', () => {
    // Subagent memakai file `--settings` yang sama, jadi Pre/PostToolUse-nya sendiri juga mem-POST
    // ke node INDUK. Pembedanya `agent_id`, yang hanya ada pada event anak.
    expect(hookStatus({ hook_event_name: 'PreToolUse', agent_id: 'child-1' })).toBeNull()
    expect(hookStatus({ hook_event_name: 'PostToolUse', agent_id: 'child-1' })).toBeNull()
    expect(hookStatus({ hook_event_name: 'PreToolUse' })).toBe('working')
    expect(hookStatus({ hook_event_name: 'PostToolUse' })).toBe('working')
  })

  it('permission request seorang anak TETAP terlihat', () => {
    // Beda dari tool-use: sebuah request yang MENUNGGU jawaban harus terlihat walau yang meminta
    // seorang anak, kalau tidak pengguna menunggu prompt yang tak pernah muncul di badge mana pun.
    // Aturan nodeterm yang sama (normalize.ts:280-281 hanya membuang event Pre/PostToolUse).
    expect(hookStatus({ hook_event_name: 'PermissionRequest', agent_id: 'child-1' })).toBe('blocked')
  })

  it('pemetaan lama akan gagal guard ini', () => {
    // Bukti guard menggigit: kalau Subagent* kembali dipetakan ke 'working', node yang turn-nya
    // sudah berakhir akan berakhir di 'working' lagi — tepat gejala yang dilaporkan.
    expect(OLD_SUBAGENT_STATUS['SubagentStop']).toBe('working')
    expect(hookStatus({ hook_event_name: 'SubagentStop' })).not.toBe(OLD_SUBAGENT_STATUS['SubagentStop'])
    expect(hookStatus({ hook_event_name: 'SubagentStart' })).not.toBe(OLD_SUBAGENT_STATUS['SubagentStart'])
  })
})
