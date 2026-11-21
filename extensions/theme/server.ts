import { watch } from 'node:fs'
import { dirname, basename } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineExtension } from '@earendil-works/pi-durable'
import type { JsonObject } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { inProcess } from '../../lib/errors.ts'
import { readSettings, updateSettings, userSettingsPath } from '../../lib/settings.ts'
import { SetThemeAction, ThemeAction, ThemeChanged } from './refs.ts'
import type { Theme } from './refs.ts'

const themeIn = (settings: JsonObject): Theme | null =>
  settings.theme === 'light' || settings.theme === 'dark' ? settings.theme : null

const readTheme = async (path: string) => themeIn(await readSettings(path).catch(() => ({})))

export const actions = {
  get: implementAction(ThemeAction, (_args, { host }) =>
    readTheme(userSettingsPath(host.userHome)),
  ),
  set: implementAction(SetThemeAction, async (theme, { host }) => {
    if (theme !== 'light' && theme !== 'dark')
      throw new Error(`Not a theme: ${JSON.stringify(theme)}`)
    await updateSettings(userSettingsPath(host.userHome), (settings) => {
      settings.theme = theme
    })
    return null
  }),
}

export default function themeExtension(host: ExtensionHost) {
  host.onOpen(async () => {
    const path = userSettingsPath(host.userHome)
    let known = await readTheme(path)
    const watcher = watch(dirname(path), (_event, name) => {
      if (name !== basename(path)) return
      inProcess(
        'a missed change is applied by the next page load, which reads the file',
        readTheme(path)
          .then(async (next) => {
            if (next === known) return
            known = next
            await host
              .harness()
              .commit((tx) => host.emit(tx, ThemeChanged, { theme: next }), context)
          })
          .catch((error: unknown) => host.notice(`Theme: ${String(error)}`)),
      )
    })
    host.onClose(async () => watcher.close())
  })
  return defineExtension({ name: 'theme' })
}
