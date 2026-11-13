import { describe, expect, it } from 'vitest'

import type { AgentStatus } from '../shared/workspace'
import { CLAUDE_HOOK_EVENTS, hookEventName } from './hooks'
import { hookStatus, hookStatusReason } from './hookStatus'

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
    // Satu event, beberapa arti: TANPA `notification_type` tidak ada yang bisa dikatakan. Tabel
    // jenisnya ada di describe-nya sendiri di bawah.
    Notification: null,
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
    // Heuristik lama memetakan ini ke 'blocked' dari teks pesannya. Yang menentukan sekarang
    // `notification_type`, jadi pesan yang menyebut "permission" tanpa jenis itu bukan apa-apa.
    const body = { hook_event_name: 'Notification', message: 'Claude needs your permission to run Bash' }
    expect(hookStatus(body as { hook_event_name?: string })).toBeNull()
  })

  it('returns null for an unknown event', () => {
    expect(hookStatus({ hook_event_name: 'Nope' })).toBeNull()
  })
})

// -----------------------------------------------------------------------------------------------
// `Notification` yang disamaratakan.
//
// Gejala (setelah chip node dipecah): sebuah notifikasi yang MEMINTA izin terbaca "TURN ENDED" —
// kebalikan dari maksudnya. Selama `waiting` dan `blocked` sama-sama berbunyi NEEDS YOU, salah-arah
// ini tak terlihat.
//
// Akar: `Notification` bukan satu keadaan. nodeterm bercabang pada `notification_type`
// (`src/shared/agents/normalize.ts:451-481`); webterm memetakan event itu BORONGAN ke 'waiting'.
//
// Pemetaan LAMA dibawa sebagai konstanta supaya guard di bawah terbukti menggigit.
const OLD_NOTIFICATION_STATUS: AgentStatus = 'waiting'

describe('Notification bercabang pada notification_type (aturan nodeterm)', () => {
  const notify = (notification_type?: string) =>
    hookStatus({ hook_event_name: 'Notification', notification_type })

  it('permission_prompt MANDEG, bukan selesai', () => {
    // Prompt izin yang datang sebagai notifikasi alih-alih sebagai PermissionRequest.
    expect(notify('permission_prompt')).toBe('blocked')
    expect(notify('permission_prompt')).not.toBe(OLD_NOTIFICATION_STATUS)
  })

  it('dialog pertanyaan tetap waiting — giliranmu, tapi tidak ada yang diblokir', () => {
    expect(notify('elicitation_dialog')).toBe('waiting')
    expect(notify('agent_needs_input')).toBe('waiting')
  })

  it('idle_prompt TIDAK memindahkan status', () => {
    // nodeterm memakainya sebagai penyelamat node yang tersangkut `working`, tapi hanya di bawah
    // aturan "boleh memindahkan node yang MASIH working" — aturan yang tak bisa dinyatakan fungsi
    // murni atas payload. Tanpa aturan itu ia menurunkan node yang sedang `blocked`, padahal
    // nodeterm mencatat ia bisa menyala saat prompt izin masih terbuka. Node tersangkut `working`
    // di webterm sudah ditangani sapuan basi (`src/shared/agentStale.ts`).
    expect(notify('idle_prompt')).toBeNull()
    expect(notify('idle_prompt')).not.toBe(OLD_NOTIFICATION_STATUS)
  })

  it('jenis informasional dan jenis yang belum dikenal no-op, bukan badge menempel', () => {
    for (const t of ['auth_success', 'elicitation_complete', 'elicitation_response', 'agent_completed', 'something_new', undefined]) {
      expect(notify(t), String(t)).toBeNull()
    }
  })

  it('pemetaan lama akan gagal guard ini', () => {
    // Bukti guard menggigit: borongan 'waiting' membuat permintaan izin terbaca selesai, dan
    // membuat setiap notifikasi informasional memasang badge yang tak pernah turun.
    expect(OLD_NOTIFICATION_STATUS).toBe('waiting')
    for (const t of ['permission_prompt', 'idle_prompt', 'auth_success', undefined]) {
      expect(notify(t), String(t)).not.toBe(OLD_NOTIFICATION_STATUS)
    }
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

describe('hookStatusReason', () => {
  it('a permission request names its tool', () => {
    expect(hookStatusReason({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' })).toEqual({ reason: 'permission', detail: 'Bash' })
  })

  it('notifications: permission prompt vs a question, with the message; info types give none', () => {
    expect(hookStatusReason({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Edit' }))
      .toEqual({ reason: 'permission', detail: 'Claude needs your permission to use Edit' })
    expect(hookStatusReason({ hook_event_name: 'Notification', notification_type: 'elicitation_dialog' })).toEqual({ reason: 'question' })
    expect(hookStatusReason({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'x' })).toBeUndefined()
  })

  it('a failed stop is an error; ordinary events carry no reason; non-string fields are ignored', () => {
    expect(hookStatusReason({ hook_event_name: 'StopFailure', error: 'rate_limit' })).toEqual({ reason: 'error', detail: 'rate_limit' })
    expect(hookStatusReason({ hook_event_name: 'Stop' })).toBeUndefined()
    expect(hookStatusReason({ hook_event_name: 'PreToolUse', tool_name: 'Bash' })).toBeUndefined()
    expect(hookStatusReason({ hook_event_name: 'PermissionRequest', tool_name: { evil: 1 } })).toEqual({ reason: 'permission' })
  })
})
