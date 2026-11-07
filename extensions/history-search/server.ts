/** History search: scopes codemode's search for the surface and tags hits read from other projects. */
import { defineExtension } from '@earendil-works/pi-durable'
import { implementAction } from '../../lib/actions.ts'
import type { ActionContext } from '../../server/actions.ts'
import { HistoryApi } from '../codemode/api.ts'
import { SearchAction } from './refs.ts'
import type { Hit, Scope, SearchResult } from './refs.ts'

export default defineExtension({ name: 'history-search' })

/** Hits per search: codemode's own default and bound. */
const LIMIT = 100

const SCOPES: readonly Scope[] = ['conversation', 'project', 'all']

export const actions = {
  search: implementAction(SearchAction, (args, ctx) => search(args, ctx)),
}

/** The search the surface calls: validated args, one codemode read per scope, other projects' hits tagged with their project and URL. */
async function search(args: unknown, ctx: ActionContext): Promise<SearchResult> {
  const {
    text,
    scope = 'project',
    limit = LIMIT,
  } = (args ?? {}) as {
    text?: unknown
    scope?: unknown
    limit?: unknown
  }
  if (typeof text !== 'string' || !text.trim()) throw new Error('text must be nonempty')
  if (!SCOPES.includes(scope as Scope)) throw new Error(`scope must be one of ${SCOPES.join(', ')}`)
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new Error('limit must be an integer from 1 to 1000')
  const codemode = ctx.host.want(HistoryApi)
  if (!codemode) throw new Error('history search needs codemode, which is disabled')
  if (scope === 'conversation') {
    if (ctx.conversationId === undefined) throw new Error('No conversation is shown')
    return { hits: await codemode.search(text, { conversationId: ctx.conversationId, limit }) }
  }
  const hits: Hit[] = await codemode.search(text, { limit })
  if (scope === 'project') return { hits }
  // Every project this instance knows, hits tagged so their row opens there. A project that does not run has
  // nothing to read (its storage is reachable only through its own instance), and once the limit is reached the
  // remaining ones are not asked. One project failing must not hide the answers the others gave.
  const errors: { project: string; message: string }[] = []
  for (const project of await ctx.host.projects()) {
    if (project.current || !project.running || hits.length >= limit) continue
    try {
      const found = await codemode.searchProject(project.name, text, { limit: limit - hits.length })
      if (!found) continue
      hits.push(
        ...found.hits
          .slice(0, limit - hits.length)
          .map((hit) => ({ ...hit, project: project.name, url: found.url })),
      )
    } catch (error) {
      errors.push({
        project: project.name,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { hits, ...(errors.length > 0 && { errors }) }
}
