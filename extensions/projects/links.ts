import type { RunningProject } from './refs.ts'

export type Page = { hostname: string; protocol: string }

export const onLoopback = ({ hostname }: Page) =>
  /^(127\.0\.0\.1|localhost|\[::1\])$|\.localhost$/.test(hostname)

const port = (url: string) => new URL(url).port || '80'

export function target(project: RunningProject, page: Page) {
  if (project.machine !== undefined) return project.url
  if (onLoopback(page)) return `${project.url}/`
  return project.tailnetPort
    ? `${page.protocol}//${page.hostname}:${project.tailnetPort}/`
    : undefined
}

export const shownPort = (project: RunningProject, page: Page) => {
  if (project.machine !== undefined) {
    try {
      const url = new URL(project.url)
      return `:${url.port || (url.protocol === 'https:' ? '443' : '80')}`
    } catch {
      return '—'
    }
  }
  return onLoopback(page)
    ? `:${port(project.url)}`
    : project.tailnetPort
      ? `:${project.tailnetPort}`
      : '—'
}
