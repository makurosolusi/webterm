// AskUserQuestion form (PLAN/AGENT-CHAT.md D8): 1–4 questions of 2–4 options, single or multi
// select, plus "Other" free text. The answer goes back as `updatedInput.answers`, keyed by question
// text; multi-select answers are comma-separated (sdk-tools.d.ts AskUserQuestionOutput.answers).
import { useId, useState, type ReactNode } from 'react'
import { RadioGroup } from 'radix-ui'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { PermissionCardProps } from './agentChatCards.types'
import { AnswerError, ResolvedBadge, Spinner, useAnswerAction } from './permissionCard'
import { rec, str } from './toolCards'
import './agentChatCards.css'

/** Separator Claude Code uses between the labels of a multi-select answer. */
export const MULTI_ANSWER_SEPARATOR = ', '

export interface Question { question: string; header: string; multiSelect: boolean; options: { label: string; description: string }[] }
interface Choice { picked: string[]; other: boolean; otherText: string }
const EMPTY: Choice = { picked: [], other: false, otherText: '' }

/** Questions of an AskUserQuestion input, dropping malformed entries. */
export function parseQuestions(input: unknown): Question[] {
  const qs = rec(input).questions
  if (!Array.isArray(qs)) return []
  return qs.map(rec).filter((q) => str(q.question) !== '').map((q) => ({
    question: str(q.question),
    header: str(q.header),
    multiSelect: q.multiSelect === true,
    options: (Array.isArray(q.options) ? q.options : []).map(rec).map((o) => ({ label: str(o.label), description: str(o.description) })),
  }))
}

/** Answer text of one question: the picked labels (plus Other text), '' when unanswered. */
export function answerOf(q: Question, c: Choice): string {
  const other = c.other ? c.otherText.trim() : ''
  if (!q.multiSelect) return c.other ? other : c.picked[0] ?? ''
  const labels = q.options.map((o) => o.label).filter((l) => c.picked.includes(l))
  return [...labels, ...(other ? [other] : [])].join(MULTI_ANSWER_SEPARATOR)
}

/** Value of the "Other" radio; never a real label (the SDK forbids an "Other" option). */
const OTHER = '\u0000other'

/** One labelled choice row; `children` is the Checkbox or Radio carrying the same `id`. */
export function ChoiceRow({ id, label, description, children }: { id: string; label: string; description?: string; children: ReactNode }) {
  return (
    <div className="acc-option">
      {children}
      <Label htmlFor={id} className="acc-option__label">{label}</Label>
      {description && <span className="acc-muted">{description}</span>}
    </div>
  )
}

// No shadcn radio-group primitive exists in components/ui; the Radix one ships in the installed
// `radix-ui` package, styled like the shadcn Checkbox (agentChatCards.css .acc-radio).
export function Radio({ id, value, disabled }: { id: string; value: string; disabled?: boolean }) {
  return <RadioGroup.Item id={id} value={value} disabled={disabled} className="acc-radio"><RadioGroup.Indicator className="acc-radio__dot" /></RadioGroup.Item>
}

function QuestionField({ q, choice, set, disabled }: { q: Question; choice: Choice; set: (c: Choice) => void; disabled: boolean }) {
  const base = useId()
  const id = (k: number | 'other') => `${base}-${k}`
  const toggle = (label: string) => set({ ...choice, picked: choice.picked.includes(label) ? choice.picked.filter((l) => l !== label) : [...choice.picked, label] })
  const rows = [...q.options.map((o, k) => ({ id: id(k), value: o.label, label: o.label, description: o.description })), { id: id('other'), value: OTHER, label: 'Other', description: '' }]
  return (
    <fieldset className="acc-question" disabled={disabled}>
      <legend className="acc-question__legend">
        {q.header && <span className="acc-badge">{q.header}</span>}
        <span>{q.question}</span>
      </legend>
      {q.multiSelect
        ? rows.map((r) => (
            <ChoiceRow key={r.id} {...r}>
              <Checkbox id={r.id} disabled={disabled} checked={r.value === OTHER ? choice.other : choice.picked.includes(r.value)}
                onCheckedChange={() => (r.value === OTHER ? set({ ...choice, other: !choice.other }) : toggle(r.value))} />
            </ChoiceRow>
          ))
        : (
            <RadioGroup.Root className="acc-question" aria-label={q.question} disabled={disabled}
              value={choice.other ? OTHER : choice.picked[0] ?? ''}
              onValueChange={(v) => set(v === OTHER ? { ...choice, picked: [], other: true } : { ...choice, picked: [v], other: false })}>
              {rows.map((r) => <ChoiceRow key={r.id} {...r}><Radio id={r.id} value={r.value} disabled={disabled} /></ChoiceRow>)}
            </RadioGroup.Root>
          )}
      {choice.other && (
        <Input aria-label={`Other answer: ${q.question}`} placeholder="Type your answer" value={choice.otherText} disabled={disabled}
          onChange={(e) => set({ ...choice, otherText: e.target.value })} />
      )}
    </fieldset>
  )
}

/** Card of an AskUserQuestion request (`kind: 'question'`). */
export function QuestionCard({ request, outcome, answer }: PermissionCardProps) {
  const questions = parseQuestions(request.input)
  const [choices, setChoices] = useState<Choice[]>(() => questions.map(() => EMPTY))
  const { pending, error, run, retry } = useAnswerAction()
  const answers = questions.map((q, n) => answerOf(q, choices[n] ?? EMPTY))
  const complete = questions.length > 0 && answers.every((a) => a !== '')
  const submit = () => run(() => answer({
    requestId: request.requestId,
    behavior: 'allow',
    updatedInput: { ...rec(request.input), answers: Object.fromEntries(questions.map((q, n) => [q.question, answers[n]])) },
  }))
  const open = outcome === 'open'
  return (
    <div className="acc-card acc-question-card" data-outcome={outcome} role="group" aria-label="Claude has a question">
      <div className="acc-permission__head">
        <span className="codicon codicon-question" aria-hidden="true" />
        <span className="acc-permission__title">{questions.length > 1 ? 'Claude has some questions' : 'Claude has a question'}</span>
        {!open && <ResolvedBadge outcome={outcome} />}
      </div>
      {questions.map((q, n) => (
        <QuestionField key={q.question} q={q} choice={choices[n] ?? EMPTY} disabled={!open || pending}
          set={(c) => setChoices((cs) => cs.map((old, k) => (k === n ? c : old)))} />
      ))}
      {open && (
        <>
          <div className="acc-row">
            {pending && <Spinner />}
            <Button size="xs" disabled={!complete || pending} onClick={() => void submit()}>Submit</Button>
          </div>
          {error && <AnswerError error={error} retry={retry} disabled={pending} />}
        </>
      )}
    </div>
  )
}
