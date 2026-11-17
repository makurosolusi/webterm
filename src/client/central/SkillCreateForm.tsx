// "New skill" and "Edit skill" form: a human drafts a skill (or a new version of one). The server lints it like any
// proposal; approval stays a separate step. Editing shows a diff of the old text against the new one before saving.
import { ActionButton, ActionResult, useAction } from '@/components/ui/action'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useState } from 'react'
import { CL } from './centralLabels'
import type { CentralControlClient } from './centralControlTypes'
import { lineDiff } from '../../server/central/ca2Routes.diff'
import SkillDiff from './SkillDiff'
import type { SkillReviewRow } from './centralControlTypes'
import { CAP_PRESETS, MAX_INSTRUCTIONS, MAX_WHEN, createErrorLines, draftValid, fullName, tailOf } from './skillLibraryModel'

const Counter = ({ n, max }: { n: number; max: number }) => <span className={n > max ? 'ccp-error' : undefined} aria-live="polite">{CL.skillCount(n, max)}</span>

interface Props { client: CentralControlClient; onCreated: (name: string) => void; onCancel: () => void; /** Set to edit this skill as a new version instead of creating one. */ edit?: SkillReviewRow }

export default function SkillCreateForm({ client, onCreated, onCancel, edit }: Props) {
  const [name, setName] = useState(edit ? tailOf(edit.record.name) : '')
  const [when, setWhen] = useState(edit?.description ?? '')
  const [body, setBody] = useState(edit?.body ?? '')
  const [caps, setCaps] = useState<string[]>([...(edit?.record.caps ?? [])])
  const capOptions = [...new Set([...CAP_PRESETS, ...(edit?.record.caps ?? [])])]
  const changes = edit ? lineDiff(edit.body, body) : ''
  const changed = edit ? body !== edit.body || when.trim() !== edit.description || caps.join() !== edit.record.caps.join() : true
  const heading = edit ? CL.skillEditHeading : CL.skillNewHeading
  const [errors, setErrors] = useState<string[]>([])
  const toggle = (cap: string, on: boolean) => setCaps((c) => (on ? [...c, cap] : c.filter((x) => x !== cap)))
  const create = useAction(async () => {
    setErrors([])
    try {
      if (edit) await client.editSkill(fullName(name), { description: when.trim(), body, caps })
      else await client.createSkill({ name: fullName(name), description: when.trim(), body, caps })
    } catch (err) {
      setErrors(createErrorLines(err))
      throw err
    }
    onCreated(fullName(name))
  }, { label: edit ? CL.skillEditSave : CL.skillCreate, toast: 'never', failure: () => CL.skillCreateFailed, success: () => (edit ? CL.skillEditSaved(fullName(name)) : CL.skillCreated(fullName(name))) })
  const valid = draftValid({ name, when, body })
  return (
    <form className="ccp-card" aria-label={heading} aria-busy={create.busy} onSubmit={(e) => e.preventDefault()}>
      <h4>{heading}</h4>
      <p>{edit ? CL.skillEditHint : CL.skillNewHint}</p>
      <label>{CL.skillName}
        <span className="ccp-name-field"><span aria-hidden="true">{CL.skillNamePrefix}</span>
          <Input value={name} aria-label={CL.skillName} autoComplete="off" disabled={create.busy || !!edit} aria-describedby="skill-name-help" onChange={(e) => setName(e.target.value)} />
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
      {edit && (changed
        ? <><strong>{CL.skillChanges}</strong><SkillDiff text={changes} label={CL.skillChanges} /></>
        : <p>{CL.skillNoChanges}</p>)}
      <fieldset disabled={create.busy}>
        <legend>{CL.skillCaps}</legend>
        <small>{CL.skillCapsHelp}</small>
        {capOptions.map((cap) => (
          <label key={cap} className="ccp-cap"><Checkbox checked={caps.includes(cap)} aria-label={cap} onCheckedChange={(v) => toggle(cap, v === true)} />{cap}</label>
        ))}
      </fieldset>
      {errors.length > 0 && (
        <div role="alert" className="ccp-error"><p>{CL.skillCreateFix}</p><ul>{errors.map((e) => <li key={e}>{e}</li>)}</ul></div>
      )}
      <footer>
        <ActionButton type="button" size="sm" disabled={!valid || !changed} action={create} busyLabel={CL.skillCreating}>{edit ? CL.skillEditSave : CL.skillCreate}</ActionButton>
        <Button type="button" size="sm" variant="secondary" disabled={create.busy} onClick={onCancel}>{CL.skillCancel}</Button>
      </footer>
      <ActionResult action={create} />
    </form>
  )
}
