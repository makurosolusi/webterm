import { useState } from 'react'

interface Props {
  onSubmit: (token: string) => Promise<boolean>
}

const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace'

function Brand() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <svg width={40} height={40} viewBox="0 0 48 48" aria-hidden>
        <defs>
          <linearGradient id="login-brand" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#a38dff" />
            <stop offset="1" stopColor="#622994" />
          </linearGradient>
        </defs>
        <path d="M13 12 L31 24 L13 36" fill="none" stroke="url(#login-brand)" strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" />
        <circle cx={13} cy={12} r={3.6} fill="#a38dff" />
        <circle cx={13} cy={36} r={3.6} fill="#a38dff" />
        <circle cx={31} cy={24} r={3.6} fill="#fff" />
        <rect x={33.5} y={32.5} width={10.5} height={5} rx={2.5} fill="#a38dff" />
      </svg>
      <span style={{ fontSize: 30, fontWeight: 800, letterSpacing: -0.5 }}>webterm</span>
    </div>
  )
}

export default function Login({ onSubmit }: Props) {
  const [value, setValue] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!value || pending) return
    setPending(true)
    setError(false)
    const ok = await onSubmit(value)
    if (!ok) {
      setError(true)
      setPending(false)
    }
    // ok === true: keep disabled; App reloads the page.
  }

  return (
    <div style={{ position: 'absolute', inset: 0, background: 'var(--canvas-bg)', color: 'var(--text)', fontFamily: mono, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 20 }}>
      <Brand />
      <div style={{ color: 'var(--muted)', fontSize: 13 }}>Enter your access token</div>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
        <input
          className="field"
          type="password"
          aria-label="Access token"
          autoFocus
          placeholder="access token"
          value={value}
          disabled={pending}
          onChange={(e) => setValue(e.target.value)}
          style={{ fontFamily: mono, textAlign: 'center', width: 260 }}
        />
        <button className="btn btn--accent" type="submit" disabled={pending}>
          Unlock
        </button>
        {error && <div style={{ color: '#ff6b6b', fontSize: 12 }}>Token salah</div>}
      </form>
    </div>
  )
}
