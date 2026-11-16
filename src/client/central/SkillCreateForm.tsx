// "New skill" form: a human drafts a skill. The server lints it like any proposal; approval stays a separate step.
import { ActionButton, ActionResult, useAction } from '@/components/ui/action'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useState } from 'react'
import { CL } from './centralLabels'
import type { CentralControlClient } from './centralControlTypes'
import { CAP_PRESETS, MAX_INSTRUCTIONS, MAX_WHEN, createErrorLines, draftValid, fullName, tailOf } from './skillLibraryModel'

const Counter = ({ n, max }: { n: number; max: number }) => <span className={n > max ? 'ccp-error' : undefined} aria-live="polite">{CL.skillCount(n, max)}</span>

export default function SkillCreateForm({ client, onCreated, onCancel }: { client: CentralControlClient; onCreated: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [when, setWhen] = useState('')
  const [body, setBody] = useState('')
  const [caps, setCaps] = useState<string[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const toggle = (cap: string, on: boolean) => setCaps((c) => (on ? [...c, cap] : c.filter((x) => x !== cap)))
  const create = useAction(async () => {
    setErrors([])
    try {
      await client.createSkill({ name: fullName(name), description: when.trim(), body, caps })
    } catch (err) {
      setErrors(createErrorLines(err))
      throw err
    }
    onCreated(fullName(name))
  }, { label: CL.skillCreate, toast: 'never', failure: () => CL.skillCreateFailed, success: () => CL.skillCreated(fullName(name)) })
  const valid = draftValid({ name, when, body })
  return (
    <form className="ccp-card" aria-label={CL.skillNewHeading} aria-busy={create.busy} onSubmit={(e) => e.preventDefault()}>
      <h4>{CL.skillNewHeading}</h4>
      <p>{CL.skillNewHint}</p>
      <label>{CL.skillName}
        <span className="ccp-name-field"><span aria-hidden="true">{CL.skillNamePrefix}</span>
          <Input value={name} aria-label={CL.skillName} autoComplete="off" disabled={create.busy} aria-describedby="skill-name-help" onChange={(e) => setName(e.target.value)} />
        </span>
      </label>
      <small id="skill-name-help">{CL.skillNameHelp} {tailOf(name) && `→ ${fullName(name)}`}</small>
      <label>{CL.skillWhen}
        <Textarea value={when} rows={2} disabled={create.busy} onChange={(e) => setWhen(e.target.value.replace(/[\r\n]+/g, ' '))} />
      </label>
      <small>{CL.skillWhenHelp} <Counter n={when.length} max={MAX_WHEN} /></small>
      <label>{CL.skillInstructions}
        <Textarea value={body} rows={8} disabled={create.busy} onChange={(e) => setBody(e.target.value)} />
      </label>
      <small>{CL.skillInstructionsHelp} <Counter n={body.length} max={MAX_INSTRUCTIONS} /></small>
      <fieldset disabled={create.busy}>
        <legend>{CL.skillCaps}</legend>
        <small>{CL.skillCapsHelp}</small>
        {CAP_PRESETS.map((cap) => (
          <label key={cap} className="ccp-cap"><Checkbox checked={caps.includes(cap)} aria-label={cap} onCheckedChange={(v) => toggle(cap, v === true)} />{cap}</label>
        ))}
      </fieldset>
      {errors.length > 0 && (
        <div role="alert" className="ccp-error"><p>{CL.skillCreateFix}</p><ul>{errors.map((e) => <li key={e}>{e}</li>)}</ul></div>
      )}
      <footer>
        <ActionButton type="button" size="sm" disabled={!valid} action={create} busyLabel={CL.skillCreating}>{CL.skillCreate}</ActionButton>
        <Button type="button" size="sm" variant="secondary" disabled={create.busy} onClick={onCancel}>{CL.skillCancel}</Button>
      </footer>
      <ActionResult action={create} />
    </form>
  )
}
