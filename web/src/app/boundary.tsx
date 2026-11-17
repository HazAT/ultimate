import { cn } from 'cn'
import { MessageSquareShareIcon, PuzzleIcon, TriangleAlertIcon } from 'lucide-react'
import { Component, Fragment, useContext } from 'react'
import type { ErrorInfo, ReactNode, Ref } from 'react'
import { createPortal } from 'react-dom'
import { fetchAssets, sourceFrames } from '../../../lib/source-frames.ts'
import type { SystemInfo } from '../../../shared/protocol.ts'
import { errorMessage, shortenPath } from '../sdk/format.ts'
import { ExtensionNameContext, useExtensions, useSystem } from '../sdk/hooks.ts'
import { provisionOf, provisionsOf, slotItems } from '../sdk/registry.ts'
import { ErrorReport } from '../sdk/types.ts'
import type { Point, SlotName } from '../sdk/types.ts'

const MAX_NON_DEPENDENCY_STACK_FRAMES = 8

function extensionPath(system: SystemInfo | undefined, name: string, file = '') {
  const info = system?.extensions.find((extension) => extension.name === name)
  if (!info) return `extensions/${name}${file}`
  return shortenPath(`${info.path}${file}`, {
    cwd: info.source === 'builtin' ? system?.code.ultimateRoot : system?.project.root,
    home: system?.machine.home,
  })
}

export function stackFrames(error: unknown) {
  return error instanceof Error ? error.stack?.replace(String(error), '').trim() : undefined
}

function shortFrame(system: SystemInfo | undefined, line: string) {
  const short = (path: string) =>
    shortenPath(path, { cwd: system?.code.ultimateRoot, home: system?.machine.home })
  return line
    .replace(/(?<=\()\/[^\s():]+/, short)
    .replace(/https?:\/\/[^/\s]+(\/@fs)?\/([^?:\s)]*)(\?[^:\s)]*)?/g, (_, fs, path) =>
      fs ? short(`/${path}`) : path,
    )
}

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
  const stack = frames && [...new Set(frames)].slice(0, MAX_NON_DEPENDENCY_STACK_FRAMES).join('\n')
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
          'inline-flex max-w-72 items-center gap-1 rounded-sm bg-error/12 px-1.5 font-mono text-[11px] text-error',
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
        'flex items-start gap-2 rounded-md border border-error/30 bg-error/8 px-2.5 py-2 font-mono text-[12px]',
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
                    void sourceFrames(stack ?? '', fetchAssets(location.origin)).then((source) =>
                      report.send(
                        errorReport(system, {
                          extension,
                          error,
                          context,
                          stack: source || undefined,
                        }),
                      ),
                    )
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

type ContributionBoundaryProps = {
  extension: string
  version: number
  variant?: 'inline' | 'block'
  fallback?: ReactNode
  errors?: HTMLElement | null
  children: ReactNode
}

export class ExtensionBoundary extends Component<
  ContributionBoundaryProps,
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
    const thrownJsFrames = stackFrames(error)
    this.setState({
      stack: [thrownJsFrames, info.componentStack?.trim()].filter(Boolean).join('\n') || undefined,
    })
  }
  render() {
    if (this.state.error === undefined)
      return (
        <ExtensionNameContext.Provider value={this.props.extension}>
          {this.props.children}
        </ExtensionNameContext.Provider>
      )
    const { extension, errors: fixedErrorStack } = this.props
    if (fixedErrorStack)
      return createPortal(
        <StackedError extension={extension} footer="a component threw">
          <ErrorCard
            className="border-none bg-transparent"
            error={this.state.error}
            extension={extension}
            stack={this.state.stack}
          />
        </StackedError>,
        fixedErrorStack,
      )
    return (
      <>
        <ErrorCard
          extension={extension}
          error={this.state.error}
          stack={this.state.stack}
          variant={this.props.variant}
        />
        {this.props.fallback}
      </>
    )
  }
}

export function Provided<Input, Value>({
  point,
  input,
  children: renderElementsWithoutHooks,
}: {
  point: Point<Input, Value>
  input: Input
  children: (value: Value | undefined) => ReactNode
}) {
  const caller = useContext(ExtensionNameContext)
  const renderInCallerScope = (value: Value | undefined) => (
    <ExtensionNameContext.Provider value={caller}>
      {renderElementsWithoutHooks(value)}
    </ExtensionNameContext.Provider>
  )
  const provision = provisionOf(useExtensions(), point.point)
  if (!provision) return renderInCallerScope(undefined)
  const use = provision.use as (input: Input) => Value
  const remountOnHookVersion = () => provision.version
  return (
    <ExtensionBoundary
      extension={provision.extension}
      fallback={renderInCallerScope(undefined)}
      key={provision.extension}
      variant="inline"
      version={provision.version}
    >
      <Provide input={input} key={remountOnHookVersion()} render={renderInCallerScope} use={use} />
    </ExtensionBoundary>
  )
}
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
  const collectProvidersInDiscoveryOrder = (index: number, values: readonly Value[]): ReactNode => {
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
        fallback={collectProvidersInDiscoveryOrder(index + 1, values)}
        key={provision.extension}
        variant="inline"
        version={provision.version}
      >
        <Provide
          input={input}
          key={provision.version}
          render={(value) => collectProvidersInDiscoveryOrder(index + 1, [...values, value])}
          use={provision.use as (input: Input) => Value}
        />
      </ExtensionBoundary>
    )
  }
  return collectProvidersInDiscoveryOrder(0, [])
}
export function Rendered<Input extends object>({
  point,
  input,
  children,
}: {
  point: Point<Input & { core: ReactNode }, ReactNode>
  input: Input
  children: ReactNode
}) {
  const caller = useContext(ExtensionNameContext)
  return provisionsOf(useExtensions(), point.point).reduce<ReactNode>(
    (core, provision) => (
      <ExtensionBoundary
        extension={provision.extension}
        fallback={core}
        key={provision.extension}
        variant="inline"
        version={provision.version}
      >
        <Provide
          input={{ ...input, core }}
          key={provision.version}
          render={(rendered) => rendered}
          use={provision.use as (input: Input & { core: ReactNode }) => ReactNode}
        />
      </ExtensionBoundary>
    ),
    <ExtensionNameContext.Provider value={caller}>{children}</ExtensionNameContext.Provider>,
  )
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

export function Slot({
  name,
  variant = 'block',
  separator,
  phone,
  errors,
}: {
  name: SlotName
  variant?: 'inline' | 'block'
  separator?: ReactNode
  phone?: boolean
  errors?: HTMLElement | null
}) {
  const items = slotItems(useExtensions(), name).filter(
    (item) => phone === undefined || item.phone === phone,
  )
  return items.map(({ key, extension, version, component: Item }, index) => (
    <Fragment key={key}>
      {index > 0 && separator}
      <ExtensionBoundary errors={errors} extension={extension} version={version} variant={variant}>
        <Item />
      </ExtensionBoundary>
    </Fragment>
  ))
}

function StackedError({
  extension,
  footer,
  children,
}: {
  extension: string
  footer: string
  children: ReactNode
}) {
  const system = useSystem()
  return (
    <div className="pointer-events-auto rounded-md border border-error/30 bg-popover/95 shadow-lg backdrop-blur">
      {children}
      <div className="flex items-center gap-1.5 px-2.5 pb-2 font-mono text-[10.5px] text-muted-foreground/80">
        <PuzzleIcon className="size-3" />
        {extensionPath(system, extension, '/web.tsx')} · {footer}
      </div>
    </div>
  )
}

export function ExtensionErrors({ ref }: { ref?: Ref<HTMLDivElement> }) {
  const failed = useExtensions().filter((record) => record.error !== undefined)
  return (
    <div className="pointer-events-none fixed top-[calc(env(safe-area-inset-top)+6rem)] right-3 z-40 flex w-96 max-w-[calc(100vw-1.5rem)] flex-col gap-2">
      {failed.map((record) => (
        <StackedError
          extension={record.name}
          footer={record.extension ? 'previous version still running' : 'not loaded'}
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
        </StackedError>
      ))}
      <div className="contents" ref={ref} />
    </div>
  )
}
