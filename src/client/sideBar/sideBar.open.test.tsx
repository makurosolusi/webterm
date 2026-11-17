/** @vitest-environment jsdom */
// openSideBarView shows a view without toggling it closed; an unknown view is ignored.
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OPEN_SIDE_BAR_VIEW, openSideBarView, useOpenSideBarRequests } from './sideBar.open'

afterEach(cleanup)

describe('openSideBarView', () => {
  it('asks the mounted side bar to show the view, every time', () => {
    const show = vi.fn()
    renderHook(() => useOpenSideBarRequests(show))
    act(() => { openSideBarView('skills'); openSideBarView('skills') })
    expect(show).toHaveBeenCalledTimes(2)
    expect(show).toHaveBeenCalledWith('skills')
  })

  it('ignores an unknown view and stops listening after unmount', () => {
    const show = vi.fn()
    const { unmount } = renderHook(() => useOpenSideBarRequests(show))
    act(() => { window.dispatchEvent(new CustomEvent(OPEN_SIDE_BAR_VIEW, { detail: { view: 'nope' } })) })
    expect(show).not.toHaveBeenCalled()
    unmount()
    act(() => openSideBarView('layers'))
    expect(show).not.toHaveBeenCalled()
  })
})
