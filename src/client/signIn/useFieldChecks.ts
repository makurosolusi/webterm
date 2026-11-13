// When the sign-in and setup forms show a field's inline error: after the user typed into it and
// left it (blur), or after a submit. The errors themselves are computed live by the form, so a fix
// clears its error at once. On submit the first invalid field (in `order`) takes focus.
import { useRef, useState } from 'react'

export function useFieldChecks<K extends string>(errors: Record<K, string | null>, order: readonly K[]) {
  const [left, setLeft] = useState<ReadonlySet<K>>(() => new Set())
  const [submitted, setSubmitted] = useState(false)
  const inputs = useRef<Partial<Record<K, HTMLInputElement | null>>>({})
  return {
    /** The error to render for `k`, or null while it should stay quiet. */
    shown: (k: K): string | null => (submitted || left.has(k) ? errors[k] : null),
    /** Blur handler; an untouched empty field stays quiet until submit. */
    blur: (k: K, value: string) => (): void => {
      if (value !== '' && !left.has(k)) setLeft(new Set(left).add(k))
    },
    ref: (k: K) => (el: HTMLInputElement | null): void => { inputs.current[k] = el },
    /** Shows every error and focuses the first invalid field; true when the form may be sent. */
    validate: (): boolean => {
      setSubmitted(true)
      const first = order.find((k) => errors[k] !== null)
      if (first !== undefined) inputs.current[first]?.focus()
      return first === undefined
    },
  }
}
