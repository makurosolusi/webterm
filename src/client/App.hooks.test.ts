/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest'
import { ACTIVITY_STATUS_ITEM } from './App.hooks'
import { setTimelineOpen, TIMELINE_OPEN_KEY } from './Timeline'

describe('Activity status bar item', () => {
  it('opens the Activity timeline (shared open store, persisted)', () => {
    setTimelineOpen(false)
    expect(ACTIVITY_STATUS_ITEM.label).toBe('Activity')
    ACTIVITY_STATUS_ITEM.onClick?.()
    expect(localStorage.getItem(TIMELINE_OPEN_KEY)).toBe('1')
  })
})
