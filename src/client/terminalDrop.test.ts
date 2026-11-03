import { describe, expect, it } from 'vitest'
import { PATH_DROP_MIME, isPathDrag, readDroppedPath } from './terminalDrop'

const dt = (data: Record<string, string>) => ({
  types: Object.keys(data),
  getData: (t: string) => data[t] ?? '',
})

describe('terminalDrop', () => {
  it('MIME ada: path dikembalikan apa adanya + satu spasi, tanpa newline', () => {
    const d = dt({ [PATH_DROP_MIME]: "'/a/b c.txt' '/x/it'\\''s'", 'text/plain': 'lain' })
    expect(isPathDrag(d)).toBe(true)
    expect(readDroppedPath(d)).toBe("'/a/b c.txt' '/x/it'\\''s' ")
  })

  it('MIME kosong atau cuma spasi: null', () => {
    expect(readDroppedPath(dt({ [PATH_DROP_MIME]: '' }))).toBeNull()
    expect(readDroppedPath(dt({ [PATH_DROP_MIME]: '  ' }))).toBeNull()
  })

  it('text/plain saja (sumber luar): bukan drag path, null', () => {
    const d = dt({ 'text/plain': 'rm -rf /' })
    expect(isPathDrag(d)).toBe(false)
    expect(readDroppedPath(d)).toBeNull()
  })
})
