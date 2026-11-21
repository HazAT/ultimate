import { Component, useContext } from 'react'
import type { ComponentType, ErrorInfo, ReactNode } from 'react'
import { errorMessage } from '../sdk/format.ts'
import { ExtensionNameContext, useExtensions } from '../sdk/hooks.ts'
import { island } from '../sdk/island.tsx'
import { islandSolid } from '../sdk/island-mark.ts'
import { provisionOf, provisionsOf, slotItems } from '../sdk/registry.ts'
import { ErrorReport } from '../sdk/types.ts'
import type { Point, SlotName } from '../sdk/types.ts'
import { ErrorCard as SolidErrorCard } from './error-card.solid.tsx'
import type { ErrorCardProps } from './error-card.solid.tsx'
import { stackFrames } from './error-report.ts'

const ErrorCardIsland = island(SolidErrorCard)

export function ErrorCard(props: Omit<ErrorCardProps, 'report'>) {
  if (props.variant === 'inline') return <ErrorCardIsland {...props} />
  return (
    <Provided input={null} point={ErrorReport}>
      {(report) => <ErrorCardIsland {...props} report={report} />}
    </Provided>
  )
}

type ContributionBoundaryProps = {
  extension: string
  version: number
  variant?: 'inline' | 'block'
  fallback?: ReactNode
  onError?: (error: unknown, stack: string | undefined) => void
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
    const stack =
      [thrownJsFrames, info.componentStack?.trim()].filter(Boolean).join('\n') || undefined
    this.setState({ stack })
    this.props.onError?.(error, stack)
  }
  render() {
    if (this.state.error === undefined)
      return (
        <ExtensionNameContext.Provider value={this.props.extension}>
          {this.props.children}
        </ExtensionNameContext.Provider>
      )
    if (this.props.onError) return this.props.fallback
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
  const provider = useContext(ExtensionNameContext)
  if (!islandSolid(use)) return render(use(input))
  const Island = use as unknown as ComponentType<Input & object>
  return render(
    (
      <ExtensionNameContext.Provider value={provider}>
        <Island {...(input as Input & object)} />
      </ExtensionNameContext.Provider>
    ) as Value,
  )
}

export function Slot({
  name,
  variant = 'block',
  phone,
}: {
  name: SlotName
  variant?: 'inline' | 'block'
  phone?: boolean
}) {
  const items = slotItems(useExtensions(), name).filter(
    (item) => phone === undefined || item.phone === phone,
  )
  return items.map(({ key, extension, version, component: Item }) => (
    <ExtensionBoundary extension={extension} key={key} version={version} variant={variant}>
      <Item />
    </ExtensionBoundary>
  ))
}
