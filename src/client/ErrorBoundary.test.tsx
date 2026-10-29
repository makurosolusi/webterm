/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ErrorBoundary } from './ErrorBoundary'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function Boom(): never {
  throw new Error('kaboom')
}

it('renders its children when nothing throws', () => {
  render(
    <ErrorBoundary>
      <span>alive</span>
    </ErrorBoundary>,
  )
  expect(screen.getByText('alive')).toBeTruthy()
})

it('shows the fallback with the error message instead of unmounting to a blank screen', () => {
  // React logs the caught error to console.error — silence it so the test output stays clean.
  vi.spyOn(console, 'error').mockImplementation(() => {})
  render(
    <ErrorBoundary>
      <Boom />
    </ErrorBoundary>,
  )
  expect(screen.getByRole('alert')).toBeTruthy()
  expect(screen.getByText('kaboom')).toBeTruthy()
})
