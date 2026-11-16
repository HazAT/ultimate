import { access, constants } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { exec as execFile } from '../../lib/exec.ts'
import { namespaceFlags } from './layout.ts'

export const unavailable = (detail: string) =>
  `Sandbox unavailable: ${detail}. Install bubblewrap and allow it user namespaces: on Ubuntu 24.04+ add /etc/apparmor.d/bwrap containing "abi <abi/4.0>, include <tunables/global> profile bwrap /usr/bin/bwrap flags=(unconfined) { userns, }" and run sudo apparmor_parser -r /etc/apparmor.d/bwrap; in a Proxmox CT also set nesting=1. bash, read, write and edit stay blocked for this agent until then.`

async function findBwrap() {
  for (const folder of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(folder, 'bwrap')
    const runnable = await access(candidate, constants.X_OK).then(
      () => true,
      () => false,
    )
    if (runnable) return candidate
  }
  throw new Error(unavailable('bwrap is not installed'))
}

export async function probe() {
  const bwrap = await findBwrap()
  await execFile(bwrap, [
    ...namespaceFlags,
    '--ro-bind',
    '/',
    '/',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    'true',
  ]).catch((error: Error & { stderr?: string }) => {
    throw new Error(
      unavailable(
        `bwrap could not create its namespaces (${(error.stderr || error.message).trim()})`,
      ),
      { cause: error },
    )
  })
  return bwrap
}
