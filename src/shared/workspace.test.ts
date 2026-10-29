import { describe, it, expect, afterEach } from 'vitest'
import {
  AGENT_CONFIG,
  BUILTIN_AGENT_IDS,
  assembleCmd,
  isContextCapable,
  classifyLink,
  canContextLink,
  canResume,
  canResumeWith,
  canSwitchModel,
  capabilityAgentId,
  hasPermissionMode,
  hasUsage,
  isBuiltinAgent,
  isPermissionMode,
  isSafeSessionId,
  mintsSessionId,
  resumeCommand,
  resumeCommandWith,
  setCustomAgentBaseResolver,
  withSessionId,
} from './workspace'
import type { BuiltinAgentId } from './workspace'

const SID = '3f2a1c00-0000-4000-8000-000000000001'

afterEach(() => {
  // Resolver adalah state level-modul: membiarkannya terpasang membuat test lain bocor.
  setCustomAgentBaseResolver(null)
})

describe('AGENT_CONFIG', () => {
  it('setiap agent punya label, warna hex, launchCmd, dan expectedProcess', () => {
    for (const cfg of Object.values(AGENT_CONFIG)) {
      expect(cfg.label.length).toBeGreaterThan(0)
      expect(cfg.color).toMatch(/^#[0-9a-fA-F]{3,8}$/)
      expect(cfg.launchCmd.length).toBeGreaterThan(0)
      expect(cfg.expectedProcess.length).toBeGreaterThan(0)
    }
  })

  it('BUILTIN_AGENT_IDS mencakup setiap kunci config tepat sekali', () => {
    expect([...BUILTIN_AGENT_IDS].sort()).toEqual(Object.keys(AGENT_CONFIG).sort())
  })
})

describe('isBuiltinAgent', () => {
  it('benar untuk setiap builtin, salah untuk id custom', () => {
    for (const id of BUILTIN_AGENT_IDS) expect(isBuiltinAgent(id)).toBe(true)
    expect(isBuiltinAgent('custom')).toBe(false)
    expect(isBuiltinAgent('custom:3f2a')).toBe(false)
    expect(isBuiltinAgent('')).toBe(false)
  })

  it('tidak ikut pewarisan baseAgent — ia soal identitas, bukan kapabilitas', () => {
    setCustomAgentBaseResolver((id) => (id === 'custom:proxy' ? 'claude' : undefined))
    expect(isBuiltinAgent('custom:proxy')).toBe(false)
    expect(canResume('custom:proxy')).toBe(true)
  })
})

describe('assembleCmd', () => {
  it('mengembalikan perintah polos tanpa profil', () => {
    expect(assembleCmd('claude')).toBe('claude')
    expect(assembleCmd('antigravity')).toBe('agy')
  })

  it('tidak pernah membungkus perintah dengan wrapper apa pun', () => {
    // Regresi dari bug nyata: versi sebelumnya memancarkan `envman -e <profil> -- <agent>`, dan di
    // mesin tanpa envman SETIAP node agent mati dengan `load envman: no such file or directory`.
    // nodeterm tidak membungkus perintah agent sama sekali, jadi webterm juga tidak boleh.
    for (const id of BUILTIN_AGENT_IDS) {
      const cmd = assembleCmd(id)
      expect(cmd).not.toContain('envman')
      expect(cmd).not.toContain(' -- ')
      // Yang diluncurkan adalah program itu sendiri: token pertama = seluruh perintah.
      expect(cmd.split(' ')[0]).toBe(cmd)
    }
  })

  it('memakai override peluncuran pengguna sebagai program, bila diberikan', () => {
    // Override MENANG atas nama CLI polos, untuk SETIAP builtin — ini jalur hidup
    // `settings.agentLaunchCommands` (Dock meneruskannya saat menambah agent), yaitu cara pengguna
    // memilih akun/profil. Kalau default-nya yang menang, setting itu diam-diam tak berefek.
    for (const id of BUILTIN_AGENT_IDS) {
      const override = `wrapper-for-${id}`
      expect(assembleCmd(id, override)).toBe(override)
      expect(assembleCmd(id, override)).not.toBe(AGENT_CONFIG[id].launchCmd)
    }
    // Kosong/spasi/absen = tidak ada override, jatuh ke default builtin.
    expect(assembleCmd('antigravity', '')).toBe('agy')
    expect(assembleCmd('codex', '   ')).toBe('codex')
    expect(assembleCmd('antigravity', undefined)).toBe('agy')
  })
})

describe('kapabilitas', () => {
  it('builtin menjawab sesuai daftar keanggotaannya', () => {
    expect(canContextLink('claude')).toBe(true)
    // copilot tidak memindai ~/.claude/skills, jadi ia di luar CONTEXT_LINK_CAPABLE.
    expect(canContextLink('copilot')).toBe(false)
    expect(canResume('opencode')).toBe(true)
    expect(mintsSessionId('claude')).toBe(true)
    expect(mintsSessionId('codex')).toBe(false)
    expect(hasUsage('codex')).toBe(true)
    expect(hasUsage('copilot')).toBe(false)
    expect(hasPermissionMode('gemini')).toBe(true)
    expect(hasPermissionMode('opencode')).toBe(false)
    expect(canSwitchModel('copilot')).toBe(true)
    expect(canSwitchModel('opencode')).toBe(false)
  })

  it('agent tak dikenal tanpa base tidak punya kapabilitas apa pun', () => {
    for (const p of [canContextLink, canResume, mintsSessionId, hasUsage, hasPermissionMode, canSwitchModel]) {
      expect(p('custom:7f0e')).toBe(false)
      expect(p('custom')).toBe(false)
    }
  })

  it('agent custom MEWARISI kapabilitas base harness-nya', () => {
    setCustomAgentBaseResolver((id) => (id === 'custom:proxy' ? 'claude' : undefined))
    expect(capabilityAgentId('custom:proxy')).toBe('claude')
    expect(canContextLink('custom:proxy')).toBe(true)
    expect(canResume('custom:proxy')).toBe(true)
    expect(mintsSessionId('custom:proxy')).toBe(true)
    expect(hasPermissionMode('custom:proxy')).toBe(true)
    // Agent custom lain lewat resolver yang sama tetap tanpa base → tanpa kapabilitas.
    expect(canResume('custom:other')).toBe(false)
  })

  it('builtin tidak pernah resolve lewat resolver, bahkan bila resolver mengklaim namanya', () => {
    setCustomAgentBaseResolver(() => 'claude')
    // copilot TETAP copilot: builtin memang harness-nya sendiri.
    expect(capabilityAgentId('copilot')).toBe('copilot')
    expect(canContextLink('copilot')).toBe(false)
  })
})

describe('isContextCapable / classifyLink', () => {
  it('true untuk agent builtin yang context-capable', () => {
    expect(isContextCapable('claude')).toBe(true)
    expect(isContextCapable('codex')).toBe(true)
    expect(isContextCapable('gemini')).toBe(true)
  })
  it('false untuk custom tanpa base dan untuk undefined', () => {
    expect(isContextCapable('custom')).toBe(false)
    expect(isContextCapable(undefined)).toBe(false)
  })
  it('kedua ujung capable -> context', () => {
    expect(classifyLink('claude', 'codex')).toBe('context')
  })
  it('salah satu ujung tidak capable -> null', () => {
    expect(classifyLink('claude', undefined)).toBe(null)
    expect(classifyLink('custom', 'claude')).toBe(null)
    expect(classifyLink('copilot', 'claude')).toBe(null)
  })
})

describe('grammar resume per agent', () => {
  const expected: Record<BuiltinAgentId, string> = {
    claude: `claude --resume ${SID}`,
    gemini: `gemini --resume ${SID}`,
    grok: `grok --resume ${SID}`,
    cursor: `cursor-agent --resume ${SID}`,
    codex: `codex resume ${SID}`,
    opencode: `opencode --session ${SID}`,
    copilot: `copilot --resume=${SID}`,
    antigravity: `agy --conversation=${SID}`,
  }

  it('setiap builtin memakai grammar yang diukur di CLI-nya sendiri', () => {
    for (const id of BUILTIN_AGENT_IDS) {
      expect(resumeCommand(id, SID)).toBe(expected[id])
    }
  })

  it('override perintah peluncuran mengganti program, grammar flag tetap', () => {
    expect(resumeCommand('codex', SID, 'my-codex-wrapper')).toBe(`my-codex-wrapper resume ${SID}`)
    expect(resumeCommand('claude', SID, '  ')).toBe(`claude --resume ${SID}`)
  })

  it('agent custom berbasis claude: binary sendiri, flag claude', () => {
    setCustomAgentBaseResolver((id) => (id === 'custom:proxy' ? 'claude' : undefined))
    expect(resumeCommandWith('my-proxy', 'custom:proxy', SID)).toBe(`my-proxy --resume ${SID}`)
  })

  it('null untuk agent tak resumable atau session id tidak aman', () => {
    expect(resumeCommand('custom:nobase', SID)).toBe(null)
    expect(resumeCommand('claude', '')).toBe(null)
    expect(resumeCommand('claude', '; rm -rf /')).toBe(null)
    expect(resumeCommandWith('claude', 'claude', '--help')).toBe(null)
  })

  it('canResumeWith adalah gerbang yang sama tanpa membangun perintah', () => {
    expect(canResumeWith('claude', SID)).toBe(true)
    expect(canResumeWith('claude', '$(id)')).toBe(false)
    expect(canResumeWith('custom:nobase', SID)).toBe(false)
  })
})

describe('withSessionId', () => {
  it('hanya menempel flag untuk agent yang mencetak session id', () => {
    expect(withSessionId('claude', 'claude', SID)).toBe(`claude --session-id ${SID}`)
    expect(withSessionId('copilot', 'copilot', SID)).toBe(`copilot --session-id=${SID}`)
    // cursor tidak punya flag session-id — ia mengadopsi id lewat --resume.
    expect(withSessionId('cursor-agent', 'cursor', SID)).toBe(`cursor-agent --resume ${SID}`)
  })

  it('mengembalikan perintah identik byte untuk agent lain atau id tidak aman', () => {
    expect(withSessionId('codex', 'codex', SID)).toBe('codex')
    expect(withSessionId('claude', 'claude', '')).toBe('claude')
    expect(withSessionId('claude', 'claude', 'a b; whoami')).toBe('claude')
  })
})

describe('isSafeSessionId', () => {
  it('menerima id yang benar-benar dicetak CLI agent', () => {
    expect(isSafeSessionId(SID)).toBe(true)
    expect(isSafeSessionId('0199a1b2.thread_01')).toBe(true)
    expect(isSafeSessionId('A-b_c.9')).toBe(true)
  })

  it('menolak input berbahaya — id ini mendarat di baris perintah shell', () => {
    for (const bad of [
      '',
      '   ',
      '-x',
      '--resume',
      '.hidden',
      'a b',
      'a;whoami',
      'a&&id',
      'a|tee /tmp/x',
      '$(id)',
      '`id`',
      'a$HOME',
      "a'b",
      'a"b',
      'a\nwhoami',
      'a/../b',
      'a>out',
      'a*',
      null,
      undefined,
      42,
      {},
    ]) {
      expect(isSafeSessionId(bad), String(bad)).toBe(false)
    }
  })

  it('bounded memberlakukan SESSION_ID_MAX, unbounded tidak', () => {
    const long = 'a'.repeat(300)
    expect(isSafeSessionId(long)).toBe(true)
    expect(isSafeSessionId(long, true)).toBe(false)
    expect(isSafeSessionId('a'.repeat(256), true)).toBe(true)
  })
})

describe('isPermissionMode', () => {
  it('menerima lima mode nodeterm dan menolak sisanya', () => {
    for (const m of ['manual', 'auto', 'acceptEdits', 'plan', 'bypassPermissions']) {
      expect(isPermissionMode(m)).toBe(true)
    }
    for (const m of ['', 'Auto', 'dontAsk', 'accept-edits', null, 1, {}]) {
      expect(isPermissionMode(m)).toBe(false)
    }
  })
})
