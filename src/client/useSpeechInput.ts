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
  onerror: (() => void) | null
  start(): void
  stop(): void
}
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
 * Dikte sekali-ucap: mulai mengenali, kirim transcript ke `onTranscript`, lalu berhenti.
 * `continuous: false` + `interimResults: false` berarti satu ucapan menghasilkan tepat satu
 * kiriman — perilaku yang sama untuk node terminal maupun agent.
 */
export function useSpeechInput(onTranscript: (text: string) => void) {
  const [micActive, setMicActive] = useState(false)
  const recogRef = useRef<SpeechRecognitionLike | null>(null)

  const toggleMic = () => {
    if (micActive) { recogRef.current?.stop(); return }
    const SR = pickRecognition(window as unknown as Record<string, unknown>)
    if (!SR) return
    const recog = new SR()
    recog.continuous = false
    recog.interimResults = false
    recog.onresult = (e) => {
      const text = firstTranscript(e)
      if (text) onTranscript(text)
    }
    recog.onend = () => setMicActive(false)
    recog.onerror = () => setMicActive(false)
    recogRef.current = recog
    recog.start()
    setMicActive(true)
  }

  return { micActive, toggleMic }
}
