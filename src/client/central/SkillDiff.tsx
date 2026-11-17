// Unified line diff of a skill text, shared by the review list and the edit form. Every changed line keeps its `+`/`-`
// prefix, so the change is readable without color; added/removed lines also carry a screen-reader prefix.
import { CL } from './centralLabels'
import { SD } from './skillDetail.labels'
import './skillDetail.css'

type Kind = 'add' | 'del' | 'hunk' | 'ctx'
const kindOf = (line: string): Kind => (line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx')

/** Marker for assistive tech; the visible `+`/`-` stays part of the line text. */
const srOf = (k: Kind): string | null => (k === 'add' ? SD.diffAdded : k === 'del' ? SD.diffRemoved : null)

export default function SkillDiff({ text, label = CL.skillDiff, lineNumbers = false }: { text: string; label?: string; lineNumbers?: boolean }) {
  return (
    <pre className="skd-diff" tabIndex={0} aria-label={label}>
      {text.split('\n').map((l, i) => {
        const k = kindOf(l)
        const sr = srOf(k)
        return (
          <span key={i} className={`skd-diff-line skd-diff-line--${k}`} data-diff={k}>
            {lineNumbers && <span className="skd-diff-no" aria-hidden="true">{i + 1}</span>}
            {sr && <span className="sr-only">{sr}: </span>}{l}{'\n'}
          </span>
        )
      })}
    </pre>
  )
}
