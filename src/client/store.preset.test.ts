import { expect, it } from 'vitest'
import { toFlow, toWsNode } from './store'
import type { WsNode } from '../shared/workspace'

it('a stored skill-author chat survives toFlow -> toWsNode (reload + save must not drop the lock)', () => {
  const n: WsNode = { id: 'c', kind: 'agentChat', x: 0, y: 0, preset: 'skill-author', presetTarget: 'webterm-foo' }
  const back = toWsNode(toFlow(n))
  expect(back.preset).toBe('skill-author')
  expect(back.presetTarget).toBe('webterm-foo')
  expect((toFlow(n).data as Partial<WsNode>).preset).toBe('skill-author')
})

it('a plain chat stays plain and junk preset values are not carried', () => {
  const back = toWsNode(toFlow({ id: 'p', kind: 'agentChat', x: 0, y: 0, preset: 'root' as never, presetTarget: 5 as never }))
  expect(back.preset).toBeUndefined()
  expect(back.presetTarget).toBeUndefined()
})
