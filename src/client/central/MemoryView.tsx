// Central's memory, read-only (shown in Settings › Memory below what agents remember). Values that look like secrets are never rendered (defense in depth:
// the server already redacts, this only guards a miss).
import { Button } from '@/components/ui/button'
import { CL } from './centralLabels'
import { centralControlApi } from './centralControlApi'
import type { CentralControlClient } from './centralControlTypes'
import { usePaged } from './centralLoad'
import './central.css'

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(sk|pk|ghp|gho|xox[bp]|AKIA)[-_A-Za-z0-9]{16,}/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\b(api[_-]?key|secret|token|password|passwd)\s*[:=]\s*\S{6,}/i,
  /\b[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9])/,
]

/** True when a memory value resembles a credential and must not be displayed. */
export function looksSecret(value: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(value))
}

export default function MemoryView({ client = centralControlApi }: { client?: CentralControlClient }) {
  const mem = usePaged((offset, signal) => client.listMemory(offset, signal))
  return (
    <section className="ccp-section" aria-labelledby="ccp-mem-h">
      <h3 id="ccp-mem-h">{CL.memoryHeading}</h3>
      <p>{CL.memoryIntro}</p>
      {mem.error && <p role="alert" className="ccp-error">{mem.error}</p>}
      {mem.loading && mem.items.length === 0 && <p role="status">{CL.loading}</p>}
      {!mem.loading && !mem.error && mem.items.length === 0 && <p>{CL.memoryEmpty}</p>}
      {mem.items.length > 0 && (
        <table className="ccp-table" aria-labelledby="ccp-mem-h">
          <thead><tr>
            <th scope="col">{CL.memoryKey}</th><th scope="col">{CL.memoryScope}</th><th scope="col">{CL.memoryTrust}</th>
            <th scope="col">{CL.memoryKind}</th><th scope="col">{CL.memoryValue}</th>
          </tr></thead>
          <tbody>
            {mem.items.map((m) => (
              <tr key={m.id}>
                <td>{m.key}</td><td>{m.scope}</td><td>{m.trust}</td><td>{m.kind}</td>
                <td>{looksSecret(m.value) || looksSecret(m.key) ? <em>{CL.secretMasked}</em> : m.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {mem.hasMore && <Button type="button" size="sm" variant="secondary" onClick={mem.loadMore}>{CL.loadMore}</Button>}
    </section>
  )
}
