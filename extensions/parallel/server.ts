import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { readSecret } from '../../lib/secrets.ts'
import { parallelRequest, ParallelApiError } from './client.ts'
import type {
  SearchResponse,
  ExtractResponse,
  ParallelResultItem,
  ParallelWarning,
} from './client.ts'
import { truncateToolOutput } from './output.ts'

export const secrets = [
  {
    name: 'PARALLEL_API_KEY',
    description: 'parallel.ai API key for web search and fetch',
    url: 'https://platform.parallel.ai',
  },
]
const missing =
  'Missing PARALLEL_API_KEY or secrets is not enabled. Enable secrets and add PARALLEL_API_KEY in the Secrets panel (⌘K → Secrets).'
export default function parallel(host: ExtensionHost) {
  const notices = host.resource('parallel:missing-key', () => ({ sent: false }))
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
      const value =
        (await readSecret(host.userHome, 'PARALLEL_API_KEY')) ?? process.env.PARALLEL_API_KEY
      if (value) return value
    }
    if (!notices.sent) {
      notices.sent = true
      host.notice(missing)
    }
    throw new Error(missing)
  }
  return defineExtension({
    name: 'parallel',
    tools: [
      defineTool({
        name: 'web_search',
        // Repeating a search only reads public web results; it changes no project state.
        replay: 'safe',
        description:
          "Search the public web with Parallel's Search API. Returns ranked pages with titles, URLs, publication dates, and LLM-optimized excerpts. Use this to discover sources or find current information. For a known public webpage, use web_fetch instead. Output is limited to 50KB or 2,000 lines.",
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
            const response = await parallelRequest<SearchResponse>(
              '/search',
              {
                objective: args.query,
                search_queries: args.searchQueries ?? [args.query],
                mode: 'turbo',
                max_chars_total: 40000,
                client_model: (await api.agent(context)).model?.modelId,
                advanced_settings: {
                  max_results: args.maxResults ?? 10,
                  ...(args.afterDate ? { source_policy: { after_date: args.afterDate } } : {}),
                },
              },
              context.abortSignal,
              await key(),
            )
            validateResponse(response, false)
            const details = {
              status: 'success',
              searchId: response.search_id,
              sessionId: response.session_id,
              results: summarize(response.results),
              warnings: warnings(response.warnings),
            }
            await api.details(details, context)
            const text =
              `Found ${response.results.length} results for: ${args.query}\n\n` +
              warningText(response.warnings) +
              response.results
                .map(
                  (result, index) =>
                    `${index + 1}. ${result.title || 'Untitled page'}\nURL: ${result.url}${result.publish_date ? `\nPublished: ${result.publish_date}` : ''}\n${result.excerpts.join('\n\n')}`,
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
          "Fetch one or more known public webpages with Parallel's Extract API and return clean, LLM-optimized markdown. Handles JavaScript-rendered pages and PDFs. Use an objective to focus the returned excerpts. Do not use for raw files, APIs, JSON feeds, or localhost; fetch those directly with curl. Output is limited to 50KB or 2,000 lines.",
        parameters: Type.Object({
          url: Type.Any({
            description: 'A public webpage URL or an array of up to 20 public webpage URLs.',
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
            const response = await parallelRequest<ExtractResponse>(
              '/extract',
              {
                urls,
                objective: args.objective,
                max_chars_total: 40000,
                client_model: (await api.agent(context)).model?.modelId,
              },
              context.abortSignal,
              await key(),
            )
            validateResponse(response, true)
            const errors = response.errors.slice(0, 20).map((error) => ({
              url: error.url.slice(0, 2048),
              error_type: error.error_type.slice(0, 200),
              http_status_code: error.http_status_code ?? null,
            }))
            const results = summarize(response.results)
            const pages = results.map((result, index) => {
              const page = response.results[index]
              const content = page.full_content || page.excerpts.join('\n\n')
              return {
                ...result,
                content: content.slice(0, 20000),
                contentTruncated: content.length > 20000,
              }
            })
            await api.details(
              {
                status: response.errors.length ? 'partial' : 'success',
                extractId: response.extract_id,
                sessionId: response.session_id,
                results,
                pages,
                errors,
                warnings: warnings(response.warnings),
              },
              context,
            )
            const text =
              response.results
                .map(
                  (result) =>
                    `## ${result.title || result.url}\n\nSource: ${result.url}${result.publish_date ? `\nPublished: ${result.publish_date}` : ''}\n\n${result.full_content || result.excerpts.join('\n\n')}`,
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
                      : '') +
                      warningText(response.warnings) +
                      text,
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
  const text = truncateToolOutput(
    error instanceof Error ? error.message : 'Parallel request failed.',
  )
  return {
    details: {
      status: 'error',
      error: text,
      httpStatus: error instanceof ParallelApiError ? (error.status ?? null) : null,
      ref_id: error instanceof ParallelApiError ? (error.referenceId ?? null) : null,
    },
    output: { isError: true, output: [{ type: 'text' as const, text }] },
  }
}
function summarize(results: ParallelResultItem[]) {
  return results.slice(0, 20).map((item) => ({
    url: item.url.slice(0, 2048),
    title: item.title?.slice(0, 500) ?? null,
    publish_date: item.publish_date?.slice(0, 100) ?? null,
    excerpts: item.excerpts.slice(0, 10).map((excerpt) => excerpt.slice(0, 2000)),
  }))
}
function warnings(items?: ParallelWarning[] | null) {
  return (items ?? [])
    .slice(0, 50)
    .map((item) => ({ type: item.type.slice(0, 100), message: item.message.slice(0, 1000) }))
}
function warningText(items?: ParallelWarning[] | null) {
  const summary = warnings(items)
  return summary.length
    ? `Warnings:\n${summary.map((item) => `- ${item.message}`).join('\n')}\n\n`
    : ''
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
export function validateResponse(value: SearchResponse | ExtractResponse, extract: boolean) {
  if (
    typeof (extract
      ? (value as ExtractResponse).extract_id
      : (value as SearchResponse).search_id) !== 'string' ||
    typeof value.session_id !== 'string' ||
    !Array.isArray(value.results) ||
    !value.results.every(
      (item) =>
        item &&
        typeof item.url === 'string' &&
        nullableString(item.title) &&
        nullableString(item.publish_date) &&
        (!extract || nullableString((item as { full_content?: unknown }).full_content)) &&
        Array.isArray(item.excerpts) &&
        item.excerpts.every((excerpt) => typeof excerpt === 'string'),
    ) ||
    (value.warnings != null &&
      (!Array.isArray(value.warnings) ||
        !value.warnings.every(
          (item) => item && typeof item.type === 'string' && typeof item.message === 'string',
        ))) ||
    (value.usage != null &&
      (!Array.isArray(value.usage) ||
        !value.usage.every(
          (item) => item && typeof item.name === 'string' && typeof item.count === 'number',
        ))) ||
    (extract &&
      (!Array.isArray((value as ExtractResponse).errors) ||
        !(value as ExtractResponse).errors.every(
          (item) =>
            item &&
            typeof item.url === 'string' &&
            typeof item.error_type === 'string' &&
            (item.http_status_code == null || typeof item.http_status_code === 'number') &&
            nullableString(item.content),
        )))
  )
    throw new Error('Parallel API returned an unexpected response shape.')
}
