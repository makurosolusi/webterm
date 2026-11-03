import { describe, expect, it } from 'vitest'
import { toFlow, toWsNode } from './store'
import type { WsNode } from '../shared/workspace'

describe('store viewOpts (P-15)', () => {
  it('round-trips viewOpts pada node files', () => {
    const n: WsNode = { id: 'f', kind: 'files', x: 0, y: 0, dirPath: '/w', viewOpts: { hidden: true, sortKey: 'mtime', sortDir: 'desc' } }
    expect(toWsNode(toFlow(n)).viewOpts).toEqual({ hidden: true, sortKey: 'mtime', sortDir: 'desc' })
  })

  it('absen tetap absen (board lama termuat = default)', () => {
    const back = toWsNode(toFlow({ id: 'f', kind: 'files', x: 0, y: 0, dirPath: '/w' }))
    expect(back.viewOpts).toBeUndefined()
    expect('viewOpts' in JSON.parse(JSON.stringify(back))).toBe(false)
  })
})
