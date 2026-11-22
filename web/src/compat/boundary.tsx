import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { errorMessage } from '../sdk/format.ts'
import { ExtensionNameContext } from './conversation-scope.tsx'
import { island } from './island.tsx'
import { Slot as SolidSlot } from '../sdk/parts.solid.tsx'
import { ReportedErrorCard } from '../app/error-stack.solid.tsx'
import { ErrorCard as PlainErrorCard } from '../app/error-card.solid.tsx'
import type { ErrorCardProps } from '../app/error-card.solid.tsx'
import { stackFrames } from '../app/error-report.ts'

const CardWithReport = island(ReportedErrorCard)
const CardWithoutReporter = island(PlainErrorCard)

export function ErrorCard(props: Omit<ErrorCardProps, 'report'>) {
  return props.variant === 'inline' ? (
    <CardWithoutReporter {...props} />
  ) : (
    <CardWithReport {...props} />
  )
}

type ContributionBoundaryProps = {
  extension: string
  version: number
  variant?: 'inline' | 'block'
  fallback?: ReactNode
  onError?: (error: unknown, stack: string | undefined) => void
  onFailed?: () => void
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
    this.props.onFailed?.()
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

/** Any slot by name, each item isolated: one that throws shows its error card and the rest still render. */
export const Slot = island(SolidSlot)
