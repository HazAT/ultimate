/** Where the rail's tiles go, from the page they are shown on. Pure and browser-safe. */
import type { RunningProject } from './refs.ts'

/** The page's own address: `location` has both. */
export type Page = { hostname: string; protocol: string }

/** A page on this machine's own loopback; any other page came over the tailnet, where loopback addresses mean nothing. */
export const onLoopback = ({ hostname }: Page) =>
  /^(127\.0\.0\.1|localhost|\[::1\])$|\.localhost$/.test(hostname)

const port = (url: string) => new URL(url).port || '80'

/**
 * Where a tile goes: the instance's loopback address from a loopback page, else the host this page came from on the
 * project's Tailscale port, which is nothing for a project that is not published on the tailnet.
 */
export function target(project: RunningProject, page: Page) {
  if (onLoopback(page)) return `${project.url}/`
  return project.tailnetPort
    ? `${page.protocol}//${page.hostname}:${project.tailnetPort}/`
    : undefined
}

/** The port a tile names, the one it goes to; `—` for a project the tailnet does not reach. */
export const shownPort = (project: RunningProject, page: Page) =>
  onLoopback(page) ? `:${port(project.url)}` : project.tailnetPort ? `:${project.tailnetPort}` : '—'
