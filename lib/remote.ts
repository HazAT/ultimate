/**
 * Another running Ultimate instance of a project, reached over its own API: loopback when it runs on this machine, the
 * address the user set in `remotes` elsewhere, else the tailnet address its machine registered with the cloud.
 * Codemode reads through it and Messages’ Ultimate-to-Ultimate messages travel it. Nothing falls back to a copy.
 */
import { hostname } from 'node:os'
import type { JsonValue } from '@earendil-works/chord/json'
import { cloudConfig, fetchRegister } from './cloud.ts'
import type { Register } from './cloud.ts'
import { projectIdentity } from './project-identity.ts'
import { readSettings, userSettingsPath } from './settings.ts'
import type { ExtensionHost } from '../server/extensions.ts'

/** At most this much JSON comes back from another instance. */
export const REMOTE_BYTES = 1024 * 1024

type LocalProject = { name: string; root?: string; current: boolean; running?: { url: string } }
/** Where a project answers: this project, or another instance's URL with the project and machine it is. */
export type Target =
  | { current: true }
  | { url: string; label: string; name: string; machine?: string }

const naming = (project: string) => (item: { name?: string; key?: string }) =>
  [item.name, item.key].some((value) => value?.toLowerCase() === project.toLowerCase())

/**
 * Where `project` (a name such as `my-app` or a key such as `github.com/acme/my-app`) answers: this project, a
 * running project on this machine, or the tailnet address of the machine that last backed it up. With `machine`, only
 * that machine's instance: this machine's when it is `here`, else that machine's record in the register. Throws a
 * sentence naming the machine when it registered no address.
 */
export function resolveProject(
  project: string,
  local: (LocalProject & { key?: string })[],
  register: Register | undefined,
  machine?: { name: string; here: boolean },
): Target {
  const named = naming(project)
  const here = machine && !machine.here ? [] : local.filter(named)
  if (here.length > 1)
    throw new Error(
      `${project} names ${here.length} projects on this machine: ${here.map((item) => item.root).join(', ')}; use its key`,
    )
  const [found] = here
  if (found?.current) return { current: true }
  if (found?.running)
    return { url: found.running.url, label: `${found.name} on this machine`, name: found.name }
  const entry = register?.projects.find(named)
  if (entry && !machine?.here) {
    const on = machine?.name ?? entry.latest.machine
    const tailnet =
      (on === entry.latest.machine ? entry.latest.tailnet : undefined) ??
      register!.machines.find((item) => item.machine === on)?.projects[entry.hash]?.tailnet
    if (tailnet)
      return { url: tailnet, label: `${entry.name} on ${on}`, name: entry.name, machine: on }
    throw new Error(
      machine
        ? `${entry.name} on ${on} registered no tailnet address`
        : `${entry.name} was last backed up from ${on}, which registered no tailnet address`,
    )
  }
  if (found) throw new Error(`${found.name} is not running on this machine; start it to query it`)
  const known = [
    ...new Set([
      ...local.map((item) => item.name),
      ...(register?.projects ?? []).map((item) => item.name),
    ]),
  ]
  throw new Error(
    `Unknown project ${project}${machine && !machine.here ? ` on ${machine.name}` : ''}${register ? '' : ' (another machine is reached only through remotes in user settings or cloud backups)'}. Known: ${known.join(', ') || 'none'}`,
  )
}

/**
 * The instances the user named in `remotes` (`{ <machine>: { <project>: url } }`, user settings only: a repository must
 * not redirect messages), as `{ machine, name, url }`.
 */
export async function remotes(host: Pick<ExtensionHost, 'userHome'>) {
  // Invalid user settings are reported by the settings loader; treat them as unset here.
  const settings = await readSettings(userSettingsPath(host.userHome)).catch(() => ({}))
  const object = (value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  return Object.entries(object('remotes' in settings ? settings.remotes : undefined)).flatMap(
    ([machine, projects]) =>
      Object.entries(object(projects)).flatMap(([name, url]) =>
        typeof url === 'string' ? [{ machine, name, url }] : [],
      ),
  )
}

/** This machine's name: the cloud's `machine` setting, else the host name. */
async function machineName(host: Pick<ExtensionHost, 'userHome' | 'notice'>) {
  return (await cloudConfig(host))?.machine ?? hostname()
}

/** This instance as another one names it: its project's name and this machine's name. */
export async function selfAddress(host: ExtensionHost) {
  const current = (await host.projects()).find((item) => item.current)
  if (!current) throw new Error('This project is not listed among the projects')
  return { project: current.name, machine: await machineName(host) }
}

/**
 * Where `project` answers: this machine first, then the user's `remotes`, then, as resolveProject decides, the cloud
 * register, read only when neither can answer.
 */
export async function locate(host: ExtensionHost, project: string, machine?: string) {
  const projects = await host.projects()
  const local = await Promise.all(
    projects.map(async (item) => ({
      ...item,
      key: project.includes('/') && item.root ? (await projectIdentity(item.root))?.key : undefined,
    })),
  )
  const here = machine === undefined ? undefined : machine === (await machineName(host))
  const runsHere = local.some((item) => naming(project)(item) && (item.current || item.running))
  if (here !== false && runsHere) return resolveProject(project, local, undefined)
  if (here !== true) {
    const named = (await remotes(host)).filter(
      (item) => naming(project)(item) && (machine === undefined || item.machine === machine),
    )
    if (named.length > 1)
      throw new Error(
        `${project} runs on ${named.map((item) => item.machine).join(', ')} in remotes; name the machine`,
      )
    const [remote] = named
    if (remote)
      return {
        url: remote.url,
        label: `${remote.name} on ${remote.machine}`,
        name: remote.name,
        machine: remote.machine,
      }
  }
  // Anything else asks the cloud's register, when backups are on, where it was last backed up.
  const cloud = here === true ? undefined : await cloudConfig(host)
  // A failing cloud is an error: the register is the only map of the other machines.
  const register = cloud ? await fetchRegister(cloud) : undefined
  return resolveProject(
    project,
    local,
    register,
    machine === undefined ? undefined : { name: machine, here: here! },
  )
}

/** Call extension action `extension/action` with `args` on `target`'s instance; its result, or a sentence naming it. */
export async function postAction(
  target: { url: string; label: string },
  extension: string,
  action: string,
  args: JsonValue,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetch(`${target.url}/api/extensions/${extension}/actions/${action}`, {
    method: 'POST',
    // The instance admits its own origin; on the tailnet, Serve's identity header names who asks.
    headers: { Origin: new URL(target.url).origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ args }),
    signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]),
  }).catch((error: unknown) => {
    throw new Error(`${target.label} did not answer at ${target.url}: ${String(error)}`)
  })
  const text = await response.text()
  if (Buffer.byteLength(text) > REMOTE_BYTES)
    throw new Error(`${target.label} answered more than 1 MiB; ask for a smaller limit`)
  const body = (() => {
    try {
      return JSON.parse(text) as { result?: unknown; error?: string }
    } catch {
      return { error: text.slice(0, 200) }
    }
  })()
  if (response.status === 403)
    throw new Error(
      `${target.label} refused the call (403): your tailnet login is not in its tailscale.allow`,
    )
  if (!response.ok) throw new Error(`${target.label}: ${body.error ?? response.status}`)
  return body.result
}
