// Skill instructions rendered by template section (`## Purpose`, `## Steps`, ...) instead of raw markdown. Unknown sections
// render as-is; nothing is dropped. Deliberately tiny: only headings, numbered/bulleted lists, `code` spans and paragraphs.
import { Button } from '@/components/ui/button'
import { Fragment, type ReactNode, useState } from 'react'
import { CL } from './centralLabels'
import { SD } from './skillDetail.labels'
import './skillDetail.css'

export interface Section { heading: string | null; lines: string[] }

/** Splits a body at its `## ` headings; text before the first one is a section without heading. */
export function parseSections(body: string): Section[] {
  const out: Section[] = []
  for (const line of body.split('\n')) {
    const m = /^##\s+(.*)$/.exec(line)
    if (m) out.push({ heading: m[1].trim(), lines: [] })
    else if (out.length === 0) out.push({ heading: null, lines: [line] })
    else out[out.length - 1].lines.push(line)
  }
  return out.filter((s) => s.heading !== null || s.lines.some((l) => l.trim() !== ''))
}

const inline = (text: string): ReactNode[] => text.split(/(`[^`]+`)/g).map((p, i) => (p.startsWith('`') && p.endsWith('`') && p.length > 2 ? <code key={i}>{p.slice(1, -1)}</code> : <Fragment key={i}>{p}</Fragment>))

type Block = { kind: 'ol' | 'ul'; items: string[] } | { kind: 'p'; text: string }
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/
const BULLET = /^\s*[-*]\s+(.*)$/

function blocksOf(lines: string[]): Block[] {
  const out: Block[] = []
  for (const line of lines) {
    const n = NUMBERED.exec(line)
    const b = n ? null : BULLET.exec(line)
    const last = out[out.length - 1]
    if (n || b) {
      const kind = n ? 'ol' : 'ul'
      const text = n ? `${n[1]}. ${n[2]}` : (b as RegExpExecArray)[1]
      if (last && last.kind === kind) last.items.push(text)
      else out.push({ kind, items: [text] })
    } else if (line.trim() === '') out.push({ kind: 'p', text: '' })
    else if (/^\s+\S/.test(line) && last && last.kind !== 'p') last.items[last.items.length - 1] += ` ${line.trim()}`
    else if (last && last.kind === 'p' && last.text !== '') last.text += `\n${line}`
    else out.push({ kind: 'p', text: line })
  }
  return out.filter((b) => b.kind !== 'p' || b.text !== '')
}

function Blocks({ lines }: { lines: string[] }) {
  return <>{blocksOf(lines).map((b, i) => (b.kind === 'p'
    ? <p key={i} className="skd-p">{inline(b.text)}</p>
    : b.kind === 'ol'
      ? <ol key={i} className="skd-ol">{b.items.map((t, j) => <li key={j}>{inline(t)}</li>)}</ol>
      : <ul key={i} className="skd-ul">{b.items.map((t, j) => <li key={j}>{inline(t)}</li>)}</ul>))}</>
}

const CLAMP_LINES = 30

/** Instructions of a skill, section by section; long ones are clamped with "Show all". */
export default function SkillContent({ body }: { body: string }) {
  const [all, setAll] = useState(false)
  const long = body.split('\n').length > CLAMP_LINES
  const sections = parseSections(body)
  return (
    <div>
      <div className={`skd-content${long && !all ? ' skd-content--clamped' : ''}`} role="region" tabIndex={0} aria-label={CL.skillInstructions}>
        {sections.map((s, i) => (
          <section key={i} className="skd-section">
            {(s.heading !== null || sections.length > 1) && <h5 className="skd-h">{s.heading ?? SD.sectionPreamble}</h5>}
            <Blocks lines={s.lines} />
          </section>
        ))}
      </div>
      {long && <Button type="button" size="xs" variant="link" aria-expanded={all} onClick={() => setAll(!all)}>{all ? SD.showLess : SD.showAll}</Button>}
    </div>
  )
}
