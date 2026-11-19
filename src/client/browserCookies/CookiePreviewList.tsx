// Step 2: the sites found in the file (domain + cookie count only, never a name or value). Importable sites are
// ticked by default; blocked sites stay visible with the reason inline instead of failing the whole import.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import type { CookiePreviewResp } from '../../shared/browser.contract'
import { CI } from './cookieImport.text'

/** Show a filter box above this many sites. */
const FILTER_MIN_SITES = 8

export const pickedCookieCount = (p: CookiePreviewResp, picked: ReadonlySet<string>): number =>
  p.domains.reduce((n, d) => n + (picked.has(d.domain) ? d.count : 0), 0)

export default function CookiePreviewList({ preview, picked, onPicked, disabled }: {
  preview: CookiePreviewResp
  picked: ReadonlySet<string>
  onPicked: (next: ReadonlySet<string>) => void
  disabled: boolean
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const rows = preview.domains.filter((d) => d.domain.includes(q))
  const blocked = (preview.blocked ?? []).filter((b) => b.domain.includes(q))
  const toggle = (domain: string, on: boolean): void => { const n = new Set(picked); if (on) n.add(domain); else n.delete(domain); onPicked(n) }
  const setVisible = (on: boolean): void => { const n = new Set(picked); for (const d of rows) { if (on) n.add(d.domain); else n.delete(d.domain) } onPicked(n) }
  const total = preview.domains.length + (preview.blocked?.length ?? 0)
  return (
    <section aria-labelledby="cookie-preview-h" className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <h3 id="cookie-preview-h" className="m-0 text-[length:var(--bui-font)] font-semibold">{CI.preview.heading}</h3>
        <span role="status" className="text-[length:var(--bui-font-sm)] text-(--vscode-descriptionForeground)">
          {CI.preview.summary(pickedCookieCount(preview, picked), picked.size)}
        </span>
      </div>
      {preview.domains.length === 0 && <p className="m-0 text-[length:var(--bui-font-sm)] text-(--vscode-descriptionForeground)">{CI.preview.nothing}</p>}
      {total > FILTER_MIN_SITES && <Input type="search" aria-label={CI.preview.filter} placeholder={CI.preview.filter} value={query} onChange={(e) => setQuery(e.target.value)} />}
      {preview.domains.length > 0 && (
        <div className="flex gap-1">
          <Button type="button" variant="link" size="bui" disabled={disabled} onClick={() => setVisible(true)}>{CI.preview.selectAll}</Button>
          <Button type="button" variant="link" size="bui" disabled={disabled} onClick={() => setVisible(false)}>{CI.preview.selectNone}</Button>
        </div>
      )}
      <ul className="m-0 flex max-h-[200px] list-none flex-col overflow-y-auto p-0" data-slot="cookie-sites">
        {rows.map((d) => (
          <li key={d.domain}>
            <label className="flex min-h-(--bui-hit) cursor-default items-center gap-2 px-1 text-[length:var(--bui-font)] hover:bg-(--vscode-list-hoverBackground)">
              <Checkbox aria-label={CI.preview.pick(d.domain)} checked={picked.has(d.domain)} disabled={disabled} onCheckedChange={(v) => toggle(d.domain, v === true)} />
              <span className="min-w-0 flex-1 truncate">{d.domain}</span>
              <span className="text-[length:var(--bui-font-sm)] text-(--vscode-descriptionForeground)">{CI.preview.count(d.count)}{d.hasSession ? ` · ${CI.preview.session}` : ''}</span>
            </label>
          </li>
        ))}
        {blocked.map((b) => (
          <li key={b.domain} className="flex min-h-(--bui-hit) flex-col justify-center px-1 py-1 text-[length:var(--bui-font)]" data-blocked="">
            <span className="flex items-center gap-2"><Checkbox aria-label={CI.preview.pick(b.domain)} checked={false} disabled /><span className="min-w-0 flex-1 truncate">{b.domain}</span>
              <span className="text-[length:var(--bui-font-sm)] text-(--vscode-descriptionForeground)">{CI.preview.count(b.count)}</span></span>
            <span className="pl-[26px] text-[length:var(--bui-font-sm)] text-(--vscode-descriptionForeground)">{CI.preview.blocked[b.reason] ?? b.reason}</span>
          </li>
        ))}
        {rows.length === 0 && blocked.length === 0 && total > 0 && <li className="px-1 py-2 text-[length:var(--bui-font-sm)] text-(--vscode-descriptionForeground)">{CI.preview.noMatch}</li>}
      </ul>
    </section>
  )
}
