import { ChevronRightIcon, ExternalLinkIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { MessageResponse } from '@/components/ai/message'
import { Shimmer } from '@/components/ai/shimmer'
import {
  Tool,
  ToolContent,
  ToolDiagnostics,
  ToolHeader,
  ToolOutput,
  ToolSection,
} from '@/components/ai/tool'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  defineWebExtension,
  events,
  formatBytes,
  useCommands,
  useToolDuration,
  useUltimate,
} from '@/sdk'
import { plural } from '@/sdk'
import type { ToolCallView } from '@/sdk'

/** A result or fetched page in the tools' `details` (server.ts). */
interface Page {
  url: string
  title: string | null
  publish_date: string | null
  excerpts: string[]
  /** web_fetch: the page's content as the model got it; without it, its excerpts. */
  content?: string | null
  /** web_fetch: the content was cut to the server's bound. */
  contentTruncated?: boolean
}
interface Warning {
  type: string
  message: string
}
interface FetchError {
  url: string
  error_type: string
  http_status_code: number | null
}
type Details =
  | {
      status: 'success' | 'partial'
      results?: Page[]
      pages?: Page[]
      errors?: FetchError[]
      warnings?: Warning[]
    }
  | { status: 'error'; error: string; httpStatus: number | null; ref_id: string | null }

const text = (value: unknown) => (typeof value === 'string' ? value : '')
/** Fetched markdown must not load anything from the web: no images. */
const offline = ['img', 'picture', 'source']

function host(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
/** A URL as shown: no scheme, no `www.`, no trailing slash. */
const bare = (url: string) => url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')
/** The first few distinct domains, in rank order. */
function domains(urls: readonly string[], count = 3) {
  const unique = [...new Set(urls.map(host))]
  return unique.length > count
    ? `${unique.slice(0, count).join(', ')} +${unique.length - count}`
    : unique.join(', ')
}
const day = (date: string) => (/^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : date)

function Action({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button
      className="mr-1.5 h-6 shrink-0 px-2 font-mono text-[11px]"
      onClick={onClick}
      size="xs"
      type="button"
      variant="outline"
    >
      {label}
    </Button>
  )
}

/**
 * For a missing or rejected EXA_API_KEY: opens the Secrets panel at it, or, while `secrets` is off, the
 * Extensions panel to turn it on.
 */
function KeyAction({ error }: { error: string }) {
  const commands = useCommands()
  const ui = useUltimate()
  if (!error.includes('EXA_API_KEY')) return null
  const has = (id: string) => commands.some((command) => command.id === id)
  if (has('secrets.panel'))
    return (
      <Action
        label={error.includes('rejected') ? 'Replace key' : 'Add key'}
        onClick={() => events.emit('secrets:open', { name: 'EXA_API_KEY' })}
      />
    )
  if (has('onboarding.extensions'))
    return <Action label="Turn on secrets" onClick={() => ui.runCommand('onboarding.extensions')} />
  return null
}

/** The card both tools share: the header, an action beside it, and the body. */
function Card({
  call,
  name,
  title,
  meta,
  running,
  children,
}: {
  call: ToolCallView
  name: string
  title: ReactNode
  meta: ReactNode
  running: string
  children: ReactNode
}) {
  const duration = useToolDuration(call)
  const details = call.details as Details | undefined
  const failure = details?.status === 'error' ? details : undefined
  // Collapsed while it goes well; a failure opens it, also one that arrives live.
  const failed = call.status === 'error'
  const [open, setOpen] = useState(failed)
  const was = useRef(failed)
  useEffect(() => {
    if (failed && !was.current) setOpen(true)
    was.current = failed
  }, [failed])
  return (
    <Tool onOpenChange={setOpen} open={open}>
      <div className="flex items-center">
        <ToolHeader
          className="min-w-0 flex-1"
          meta={
            <>
              {meta}
              {duration && <span>{duration}</span>}
            </>
          }
          name={name}
          state={call.status}
          title={title}
        />
        {failure && <KeyAction error={failure.error} />}
      </div>
      <ToolContent>
        {call.status === 'running' && (
          <ToolSection>
            <Shimmer className="text-[12px]">{running}</Shimmer>
          </ToolSection>
        )}
        {failure ? (
          <ToolSection>
            <div className="break-words text-error">{failure.error}</div>
            {(failure.httpStatus || failure.ref_id) && (
              <div className="text-[11px] text-muted-foreground/70">
                {[
                  failure.httpStatus && `HTTP ${failure.httpStatus}`,
                  failure.ref_id && `ref ${failure.ref_id}`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            )}
          </ToolSection>
        ) : details ? (
          children
        ) : (
          call.status === 'error' && <ToolOutput isError output={call.output} />
        )}
        <ToolDiagnostics diagnostics={call.diagnostics.filter((d) => d.code !== 'tool_error')} />
      </ToolContent>
    </Tool>
  )
}

/** Counts for the header: warnings, and fetches that failed. */
function Counts({ details }: { details?: Details }) {
  if (!details || details.status === 'error') return null
  const failed = details.errors?.length ?? 0
  const warned = details.warnings?.length ?? 0
  return (
    <>
      {failed > 0 && <span className="text-error">{failed} failed</span>}
      {warned > 0 && <span className="text-warning">{plural(warned, 'warning')}</span>}
    </>
  )
}

function Notes({ details }: { details: Details }) {
  if (details.status === 'error') return null
  const errors = details.errors ?? []
  const warnings = details.warnings ?? []
  if (!errors.length && !warnings.length) return null
  return (
    <ToolSection className="border-t border-border/60 text-[11.5px]">
      {errors.map((error, index) => (
        <div className="flex min-w-0 gap-1.5 text-error" key={`error:${index}`}>
          <span className="shrink-0">✗</span>
          <span className="min-w-0 truncate" title={error.url}>
            {bare(error.url)}
          </span>
          <span className="shrink-0 text-error/80">
            {error.error_type}
            {error.http_status_code ? ` · HTTP ${error.http_status_code}` : ''}
          </span>
        </div>
      ))}
      {warnings.map((warning, index) => (
        <div className="flex min-w-0 gap-1.5 text-warning" key={`warning:${index}`}>
          <span className="shrink-0">!</span>
          <span className="min-w-0 break-words">{warning.message}</span>
        </div>
      ))}
    </ToolSection>
  )
}

/** A link that opens in a new tab; nothing is requested until it is followed. */
function Link({
  url,
  className,
  children,
}: {
  url: string
  className?: string
  children: ReactNode
}) {
  return (
    <a className={className} href={url} rel="noreferrer" target="_blank" title={url}>
      {children}
    </a>
  )
}

function Search({ call }: { call: ToolCallView }) {
  const details = call.details as Details | undefined
  const results = (details?.status !== 'error' && details?.results) || []
  const keywords = Array.isArray(call.args.searchQueries)
    ? call.args.searchQueries.filter((query): query is string => typeof query === 'string')
    : []
  const query = text(call.args.query)
  const shown = details && details.status !== 'error'
  return (
    <Card
      call={call}
      meta={
        <>
          <Counts details={details} />
          {shown && <span>{plural(results.length, 'result')}</span>}
        </>
      }
      name="search"
      running="searching the web…"
      title={
        <>
          <span className="text-foreground/90">{query}</span>
          {results.length > 0 && (
            <span className="text-muted-foreground/60">
              {' '}
              · {domains(results.map((r) => r.url))}
            </span>
          )}
        </>
      }
    >
      {keywords.length > 0 && (
        <ToolSection className="text-[11px] text-muted-foreground">
          keywords: {keywords.join(' · ')}
        </ToolSection>
      )}
      {results.length > 0 && (
        <ol aria-label="Search results" className="divide-y divide-border/60">
          {results.map((result, index) => {
            const excerpt = result.excerpts.join(' … ').replace(/\s+/g, ' ').trim()
            return (
              <li className="flex gap-2.5 px-2.5 py-2" key={index}>
                <span className="w-4 shrink-0 text-right text-muted-foreground/60 tabular-nums">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <Link
                    className="block truncate font-sans text-[13px] text-foreground hover:underline"
                    url={result.url}
                  >
                    {result.title || bare(result.url)}
                  </Link>
                  <div className="mt-0.5 flex min-w-0 gap-2 text-[11px] text-muted-foreground">
                    <span className="truncate">{host(result.url)}</span>
                    {result.publish_date && (
                      <span className="shrink-0 text-muted-foreground/70">
                        {day(result.publish_date)}
                      </span>
                    )}
                  </div>
                  {excerpt && (
                    <p className="mt-1 line-clamp-3 font-sans text-[12.5px] leading-snug text-muted-foreground">
                      {excerpt}
                    </p>
                  )}
                </div>
              </li>
            )
          })}
        </ol>
      )}
      {shown && results.length === 0 && (
        <ToolSection className="text-muted-foreground/70">no results</ToolSection>
      )}
      {details && <Notes details={details} />}
    </Card>
  )
}

/** One fetched page: its title, its source, and its content as markdown behind a disclosure. */
function FetchedPage({ page, open }: { page: Page; open: boolean }) {
  const body = page.content || page.excerpts.join('\n\n')
  return (
    <li className="px-2.5 py-2">
      <div className="truncate font-sans text-[13px] text-foreground">
        {page.title || bare(page.url)}
      </div>
      <Link
        className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        url={page.url}
      >
        <span className="truncate">{bare(page.url)}</span>
        <ExternalLinkIcon className="size-3 shrink-0" />
      </Link>
      {body && (
        <Collapsible defaultOpen={open}>
          <CollapsibleTrigger className="group mt-1.5 flex items-center gap-1 rounded-sm text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring">
            <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]:rotate-90" />
            {page.content
              ? `content · ${formatBytes(new TextEncoder().encode(page.content).length)}${page.contentTruncated ? ' · truncated' : ''}`
              : plural(page.excerpts.length, 'excerpt')}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-1.5 max-h-96 overflow-y-auto rounded-sm border border-border/70 bg-background px-3 py-2 font-sans">
              <MessageResponse className="text-[13px] leading-relaxed" disallowedElements={offline}>
                {body}
              </MessageResponse>
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </li>
  )
}

function Fetch({ call }: { call: ToolCallView }) {
  const details = call.details as Details | undefined
  const pages = (details?.status !== 'error' && details?.pages) || []
  const urls = (Array.isArray(call.args.url) ? call.args.url : [call.args.url]).filter(
    (url): url is string => typeof url === 'string' && url.length > 0,
  )
  const objective = text(call.args.objective)
  const shown = details && details.status !== 'error'
  return (
    <Card
      call={call}
      meta={
        <>
          <Counts details={details} />
          {shown && <span>{plural(pages.length, 'page')}</span>}
        </>
      }
      name="fetch"
      running={`fetching ${plural(urls.length || 1, 'page')}…`}
      title={
        <span className="text-foreground/90">
          {urls.length === 1 ? bare(urls[0]) : domains(urls)}
        </span>
      }
    >
      {objective && (
        <ToolSection className="text-[11px] text-muted-foreground">
          objective: {objective}
        </ToolSection>
      )}
      {pages.length > 0 && (
        <ul aria-label="Fetched pages" className="divide-y divide-border/60">
          {pages.map((page, index) => (
            <FetchedPage key={index} open={pages.length === 1} page={page} />
          ))}
        </ul>
      )}
      {details && <Notes details={details} />}
    </Card>
  )
}

export default defineWebExtension({ tools: { web_search: Search, web_fetch: Fetch } })
