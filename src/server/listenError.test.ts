import { describe, expect, it } from 'vitest'
import { describeListenError, isKnownListenError } from './listenError'

const err = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`listen ${code}`), { code })

describe('describeListenError', () => {
  it('EADDRINUSE menyebut port dan cara keluarnya', () => {
    const msg = describeListenError(err('EADDRINUSE'), '127.0.0.1', 8700)
    expect(msg).toContain('port 8700 on 127.0.0.1 is already in use')
    expect(msg).toContain('PORT')
  })

  it('EACCES menyebut izin dan port yang lebih tinggi', () => {
    const msg = describeListenError(err('EACCES'), '0.0.0.0', 80)
    expect(msg).toContain('permission denied to listen on 0.0.0.0:80')
  })

  it('EADDRNOTAVAIL menyebut alamat dan HOST', () => {
    const msg = describeListenError(err('EADDRNOTAVAIL'), '10.9.9.9', 8700)
    expect(msg).toContain('address 10.9.9.9 is not available')
    expect(msg).toContain('HOST')
  })

  it('tanpa stack mentah pada pesan', () => {
    for (const code of ['EADDRINUSE', 'EACCES', 'EADDRNOTAVAIL']) {
      expect(describeListenError(err(code), 'h', 1)).not.toMatch(/\n\s+at /)
    }
  })

  it('kode asing jatuh ke bentuk generik dengan kodenya', () => {
    expect(describeListenError(err('EMFILE'), 'h', 5)).toContain('listen on h:5 failed (EMFILE)')
  })
})

describe('isKnownListenError', () => {
  it('benar hanya untuk tiga kode yang punya pesan ramah', () => {
    expect(['EADDRINUSE', 'EACCES', 'EADDRNOTAVAIL'].every((c) => isKnownListenError(err(c)))).toBe(true)
    expect(isKnownListenError(err('EMFILE'))).toBe(false)
    expect(isKnownListenError(new Error('x'))).toBe(false)
    expect(isKnownListenError(null)).toBe(false)
  })
})
