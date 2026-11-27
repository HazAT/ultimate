import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineExtension } from '@earendil-works/pi-durable'
import { implementAction } from '../../lib/actions.ts'
import { contractOutline } from '../../lib/api-files.ts'
import {
  extensionLists,
  toggleExtension,
  updateSettings,
  userSettingsPath,
} from '../../lib/settings.ts'
import type { ExtensionAction } from '../../server/actions.ts'
import {
  AdoptProjectSetupAction,
  DecideAction,
  DetailsAction,
  ExtensionsAction,
  SetExtensionAction,
} from './refs.ts'

export default defineExtension({ name: 'manager' })

export const userActions = ['decide', 'setExtension', 'adoptProjectSetup']

export const actions: Record<string, ExtensionAction> = {
  decide: implementAction(DecideAction, async (args, { host }) => {
    if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.local !== 'boolean')
      throw new Error('local must be a boolean')
    await host.setProjectDecision(args.local)
    return { project: await host.projectSetup() }
  }),
  setExtension: implementAction(SetExtensionAction, async (args, { host }) => {
    if (
      !args ||
      typeof args !== 'object' ||
      Array.isArray(args) ||
      typeof args.name !== 'string' ||
      !args.name.trim() ||
      typeof args.enabled !== 'boolean' ||
      (args.scope !== 'project' && args.scope !== 'user')
    )
      throw new Error('Expected name, enabled boolean, and scope project or user')
    if (args.scope === 'project' && (await host.projectSetup()).decision !== true)
      throw new Error("Choose this project's local setup before changing project extensions")
    const path = join(
      args.scope === 'project' ? host.projectRoot : host.userHome,
      '.ultimate/settings.json',
    )
    await updateSettings(path, (value) =>
      toggleExtension(extensionLists(value), args.name as string, args.enabled as boolean),
    )
    await host.reloadExtensions()
    return { ok: true }
  }),
  adoptProjectSetup: implementAction(AdoptProjectSetupAction, async (_args, { host }) => {
    if ((await host.projectSetup()).decision !== true)
      throw new Error("Choose this project's local setup before adopting project extensions")
    const project = extensionLists(await host.projectSettings())
    if (
      !(project.enable as string[] | undefined)?.length &&
      !(project.disable as string[] | undefined)?.length
    )
      return { ok: true }
    await updateSettings(userSettingsPath(host.userHome), (value) => {
      const extensions = extensionLists(value)
      for (const [key, enabled] of [
        ['enable', true],
        ['disable', false],
      ] as const)
        for (const name of (project[key] as string[]) ?? [])
          toggleExtension(extensions, name, enabled)
    })
    await host.reloadExtensions()
    return { ok: true }
  }),
  details: implementAction(DetailsAction, async (args, { host }) => {
    const name = args && typeof args === 'object' && !Array.isArray(args) ? args.name : undefined
    const folder = host.extensions().find((entry) => entry.name === name)
    if (typeof name !== 'string' || !folder)
      throw new Error(`Unknown extension ${JSON.stringify(name)}`)
    const { apis } = host.catalogue()
    const matching = (pick: (api: (typeof apis)[number]) => boolean) =>
      apis.filter(pick).map((api) => api.name)
    return {
      ...(await contractOutline(folder)),
      provides: matching((api) => api.provider === name),
      declares: matching((api) => api.owner === name && api.provider !== name),
      needs: matching((api) => api.needs.includes(name)),
      wants: matching((api) => api.wants.includes(name)),
    }
  }),
  extensions: implementAction(ExtensionsAction, async (_args, { host }) => {
    const project = await host.projectExtensions()
    return Promise.all(
      [
        ...host
          .extensions()
          .filter((entry) => !project.some((folder) => folder.name === entry.name)),
        ...project,
      ].map(async (entry) => {
        const readme = await readFile(join(entry.path, 'README.md'), 'utf8').catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
            return ''
          },
        )
        const paragraph =
          readme
            .replace(/^#+ .*\n+/u, '')
            .trim()
            .split(/\n\s*\n/u)[0] ?? ''
        return {
          name: entry.name,
          source: entry.source,
          ...(entry.replaces ? { replaces: entry.replaces } : {}),
          enabled: entry.enabled,
          layer: entry.layer,
          readme: paragraph.match(/^.*?[.!?](?:\s|$)/su)?.[0].trim() ?? paragraph,
        }
      }),
    )
  }),
}
