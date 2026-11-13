// Settings › Terminal › Look: one live sample of the terminal look (macOS Terminal profile preview,
// Warp). Plain DOM, no xterm: colors, font family, size, normal and bold weight, bold-in-bright, line
// height, letter spacing, cursor shape and blink. The blink honors `prefers-reduced-motion` (CSS).
import type { Settings } from '../shared/settings'
import { resolveTerminalTheme } from './themes'

const ANSI = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'] as const

type PreviewSettings = Pick<Settings, 'terminalTheme' | 'fontFamily' | 'fontSize' | 'fontWeight' | 'fontWeightBold'
  | 'drawBoldTextInBrightColors' | 'terminalLineHeight' | 'terminalLetterSpacing' | 'cursorStyle' | 'cursorBlink'>

/** A few lines drawn the way a terminal with these settings would draw them. */
export function TerminalPreview({ settings: s }: { settings: PreviewSettings }): React.JSX.Element {
  const t = resolveTerminalTheme(s.terminalTheme).theme
  const cursor = t.cursor ?? t.foreground
  return (
    <div className="st-terminal-preview" data-testid="terminal-preview" aria-hidden="true"
      style={{
        background: t.background, color: t.foreground, fontFamily: s.fontFamily, fontSize: s.fontSize,
        fontWeight: s.fontWeight, lineHeight: s.terminalLineHeight, letterSpacing: s.terminalLetterSpacing,
      }}>
      <div><span style={{ color: t.green }}>~/project</span> <span style={{ color: t.blue }}>main</span> $ ls</div>
      <div>{ANSI.map((c) => <span key={c} style={{ color: t[c], marginRight: '0.6em' }}>{c}</span>)}</div>
      <div>
        <span data-testid="terminal-preview-bold"
          style={{ fontWeight: s.fontWeightBold, color: s.drawBoldTextInBrightColors ? t.brightGreen : t.green }}>bold</span>
        {' '}normal $ <span data-testid="terminal-preview-cursor" data-cursor={s.cursorStyle}
          className={`st-tp-cursor st-tp-cursor--${s.cursorStyle}${s.cursorBlink ? ' st-tp-cursor--blink' : ''}`}
          style={{ '--st-tp-cursor': cursor } as React.CSSProperties}>{' '}</span>
      </div>
    </div>
  )
}
