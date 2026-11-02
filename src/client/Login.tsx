import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import Brand from './Brand'

interface Props {
  onSubmit: (token: string) => Promise<boolean>
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
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-[var(--vscode-editor-background)] text-foreground">
      <Brand gradientId="login-brand" />
      <Label htmlFor="login-access-token" className="text-[13px] font-normal text-[var(--vscode-descriptionForeground)]">
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
        {error && <div role="alert" className="text-xs text-[var(--vscode-errorForeground)]">Token salah</div>}
      </form>
    </div>
  )
}
