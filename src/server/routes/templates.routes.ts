// Canvas templates / factories (templates/template.route.ts), lazily imported. Stored in webterm.db's
// `app` table, so they work with the ledger off; only template routines need the ledger.
import { send, type ApiRoute } from './route.core'

export const templatesRoutes: ApiRoute[] = [
  {
    name: 'templates',
    match: (c) => c.path === '/api/templates' || c.path.startsWith('/api/templates/'),
    handle: async (c) => {
      const { templatesRoute, TEMPLATES_BODY_MAX_BYTES } = await import('../templates/template.route')
      const { productionTemplatesDeps } = await import('../templates/template.runtime')
      const res = await templatesRoute(c.req, c.url, c.body(TEMPLATES_BODY_MAX_BYTES), productionTemplatesDeps())
      return send(c.res, res)
    },
  },
]
