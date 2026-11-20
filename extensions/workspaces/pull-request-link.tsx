import type { ReactNode } from 'react'
import { parsePullRequest } from '@/components/ai/mentions'
import { useGithubRepo } from './landing.tsx'

export function PullRequestLink({
  href,
  children,
  core,
}: {
  href: string
  children: ReactNode
  core: ReactNode
}) {
  const number = parsePullRequest(href)
  const github = useGithubRepo()
  if (!number || !github) return core
  return (
    <a
      className="font-medium text-primary underline"
      data-pull-request={number}
      href={`https://${github}/pull/${number}`}
      rel="noreferrer"
      target="_blank"
    >
      {children}
    </a>
  )
}
