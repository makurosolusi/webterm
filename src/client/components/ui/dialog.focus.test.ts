// Radix focuses the dialog container programmatically (tabindex=-1). The unlayered global
// `:where([tabindex]):focus-visible` outline beats Tailwind's layered `outline-none`, so the whole
// dialog got boxed in blue. The important variant (`outline-none!`) wins over that unlayered rule.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('the shared dialog container hides its programmatic focus outline with an important utility', () => {
  const src = readFileSync(join(__dirname, 'dialog.tsx'), 'utf8')
  const content = src.slice(src.indexOf('function DialogContent'), src.indexOf('function DialogHeader'))
  expect(content).toMatch(/\boutline-none!/)
  expect(content).not.toMatch(/\boutline-none(?!!)\s/)
})
