import { describe, expect, it } from 'vitest'
import {
  SHIFT_ENTER_SEQ,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  isCleanViewChord,
  isCopyShortcut,
  isPasteShortcut,
  nextTerminalFontSize,
  optionArrowSeq,
  suppressMiddleClickPaste,
  terminalFontZoomChord,
  terminalKeyAction,
  xtermOwnsMouseDown,
  type TerminalKeyEvent,
} from './terminalKeys'

const MAC = { isMac: true, isWindows: false }
const LINUX = { isMac: false, isWindows: false }
const WIN = { isMac: false, isWindows: true }

function key(partial: Partial<TerminalKeyEvent> & { key: string }): TerminalKeyEvent {
  return {
    type: 'keydown',
    code: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...partial,
  }
}

describe('isCopyShortcut', () => {
  it('accepts the per-platform copy chords', () => {
    expect(isCopyShortcut(key({ key: 'c', code: 'KeyC', metaKey: true }))).toBe(true)
    expect(isCopyShortcut(key({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true }))).toBe(true)
    expect(isCopyShortcut(key({ key: 'Insert', code: 'Insert', ctrlKey: true }))).toBe(true)
  })

  it('leaves plain Ctrl+C alone so SIGINT still reaches the PTY', () => {
    expect(isCopyShortcut(key({ key: 'c', code: 'KeyC', ctrlKey: true }))).toBe(false)
  })

  it('falls back to the physical key on non-Latin layouts', () => {
    // Di layout Cyrillic `e.key` adalah 'с', jadi tanpa fallback `e.code` seleksi xterm tidak
    // punya copy keyboard sama sekali (menu Edit browser hanya menyalin seleksi DOM).
    expect(isCopyShortcut(key({ key: 'с', code: 'KeyC', metaKey: true }))).toBe(true)
  })

  it('ignores AltGr combos, keyup and Shift+Insert', () => {
    expect(isCopyShortcut(key({ key: 'c', code: 'KeyC', ctrlKey: true, altKey: true }))).toBe(false)
    expect(isCopyShortcut(key({ key: 'c', code: 'KeyC', metaKey: true, type: 'keyup' }))).toBe(false)
    // Shift+Insert = paste, bukan milik kita.
    expect(isCopyShortcut(key({ key: 'Insert', code: 'Insert', shiftKey: true }))).toBe(false)
  })
})

describe('isPasteShortcut', () => {
  it('claims Ctrl+V on Windows only', () => {
    const e = key({ key: 'v', code: 'KeyV', ctrlKey: true })
    // Di Windows xterm memetakan Ctrl+V ke \x16 DENGAN cancel:true, yang menekan perintah paste
    // browser — hasilnya tidak ada yang di-paste dan tidak ada yang diketik.
    expect(isPasteShortcut(e, true)).toBe(true)
    // Di macOS ⌘V yang mem-paste dan Ctrl+V harus tetap \x16; di Linux konvensinya Ctrl+Shift+V.
    expect(isPasteShortcut(e, false)).toBe(false)
  })

  it('ignores Ctrl+Shift+V, which xterm already passes through', () => {
    expect(isPasteShortcut(key({ key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true }), true))
      .toBe(false)
  })
})

describe('optionArrowSeq', () => {
  it('maps Option+Left/Right on macOS to word-back/word-forward', () => {
    expect(optionArrowSeq(key({ key: 'ArrowLeft', altKey: true }), true)).toBe('\x1bb')
    expect(optionArrowSeq(key({ key: 'ArrowRight', altKey: true }), true)).toBe('\x1bf')
  })

  it('does nothing off macOS', () => {
    expect(optionArrowSeq(key({ key: 'ArrowLeft', altKey: true }), false)).toBeNull()
  })

  it('ignores extra modifiers, plain arrows, keyup and other arrows', () => {
    expect(optionArrowSeq(key({ key: 'ArrowLeft', altKey: true, shiftKey: true }), true)).toBeNull()
    expect(optionArrowSeq(key({ key: 'ArrowLeft', altKey: true, ctrlKey: true }), true)).toBeNull()
    expect(optionArrowSeq(key({ key: 'ArrowLeft', altKey: true, metaKey: true }), true)).toBeNull()
    expect(optionArrowSeq(key({ key: 'ArrowLeft' }), true)).toBeNull()
    expect(optionArrowSeq(key({ key: 'ArrowLeft', altKey: true, type: 'keyup' }), true)).toBeNull()
    expect(optionArrowSeq(key({ key: 'ArrowUp', altKey: true }), true)).toBeNull()
  })
})

describe('isCleanViewChord', () => {
  it('claims the platform primary modifier with Period', () => {
    expect(isCleanViewChord(key({ key: '.', code: 'Period', metaKey: true }), true)).toBe(true)
    expect(isCleanViewChord(key({ key: '.', code: 'Period', ctrlKey: true }), false)).toBe(true)
  })

  it('rejects the other platform modifier, extra modifiers and keyup', () => {
    // Ctrl+. di macOS bukan chord app — ia tombol yang dikirim orang ke shell.
    expect(isCleanViewChord(key({ key: '.', code: 'Period', ctrlKey: true }), true)).toBe(false)
    expect(isCleanViewChord(key({ key: '.', code: 'Period', metaKey: true }), false)).toBe(false)
    expect(isCleanViewChord(key({ key: '.', code: 'Period' }), true)).toBe(false)
    expect(isCleanViewChord(key({ key: '>', code: 'Period', metaKey: true, shiftKey: true }), true))
      .toBe(false)
    expect(isCleanViewChord(key({ key: '.', code: 'Period', metaKey: true, altKey: true }), true))
      .toBe(false)
    expect(isCleanViewChord(key({ key: '.', code: 'Period', metaKey: true, type: 'keyup' }), true))
      .toBe(false)
  })
})

describe('terminalKeyAction', () => {
  it('maps Shift+Enter to the newline sequence', () => {
    expect(terminalKeyAction(key({ key: 'Enter', shiftKey: true }), 'app-first', MAC))
      .toBe('shift-enter')
    expect(SHIFT_ENTER_SEQ).toBe('\x1b\r')
  })

  it('leaves plain and modified Enter to xterm', () => {
    expect(terminalKeyAction(key({ key: 'Enter' }), 'app-first', MAC)).toBe('pass')
    expect(terminalKeyAction(key({ key: 'Enter', shiftKey: true, metaKey: true }), 'app-first', MAC))
      .toBe('pass')
  })

  it('keeps the terminal-owned chords under either policy', () => {
    const copy = key({ key: 'c', code: 'KeyC', metaKey: true })
    expect(terminalKeyAction(copy, 'app-first', MAC)).toBe('copy')
    expect(terminalKeyAction(copy, 'terminal-first', MAC)).toBe('copy')
    const enter = key({ key: 'Enter', shiftKey: true })
    expect(terminalKeyAction(enter, 'terminal-first', MAC)).toBe('shift-enter')
  })

  it('routes the Windows paste chord to the browser', () => {
    expect(terminalKeyAction(key({ key: 'v', code: 'KeyV', ctrlKey: true }), 'app-first', WIN))
      .toBe('native')
  })

  it('gates app chords on the policy', () => {
    const cmd1 = key({ key: '1', code: 'Digit1', metaKey: true })
    expect(terminalKeyAction(cmd1, 'app-first', MAC)).toBe('bubble')
    expect(terminalKeyAction(cmd1, 'terminal-first', MAC)).toBe('pass')
    const ctrl0 = key({ key: '0', code: 'Digit0', ctrlKey: true })
    expect(terminalKeyAction(ctrl0, 'app-first', LINUX)).toBe('bubble')
    expect(terminalKeyAction(ctrl0, 'terminal-first', LINUX)).toBe('pass')
  })

  it('bubbles the clean-view escape chord under EITHER policy', () => {
    // Satu-satunya chord yang `terminal-first` tidak boleh matikan: tanpa chrome, mematikannya
    // mengunci pengguna di clean view.
    const cmdPeriod = key({ key: '.', code: 'Period', metaKey: true })
    expect(terminalKeyAction(cmdPeriod, 'app-first', MAC)).toBe('bubble')
    expect(terminalKeyAction(cmdPeriod, 'terminal-first', MAC)).toBe('bubble')
    const ctrlPeriod = key({ key: '.', code: 'Period', ctrlKey: true })
    expect(terminalKeyAction(ctrlPeriod, 'app-first', LINUX)).toBe('bubble')
    expect(terminalKeyAction(ctrlPeriod, 'terminal-first', LINUX)).toBe('bubble')
  })

  it('leaves the wrong-platform, modified and released Period to the PTY', () => {
    expect(terminalKeyAction(key({ key: '.', code: 'Period', ctrlKey: true }), 'app-first', MAC))
      .toBe('pass')
    expect(terminalKeyAction(key({ key: '.', code: 'Period', metaKey: true }), 'app-first', LINUX))
      .toBe('pass')
    expect(
      terminalKeyAction(key({ key: '>', code: 'Period', metaKey: true, shiftKey: true }), 'app-first', MAC),
    ).toBe('pass')
    expect(
      terminalKeyAction(key({ key: '.', code: 'Period', metaKey: true, altKey: true }), 'app-first', MAC),
    ).toBe('pass')
    expect(
      terminalKeyAction(key({ key: '.', code: 'Period', metaKey: true, type: 'keyup' }), 'app-first', MAC),
    ).toBe('pass')
  })

  it('uses the primary modifier of the platform, not both', () => {
    // Ctrl+1 di macOS bukan chord app — ia tombol yang dikirim orang ke shell.
    expect(terminalKeyAction(key({ key: '1', code: 'Digit1', ctrlKey: true }), 'app-first', MAC))
      .toBe('pass')
    expect(terminalKeyAction(key({ key: '1', code: 'Digit1', metaKey: true }), 'app-first', LINUX))
      .toBe('pass')
  })

  it('leaves Shift+digit and ordinary typing to the PTY', () => {
    expect(
      terminalKeyAction(key({ key: '!', code: 'Digit1', metaKey: true, shiftKey: true }), 'app-first', MAC),
    ).toBe('pass')
    expect(terminalKeyAction(key({ key: 'a', code: 'KeyA' }), 'app-first', MAC)).toBe('pass')
    expect(terminalKeyAction(key({ key: 'c', code: 'KeyC', ctrlKey: true }), 'app-first', LINUX))
      .toBe('pass')
  })
})

describe('terminalFontZoomChord', () => {
  it('recognises grow, shrink and reset on the primary modifier', () => {
    expect(terminalFontZoomChord(key({ key: '+', metaKey: true }), true)).toBe('increase')
    expect(terminalFontZoomChord(key({ key: '=', metaKey: true }), true)).toBe('increase')
    expect(terminalFontZoomChord(key({ key: '-', metaKey: true }), true)).toBe('decrease')
    expect(terminalFontZoomChord(key({ key: '0', code: 'Digit0', metaKey: true }), true)).toBe('reset')
    expect(terminalFontZoomChord(key({ key: '-', ctrlKey: true }), false)).toBe('decrease')
  })

  it('accepts Shift for + and - but not for reset', () => {
    // Tombol berlabel + di layout US adalah ⇧=, jadi Shift tidak boleh dibatasi di sana; ⌘⇧0
    // sebaliknya chord lain.
    expect(terminalFontZoomChord(key({ key: '+', metaKey: true, shiftKey: true }), true))
      .toBe('increase')
    expect(terminalFontZoomChord(key({ key: '0', code: 'Digit0', metaKey: true, shiftKey: true }), true))
      .toBe(null)
  })

  it('needs the platform primary modifier and no Alt', () => {
    expect(terminalFontZoomChord(key({ key: '-', ctrlKey: true }), true)).toBe(null)
    expect(terminalFontZoomChord(key({ key: '-', metaKey: true }), false)).toBe(null)
    expect(terminalFontZoomChord(key({ key: '-' }), true)).toBe(null)
    expect(terminalFontZoomChord(key({ key: '-', metaKey: true, altKey: true }), true)).toBe(null)
    expect(terminalFontZoomChord(key({ key: '-', metaKey: true, type: 'keyup' }), true)).toBe(null)
  })

  it('only counts numpad 0 while it types a zero', () => {
    // Dengan Num Lock off tombol itu Insert — dan Ctrl+Insert adalah chord COPY.
    expect(terminalFontZoomChord(key({ key: '0', code: 'Numpad0', metaKey: true }), true)).toBe('reset')
    expect(terminalFontZoomChord(key({ key: 'Insert', code: 'Numpad0', metaKey: true }), true)).toBe(null)
  })
})

describe('nextTerminalFontSize', () => {
  it('steps from the effective size by one', () => {
    expect(nextTerminalFontSize('increase', undefined, 13)).toBe(14)
    expect(nextTerminalFontSize('decrease', undefined, 13)).toBe(12)
    expect(nextTerminalFontSize('increase', 20, 13)).toBe(21)
  })

  it('drops the override when it lands back on the global size', () => {
    // Supaya terminal yang dinaikkan lalu diturunkan kembali ikut perubahan global berikutnya.
    expect(nextTerminalFontSize('decrease', 14, 13)).toBeUndefined()
    expect(nextTerminalFontSize('reset', 20, 13)).toBeUndefined()
    expect(nextTerminalFontSize('reset', undefined, 13)).toBeUndefined()
  })

  it('no-ops at the bounds instead of jumping', () => {
    expect(nextTerminalFontSize('increase', TERMINAL_FONT_SIZE_MAX, 13)).toBe(TERMINAL_FONT_SIZE_MAX)
    expect(nextTerminalFontSize('decrease', TERMINAL_FONT_SIZE_MIN, 13)).toBe(TERMINAL_FONT_SIZE_MIN)
  })

  it('never moves a hand-edited out-of-range size the wrong way', () => {
    // ⌘+ tidak boleh MENGECILKAN terminal yang ukuran globalnya diedit di atas maksimum.
    expect(nextTerminalFontSize('increase', undefined, 40)).toBeUndefined()
    expect(nextTerminalFontSize('decrease', undefined, 4)).toBeUndefined()
  })
})

describe('mouse', () => {
  it('suppresses the middle button only while paste is disabled', () => {
    expect(suppressMiddleClickPaste(1, false)).toBe(true)
    expect(suppressMiddleClickPaste(1, true)).toBe(false)
    expect(suppressMiddleClickPaste(0, false)).toBe(false)
    expect(suppressMiddleClickPaste(2, false)).toBe(false)
  })

  it('claims primary drags for selection while nothing tracks the mouse', () => {
    const down = { button: 0, altKey: false, shiftKey: false }
    expect(xtermOwnsMouseDown(down, 'none', { isMac: true, optionForces: true })).toBe(true)
    expect(xtermOwnsMouseDown({ ...down, button: 1 }, 'none', { isMac: true, optionForces: true }))
      .toBe(false)
  })

  it('needs the forcing modifier while an app tracks the mouse', () => {
    // Di dalam vim/htop drag biasa adalah milik app; Option (mac) / Shift memaksa seleksi.
    const plain = { button: 0, altKey: false, shiftKey: false }
    expect(xtermOwnsMouseDown(plain, 'any', { isMac: true, optionForces: true })).toBe(false)
    expect(
      xtermOwnsMouseDown({ ...plain, altKey: true }, 'any', { isMac: true, optionForces: true }),
    ).toBe(true)
    expect(
      xtermOwnsMouseDown({ ...plain, altKey: true }, 'any', { isMac: true, optionForces: false }),
    ).toBe(false)
    expect(xtermOwnsMouseDown({ ...plain, shiftKey: true }, 'any', { isMac: false, optionForces: false }))
      .toBe(true)
    expect(xtermOwnsMouseDown({ ...plain, altKey: true }, 'any', { isMac: false, optionForces: false }))
      .toBe(false)
  })
})
