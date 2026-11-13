// The native error box's wording (sessionError.ts) for each way openNativeSession can fail.
import { expect, test } from 'bun:test'
import { AlreadyRunningError } from '../server/instanceGuard'
import { AttachRefusedError } from './nativeSession'
import { sessionErrorDialog } from './sessionError'

test('another live server for the data dir (the start guard)', () => {
  const err = new AlreadyRunningError('/tmp/wt-data', 'http://127.0.0.1:5000', 42) // test-only
  expect(sessionErrorDialog(err)).toEqual({ title: 'webterm', message: 'webterm is already running for this data folder.', detail: err.message })
})

test('a live server that refused a sign-in window', () => {
  const err = new AttachRefusedError('webterm server pid 42 on http://127.0.0.1:5000 refused a sign-in window (HTTP 403)')
  expect(sessionErrorDialog(err)).toEqual({ title: 'webterm', message: 'The running webterm server would not open a window.', detail: err.message })
})

test('any other start failure, including a non-Error throw', () => {
  expect(sessionErrorDialog(new Error('listen EADDRINUSE'))).toEqual({ title: 'webterm', message: 'webterm could not start.', detail: 'listen EADDRINUSE' })
  expect(sessionErrorDialog('boom').detail).toBe('boom')
})
