import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface Props {
  onSubmit: (token: string) => Promise<boolean>
}

function Brand() {
  return (
    <div className="flex items-center gap-3">
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
      <span className="text-[30px] font-extrabold tracking-[-0.5px]">webterm</span>
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
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-[var(--canvas-bg)] font-mono text-foreground">
      <Brand />
      <Label htmlFor="login-access-token" className="text-[13px] font-normal text-muted-foreground">
        Enter your access token
      </Label>
      <form onSubmit={submit} className="flex flex-col items-center gap-2.5">
        <Input
          id="login-access-token"
          className="h-auto w-[260px] text-center focus-visible:ring-0"
          type="password"
          aria-label="Access token"
          autoFocus
          placeholder="access token"
          value={value}
          disabled={pending}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button type="submit" disabled={pending}>
          Unlock
        </Button>
        {error && <div className="text-xs text-destructive">Token salah</div>}
      </form>
    </div>
  )
}
