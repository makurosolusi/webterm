import { describe, expect, it } from 'vitest'
import { findTooltipPolicyViolations } from './icon-button.policy'

const reasons = (src: string) => findTooltipPolicyViolations(src).map((v) => [v.line, v.reason])

describe('findTooltipPolicyViolations', () => {
  it('flags native titles and bare icon Buttons, with their line', () => {
    const src = [
      '<Button size="icon" onClick={() => go()} aria-label="Go">',
      '<button',
      '  type="button" title="Close">x</button>',
      '<IconButton label="Fine" size="icon" />',
      '<Button variant="ghost">Text</Button>',
    ].join('\n')
    expect(reasons(src)).toEqual([
      [1, 'bare-icon-button'],
      [2, 'native-title'],
    ])
  })

  it('reads past arrow functions inside the tag', () => {
    expect(findTooltipPolicyViolations('<button onClick={() => x()} title="Hi" />')).toHaveLength(1)
  })

  describe('icon-only buttons', () => {
    it.each([
      ['codicon() call', `<button type="button" aria-label="Run" onClick={() => run()}>{codicon('play')}</button>`],
      ['codicon() with a ternary', `<button aria-label="Lock">{codicon(locked ? 'lock' : 'unlock')}</button>`],
      ['codicon span', '<button aria-label="Close">\n  <span className="codicon codicon-close" aria-hidden="true" />\n</button>'],
      ['codicon template span', '<Button variant="ghost" aria-label="Go"><span className={`codicon codicon-${icon}`} /></Button>'],
      ['wrapper span around a glyph', `<button aria-label="Gear"><span className="x__icon" aria-hidden>{codicon('gear')}</span></button>`],
      ['inline svg', '<button aria-label="Dot"><svg viewBox="0 0 8 8"><circle r="4" /></svg></button>'],
      ['XxxIcon component', '<button aria-label="Kind"><KindIcon kind={k} /></button>'],
      ['lucide import', "import { X as CloseGlyph } from 'lucide-react'\n<button aria-label=\"Close\"><CloseGlyph size={14} /></button>"],
      ['JSX comment beside the glyph', `<button aria-label="Run">{/* play */}{codicon('play')}</button>`],
      ['Radix Trigger asChild without a tooltip', `<DropdownMenu.Trigger asChild>\n  <button aria-label="More">{codicon('kebab-vertical')}</button>\n</DropdownMenu.Trigger>`],
    ])('flags %s', (_name, src) => {
      expect(findTooltipPolicyViolations(src).map((v) => v.reason)).toEqual(['icon-only-button'])
    })

    it.each([
      ['visible text', `<button aria-label="Run">{codicon('play')} Run</button>`],
      ['text expression', `<button>{codicon('play')}{label}</button>`],
      ['conditional child', `<button>{busy ? <Spinner /> : codicon('play')}</button>`],
      ['ellipsis text', '<button aria-label="More">…</button>'],
      ['non-icon component', '<button><Badge count={2} /></button>'],
      ['self-closing', '<button aria-label="x" />'],
      ['wrapped in IconTooltip', `<IconTooltip label="Run" side="top">\n  <button aria-label="Run" onClick={() => run()}>{codicon('play')}</button>\n</IconTooltip>`],
      ['wrapped in VscodeTooltip', `<VscodeTooltip content={label}>\n  <button aria-label={label}><span className="codicon codicon-x" /></button>\n</VscodeTooltip>`],
      ['IconButton', `<IconButton label="Run">{codicon('play')}</IconButton>`],
      ['tooltip around a Radix Trigger asChild', `<IconTooltip label="Account">\n  <DropdownMenu.Trigger asChild disabled={off}>\n    <button aria-label="Account"><span className="codicon codicon-account" aria-hidden /></button>\n  </DropdownMenu.Trigger>\n</IconTooltip>`],
    ])('accepts %s', (_name, src) => {
      expect(findTooltipPolicyViolations(src)).toEqual([])
    })

    it('only exempts the button directly inside the tooltip, not a later sibling', () => {
      const src = [
        `<IconTooltip label="A"><button aria-label="A">{codicon('a')}</button></IconTooltip>`,
        `<button aria-label="B">{codicon('b')}</button>`,
      ].join('\n')
      expect(reasons(src)).toEqual([[2, 'icon-only-button']])
    })

    it('does not double-report a bare icon Button', () => {
      expect(reasons(`<Button size="icon-sm" aria-label="Go">{codicon('go')}</Button>`)).toEqual([[1, 'bare-icon-button']])
    })
  })
})
