import { useRef, useState } from 'react'

/**
 * Web Speech API belum ada di `lib.dom`, jadi bentuk minimal yang benar-benar dipakai
 * dideklarasikan di sini — satu tempat, tanpa `any` yang menyebar ke tiap node.
 */
interface SpeechRecognitionLike {
  continuous: boolean
  interimResults: boolean
  onresult: ((e: SpeechResultEventLike) => void) | null
  onend: (() => void) | null
  onerror: ((e: SpeechErrorEventLike) => void) | null
  start(): void
  stop(): void
}
/** Hanya `error` yang dipakai: ia kode mesin (`not-allowed`, `no-speech`, …) yang harus
 *  diterjemahkan sebelum diperlihatkan. */
export interface SpeechErrorEventLike { error?: string }
export interface SpeechResultEventLike {
  results?: ArrayLike<ArrayLike<{ transcript?: string }> | undefined>
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike

/**
 * Konstruktor yang tersedia, atau `undefined` di browser tanpa Web Speech.
 * Prefiks `webkit` didahulukan: Chrome/Safari hanya mengekspos yang itu, dan di browser yang
 * punya keduanya keduanya menunjuk implementasi yang sama.
 */
export function pickRecognition(w: Record<string, unknown>): SpeechRecognitionCtor | undefined {
  return (w.webkitSpeechRecognition ?? w.SpeechRecognition) as SpeechRecognitionCtor | undefined
}

/** Transcript alternatif terbaik dari hasil pertama; `undefined` kalau tidak ada yang terdengar. */
export function firstTranscript(e: SpeechResultEventLike): string | undefined {
  return e.results?.[0]?.[0]?.transcript || undefined
}

/**
 * Kalimat untuk kode error Web Speech. Kode mentahnya tidak berarti apa pun bagi pengguna, dan
 * kasus yang paling sering kena di webterm adalah ORIGIN: Web Speech menuntut secure context, jadi
 * membuka webterm lewat IP LAN di `http://` membuat izin mikrofon ditolak permanen — itu yang harus
 * disebut, bukan "error".
 */
export function speechErrorText(code?: string): string {
  if (code === 'not-allowed' || code === 'service-not-allowed')
    return 'Dictation blocked: allow microphone access for this page. Web Speech also needs a secure origin — localhost or https, not a plain-http LAN address.'
  if (code === 'no-speech') return 'Dictation heard nothing.'
  return `Dictation failed${code ? ` (${code})` : ''}.`
}

/**
 * Dikte sekali-ucap: mulai mengenali, kirim transcript ke `onTranscript`, lalu berhenti.
 * `continuous: false` + `interimResults: false` berarti satu ucapan menghasilkan tepat satu
 * kiriman — perilaku yang sama untuk node terminal maupun agent.
 *
 * `supported` DIKEMBALIKAN, bukan ditelan di dalam: tanpa itu pemanggil tetap merender tombol mic
 * di browser yang tidak punya Web Speech sama sekali, dan tombol itu bisu — tidak bisa dibedakan
 * pengguna dari tombol yang rusak. `onError` ada dengan alasan yang sama untuk kegagalan RUNTIME
 * (izin ditolak, `start()` melempar): ditelan berarti satu klik tanpa akibat apa pun.
 */
export function useSpeechInput(
  onTranscript: (text: string) => void,
  onError?: (message: string) => void,
) {
  const [micActive, setMicActive] = useState(false)
  const recogRef = useRef<SpeechRecognitionLike | null>(null)
  // Dibaca saat render, bukan di level modul: modul ini diimpor juga oleh vitest node-env, yang
  // tidak punya `window`.
  const SR = pickRecognition(window as unknown as Record<string, unknown>)

  const toggleMic = () => {
    if (micActive) { recogRef.current?.stop(); return }
    if (!SR) { onError?.('Dictation is not available in this browser.'); return }
    const recog = new SR()
    recog.continuous = false
    recog.interimResults = false
    recog.onresult = (e) => {
      const text = firstTranscript(e)
      if (text) onTranscript(text)
    }
    recog.onend = () => setMicActive(false)
    recog.onerror = (e) => { setMicActive(false); onError?.(speechErrorText(e?.error)) }
    recogRef.current = recog
    try {
      recog.start()
    } catch (err) {
      // `start()` melempar InvalidStateError bila pengenal sebelumnya belum benar-benar berhenti.
      // Tidak ditelan: `micActive` tetap false, jadi tanpa laporan ini kliknya tanpa jejak apa pun.
      onError?.(`Dictation could not start: ${String(err)}`)
      return
    }
    setMicActive(true)
  }

  return { micActive, toggleMic, supported: !!SR }
}
