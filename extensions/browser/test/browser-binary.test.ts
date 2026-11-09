import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { playwrightChromiums } from '../server.ts'
import { removeTemps, temp } from '../../../test/helpers.ts'

afterEach(removeTemps)

it('finds Playwright Chromium in the macOS cache, newest build first', async () => {
  const home = await temp()
  const cache = join(home, 'Library/Caches/ms-playwright')
  for (const name of [
    'chromium-998',
    'chromium-1248',
    'chromium-1208',
    'chromium_headless_shell-1248',
  ])
    await mkdir(join(cache, name), { recursive: true })
  const app =
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
  const legacy = 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'
  expect(await playwrightChromiums(home, 'darwin', 'arm64')).toEqual([
    join(cache, 'chromium-1248', app),
    join(cache, 'chromium-1248', legacy),
    join(cache, 'chromium-1208', app),
    join(cache, 'chromium-1208', legacy),
    join(cache, 'chromium-998', app),
    join(cache, 'chromium-998', legacy),
  ])
  expect(await playwrightChromiums(home, 'linux', 'x64')).toEqual([])
})

it('finds Playwright Chromium in the Linux cache, newest build first', async () => {
  const home = await temp()
  const cache = join(home, '.cache/ms-playwright')
  for (const name of [
    'chromium-998',
    'chromium-1248',
    'chromium-1208',
    'chromium_headless_shell-1248',
    'firefox-1490',
    'ffmpeg-1011',
    '.links',
  ])
    await mkdir(join(cache, name), { recursive: true })
  expect(await playwrightChromiums(home, 'linux', 'x64')).toEqual([
    join(cache, 'chromium-1248', 'chrome-linux64/chrome'),
    join(cache, 'chromium-1208', 'chrome-linux64/chrome'),
    join(cache, 'chromium-998', 'chrome-linux64/chrome'),
  ])
  expect(await playwrightChromiums(home, 'darwin', 'arm64')).toEqual([])
})
