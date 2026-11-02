import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const dir = path.dirname(fileURLToPath(import.meta.url))

function loadCss(name: string) {
  const css = readFileSync(path.join(dir, name), 'utf8')
  return (selector: string): string => {
    const start = css.indexOf(`${selector} {`)
    if (start === -1) throw new Error(`expected CSS rule ${selector} in ${name}`)
    return css.slice(start, css.indexOf('}', start))
  }
}

describe('vscode-overlay.css metrics', () => {
  const block = loadCss('vscode-overlay.css')

  it('keeps dialog metrics and layering (monaco-dialog-box)', () => {
    expect(block('.vscode-dialog')).toContain('width: 480px')
    expect(block('.vscode-dialog')).toContain('padding: 8px')
    expect(block('.vscode-dialog')).toContain('border-radius: 5px')
    expect(block('.vscode-dialog')).toContain('0 0 8px 2px')
    expect(block('.vscode-dialog-backdrop')).toContain('z-index: 1100')
    expect(block('.vscode-dialog-backdrop')).toContain('rgba(0, 0, 0, 0.5)')
  })

  it('keeps popover and tooltip on the hover-widget metrics', () => {
    expect(block('.vscode-popover')).toContain('border-radius: 5px')
    expect(block('.vscode-popover')).toContain('--vscode-menu-background')
    expect(block('.vscode-tooltip')).toContain('z-index: 1400')
    expect(block('.vscode-tooltip')).toContain('max-width: 500px')
    expect(block('.vscode-tooltip')).toContain('padding: 4px 8px')
    expect(block('.vscode-tooltip')).toContain('border-radius: 3px')
    expect(block('.vscode-tooltip')).toContain('--vscode-editorHoverWidget-border')
    expect(block('.vscode-tooltip')).toContain('--vscode-editorHoverWidget-background')
  })
})

describe('vscode-menu.css metrics', () => {
  const block = loadCss('vscode-menu.css')

  it('keeps menu rows at 22px, a 2em icon column, a 160px minimum, and a 5px radius', () => {
    expect(block('.vscode-menu')).toContain('min-width: 160px')
    expect(block('.vscode-menu')).toContain('border-radius: 5px')
    expect(block('.vscode-menu__row')).toContain('height: 22px')
    expect(block('.vscode-menu__icon')).toContain('width: 2em')
    expect(block('.vscode-menu__separator')).toContain('height: 1px')
    expect(block('.vscode-menu__keybinding')).toContain('opacity: 0.7')
  })

  it('does not paint danger rows red', () => {
    const css = readFileSync(path.join(dir, 'vscode-menu.css'), 'utf8')
    expect(css).not.toContain('data-danger')
    expect(css).not.toContain('errorForeground')
  })
})

describe('vscode-notification.css metrics', () => {
  const block = loadCss('vscode-notification.css')

  it('stacks bottom-right above the 22px status bar with a 450px cap', () => {
    expect(block('.vscode-notification-stack')).toContain('width: 450px')
    expect(block('.vscode-notification-stack')).toContain('right: 3px')
    expect(block('.vscode-notification-stack')).toContain('bottom: calc(var(--vscode-statusBar-height, 22px) + 3px)')
    expect(block('.vscode-notification-stack')).toContain('z-index: 1300')
  })

  it('keeps the toast item metrics and the 2px progress bar', () => {
    expect(block('.vscode-notification')).toContain('border-radius: 4px')
    expect(block('.vscode-notification')).toContain('300ms ease-out')
    expect(block('.vscode-notification__main')).toContain('padding: 10px 5px')
    expect(block('.vscode-notification__text')).toContain('line-height: 22px')
    expect(block('.vscode-notification__action')).toContain('min-height: 24px')
    expect(block('.vscode-notification__progress')).toContain('height: 2px')
  })
})

describe('vscode-quick-pick.css metrics', () => {
  const block = loadCss('vscode-quick-pick.css')

  it('positions the quick pick 600px wide with 22px rows and 440px of visible list', () => {
    expect(block('.vscode-quick-pick')).toContain('width: 600px')
    expect(block('.vscode-quick-pick')).toContain('calc(var(--vscode-titlebar-height, 35px) + 6px)')
    expect(block('.vscode-quick-pick__input')).toContain('height: 24px')
    expect(block('.vscode-quick-pick__input')).toContain('margin: 6px 6px 6px 11px')
    expect(block('.vscode-quick-pick__item')).toContain('height: 22px')
    expect(block('.vscode-quick-pick__item')).toContain('border-radius: 3px')
    expect(block('.vscode-quick-pick__list')).toContain('max-height: 440px')
  })

  it('bolds the matched characters with the list highlight colour', () => {
    expect(block('.vscode-quick-pick__highlight')).toContain('font-weight: 700')
    expect(block('.vscode-quick-pick__highlight')).toContain('--vscode-list-highlightForeground')
  })
})
