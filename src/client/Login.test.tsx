/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Login from './Login'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('Login', () => {
  it('renders the token input and submit button', () => {
    render(<Login onSubmit={async () => true} />)
    expect(screen.getByLabelText('Access token')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeDefined()
  })

  it('submits the typed token verbatim', async () => {
    const onSubmit = vi.fn(async () => true)
    render(<Login onSubmit={onSubmit} />)
    fireEvent.change(screen.getByLabelText('Access token'), { target: { value: 's3cret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('s3cret'))
  })

  it('shows an error when the token is rejected', async () => {
    render(<Login onSubmit={async () => false} />)
    fireEvent.change(screen.getByLabelText('Access token'), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    expect(await screen.findByText('Token salah')).toBeDefined()
  })

  it('shows no error when the token is accepted', async () => {
    const onSubmit = vi.fn(async () => true)
    render(<Login onSubmit={onSubmit} />)
    fireEvent.change(screen.getByLabelText('Access token'), { target: { value: 'ok' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(screen.queryByText('Token salah')).toBeNull()
  })
})
