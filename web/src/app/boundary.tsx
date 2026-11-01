import { cn } from 'cn'
import { MessageSquareShareIcon, PuzzleIcon, TriangleAlertIcon } from 'lucide-react'
import { Component, Fragment, useContext } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import type { SystemInfo } from '../../../shared/protocol.ts'
import { errorMessage, shortenPath } from '../sdk/format.ts'
import { ExtensionNameContext, useExtensions, useSystem } from '../sdk/hooks.ts'
import { provisionOf, provisionsOf, slotItems } from '../sdk/registry.ts'
import { ErrorReport } from '../sdk/types.ts'
import type { Point, SlotName } from '../sdk/types.ts'

/** Frames of a stack an error report keeps, after dropping dependencies (React, Vite's prebundles) and bare elements. */
const STACK_LINES = 8

/** Where an extension lives: `extensions/…` in the clone, `~/.ultimate/…` or the project's `.ultimate/…` otherwise. */
function extensionPath(system: SystemInfo | undefined, name: string, file = '') {
  const info = system?.extensions.find((extension) => extension.name === name)
  if (!info) return `extensions/${name}${file}`
  return shortenPath(`${info.path}${file}`, {
    cwd: info.source === 'builtin' ? system?.code.ultimateRoot : system?.project.root,
    home: system?.machine.home,
  })
}

/** A thrown error's frames: V8 starts its stack with `Name: message`, which the report already holds. */
export function stackFrames(error: unknown) {
  return error instanceof Error ? error.stack?.replace(String(error), '').trim() : undefined
}

/**
 * A stack frame with short paths: Vite's URL loses its origin and `?t=` stamp, a file served by `/@fs/` reads as
 * `shortenPath` shows it, and one under the web root as `src/…`.
 */
function shortFrame(system: SystemInfo | undefined, line: string) {
  return line.replace(/https?:\/\/[^/\s]+(\/@fs)?\/([^?:\s)]*)(\?[^:\s)]*)?/g, (_, fs, path) =>
    fs
      ? shortenPath(`/${path}`, { cwd: system?.code.ultimateRoot, home: system?.machine.home })
      : path,
  )
}

/** What an error card hands over for debugging: the failure, where it lives, its stack and the running build. */
export function errorReport(
  system: SystemInfo | undefined,
  failure: { extension: string; error: string; context: string; stack?: string },
) {
  const source = system?.extensions.find((info) => info.name === failure.extension)?.source
  const frames = failure.stack
    ?.split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/\/(node_modules|deps)\/|\(<anonymous>\)$/.test(line))
    .map((line) => shortFrame(system, line))
  const stack = frames && [...new Set(frames)].slice(0, STACK_LINES).join('\n')
  const build = system && `${system.build.id} · gen ${system.build.generation}`
  return [
    `Extension \`${failure.extension}\` failed: ${failure.context}.`,
    `Path: ${extensionPath(system, failure.extension)}${source ? ` (${source})` : ''}`,
    `Error: ${failure.error}`,
    stack && `Stack:\n\`\`\`\n${stack}\n\`\`\``,
    build && `Build: ${build}`,
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * A compact card naming the extension that failed. `inline` fits a status line or toolbar. A block card offers its
 * report (`context` says what failed, `stack` where) to whatever provides `ErrorReport`.
 */
export function ErrorCard({
  extension,
  error,
  context = 'a component threw',
  stack,
  variant = 'block',
  className,
}: {
  extension: string
  error: string
  context?: string
  stack?: string
  variant?: 'inline' | 'block'
  className?: string
}) {
  const system = useSystem()
  if (variant === 'inline')
    return (
      <span
        className={cn(
          'inline-flex max-w-72 items-center gap-1 rounded-sm bg-error/12 px-1.5 font-mono text-[0.6875rem] text-error',
          className,
        )}
        title={error}
        data-extension-error={extension}
      >
        <TriangleAlertIcon className="size-3 shrink-0" />
        <span className="truncate">
          {extension}: {error}
        </span>
      </span>
    )
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-md border border-error/30 bg-error/8 px-2.5 py-2 font-mono text-[0.75rem]',
        className,
      )}
      data-extension-error={extension}
    >
      <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-error" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-error">
          <span className="min-w-0 flex-1">
            extension <span className="font-semibold">{extension}</span> failed
          </span>
          <Provided input={null} point={ErrorReport}>
            {(report) =>
              report && (
                <button
                  aria-label={report.title}
                  className="-my-0.5 shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                  onClick={() =>
                    report.send(errorReport(system, { extension, error, context, stack }))
                  }
                  title={report.title}
                  type="button"
                >
                  <MessageSquareShareIcon className="size-3.5" />
                </button>
              )
            }
          </Provided>
        </div>
        <div className="mt-0.5 max-h-48 overflow-auto whitespace-pre text-muted-foreground">
          {error}
        </div>
      </div>
    </div>
  )
}

/**
 * Catches what one extension's component throws; a new version of the extension retries. Where one boundary position
 * shows different contributions (panel tabs), key it by extension and contribution, so an error stays with
 * the contribution that threw.
 */
export class ExtensionBoundary extends Component<
  {
    extension: string
    version: number
    variant?: 'inline' | 'block'
    /** Rendered after the error card, such as the core renderer of the same data. */
    fallback?: ReactNode
    children: ReactNode
  },
  { error?: string; stack?: string; version: number }
> {
  state: { error?: string; stack?: string; version: number } = { version: this.props.version }
  static getDerivedStateFromError(error: unknown) {
    return { error: errorMessage(error), stack: undefined }
  }
  static getDerivedStateFromProps(
    props: { version: number },
    state: { error?: string; version: number },
  ) {
    return props.version === state.version
      ? null
      : { error: undefined, stack: undefined, version: props.version }
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`[extension ${this.props.extension}]`, error, info.componentStack)
    // The component stack names the extension's components; the JS stack, where in them it threw.
    const thrown = stackFrames(error)
    this.setState({
      stack: [thrown, info.componentStack?.trim()].filter(Boolean).join('\n') || undefined,
    })
  }
  render() {
    if (this.state.error === undefined)
      return (
        <ExtensionNameContext.Provider value={this.props.extension}>
          {this.props.children}
        </ExtensionNameContext.Provider>
      )
    return (
      <>
        <ErrorCard
          extension={this.props.extension}
          error={this.state.error}
          stack={this.state.stack}
          variant={this.props.variant}
        />
        {this.props.fallback}
      </>
    )
  }
}

/**
 * Renders `children` with the value the facet providing `point` computes for `input`, or with `undefined` while none
 * does. `children` only returns elements: it runs inside the provider's render, so it calls no hooks. A provider that
 * throws shows an inline error card before `children(undefined)`.
 */
export function Provided<Input, Value>({
  point,
  input,
  children,
}: {
  point: Point<Input, Value>
  input: Input
  children: (value: Value | undefined) => ReactNode
}) {
  // The caller's elements stay the caller's: its extension name keys its UI state.
  const caller = useContext(ExtensionNameContext)
  const own = (value: Value | undefined) => (
    <ExtensionNameContext.Provider value={caller}>{children(value)}</ExtensionNameContext.Provider>
  )
  const provision = provisionOf(useExtensions(), point.point)
  if (!provision) return own(undefined)
  const use = provision.use as (input: Input) => Value
  return (
    <ExtensionBoundary
      extension={provision.extension}
      fallback={own(undefined)}
      key={provision.extension}
      variant="inline"
      version={provision.version}
    >
      {/* A new version of the provider may call other hooks, so it mounts afresh. */}
      <Provide input={input} key={provision.version} render={own} use={use} />
    </ExtensionBoundary>
  )
}
/**
 * Renders `children` with the values every facet providing `point` computes for `input`, in discovery order; for points
 * that combine contributions, such as rows several extensions add. Each provider runs behind its own boundary: one that
 * throws shows an inline error card and is left out.
 */
export function AllProvided<Input, Value>({
  point,
  input,
  children,
}: {
  point: Point<Input, Value>
  input: Input
  children: (values: readonly Value[]) => ReactNode
}) {
  const caller = useContext(ExtensionNameContext)
  const provisions = provisionsOf(useExtensions(), point.point)
  // Each provider's hook runs inside the one before it, so the values arrive together at the end of the chain.
  const chain = (index: number, values: readonly Value[]): ReactNode => {
    const provision = provisions[index]
    if (!provision)
      return (
        <ExtensionNameContext.Provider value={caller}>
          {children(values)}
        </ExtensionNameContext.Provider>
      )
    return (
      <ExtensionBoundary
        extension={provision.extension}
        fallback={chain(index + 1, values)}
        key={provision.extension}
        variant="inline"
        version={provision.version}
      >
        <Provide
          input={input}
          key={provision.version}
          render={(value) => chain(index + 1, [...values, value])}
          use={provision.use as (input: Input) => Value}
        />
      </ExtensionBoundary>
    )
  }
  return chain(0, [])
}
function Provide<Input, Value>({
  use,
  input,
  render,
}: {
  use: (input: Input) => Value
  input: Input
  render: (value: Value) => ReactNode
}) {
  return render(use(input))
}

/** Every component extensions put in `name`, each behind its own boundary. */
export function Slot({
  name,
  variant = 'block',
  separator,
  phone,
}: {
  name: SlotName
  variant?: 'inline' | 'block'
  separator?: ReactNode
  /** Only the items marked `phone` (true) or only the others (false); all by default. */
  phone?: boolean
}) {
  const items = slotItems(useExtensions(), name).filter(
    (item) => phone === undefined || item.phone === phone,
  )
  return items.map(({ key, extension, version, component: Item }, index) => (
    <Fragment key={key}>
      {index > 0 && separator}
      <ExtensionBoundary extension={extension} version={version} variant={variant}>
        <Item />
      </ExtensionBoundary>
    </Fragment>
  ))
}

/** Extensions whose web facet failed to load, until it loads again. */
export function ExtensionErrors() {
  const failed = useExtensions().filter((record) => record.error !== undefined)
  const system = useSystem()
  if (failed.length === 0) return null
  return (
    <div className="pointer-events-none fixed right-3 bottom-10 z-40 flex w-96 max-w-[calc(100vw-1.5rem)] flex-col gap-2">
      {failed.map((record) => (
        <div
          className="pointer-events-auto rounded-md border border-error/30 bg-popover/95 shadow-lg backdrop-blur"
          key={record.name}
        >
          <ErrorCard
            className="border-none bg-transparent"
            context={
              record.extension
                ? 'web.tsx did not reload; the previous version is still running'
                : 'web.tsx did not load'
            }
            error={record.error ?? ''}
            extension={record.name}
          />
          <div className="flex items-center gap-1.5 px-2.5 pb-2 font-mono text-[0.6562rem] text-muted-foreground">
            <PuzzleIcon className="size-3" />
            {extensionPath(system, record.name, '/web.tsx')}
            {record.extension ? ' · previous version still running' : ' · not loaded'}
          </div>
        </div>
      ))}
    </div>
  )
}
