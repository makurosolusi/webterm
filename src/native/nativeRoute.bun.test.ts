import { describe, expect, it } from 'bun:test'
import { routeNative } from './nativeRoute'

/** Importers that record which target loaded; neither touches Electrobun, a window or the server. */
function spyImporters() {
  const loaded: string[] = []
  return { loaded, load: { cli: async () => { loaded.push('cli') }, app: async () => { loaded.push('app') } } }
}

describe('routeNative', () => {
  it('sends __mcp-stdio to the CLI gate (MCP main) without loading the window/server code', async () => {
    const { loaded, load } = spyImporters()
    expect(await routeNative(['__mcp-stdio', '--headers', '/tmp/h', '--port', '8700'], load)).toBe('cli')
    expect(loaded).toEqual(['cli'])
  })

  it('sends __eval-run to the CLI gate too', async () => {
    const { loaded, load } = spyImporters()
    expect(await routeNative(['__eval-run', '--model', 'fake'], load)).toBe('cli')
    expect(loaded).toEqual(['cli'])
  })

  it('loads the app for the launcher (no argv) and for anything else, never the CLI gate', async () => {
    for (const argv of [[], ['--help'], ['some-file.txt']]) {
      const { loaded, load } = spyImporters()
      expect(await routeNative(argv, load)).toBe('app')
      expect(loaded).toEqual(['app'])
    }
  })
})
