/** @vitest-environment jsdom */
// A field whose default is a safeguard shows the reason next to its control (shared/settings.safeguards.ts), on a
// Settings key, a Central row id and the Rules & secrets page; an ordinary field shows none.
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SAFEGUARDS } from '../shared/settings.safeguards'
import { Field, SafeguardNote } from './SettingsFields'
import { toSettingsFieldId } from './settings.link'

afterEach(cleanup)

describe('safeguard hints', () => {
  it('Settings key and Central row show their reason; an ordinary field shows none', () => {
    render(<>
      <Field label="Approval" setting="centralCheckinDailyLimit"><span /></Field>
      <Field label="Level" field="central.level"><span /></Field>
      <Field label="Cost" field="central.costLimit"><span /></Field>
      <Field label="Copy" setting="copyOnSelect"><span /></Field>
    </>)
    expect(screen.getByText(SAFEGUARDS.centralCheckinDailyLimit)).toBeTruthy()
    expect(screen.getByText(SAFEGUARDS.WEBTERM_CENTRAL_AUTONOMY)).toBeTruthy()
    expect(screen.getByText(SAFEGUARDS.WEBTERM_CENTRAL_DAILY_COST_MICROS)).toBeTruthy()
    expect(document.querySelectorAll('[data-safeguard]')).toHaveLength(3)
    expect(document.querySelector('[data-field="copyOnSelect"] [data-safeguard]')).toBeNull()
  })

  it('page-level notes (secret access, Deny rules) render their reason', () => {
    render(<><SafeguardNote id="secretAccess" /><SafeguardNote id="denyRules" /><SafeguardNote id="fontSize" /></>)
    expect(screen.getByText(SAFEGUARDS.secretAccess)).toBeTruthy()
    expect(screen.getByText(SAFEGUARDS.denyRules)).toBeTruthy()
    expect(document.querySelectorAll('[data-safeguard]')).toHaveLength(2)
  })

  it('every alias target used by a Central row is a real field id', () => {
    for (const id of ['central.level', 'central.costLimit', 'central.dailySpawns', 'central.maxInflight', 'central.checkinLimit']) {
      expect(toSettingsFieldId(id), id).toBe(id)
    }
  })
})
