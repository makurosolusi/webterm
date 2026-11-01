import type { Database } from 'bun:sqlite'
import { portfolio } from '../centralProjection'
export function centralPrompt(db: Database, humanText: string, enabled: boolean): string {
  if (!enabled) return humanText
  const summary = (portfolio(db, { limit: 50 })?.items ?? [])
    .map((item) => ({ id: item.id, name: item.name, status: item.status }))
    .slice(0, 50)
  const json = JSON.stringify(summary).slice(0, 4096)
  return `You are the webterm central steward. Use the portfolio JSON below. Never claim approval. To propose work, emit exactly one block in this form: <webterm-proposal>{"tool":"goal.propose"|"plan.propose","input":{...}}</webterm-proposal>. Allowed tools are only goal.propose and plan.propose.\nPortfolio: ${json}\n\nHuman request:\n${humanText}`
}
