// Custom commands (Settings wizard + `webterm command`): reads are open to whoever passes the outer gate,
// mutations are human-UI only (route.uiOnly): adding a command changes what every terminal can execute.
import { CUSTOM_COMMANDS_PATH } from '../../shared/customCommands'
import { customCommandsApi, isCustomCommandsMutation } from '../customCommands.api'
import { defaultCtx } from '../customCommands.store'
import { send, type ApiRoute } from './route.core'
import { uiOnly } from './route.uiOnly'

const matches = (path: string): boolean => path === CUSTOM_COMMANDS_PATH || path.startsWith(`${CUSTOM_COMMANDS_PATH}/`)
const handle: ApiRoute['handle'] = async (c) => send(c.res, await customCommandsApi(defaultCtx(), c.method, c.url, () => c.readBody()))

export const customCommandsRoutes: ApiRoute[] = [
  uiOnly({ name: 'custom-commands-write', match: (c) => matches(c.path) && isCustomCommandsMutation(c.method, c.path), handle }),
  { name: 'custom-commands-read', match: (c) => matches(c.path), handle },
]
