import type { JsonValue } from '@earendil-works/chord'
import { defineExtension } from '@earendil-works/pi-durable'
import type { JsonObject } from '@earendil-works/pi-durable'
import { join } from 'node:path'
import { readSettings, userSettingsPath } from '../../../lib/settings.ts'
import type { ActionContext } from '../../../server/actions.ts'
import { dropRoots, findFiles, maxDropBytes, saveFile } from './files.ts'

export default defineExtension({ name: 'drop' })

function field(args: JsonValue, key: string): unknown {
  return args !== null && typeof args === 'object' && !Array.isArray(args) ? args[key] : undefined
}

function text(args: JsonValue, key: string): string {
  const value = field(args, key)
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Expected the value in ${key}`)
  return value
}

/** A folder someone named in `drop.roots`, with `~/` meaning the user's home. */
function folder(entry: string, userHome: string): string {
  return entry.startsWith('~/') ? join(userHome, entry.slice(2)) : entry
}

function folders(value: unknown, userHome: string): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === 'string' && entry !== '')
        .map((entry) => folder(entry, userHome))
    : []
}

/** `drop.roots`: extra folders to look a dropped file up in, the project's extending the user's. */
async function configured(ctx: ActionContext): Promise<string[]> {
  const { host } = ctx
  const user: JsonObject = await readSettings(userSettingsPath(host.userHome)).catch(() => ({}))
  const project = await host.projectSettings()
  return [
    ...folders(user['drop.roots'], host.userHome),
    ...folders(project['drop.roots'], host.userHome),
  ]
}

export const actions = {
  /** Where a file named `name` is on this machine: `{ paths }`, at most eight absolute paths, shallow ones first. */
  async resolve(args: JsonValue, ctx: ActionContext) {
    const roots = dropRoots(
      { userHome: ctx.host.userHome, home: ctx.host.home, projectRoot: ctx.host.projectRoot },
      await configured(ctx),
    )
    return { paths: await findFiles(roots, text(args, 'name')) }
  },

  /**
   * Copy a dropped file into the conversation's own folder under the state home: `{ name, data }` with `data` base64,
   * up to 8 MiB, answering `{ path }` with where it was written.
   */
  async save(args: JsonValue, ctx: ActionContext) {
    const name = text(args, 'name')
    const data = field(args, 'data')
    if (typeof data !== 'string' || !data) throw new Error(`Expected the file's bytes in data`)
    const bytes = Buffer.from(data, 'base64')
    if (bytes.length === 0) throw new Error(`${name} carried no bytes`)
    if (bytes.length > maxDropBytes)
      throw new Error(`${name} is larger than 8 MiB; drop its path instead of its contents`)
    const directory = join(ctx.host.home, 'attachments', String(ctx.conversationId ?? 'none'))
    return { path: await saveFile(directory, name, bytes) }
  },
}
