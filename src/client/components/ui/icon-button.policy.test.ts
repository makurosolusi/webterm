import { describe, expect, it } from 'vitest'
import { findTooltipPolicyViolations } from './icon-button.policy'

describe('findTooltipPolicyViolations', () => {
  it('flags native titles and bare icon Buttons, with their line', () => {
    const src = [
      '<Button size="icon" onClick={() => go()} aria-label="Go">',
      '<button',
      '  type="button" title="Close">x</button>',
      '<IconButton label="Fine" size="icon" />',
      '<Button variant="ghost">Text</Button>',
    ].join('\n')
    expect(findTooltipPolicyViolations(src).map((v) => [v.line, v.reason])).toEqual([
      [1, 'bare-icon-button'],
      [2, 'native-title'],
    ])
  })

  it('reads past arrow functions inside the tag', () => {
    expect(findTooltipPolicyViolations('<button onClick={() => x()} title="Hi" />')).toHaveLength(1)
  })
})
