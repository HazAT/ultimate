import type { ReactNode } from 'react'
import { cn, useAction, useSystem } from '@/sdk'
import type { ExtensionInfo, SystemInfo } from '@/sdk'
import { ExtensionsAction } from './refs.ts'

/** The Extensions panel's setup entry point; the overlay routes it to @ultimate, not a dialog. */
export const projectDialog = 'onboarding.project'
/** The start page's Isolated switch entry point; the overlay routes it to @ultimate. */
export const gitDialog = 'onboarding.git'
/** ⌘K Get ready…: the first run again, whatever the recorded state. */
export const firstRunDialog = 'onboarding.first-run'

export const sources: Record<ExtensionInfo['source'], string> = {
  builtin: 'built-in',
  user: 'yours',
  project: 'this project',
}

/**
 * Each extension's line by name, and whether a project folder replaces a built-in of that name; read when mounted and
 * again when the set of extension folders changes.
 */
export function useDescribed() {
  const system = useSystem()
  const folders = system?.extensions.map((extension) => extension.path)
  const described = useAction(ExtensionsAction, null, { on: folders })
  const entry = (name: string) => described.data?.find((candidate) => candidate.name === name)
  return {
    /** With `source`, the line of that folder: a built-in a project folder replaces has its own. */
    line: (name: string, source?: ExtensionInfo['source']) => {
      const known = entry(name)
      if (known && (!source || known.source === source)) return known.readme
      const readme = system?.extensions.find((extension) => extension.name === name)?.readme
      return readme && !readme.startsWith('#') ? readme : ''
    },
    replaces: (name: string) => entry(name)?.replaces === 'builtin',
  }
}

/** The names a project's `.ultimate/settings.json` enables and disables. */
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

/** A README line with its `code` spans set in monospace. */
export function Line({ text, className }: { text: string; className?: string }) {
  if (!text) return null
  return (
    <span className={className} title={text.replaceAll('`', '')}>
      {text.split('`').map((part, index) =>
        index % 2 ? (
          // oxlint-disable-next-line react/no-array-index-key -- Code span positions in split text.
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

/** A small section heading with a meta value on the right, as in the Agents and Info panels. */
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

/** Two or three exclusive choices as one control; `value` null selects none. */
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
