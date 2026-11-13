// Bundle entry of the native app (electrobun.config.ts `build.bun.entrypoint`). Electrobun runs it in a
// Worker with no extra argv: that loads the window (nativeApp.ts). A child the server starts as
// `<bun> <this bundle> __mcp-stdio|__eval-run ...` (selfLaunch.ts) goes to the CLI gate instead and never
// evaluates any Electrobun code (nativeRoute.ts). Both targets are dynamic imports so neither loads eagerly.
import { routeNative } from './nativeRoute'

await routeNative(process.argv.slice(2), {
  cli: () => import('../server/cli/cliGate'),
  app: () => import('./nativeApp'),
})
