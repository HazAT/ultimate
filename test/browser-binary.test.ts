import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { browserCandidates } from '../extensions/browser/server.ts'
import { temp } from './helpers.ts'

it('tries the macOS system browsers and the Playwright cache under Library/Caches, newest first', async () => {
  const home = await temp()
  for (const revision of ['chromium-1208', 'chromium-1243', 'chromium_headless_shell-1208'])
    await mkdir(join(home, 'Library/Caches/ms-playwright', revision), { recursive: true })
  expect(
    await browserCandidates({ platform: 'darwin', arch: 'arm64', home, override: undefined }),
  ).toEqual([
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    join(
      home,
      'Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    ),
    join(
      home,
      'Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    ),
  ])
})

it('tries the Linux system browsers and the Playwright cache under .cache, after an override', async () => {
  const home = await temp()
  await mkdir(join(home, '.cache/ms-playwright/chromium-1200'), { recursive: true })
  expect(
    await browserCandidates({ platform: 'linux', arch: 'x64', home, override: '/opt/chrome' }),
  ).toEqual([
    '/opt/chrome',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome-stable',
    join(home, '.cache/ms-playwright/chromium-1200/chrome-linux64/chrome'),
  ])
})
