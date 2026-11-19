// HTTP handler for custom commands: list / add / remove / which / detect. Pure over a store context so
// it is testable without a server; the route file adds the auth gate (route.uiOnly) around mutations.
//   GET    /api/custom-commands                 -> 200 { binDir, commands: CustomCommandStatus[] }
//   POST   /api/custom-commands                 -> 201 { command }   body: CustomCommandAddRequest
//   POST   /api/custom-commands/remove          -> 200 { removed }   body: { name }  (capability binding; no :param)
//   DELETE /api/custom-commands/:name           -> 200 { removed }
//   GET    /api/custom-commands/which?name=     -> 200 { name, path, custom }
//   GET    /api/custom-commands/detect          -> 200 { candidates: CustomCommandDetected[] }  every executable in the managed +
//                                                  extra dirs plus common wrappers on PATH, with format/compat/source; nothing is run
//   GET    /api/custom-commands/paths           -> 200 { managed, platformDir, extra: [{dir, exists, safe}], common }
//   POST   /api/custom-commands/paths           -> 201 PathsView     body: { dir }
//   POST   /api/custom-commands/paths/remove    -> 200 PathsView     body: { dir }  (also DELETE /paths?dir=)
//   POST   /api/custom-commands/rescan          -> 200 { added }     re-scan usual tool dirs + login shell PATH now
// Errors: { error: <code>, message } with 400 invalid_*/reserved_name/unsafe_path_dir, 404 not_found, 409 duplicate/limit_reached,
// 503 bin_dir_readonly, 500 write_failed.
import { CUSTOM_COMMANDS_PATH, CUSTOM_COMMAND_NAME_RE, type CustomCommandAddRequest, type CustomCommandErrorCode, type CustomCommandFailure } from '../shared/customCommands'
import { detectCommands } from './customCommands.detect'
import { addPathDir, listPaths, removePathDir } from './customCommands.paths'
import { addCommand, listCommands, removeCommand, whichCommand, type CustomCommandsCtx } from './customCommands.store'
import { rescan } from './pathResolver'

export interface ApiResult { status: number; body: unknown }

const STATUS: Record<CustomCommandErrorCode, number> = {
  invalid_name: 400, reserved_name: 400, invalid_kind: 400, invalid_target: 400, invalid_argv: 400, invalid_note: 400, invalid_path_dir: 400, unsafe_path_dir: 400,
  duplicate: 409, limit_reached: 409, not_found: 404, bin_dir_readonly: 503, write_failed: 500,
}
const failure = (f: CustomCommandFailure): ApiResult => ({ status: STATUS[f.code], body: { error: f.code, message: f.message } })
const bad = (error: string, message: string): ApiResult => ({ status: 400, body: { error, message } })

async function parsedBody(readBody: () => Promise<string>): Promise<Record<string, unknown> | null> {
  try {
    const v: unknown = JSON.parse(await readBody())
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null // not JSON: the caller answers 400 invalid_json
  }
}

/** The mutating verbs, so the route file can wrap exactly these in the human-UI gate. */
export const isCustomCommandsMutation = (method: string, path: string): boolean =>
  (method === 'POST' && [CUSTOM_COMMANDS_PATH, `${CUSTOM_COMMANDS_PATH}/remove`, `${CUSTOM_COMMANDS_PATH}/paths`, `${CUSTOM_COMMANDS_PATH}/paths/remove`].includes(path)) ||
  (method === 'DELETE' && path.startsWith(`${CUSTOM_COMMANDS_PATH}/`))

/** null = not a custom-commands path (fall through). */
export async function customCommandsApi(ctx: CustomCommandsCtx, method: string, url: URL, readBody: () => Promise<string>): Promise<ApiResult | null> {
  const path = url.pathname
  if (path !== CUSTOM_COMMANDS_PATH && !path.startsWith(`${CUSTOM_COMMANDS_PATH}/`)) return null
  const sub = path.slice(CUSTOM_COMMANDS_PATH.length + 1)
  try {
    if (method === 'GET' && sub === '') return { status: 200, body: { binDir: ctx.binDir, commands: listCommands(ctx) } }
    if (method === 'GET' && sub === 'detect') return { status: 200, body: { candidates: detectCommands(ctx) } }
    if (method === 'GET' && sub === 'which') {
      const name = url.searchParams.get('name') ?? ''
      return CUSTOM_COMMAND_NAME_RE.test(name) ? { status: 200, body: whichCommand(ctx, name) } : bad('invalid_name', 'name query parameter is required.')
    }
    if (method === 'GET' && sub === 'paths') return { status: 200, body: listPaths(ctx) }
    if (method === 'POST' && sub === 'rescan') return { status: 200, body: await rescan() }
    if (method === 'DELETE' && sub === 'paths') {
      const r = removePathDir(ctx, url.searchParams.get('dir'))
      return r.ok ? { status: 200, body: r.data } : failure(r)
    }
    if (method === 'POST' && (sub === 'paths' || sub === 'paths/remove')) {
      const body = await parsedBody(readBody)
      if (!body) return bad('invalid_json', 'Body must be a JSON object.')
      const r = sub === 'paths' ? addPathDir(ctx, body.dir) : removePathDir(ctx, body.dir)
      return r.ok ? { status: sub === 'paths' ? 201 : 200, body: r.data } : failure(r)
    }
    if (method === 'POST' && (sub === '' || sub === 'remove')) {
      const body = await parsedBody(readBody)
      if (!body) return bad('invalid_json', 'Body must be a JSON object.')
      if (sub === 'remove') {
        const r = removeCommand(ctx, String(body.name ?? ''))
        return r.ok ? { status: 200, body: { removed: r.data.name } } : failure(r)
      }
      const r = addCommand(ctx, body as unknown as CustomCommandAddRequest)
      return r.ok ? { status: 201, body: { command: r.data } } : failure(r)
    }
    if (method === 'DELETE' && sub !== '' && !sub.includes('/')) {
      const r = removeCommand(ctx, decodeURIComponent(sub))
      return r.ok ? { status: 200, body: { removed: r.data.name } } : failure(r)
    }
    return { status: 405, body: { error: 'method_not_allowed', message: `${method} ${path}` } }
  } catch (e) {
    return { status: 500, body: { error: 'registry_unreadable', message: (e as Error).message } }
  }
}
