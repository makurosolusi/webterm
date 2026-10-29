// Dua hal yang diuji di sini, keduanya tentang node agent yang tampak hidup tapi diam:
//   1. keputusan "resume atau peluncuran pertama" — bug "Session ID … is already in use." saat node
//      dibuka kembali dari Recently closed;
//   2. tombol header yang gagal TANPA memberi tahu siapa pun.
//
// Pola campuran yang sudah dipakai repo ini: logika yang bisa diangkat diuji sebagai fungsi murni,
// sisanya (hidup di dalam JSX) diuji lewat pembacaan source seperti `nodeRender.test.ts`. Tiap guard
// pembacaan source dibuktikan MENGGIGIT dengan menyimpan bentuk lamanya sebagai konstanta.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BUILTIN_AGENT_IDS, SESSION_ID_CAPABLE } from '../shared/workspace'
import { resumesOnFirstLaunch } from './AgentNode'
import { type ClosedEntry, takeClosed } from './closedHistory'
import { speechErrorText } from './useSpeechInput'

const src = (f: string) => readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), 'utf8')

const SID = '6432c1be-c265-4c86-a6d2-05deea24e259'

describe('resumesOnFirstLaunch', () => {
  it('node yang datang SUDAH ber-sessionId harus resume — itu bug reopen-nya', () => {
    // Node dari "Recently closed" dipulihkan sebagai snapshot utuh, jadi sessionId ikut kembali
    // sementara PTY-nya sudah mati. `--session-id <id-lama>` ditolak CLI; `--resume` yang benar.
    expect(resumesOnFirstLaunch('claude', SID)).toBe(true)
  })

  it('node agent yang BENAR-BENAR baru tetap meluncur dengan --session-id', () => {
    expect(resumesOnFirstLaunch('claude', undefined)).toBe(false)
    expect(resumesOnFirstLaunch('claude', '')).toBe(false)
  })

  it('hanya agent yang mencetak session id sendiri yang layak di-resume', () => {
    // Digerbangi daftar kapabilitas yang SAMA dengan `resumableSid`. Untuk agent lain `sessionId`
    // cuma uuid lokal yang tak pernah dilihat CLI-nya — me-resume-nya membuka chat kosong.
    for (const id of BUILTIN_AGENT_IDS) {
      const minted = (SESSION_ID_CAPABLE as readonly string[]).includes(id)
      expect(resumesOnFirstLaunch(id, SID), id).toBe(minted)
    }
    // Daftarnya tidak boleh kosong, kalau tidak loop di atas lolos tanpa menguji cabang `true`.
    expect(SESSION_ID_CAPABLE.length).toBeGreaterThan(0)
  })

  it('terminal biasa (tanpa agentId) tidak pernah resume', () => {
    expect(resumesOnFirstLaunch(undefined, SID)).toBe(false)
  })
})

// Bentuk LAMA `onAddAgent`, yang mencetak session id di titik pembuatan node. Ada untuk membuktikan
// guard di bawah bisa merah.
const OLD_ADD_AGENT_MINTS_SID = 'sessionId: crypto.randomUUID()'

/** Pencarian `onAddAgent` sebagai TEKS: vitest repo ini jalan di node-env tanpa DOM, jadi komposisi
 *  App → AgentNode tidak bisa dirender. Diambil sampai `]` penutup useCallback-nya. */
const addAgentBody = (s: string) => {
  const i = s.indexOf('const onAddAgent = useCallback(')
  const j = s.indexOf('}, [addFlowNode])', i)
  expect(i, 'onAddAgent tidak ditemukan di App.tsx').toBeGreaterThan(-1)
  expect(j, 'badan onAddAgent tidak berujung di [addFlowNode]').toBeGreaterThan(i)
  return s.slice(i, j)
}
const mintsSidAtCreation = (s: string) => /sessionId:\s*crypto\.randomUUID\(\)/.test(s)
/** `AgentNode` mencetak id-nya sendiri saat props-nya kosong, DAN mem-persist-nya sekali. Itu yang
 *  membuat penghapusan di `App.tsx` tidak kehilangan apa pun. */
const agentNodeMintsOwnSid = (s: string) =>
  /const \[sid, setSid\] = useState<string>\(sessionId \?\? randomId\(\)\)/.test(s) &&
  /if \(!sessionId\) onSession\(id, sid\)/.test(s)

describe('titik pembuatan node agent TIDAK mencetak session id', () => {
  // Inti bug "nambah agent baru malah langsung error": `resumesOnFirstLaunch` memakai ADA-TIDAKNYA
  // `sessionId` sebagai proksi untuk "pernah diluncurkan". Proksi itu hanya benar kalau tak ada yang
  // mencetak id di muka. Ini KOMPOSISInya — yang di atas cuma menguji fungsinya dengan input manual.
  it('`onAddAgent` di App.tsx melahirkan node tanpa sessionId', () => {
    expect(mintsSidAtCreation(addAgentBody(src('App.tsx')))).toBe(false)
  })

  it('guard menolak bentuk lama yang mencetaknya di muka', () => {
    expect(mintsSidAtCreation(OLD_ADD_AGENT_MINTS_SID)).toBe(true)
  })

  it('node yang lahir dari `onAddAgent` meluncur dengan --session-id, bukan --resume', () => {
    expect(resumesOnFirstLaunch('claude', undefined)).toBe(false)
  })

  it('`AgentNode` tetap mencetak dan mem-persist id-nya sendiri', () => {
    expect(agentNodeMintsOwnSid(src('AgentNode.tsx'))).toBe(true)
    expect(agentNodeMintsOwnSid('const [sid, setSid] = useState<string>(randomId())')).toBe(false)
  })
})

describe('bug reopen yang sudah ditutup tetap tertutup', () => {
  // Penghapusan di App.tsx tidak boleh diam-diam menghidupkan lagi "Session ID … is already in use.":
  // jalur reopen punya sessionId-nya dari snapshot node, bukan dari titik pembuatan.
  it('node ber-sessionId tetap resume', () => {
    expect(resumesOnFirstLaunch('claude', SID)).toBe(true)
  })

  it('reopen memulihkan snapshot `WsNode` UTUH, jadi `sessionId` ikut kembali', () => {
    const closed: ClosedEntry = {
      node: { id: 'n1', kind: 'agent', x: 0, y: 0, agentId: 'claude', sessionId: SID },
      workspaceId: 'w1',
      workspaceName: 'w',
      closedAt: 0,
    }
    // `takeClosed` adalah apa yang dibaca `reopen` sebelum menyerahkan `entry.node` ke `addNode`.
    expect(takeClosed([closed], 'n1').entry?.node.sessionId).toBe(SID)
    expect(resumesOnFirstLaunch('claude', takeClosed([closed], 'n1').entry?.node.sessionId)).toBe(true)
    // Dan reopen memang menyerahkan node itu apa adanya, bukan membangun ulang sebagiannya.
    expect(src('closedHistory.ts')).toMatch(/deps\.addNode\(\(\) => entry\.node\)/)
  })
})

// Bentuk LAMA, persis seperti sebelum perbaikan. Ada untuk membuktikan guard di bawah bisa merah.
const OLD_RESUME_INIT = 'const [resume, setResume] = useState(false)'
const OLD_AI_NAME = `try { const r = await apiGenerateName(id); if (r.ok) rf.updateNodeData(id, { title: r.message }) }
    finally { setAiNaming(false) }`
const OLD_MIC_PROP = 'micActive={micActive} onToggleMic={toggleMic}'
const OLD_EYE_PROP = 'hideLinks={d.hideLinks} onToggleHideLinks={() => onToggleHideLinks(id)}'
const OLD_ONERROR = 'recog.onerror = () => setMicActive(false)'

const resumeInitDerived = (s: string) => /useState\(\(\) => resumesOnFirstLaunch\(agentId, sessionId\)\)/.test(s)
const resumeInitPinnedFalse = (s: string) => /const \[resume, setResume\] = useState\(false\)/.test(s)
/** Cabang gagal `aiName` menulis `r.message` ke thread node, bukan membuangnya. */
const surfacesAiFailure = (s: string) => /else addComment\(r\.message, NOTE_AUTHOR\)/.test(s)
/** `aiName` punya catch — tanpa itu fetch yang melempar jadi unhandled rejection tanpa jejak. */
const aiNameCatches = (s: string) => /apiGenerateName\(id\)[\s\S]{0,300}?\} catch \(/.test(s)
const micHiddenWhenUnsupported = (s: string) =>
  /const onToggleMicProp = micSupported \? toggleMic : undefined/.test(s) &&
  /onToggleMic=\{onToggleMicProp\}/.test(s)
const eyeGatedOnContextCapable = (s: string) =>
  /const onToggleHideLinksProp = isContextCapable\(agentId\) \? \(\) => onToggleHideLinks\(id\) : undefined/.test(s) &&
  /onToggleHideLinks=\{onToggleHideLinksProp\}/.test(s)
/** Tanpa `supported` yang diambil dari hook, `micSupported` cuma undefined dan gatingnya bohong. */
const takesSupportedFromHook = (s: string) => /\{ micActive, toggleMic, supported: micSupported \} = useSpeechInput/.test(s)
const reportsRecogError = (s: string) => /recog\.onerror = \(e\) => \{[^}]*onError\?\.\(speechErrorText\(e\?\.error\)\)/.test(s)
const guardsRecogStart = (s: string) => /try \{\s*recog\.start\(\)\s*\} catch \(/.test(s)

describe('AgentNode: resume diturunkan dari props, tidak dipaku', () => {
  it('initializer membaca `resumesOnFirstLaunch`, bukan `false`', () => {
    const s = src('AgentNode.tsx')
    expect(resumeInitDerived(s)).toBe(true)
    expect(resumeInitPinnedFalse(s)).toBe(false)
  })

  it('guard menolak bentuk lamanya', () => {
    expect(resumeInitPinnedFalse(OLD_RESUME_INIT)).toBe(true)
    expect(resumeInitDerived(OLD_RESUME_INIT)).toBe(false)
  })

  it('initializer LAZY — dipanggil sekali per mount', () => {
    // `useState(resumesOnFirstLaunch(...))` (tanpa `() =>`) akan dievaluasi tiap render. Pada render
    // kedua `onSession` sudah mengisi `sessionId`, jadi node BARU pun akan terbaca resume.
    expect(resumeInitDerived('useState(resumesOnFirstLaunch(agentId, sessionId))')).toBe(false)
  })
})

describe('AgentNode: tombol header tidak boleh gagal diam-diam', () => {
  it('sparkle melaporkan kegagalan ke thread node dan punya catch', () => {
    const s = src('AgentNode.tsx')
    expect(surfacesAiFailure(s)).toBe(true)
    expect(aiNameCatches(s)).toBe(true)
  })

  it('guard sparkle menolak bentuk lama yang menelan `!r.ok`', () => {
    expect(surfacesAiFailure(OLD_AI_NAME)).toBe(false)
    expect(aiNameCatches(OLD_AI_NAME)).toBe(false)
  })

  it('catatan mesin dibedakan dari catatan pengguna lewat `author`', () => {
    const s = src('AgentNode.tsx')
    expect(s).toMatch(/const NOTE_AUTHOR = 'webterm'/)
    // `addComment` harus bisa membawa author; tanpa param itu catatan mesin tampak ditulis pengguna.
    expect(s).toMatch(/const addComment = \(text: string, author\?: string\)/)
  })

  it('mic disembunyikan di browser tanpa Web Speech, mata hanya untuk node context-capable', () => {
    const s = src('AgentNode.tsx')
    expect(micHiddenWhenUnsupported(s)).toBe(true)
    expect(eyeGatedOnContextCapable(s)).toBe(true)
  })

  it('guard mic/mata menolak bentuk lama yang selalu merender tombolnya', () => {
    expect(micHiddenWhenUnsupported(OLD_MIC_PROP)).toBe(false)
    expect(eyeGatedOnContextCapable(OLD_EYE_PROP)).toBe(false)
  })

  it('`hideLinks` TETAP dibaca dari data node', () => {
    // Dijaga nodeRender.test.ts juga; diulang di sini karena gating di atas menyentuh baris yang sama.
    expect(src('AgentNode.tsx')).toMatch(/hideLinks=\{d\.hideLinks\}/)
  })
})

// Bentuk LAMA `TerminalNode.tsx`, yang kena bug mic bisu yang sama persis seperti node agent.
const OLD_TERMINAL_MIC = `const { micActive, toggleMic } = useSpeechInput((text) => send({ t: 'input', id, data: text }))
          micActive={micActive} onToggleMic={toggleMic}`

describe('TerminalNode: tombol mic tidak boleh dirender saat Web Speech tidak ada', () => {
  it('mengambil `supported` dari hook dan mengirim undefined saat tidak didukung', () => {
    const s = src('TerminalNode.tsx')
    expect(takesSupportedFromHook(s)).toBe(true)
    expect(micHiddenWhenUnsupported(s)).toBe(true)
  })

  it('guard menolak bentuk lama yang selalu merender tombol mic', () => {
    expect(takesSupportedFromHook(OLD_TERMINAL_MIC)).toBe(false)
    expect(micHiddenWhenUnsupported(OLD_TERMINAL_MIC)).toBe(false)
    expect(micHiddenWhenUnsupported(OLD_MIC_PROP)).toBe(false)
  })
})

describe('useSpeechInput: kegagalan dikte punya suara', () => {
  it('error pengenal dilaporkan, bukan ditelan', () => {
    const s = src('useSpeechInput.ts')
    expect(reportsRecogError(s)).toBe(true)
    expect(guardsRecogStart(s)).toBe(true)
  })

  it('guard menolak handler lama yang hanya mematikan lampu mic', () => {
    expect(reportsRecogError(OLD_ONERROR)).toBe(false)
    expect(guardsRecogStart('recog.start()\n    setMicActive(true)')).toBe(false)
  })

  it('izin ditolak menyebut ORIGIN — penyebab paling sering di webterm', () => {
    // webterm disajikan lewat http; dibuka dari alamat LAN ia bukan secure context, dan Web Speech
    // menolak tanpa pernah menampilkan dialog izin. Pesan "error" saja tidak menolong siapa pun.
    for (const code of ['not-allowed', 'service-not-allowed']) {
      expect(speechErrorText(code)).toMatch(/secure origin/)
      expect(speechErrorText(code)).toMatch(/localhost or https/)
    }
  })

  it('kode lain tetap terbawa supaya bisa dicari', () => {
    expect(speechErrorText('audio-capture')).toContain('audio-capture')
    expect(speechErrorText('no-speech')).toBe('Dictation heard nothing.')
  })

  it('tanpa kode tidak meninggalkan tanda kurung kosong', () => {
    expect(speechErrorText()).toBe('Dictation failed.')
    expect(speechErrorText()).not.toContain('(')
  })
})
