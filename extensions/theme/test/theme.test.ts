import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { afterEach, expect, it } from 'vitest'
import type { ActionContext } from '../../../server/actions.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { prepareHarness } from '../../../server/harness.ts'
import { apis, eventHost, removeTemps, temp, until } from '../../../test/helpers.ts'
import { ThemeChanged } from '../refs.ts'
import themeExtension, { actions } from '../server.ts'

afterEach(removeTemps)

async function project(userHome: string) {
  const home = await temp('ultimate-theme-project-')
  const opened = await (
    await prepareHarness({ home, ultimateRoot: home, userHome, faux: fauxProvider() })
  ).open()
  const events = eventHost(() => opened.harness, 'theme')
  const closers: (() => Promise<void>)[] = []
  const host = {
    userHome,
    ...apis(),
    harness: () => opened.harness,
    emit: events.emit,
    notice: (message: string) => {
      throw new Error(message)
    },
    onOpen: (open: () => Promise<void>) => void open(),
    onClose: (close: () => Promise<void>) => void closers.push(close),
  } as unknown as ExtensionHost
  themeExtension(host)
  return {
    host,
    events,
    stop: async () => {
      for (const close of closers) await close()
    },
  }
}

it('a theme chosen in one project reaches another project of the machine', async () => {
  const userHome = await temp('ultimate-theme-user-')
  const first = await project(userHome)
  const second = await project(userHome)
  try {
    expect(await actions.get(null, { host: second.host } as ActionContext)).toBeNull()
    await actions.set('light', { host: first.host } as ActionContext)
    await until(
      async () => (await second.events.eventLog.recent({ events: [ThemeChanged] })).length > 0,
    )
    expect(await actions.get(null, { host: second.host } as ActionContext)).toBe('light')
    expect(
      (await second.events.eventLog.recent({ events: [ThemeChanged] })).map((event) => event.data),
    ).toEqual([{ theme: 'light' }])
    await expect(actions.set('purple', { host: first.host } as ActionContext)).rejects.toThrow(
      'Not a theme',
    )
  } finally {
    await first.stop()
    await second.stop()
  }
})
