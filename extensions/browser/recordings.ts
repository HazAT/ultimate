import { constants, renameSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@earendil-works/chord/context'
import {
  ToolResultEntry,
  ToolTask,
  type TaskId,
  type ToolTaskResult,
} from '@earendil-works/pi-durable'
import type { Page } from 'playwright-core'
import { browserVideoId, browserVideoOf } from '../../lib/browser-video.ts'
import { errnoCode, isMissing } from '../../lib/errors.ts'
import type { ExtensionHost } from '../../server/extensions.ts'

const videoName = 'video.webm'
const receiptName = 'receipt.json'

function recordingRoot(home: string) {
  return join(home, 'browser-videos')
}

export async function stageRecording(home: string) {
  const root = recordingRoot(home)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const stat = await lstat(root)
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o777) !== 0o700 ||
    stat.uid !== (process.getuid?.() ?? stat.uid)
  )
    throw new Error('Browser video storage is not a private directory')
  return mkdtemp(join(root, '.recording-'))
}

export async function prepareRecording(staging: string, source: string) {
  if (dirname(source) !== staging || !source.endsWith('.webm'))
    throw new Error('The browser did not save a WebM in the recording directory')
  const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || !stat.size || stat.uid !== (process.getuid?.() ?? stat.uid))
      throw new Error('The browser did not produce a usable WebM video')
    await file.chmod(0o600)
  } finally {
    await file.close()
  }
  const final = join(staging, videoName)
  await rename(source, final)
  for (const name of await readdir(staging)) {
    if (name !== videoName) await rm(join(staging, name), { force: true })
  }
  return final
}

export async function verifyPlayback(page: Page, file: string) {
  await page.goto(pathToFileURL(file).href, { waitUntil: 'domcontentloaded' })
  const playable = await page.evaluate(async () => {
    const video = document.querySelector('video')
    if (!video || video.error || video.networkState === video.NETWORK_NO_SOURCE) return false
    video.pause()
    const waitFor = (name: 'loadeddata' | 'seeked') =>
      new Promise<boolean>((resolve) => {
        const listeners = new AbortController()
        const done = (ok: boolean) => {
          listeners.abort()
          resolve(ok)
        }
        video.addEventListener(name, () => done(true), { signal: listeners.signal })
        video.addEventListener('error', () => done(false), { signal: listeners.signal })
      })
    if (video.readyState < video.HAVE_CURRENT_DATA && !(await waitFor('loadeddata'))) return false
    if (!video.videoWidth || !Number.isFinite(video.duration) || video.duration <= 0) return false
    const target = video.duration / 2
    if (!video.seekable.length || video.seekable.end(video.seekable.length - 1) < target)
      return false
    const sought = waitFor('seeked')
    video.currentTime = target
    return (await sought) && !video.error && video.readyState >= video.HAVE_CURRENT_DATA
  })
  if (!playable) throw new Error('Chromium could not decode and seek the recorded WebM video')
}

export async function finalizeRecording(staging: string, id: string, taskId: TaskId, ctx: Context) {
  await writeFile(join(staging, receiptName), JSON.stringify(taskId), { flag: 'wx', mode: 0o600 })
  ctx.abortSignal?.throwIfAborted()
  renameSync(staging, join(dirname(staging), id))
}

export async function discardRecording(home: string, id: string) {
  if (browserVideoId.test(id))
    await rm(join(recordingRoot(home), id), { force: true, recursive: true })
}

function ownerOnly(stat: { uid: number; mode: number }) {
  return stat.uid === (process.getuid?.() ?? stat.uid) && !(stat.mode & 0o077)
}

async function openPrivateFile(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let keep = false
  try {
    const stat = await file.stat()
    keep = stat.isFile() && stat.size > 0 && ownerOnly(stat)
    if (keep) return file
  } finally {
    if (!keep) await file.close()
  }
  return undefined
}

async function readReceipt(path: string) {
  const file = await openPrivateFile(path)
  if (!file) return undefined
  try {
    const receipt: unknown = JSON.parse(await file.readFile('utf8'))
    if (typeof receipt === 'number' && Number.isSafeInteger(receipt) && receipt > 0)
      return receipt as TaskId<ToolTaskResult>
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
  } finally {
    await file.close()
  }
  return undefined
}

export async function openRecording(host: ExtensionHost, id: string, ctx: Context) {
  if (!browserVideoId.test(id)) return undefined
  const root = recordingRoot(host.home)
  const directory = join(root, id)
  try {
    for (const path of [root, directory]) {
      const stat = await lstat(path)
      if (!stat.isDirectory() || !ownerOnly(stat)) return undefined
    }
    const receipt = await readReceipt(join(directory, receiptName))
    if (!receipt) return undefined
    const harness = host.harness()
    const task = await harness.getTask(receipt, ctx)
    if (
      task?.kind !== ToolTask.definition.name ||
      task.state.status !== 'terminal' ||
      task.state.outcome.status !== 'completed' ||
      task.state.outcome.result.kind !== 'model'
    )
      return undefined
    const { entryId } = task.state.outcome.result
    const entry = await harness.commit((tx) => tx.entry(ToolResultEntry, entryId), ctx)
    if (entry?.conversationId !== task.conversationId) return undefined
    const message = entry.model?.[0]
    if (message?.role !== 'toolResult' || message.toolName !== 'browser_video' || message.isError)
      return undefined
    const clip = browserVideoOf(message.details)
    if (clip?.id !== id) return undefined
    const file = await openPrivateFile(join(directory, videoName))
    if (file) return { file, clip, conversation: task.conversationId }
  } catch (error) {
    if (!isMissing(error) && errnoCode(error) !== 'ELOOP') throw error
  }
  return undefined
}
