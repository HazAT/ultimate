/** Where the rail's tiles go, from the page they are shown on. Pure and browser-safe. */
import type { RunningProject } from './refs.ts'

/** The page's own address: `location` has both. */
export type Page = { hostname: string; protocol: string }

/** A page on this machine's own loopback; any other page came over the tailnet, where loopback addresses mean nothing. */
export const onLoopback = ({ hostname }: Page) =>
  /^(127\.0\.0\.1|localhost|\[::1\])$|\.localhost$/.test(hostname)

const port = (url: string) => new URL(url).port || '80'

/**
 * Where a tile goes: a remote's configured URL unchanged; on this machine, the instance's loopback address from a
 * loopback page, else this page's host on the project's Tailscale port, or nothing when not published.
 */
export function target(project: RunningProject, page: Page) {
  if (project.machine !== undefined) return project.url
  if (onLoopback(page)) return `${project.url}/`
  return project.tailnetPort
    ? `${page.protocol}//${page.hostname}:${project.tailnetPort}/`
    : undefined
}

/** The port a tile names, the one it goes to; `—` when unreachable or a configured URL cannot be parsed. */
export const shownPort = (project: RunningProject, page: Page) => {
  if (project.machine !== undefined) {
    try {
      const url = new URL(project.url)
      return `:${url.port || (url.protocol === 'https:' ? '443' : '80')}`
    } catch {
      // A malformed user-configured URL must not stop the rest of the rail rendering.
      return '—'
    }
  }
  return onLoopback(page)
    ? `:${port(project.url)}`
    : project.tailnetPort
      ? `:${project.tailnetPort}`
      : '—'
}
