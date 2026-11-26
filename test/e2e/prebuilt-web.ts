import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import type { TestProject } from 'vitest/node'
import { createWeb } from '../../server/web.ts'
import { copySource } from '../source-copy.ts'
import { testTempPrefix } from '../sweep-temp.ts'

declare module 'vitest' {
  interface ProvidedContext {
    /** One source copy shared by servers that only serve it, and its production web bundle (`web` in a home). */
    prebuiltWeb: { root: string; web: string; bundle: string }
  }
}

/**
 * Build the web UI once per run. Each fixture home otherwise ran its own 5 s production build on its first page load,
 * and under load (25 s and more) that build alone overran browser steps and 60 s tests.
 */
export default async function buildOnce(project: TestProject) {
  const folder = await realpath(await mkdtemp(join(tmpdir(), `${testTempPrefix}${process.pid}-`)))
  const root = join(folder, 'source')
  const userHome = join(folder, 'user')
  await copySource(root)
  new ProjectTrustStore(join(userHome, '.ultimate')).set(root, true)
  const notices: string[] = []
  const web = await createWeb({
    ultimateRoot: root,
    projectRoot: root,
    userHome,
    home: folder,
    watch: () => () => {},
    before: async () => {},
    held: () => false,
    pages: () => 1,
    changed: () => {},
    notice: (message) => notices.push(message),
  })
  await web.rebuild()
  await web.close()
  if (notices.length || !web.info().id)
    throw new Error(`The web UI did not build: ${notices.join('\n')}`)
  project.provide('prebuiltWeb', { root, web: join(folder, 'web'), bundle: web.info().id })
  return () => rm(folder, { recursive: true, force: true })
}
