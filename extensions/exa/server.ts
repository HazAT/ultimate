import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { readSecret } from '../../lib/secrets.ts'
import { exaRequest, ExaApiError } from './client.ts'
import type { SearchResponse, ContentsResponse, ExaResult, ExaWarning } from './client.ts'
import { truncateToolOutput } from './output.ts'

export const secrets = [
  {
    name: 'EXA_API_KEY',
    description: 'exa.ai API key for web search and fetch',
    url: 'https://dashboard.exa.ai/api-keys',
  },
]
/** Turning parallel on or off changes whether exa may load. */
export const reloadOnSettings = true
const guidance = `Use web_search to discover pages, verify current facts, or locate documentation.
Use web_search searchQueries for 2-3 concise keyword variants when a topic benefits from multiple angles.
Use web_fetch after web_search when the full content of a promising result is needed.
Do not use web_search for a URL already provided by the user; use web_fetch for public webpages or curl for raw/API/local URLs.
Use web_fetch for a specific public webpage URL, including JavaScript-heavy pages and PDFs.
Use web_fetch objective when only a particular topic or section of the page is relevant.
Use web_fetch with an array to fetch up to 20 related webpages in one request.
Do not use web_fetch for raw files, API endpoints, JSON feeds, or localhost; use curl or bash for those.
Do not use web_fetch for discovery; use web_search when no URL is known yet.`
const missing =
  'Missing EXA_API_KEY or secrets is not enabled. Enable secrets and add EXA_API_KEY in the Secrets panel (⌘K → Secrets).'
export default function exa(host: ExtensionHost) {
  if (host.extensions().some((extension) => extension.name === 'parallel' && extension.enabled)) {
    throw new Error(
      'parallel is on and registers web_search and web_fetch too: turn parallel or exa off in the Extensions panel.',
    )
  }
  const notices = host.resource('exa:missing-key', () => ({ sent: false }))
  async function key() {
    if (
      host
        .extensions()
        .some(
          (extension) =>
            extension.name === 'secrets' &&
            extension.enabled &&
            extension.server &&
            !extension.server.error,
        )
    ) {
      const value = (await readSecret(host.userHome, 'EXA_API_KEY')) ?? process.env.EXA_API_KEY
      if (value) return value
    }
    if (!notices.sent) {
      notices.sent = true
      host.notice(missing)
    }
    throw new Error(missing)
  }
  return defineExtension({
    name: 'exa',
    sections: [section('web_tools', () => guidance)],
    tools: [
      defineTool({
        name: 'web_search',
        // Repeating a search only reads public web results; it changes no project state.
        replay: 'safe',
        description:
          "Search the public web with Exa's Search API. Returns ranked pages with titles, URLs, publication dates, and LLM-optimized excerpts. Use this to discover sources or find current information. For a known public webpage, use web_fetch instead. Output is limited to 50KB or 2,000 lines.",
        parameters: Type.Object({
          query: Type.String({
            minLength: 1,
            maxLength: 5000,
            description:
              'A self-contained description of what to find on the web. Include the key topic, desired facts, and any source or freshness preferences.',
          }),
          searchQueries: Type.Optional(
            Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
              minItems: 1,
              maxItems: 5,
              description:
                'Optional concise keyword queries (2-3 is best). Use diverse terms and angles rather than full sentences.',
            }),
          ),
          maxResults: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: 20,
              description: 'Maximum number of results. Defaults to 10.',
            }),
          ),
          afterDate: Type.Optional(
            Type.String({
              pattern: '^\\d{4}-\\d{2}-\\d{2}$',
              description: 'Only include content published on or after this date (YYYY-MM-DD).',
            }),
          ),
        }),
        async execute(args, api, context) {
          try {
            const apiKey = await key()
            const max = args.maxResults ?? 10
            // Exa takes one query per search: run each keyword variant, guided by the main
            // query for excerpt selection, and merge by rank; without variants, one search.
            const queries = [
              ...new Set(args.searchQueries?.length ? args.searchQueries : [args.query]),
            ]
            const responses = await Promise.all(
              queries.map((query) =>
                exaRequest<SearchResponse>(
                  '/search',
                  {
                    query,
                    type: 'auto',
                    numResults: max,
                    ...(args.afterDate
                      ? { startPublishedDate: `${args.afterDate}T00:00:00.000Z` }
                      : {}),
                    contents: {
                      highlights:
                        args.searchQueries?.length && query !== args.query
                          ? { query: args.query }
                          : true,
                    },
                  },
                  context.abortSignal,
                  apiKey,
                ),
              ),
            )
            for (const response of responses) validateResponse(response, false)
            const results = merge(responses, max)
            const combined = warnings(responses.flatMap((response) => response.notices ?? []))
            const details = {
              status: 'success',
              requestIds: responses.map((response) => response.requestId ?? null),
              results: summarize(results),
              warnings: combined,
            }
            await api.details(details, context)
            const text =
              `Found ${results.length} results for: ${args.query}\n\n` +
              warningText(combined) +
              results
                .map(
                  (result, index) =>
                    `${index + 1}. ${result.title || 'Untitled page'}\nURL: ${result.url}${result.publishedDate ? `\nPublished: ${result.publishedDate}` : ''}\n${excerpts(result).join('\n\n')}`,
                )
                .join('\n\n---\n\n')
            return { output: [{ type: 'text', text: truncateToolOutput(text) }] }
          } catch (error) {
            const result = failure(error)
            await api.details(result.details, context)
            return result.output
          }
        },
      }),
      defineTool({
        name: 'web_fetch',
        // Repeating extraction only reads public pages; it changes no project state.
        replay: 'safe',
        prepareArguments(args) {
          const input = args as { url: unknown; objective?: string }
          if (typeof input?.url === 'string' && input.url.trim().startsWith('[')) {
            try {
              return { ...input, url: JSON.parse(input.url) }
            } catch {
              /* Let validation report malformed URLs. */
            }
          }
          return input
        },
        description:
          "Fetch one or more known public webpages with Exa's Contents API and return clean, LLM-optimized markdown. Handles JavaScript-rendered pages and PDFs. Use an objective to focus the returned excerpts. Do not use for raw files, APIs, JSON feeds, or localhost; fetch those directly with curl. Output is limited to 50KB or 2,000 lines.",
        parameters: Type.Object({
          url: Type.Any({
            description:
              'A public webpage URL or an array of up to 20 public webpage URLs. Use curl instead for raw files, API endpoints, JSON feeds, or localhost.',
          }),
          objective: Type.Optional(
            Type.String({
              minLength: 1,
              maxLength: 5000,
              description: 'What information to prioritize. Omit to retrieve general page content.',
            }),
          ),
        }),
        async execute(args, api, context) {
          try {
            const urls = normalizeUrls(args.url)
            const response = await exaRequest<ContentsResponse>(
              '/contents',
              {
                urls,
                text: { maxCharacters: 40000 },
                // Refetch pages whose cached copy is older than a day.
                maxAgeHours: 24,
                ...(args.objective ? { highlights: { query: args.objective } } : {}),
              },
              context.abortSignal,
              await key(),
            )
            validateResponse(response, true)
            const errors = (response.statuses ?? [])
              .filter((status) => status.status === 'error')
              .slice(0, 20)
              .map((status) => ({
                url: status.id.slice(0, 2048),
                error_type: (status.error?.tag ?? 'fetch failed').slice(0, 200),
                http_status_code: status.error?.httpStatusCode ?? null,
              }))
            const results = summarize(response.results)
            const pages = results.map((result, index) => {
              const page = response.results[index]
              const content = page.text || excerpts(page).join('\n\n')
              return {
                ...result,
                content: content.slice(0, 20000),
                contentTruncated: content.length > 20000,
              }
            })
            await api.details(
              {
                status: errors.length ? 'partial' : 'success',
                requestId: response.requestId ?? null,
                results,
                pages,
                errors,
                warnings: [],
              },
              context,
            )
            const text =
              response.results
                .map(
                  (result) =>
                    `## ${result.title || result.url}\n\nSource: ${result.url}${result.publishedDate ? `\nPublished: ${result.publishedDate}` : ''}\n\n${result.text || excerpts(result).join('\n\n')}`,
                )
                .join('\n\n---\n\n') || 'No page content was extracted.'
            return {
              isError: !response.results.length && !!errors.length,
              output: [
                {
                  type: 'text',
                  text: truncateToolOutput(
                    (errors.length
                      ? `Fetch errors:\n${errors.map((error) => `- ${error.url} — ${error.error_type}${error.http_status_code ? ` (HTTP ${error.http_status_code})` : ''}`).join('\n')}\n\n`
                      : '') + text,
                  ),
                },
              ],
            }
          } catch (error) {
            const result = failure(error)
            await api.details(result.details, context)
            return result.output
          }
        },
      }),
    ],
  })
}
function failure(error: unknown) {
  const text = truncateToolOutput(error instanceof Error ? error.message : 'Exa request failed.')
  return {
    details: {
      status: 'error',
      error: text,
      httpStatus: error instanceof ExaApiError ? (error.status ?? null) : null,
      ref_id: error instanceof ExaApiError ? (error.requestId ?? null) : null,
    },
    output: { isError: true, output: [{ type: 'text' as const, text }] },
  }
}
/** A result's excerpts as the model and the UI see them: highlights, or the summary. */
function excerpts(item: ExaResult): string[] {
  if (item.highlights?.length) return item.highlights
  return item.summary ? [item.summary] : []
}
/** Interleave ranked result lists round-robin, dropping duplicate URLs, up to `max`. */
function merge(responses: SearchResponse[], max: number): ExaResult[] {
  const seen = new Set<string>()
  const merged: ExaResult[] = []
  for (let rank = 0; merged.length < max; rank++) {
    let any = false
    for (const response of responses) {
      const item = response.results[rank]
      if (!item) continue
      any = true
      if (merged.length >= max || seen.has(item.url)) continue
      seen.add(item.url)
      merged.push(item)
    }
    if (!any) break
  }
  return merged
}
/** The `details` result shape the renderers share with the parallel extension. */
function summarize(results: ExaResult[]) {
  return results.slice(0, 20).map((item) => ({
    url: item.url.slice(0, 2048),
    title: item.title?.slice(0, 500) ?? null,
    publish_date: item.publishedDate?.slice(0, 100) ?? null,
    excerpts: excerpts(item)
      .slice(0, 10)
      .map((excerpt) => excerpt.slice(0, 2000)),
  }))
}
function warnings(items?: ExaWarning[] | null) {
  return (items ?? []).slice(0, 50).map((item) => ({
    type: (item.code ?? 'notice').slice(0, 100),
    message: item.message.slice(0, 1000),
  }))
}
function warningText(items: { message: string }[]) {
  return items.length ? `Warnings:\n${items.map((item) => `- ${item.message}`).join('\n')}\n\n` : ''
}
export function normalizeUrls(value: unknown): string[] {
  const urls = Array.isArray(value) ? value : [value]
  if (
    !urls.length ||
    urls.length > 20 ||
    !urls.every((url) => typeof url === 'string' && url.trim())
  )
    throw new Error('web_fetch requires one URL or an array of 1-20 URLs.')
  return urls.map((url) => {
    try {
      const parsed = new URL(url.trim())
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error()
      return parsed.href
    } catch {
      throw new Error('web_fetch requires valid http(s) URLs.')
    }
  })
}
const nullableString = (item: unknown) => item == null || typeof item === 'string'
const nullableStrings = (item: unknown) =>
  item == null || (Array.isArray(item) && item.every((entry) => typeof entry === 'string'))
export function validateResponse(value: SearchResponse | ContentsResponse, contents: boolean) {
  if (
    !value ||
    !Array.isArray(value.results) ||
    !value.results.every(
      (item) =>
        item &&
        typeof item.url === 'string' &&
        nullableString(item.title) &&
        nullableString(item.publishedDate) &&
        nullableString(item.text) &&
        nullableString(item.summary) &&
        nullableStrings(item.highlights),
    ) ||
    (!contents &&
      [(value as SearchResponse).warnings, (value as SearchResponse).notices].some(
        (list) =>
          list != null &&
          (!Array.isArray(list) || !list.every((item) => item && typeof item.message === 'string')),
      )) ||
    (contents &&
      (value as ContentsResponse).statuses != null &&
      (!Array.isArray((value as ContentsResponse).statuses) ||
        !(value as ContentsResponse).statuses!.every(
          (item) => item && typeof item.id === 'string' && typeof item.status === 'string',
        )))
  )
    throw new Error('Exa API returned an unexpected response shape.')
}
