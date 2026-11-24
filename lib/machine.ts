import { spawnSync } from 'node:child_process'
import { hostname, platform } from 'node:os'

let localHostName: string | undefined

export function machineHostname() {
  if (platform() !== 'darwin') return hostname()
  if (localHostName !== undefined) return localHostName
  const scutil = spawnSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' })
  const local = scutil.status === 0 ? scutil.stdout.trim() : ''
  if (!local) return hostname()
  localHostName = local
  return local
}
