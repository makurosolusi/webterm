/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { Button } from './button'
import { Card, CardContent } from './card'

afterEach(cleanup)

it('renders the generated Button and Card primitives', () => {
  render(
    <Card>
      <CardContent>
        <Button>Continue</Button>
      </CardContent>
    </Card>,
  )

  expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy()
  expect(screen.getByText('Continue')).toBeTruthy()
})
