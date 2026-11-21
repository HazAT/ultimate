import { constants, renameSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Page } from 'playwright-core'

const videoName = 'video.webm'

export async function stageRecording(home: string) {
  const root = join(home, 'browser-videos')
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

export function publishRecording(staging: string, id: string) {
  renameSync(staging, join(dirname(staging), id))
}
