import type { ReactNode } from 'react'
import { cn, useAction, useSystem } from '@/sdk'
import type { ExtensionInfo, SystemInfo } from '@/sdk'
import { ExtensionsAction } from './refs.ts'

export const projectDialog = 'onboarding.project'
export const gitDialog = 'onboarding.git'
export const firstRunDialog = 'onboarding.first-run'

export const sources: Record<ExtensionInfo['source'], string> = {
  builtin: 'built-in',
  user: 'yours',
  project: 'this project',
}

export function useDescribed() {
  const system = useSystem()
  const folders = system?.extensions.map((extension) => extension.path)
  const described = useAction(ExtensionsAction, null, { on: folders })
  const entry = (name: string) => described.data?.find((candidate) => candidate.name === name)
  return {
    line: (name: string, source?: ExtensionInfo['source']) => {
      const known = entry(name)
      if (known && (!source || known.source === source)) return known.readme
      const readme = system?.extensions.find((extension) => extension.name === name)?.readme
      return readme && !readme.startsWith('#') ? readme : ''
    },
    replaces: (name: string) => entry(name)?.replaces === 'builtin',
  }
}

export function projectLists(system: SystemInfo) {
  const extensions = system.project.settings.extensions
  const names = (key: string) => {
    const value =
      extensions && typeof extensions === 'object' && !Array.isArray(extensions)
        ? extensions[key]
        : undefined
    return Array.isArray(value)
      ? value.filter((name): name is string => typeof name === 'string')
      : []
  }
  return { enable: names('enable'), disable: names('disable') }
}

export function Line({ text, className }: { text: string; className?: string }) {
  if (!text) return null
  return (
    <span className={className} title={text.replaceAll('`', '')}>
      {text.split('`').map((part, index) =>
        index % 2 ? (
          <code className="font-mono text-[0.92em] text-foreground/75" key={index}>
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </span>
  )
}

export function Heading({
  children,
  meta,
  className,
}: {
  children: ReactNode
  meta?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex items-center gap-2 section-label', className)}>
      {children}
      {meta !== undefined && (
        <span className="ml-auto truncate pl-2 text-muted-foreground/70">{meta}</span>
      )}
    </div>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: T | null
  options: readonly { value: T; label: ReactNode; disabled?: boolean; title?: string }[]
  onChange: (value: T) => void
  label: string
  className?: string
}) {
  return (
    <div
      aria-label={label}
      className={cn(
        'inline-flex rounded-md border border-border/80 bg-background p-0.5 font-mono text-[11px]',
        className,
      )}
      role="group"
    >
      {options.map((option) => (
        <button
          aria-pressed={option.value === value}
          className={cn(
            'flex h-6 flex-1 items-center justify-center gap-1.5 rounded-[5px] px-2 whitespace-nowrap text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-muted-foreground',
            option.value === value && 'bg-accent text-foreground shadow-xs',
          )}
          disabled={option.disabled}
          key={option.value}
          onClick={() => onChange(option.value)}
          title={option.title}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
