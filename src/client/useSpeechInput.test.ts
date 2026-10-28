import { describe, it, expect } from 'vitest'
import { pickRecognition, firstTranscript } from './useSpeechInput'

describe('pickRecognition', () => {
  it('mendahulukan varian webkit saat keduanya ada', () => {
    const webkit = function () {} as unknown
    const std = function () {} as unknown
    expect(pickRecognition({ webkitSpeechRecognition: webkit, SpeechRecognition: std })).toBe(webkit)
  })
  it('jatuh ke nama standar bila tak ada varian webkit', () => {
    const std = function () {} as unknown
    expect(pickRecognition({ SpeechRecognition: std })).toBe(std)
  })
  it('undefined di browser tanpa Web Speech — pemanggil keluar tanpa melempar', () => {
    expect(pickRecognition({})).toBeUndefined()
  })
})

describe('firstTranscript', () => {
  it('mengambil alternatif pertama dari hasil pertama', () => {
    expect(firstTranscript({ results: [[{ transcript: 'buka file' }, { transcript: 'buka vile' }]] }))
      .toBe('buka file')
  })
  it('undefined bila tak ada hasil sama sekali', () => {
    expect(firstTranscript({})).toBeUndefined()
    expect(firstTranscript({ results: [] })).toBeUndefined()
  })
  it('transcript kosong dianggap tak ada — jangan kirim input kosong ke PTY', () => {
    expect(firstTranscript({ results: [[{ transcript: '' }]] })).toBeUndefined()
    expect(firstTranscript({ results: [undefined] })).toBeUndefined()
  })
})
