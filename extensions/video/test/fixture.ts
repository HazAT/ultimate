import { afterEach } from 'vitest'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ActionContext } from '../../../server/actions.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { context, prepareHarness } from '../../../server/harness.ts'
import type { OpenHost } from '../../../server/harness.ts'
import { apis, eventHost, openers, temp } from '../../../test/helpers.ts'
import { AntigravityApi } from '../../antigravity/api.ts'
import type { AntigravityService } from '../../antigravity/api.ts'
import { VideoApi } from '../api.ts'
import type { Runner } from '../prepare.ts'
import videoExtension, { actions, docs } from '../server.ts'

const opened = new Set<OpenHost>()
afterEach(async () => {
  for (const host of opened) await host.close()
  opened.clear()
})

export async function fixture(run: Runner, generate?: AntigravityService['generate']) {
  const home = await temp('ultimate-video-')
  const prepared = await prepareHarness({ home, ultimateRoot: home, userHome: home })
  const services = apis()
  if (generate) services.implement(AntigravityApi, { generate })
  const lifecycle = openers()
  let current: OpenHost
  const harness = () => current.harness
  const events = eventHost(harness, 'video')
  const resources = new Map<string, unknown>()
  const host = {
    ...prepared,
    ...services,
    ...events,
    harness,
    onOpen: lifecycle.onOpen,
    notice: (message: string) => {
      throw new Error(message)
    },
    resource: (key: string, create: () => unknown) => {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key)
    },
  } as unknown as ExtensionHost
  prepared.registry.install(videoExtension(host, run))
  const open = async () => {
    current = await prepared.open(false)
    opened.add(current)
    await lifecycle.open()
    harness().resume()
  }
  const close = async () => {
    await lifecycle.close()
    await current.close()
    opened.delete(current)
  }
  await open()
  const action = {
    host,
    conversationId: ROOT_CONVERSATION_ID,
    signal: new AbortController().signal,
  } as ActionContext
  const state = () => harness().snapshot(docs[0], ROOT_CONVERSATION_ID, context)
  return {
    home,
    action,
    open,
    close,
    harness,
    state,
    recent: events.eventLog.recent,
    service: services.need(VideoApi),
    async upload(bytes: Buffer) {
      const { id } = await actions.begin(
        { name: 'clip.mp4', mimeType: 'video/mp4', bytes: bytes.length },
        action,
      )
      await actions.append({ id, offset: 0, data: bytes.toString('base64') }, action)
      await actions.finish({ id }, action)
      return id
    },
    async prepared(id: string) {
      harness().resume()
      const live = await harness().commit(
        async (tx) =>
          (await tx.scanTasks({ kind: 'video.prepare', status: 'pending' }, 10)).items.concat(
            (await tx.scanTasks({ kind: 'video.prepare', status: 'running' }, 10)).items,
          ),
        context,
      )
      for (const task of live) await harness().waitForTask(task.id, context)
      return (await state())?.videos[id]
    },
  }
}
