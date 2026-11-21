/** @jsxImportSource @solidjs/web */
import { ChevronRight, ExternalLink } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { createEffect, createMemo, createSignal, For, Match, Show, Switch } from 'solid-js'
import { Shimmer } from '@/components/ai/shimmer.solid.tsx'
import {
  Tool,
  ToolContent,
  ToolDiagnostics,
  ToolHeader,
  ToolOutput,
  ToolSection,
} from '@/components/ai/tool.solid.tsx'
import { Markdown } from '@/components/markdown/markdown.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.solid.tsx'
import {
  useToolDuration,
  events,
  formatBytes,
  plural,
  runCommand,
  useCommands,
  type SolidToolProps,
  type ToolCallView,
} from '@/sdk/solid'

interface Page {
  url: string
  title: string | null
  publish_date: string | null
  excerpts: string[]
  content?: string | null
  contentTruncated?: boolean
}
interface Warning {
  message: string
}
interface FetchError {
  url: string
  error_type: string
  http_status_code: number | null
}
interface Results {
  status: 'success' | 'partial'
  results?: Page[]
  pages?: Page[]
  errors?: FetchError[]
  warnings?: Warning[]
}
interface Failure {
  status: 'error'
  error: string
  httpStatus: number | null
  ref_id: string | null
}
type Details = Results | Failure

const text = (value: unknown) => (typeof value === 'string' ? value : '')
const elementsThatCouldFetchRemoteAssets = ['img', 'picture', 'source']
const detailsOf = (call: ToolCallView) => call.details as Details | undefined
const resultsOf = (call: ToolCallView) => {
  const details = detailsOf(call)
  return details?.status !== 'error' ? details : undefined
}

function host(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
const bare = (url: string) => url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')
function domains(urls: readonly string[], count = 3) {
  const unique = [...new Set(urls.map(host))]
  return unique.length > count
    ? `${unique.slice(0, count).join(', ')} +${unique.length - count}`
    : unique.join(', ')
}
const day = (date: string) => (/^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : date)

function KeyAction(props: { error: string; id: string }) {
  const commands = useCommands()
  const has = (id: string) => commands().some((command) => command.id === id)
  const secrets = () => has('secrets.panel')
  const label = () =>
    secrets() ? (props.error.includes('rejected') ? 'Replace key' : 'Add key') : 'Turn on secrets'
  return (
    <Show
      when={props.error.includes('PARALLEL_API_KEY') && (secrets() || has('onboarding.extensions'))}
    >
      <Button
        aria-label={`${label()} for Parallel #${props.id}`}
        class="mr-1.5 h-6 shrink-0 px-2 font-mono text-[11px]"
        onClick={() => {
          if (secrets()) events.emit('secrets:open', { name: 'PARALLEL_API_KEY' })
          else return runCommand('onboarding.extensions')
        }}
        size="xs"
        type="button"
        variant="outline"
      >
        {label()}
      </Button>
    </Show>
  )
}

function Card(props: {
  call: ToolCallView
  name: string
  label: string
  title: JSX.Element
  meta: JSX.Element
  running: string
  children: JSX.Element
}) {
  const duration = useToolDuration(() => props.call)
  const details = () => detailsOf(props.call)
  const failure = () => {
    const info = details()
    return info?.status === 'error' ? info : undefined
  }
  const failed = createMemo(() => props.call.status === 'error')
  const [open, setOpen] = createSignal(failed)
  createEffect(failed, (error) => {
    if (error) setOpen(true)
  })
  return (
    <Tool bind={[open, setOpen]}>
      <div class="flex items-center">
        <ToolHeader
          aria-label={props.label}
          class="min-w-0 flex-1"
          meta={
            <>
              {props.meta}
              <Show when={duration()}>
                <span>{duration()}</span>
              </Show>
            </>
          }
          name={props.name}
          state={props.call.status}
          title={props.title}
        />
        <Show when={failure()}>
          {(error) => <KeyAction error={error().error} id={props.call.id} />}
        </Show>
      </div>
      <ToolContent>
        <Show when={props.call.status === 'running'}>
          <ToolSection>
            <Shimmer class="text-[12px]">{props.running}</Shimmer>
          </ToolSection>
        </Show>
        <Switch>
          <Match when={failure()}>{(error) => <FailureNote failure={error()} />}</Match>
          <Match when={details()}>{props.children}</Match>
          <Match when={failed()}>
            <ToolOutput isError output={props.call.output} />
          </Match>
        </Switch>
        <ToolDiagnostics
          diagnostics={props.call.diagnostics.filter((d) => d.code !== 'tool_error')}
        />
      </ToolContent>
    </Tool>
  )
}

function FailureNote(props: { failure: Failure }) {
  const ref = () =>
    [
      props.failure.httpStatus && `HTTP ${props.failure.httpStatus}`,
      props.failure.ref_id && `ref ${props.failure.ref_id}`,
    ]
      .filter(Boolean)
      .join(' · ')
  return (
    <ToolSection>
      <div class="break-words text-error">{props.failure.error}</div>
      <Show when={ref()}>
        <div class="text-[11px] text-muted-foreground/70">{ref()}</div>
      </Show>
    </ToolSection>
  )
}

function Counts(props: { results?: Results }) {
  const failed = () => props.results?.errors?.length ?? 0
  const warned = () => props.results?.warnings?.length ?? 0
  return (
    <>
      <Show when={failed() > 0}>
        <span class="text-error">{failed()} failed</span>
      </Show>
      <Show when={warned() > 0}>
        <span class="text-warning">{plural(warned(), 'warning')}</span>
      </Show>
    </>
  )
}

function Notes(props: { results?: Results }) {
  return (
    <Show when={props.results?.errors?.length || props.results?.warnings?.length}>
      <ToolSection class="border-t border-border/60 text-[11.5px]">
        <For each={props.results?.errors} keyed={false}>
          {(error) => (
            <div class="flex min-w-0 gap-1.5 text-error">
              <span class="shrink-0">✗</span>
              <span class="min-w-0 truncate" title={error().url}>
                {bare(error().url)}
              </span>
              <span class="shrink-0 text-error/80">
                {error().error_type}
                {error().http_status_code ? ` · HTTP ${error().http_status_code}` : ''}
              </span>
            </div>
          )}
        </For>
        <For each={props.results?.warnings} keyed={false}>
          {(warning) => (
            <div class="flex min-w-0 gap-1.5 text-warning">
              <span class="shrink-0">!</span>
              <span class="min-w-0 break-words">{warning().message}</span>
            </div>
          )}
        </For>
      </ToolSection>
    </Show>
  )
}

const webAddress = (url: string) => {
  const parsed = URL.parse(url)
  return parsed && /^https?:$/.test(parsed.protocol) ? parsed.href : undefined
}

function Link(props: { url: string; class: string; children: JSX.Element }) {
  return (
    <Show
      when={webAddress(props.url)}
      fallback={
        <span class={props.class} title={props.url}>
          {props.children}
        </span>
      }
    >
      {(href) => (
        <a class={props.class} href={href()} rel="noreferrer" target="_blank" title={props.url}>
          {props.children}
        </a>
      )}
    </Show>
  )
}

function SearchResult(props: { page: Page; number: number }) {
  const excerpt = createMemo(() => props.page.excerpts.join(' … ').replace(/\s+/g, ' ').trim())
  return (
    <li class="flex gap-2.5 px-2.5 py-2">
      <span class="w-4 shrink-0 text-right text-muted-foreground/60 tabular-nums">
        {props.number}
      </span>
      <div class="min-w-0 flex-1">
        <Link
          class="block truncate font-sans text-[13px] text-foreground hover:underline"
          url={props.page.url}
        >
          {props.page.title || bare(props.page.url)}
        </Link>
        <div class="mt-0.5 flex min-w-0 gap-2 text-[11px] text-muted-foreground">
          <span class="truncate">{host(props.page.url)}</span>
          <Show when={props.page.publish_date}>
            {(date) => <span class="shrink-0 text-muted-foreground/70">{day(date())}</span>}
          </Show>
        </div>
        <Show when={excerpt()}>
          <p class="mt-1 line-clamp-3 font-sans text-[12.5px] leading-snug text-muted-foreground">
            {excerpt()}
          </p>
        </Show>
      </div>
    </li>
  )
}

export function Search(props: SolidToolProps) {
  const details = () => resultsOf(props.call)
  const results = () => details()?.results ?? []
  const keywords = createMemo(() => {
    const queries = props.call.args.searchQueries
    return Array.isArray(queries)
      ? queries.filter((query): query is string => typeof query === 'string')
      : []
  })
  const query = () => text(props.call.args.query)
  return (
    <Card
      call={props.call}
      label={`Web search #${props.call.id}: ${query()}`}
      meta={
        <>
          <Counts results={details()} />
          <Show when={details()}>
            <span>{plural(results().length, 'result')}</span>
          </Show>
        </>
      }
      name="search"
      running="searching the web…"
      title={
        <>
          <span class="text-foreground/90">{query()}</span>
          <Show when={results().length > 0}>
            <span class="text-muted-foreground/60"> · {domains(results().map((r) => r.url))}</span>
          </Show>
        </>
      }
    >
      <Show when={keywords().length > 0}>
        <ToolSection class="text-[11px] text-muted-foreground">
          keywords: {keywords().join(' · ')}
        </ToolSection>
      </Show>
      <Show
        when={results().length > 0}
        fallback={<ToolSection class="text-muted-foreground/70">no results</ToolSection>}
      >
        <ol aria-label="Search results" class="divide-y divide-border/60">
          <For each={results()} keyed={(result) => result.url}>
            {(result, index) => <SearchResult number={index() + 1} page={result()} />}
          </For>
        </ol>
      </Show>
      <Notes results={details()} />
    </Card>
  )
}

function FetchedPage(props: { page: Page; open: boolean; id: string; number: number }) {
  const body = createMemo(() => props.page.content || props.page.excerpts.join('\n\n'))
  const summary = () => {
    const { content, contentTruncated, excerpts } = props.page
    return content
      ? `content · ${formatBytes(new TextEncoder().encode(content).length)}${contentTruncated ? ' · truncated' : ''}`
      : plural(excerpts.length, 'excerpt')
  }
  return (
    <li class="px-2.5 py-2">
      <div class="truncate font-sans text-[13px] text-foreground">
        {props.page.title || bare(props.page.url)}
      </div>
      <Link
        class="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        url={props.page.url}
      >
        <span class="truncate">{bare(props.page.url)}</span>
        <ExternalLink aria-hidden="true" class="size-3 shrink-0" />
      </Link>
      <Show when={body()}>
        <Collapsible defaultOpen={props.open}>
          <CollapsibleTrigger
            aria-label={`Read page ${props.number} of fetch #${props.id}: ${bare(props.page.url)}`}
            class="group mt-1.5 flex items-center gap-1 rounded-sm text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          >
            <ChevronRight
              aria-hidden="true"
              class="size-3 transition-transform group-data-open:rotate-90"
            />
            {summary()}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div class="mt-1.5 max-h-96 overflow-y-auto rounded-sm border border-border/70 bg-background px-3 py-2 font-sans">
              <Markdown
                class="text-[13px] leading-relaxed"
                text={body()}
                without={elementsThatCouldFetchRemoteAssets}
              />
            </div>
          </CollapsibleContent>
        </Collapsible>
      </Show>
    </li>
  )
}

export function Fetch(props: SolidToolProps) {
  const details = () => resultsOf(props.call)
  const pages = () => details()?.pages ?? []
  const urls = createMemo(() => {
    const url = props.call.args.url
    return (Array.isArray(url) ? url : [url]).filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    )
  })
  const target = () => (urls().length === 1 ? bare(urls()[0]) : domains(urls()))
  const objective = () => text(props.call.args.objective)
  return (
    <Card
      call={props.call}
      label={`Web fetch #${props.call.id}: ${target()}`}
      meta={
        <>
          <Counts results={details()} />
          <Show when={details()}>
            <span>{plural(pages().length, 'page')}</span>
          </Show>
        </>
      }
      name="fetch"
      running={`fetching ${plural(urls().length || 1, 'page')}…`}
      title={<span class="text-foreground/90">{target()}</span>}
    >
      <Show when={objective()}>
        <ToolSection class="text-[11px] text-muted-foreground">
          objective: {objective()}
        </ToolSection>
      </Show>
      <Show when={pages().length > 0}>
        <ul aria-label="Fetched pages" class="divide-y divide-border/60">
          <For each={pages()} keyed={false}>
            {(page, index) => (
              <FetchedPage
                id={props.call.id}
                number={index + 1}
                open={pages().length === 1}
                page={page()}
              />
            )}
          </For>
        </ul>
      </Show>
      <Notes results={details()} />
    </Card>
  )
}
