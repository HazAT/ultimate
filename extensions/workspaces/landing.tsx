import type { ConversationId } from '@earendil-works/pi-durable'
import { cn } from 'cn'
import { ArrowUpRightIcon, SquareArrowOutUpRightIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { api, plural, Provided, useConversationSummary, useUltimate } from '@/sdk'
import { Review } from './landing-points.ts'
import { GithubAction, RepoAction } from './refs.ts'
import type { GithubRepo } from './refs.ts'

export function Open({
  id,
  className,
  label,
  entry,
}: {
  id: ConversationId
  className?: string
  label?: string
  entry?: number
}) {
  const { switchConversation } = useUltimate()
  const busy = useConversationSummary(id)?.busy
  return (
    <Button
      className={cn(
        'h-5 shrink-0 gap-1 px-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground',
        className,
      )}
      onClick={() => switchConversation(id)}
      size="xs"
      title={`Show conversation #${id}`}
      variant="ghost"
    >
      {busy && <span className="size-1.5 shrink-0 animate-pulse-dot rounded-full bg-brand" />}
      <SquareArrowOutUpRightIcon className="size-3" />
      open {label ? `${label} ` : ''}#{id}
      {entry !== undefined ? `/${entry}` : ''}
    </Button>
  )
}

let githubRepoOncePerPage: Promise<string | null> | undefined
export function useGithubRepo() {
  const [url, setUrl] = useState<string | null>()
  useEffect(() => {
    githubRepoOncePerPage ??= api.action(GithubAction).catch(() => null)
    let live = true
    void githubRepoOncePerPage.then((value) => live && setUrl(value))
    return () => {
      live = false
    }
  }, [])
  return url
}

let projectRepoOncePerPage: Promise<GithubRepo | null> | undefined
export function useProjectRepo() {
  const [value, setValue] = useState<GithubRepo | null>()
  useEffect(() => {
    projectRepoOncePerPage ??= api.action(RepoAction).catch(() => null)
    let live = true
    void projectRepoOncePerPage.then((found) => live && setValue(found))
    return () => {
      live = false
    }
  }, [])
  return value
}

const external = (href: string, children: ReactNode, className?: string) => (
  <a
    className={cn(
      'inline-flex shrink-0 items-center gap-0.5 hover:text-foreground hover:underline',
      className,
    )}
    href={href}
    rel="noreferrer"
    target="_blank"
    title={`Compare on DiffsHub: ${href.replace(/^https:\/\/diffshub\.com\//, '')}`}
  >
    {children}
    <ArrowUpRightIcon className="size-2.5 opacity-60" />
  </a>
)

export function CommitCount({
  count,
  href,
  range,
  className,
}: {
  count: number
  href?: string
  range?: string
  className?: string
}) {
  const label = plural(count, 'commit')
  const plain = href ? (
    external(href, label, className)
  ) : (
    <span className={cn('shrink-0', className)}>{label}</span>
  )
  if (!range) return plain
  return (
    <Provided input={range} point={Review}>
      {(open) =>
        open ? (
          <span className={cn('inline-flex shrink-0 items-center gap-1', className)}>
            <button
              className="cursor-pointer hover:text-foreground hover:underline"
              onClick={open}
              title={`Review ${range.replace(/\b([0-9a-f]{7})[0-9a-f]{33}\b/g, '$1')}`}
              type="button"
            >
              {label}
            </button>
            {href && external(href, null)}
          </span>
        ) : (
          plain
        )
      }
    </Provided>
  )
}
