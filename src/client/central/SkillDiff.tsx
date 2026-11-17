// Line diff of a skill text (`+`/`-` prefixed lines), shared by the review list and the edit form.
import { CL } from './centralLabels'

const diffClass = (line: string): string => (line.startsWith('+') ? 'ccp-diff--add' : line.startsWith('-') ? 'ccp-diff--del' : '')

export default function SkillDiff({ text, label = CL.skillDiff }: { text: string; label?: string }) {
  return (
    <pre className="ccp-diff" tabIndex={0} aria-label={label}>
      {text.split('\n').map((l, i) => <span key={i} className={diffClass(l)}>{l}{'\n'}</span>)}
    </pre>
  )
}
