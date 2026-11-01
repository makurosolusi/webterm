// Test-only HTTP doubles for the extended route tests. Not named `*.test.ts`, so vitest
// never runs it as a suite.
import type { IncomingMessage, ServerResponse } from 'node:http'

export interface FakeResponse {
  status: number
  headers: Record<string, string>
  body: string
  json(): unknown
}

export function fakeRes(): { res: ServerResponse; state: FakeResponse } {
  const state: FakeResponse = {
    status: 0,
    headers: {},
    body: '',
    json() {
      return state.body === '' ? undefined : JSON.parse(state.body)
    },
  }
  const res = {
    get statusCode() {
      return state.status
    },
    set statusCode(value: number) {
      state.status = value
    },
    setHeader(name: string, value: string) {
      state.headers[name] = value
    },
    end(body?: string) {
      state.body = body ?? ''
    },
  } as unknown as ServerResponse
  return { res, state }
}

export function fakeReq(method: string, path: string): IncomingMessage {
  return { method, url: path } as unknown as IncomingMessage
}

export function urlOf(path: string): URL {
  return new URL(path, 'http://x')
}
