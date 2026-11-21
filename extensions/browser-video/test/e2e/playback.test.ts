import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from '@earendil-works/pi-ai/providers/faux'
import { ROOT_CONVERSATION_ID, type ConversationId } from '@earendil-works/pi-durable'
import { chromium, type Locator, type Page } from 'playwright-core'
import { expect, it, onTestFinished } from 'vitest'
import { browserVideoOf } from '../../../../lib/browser-video.ts'
import { git } from '../../../../lib/git.ts'
import { context } from '../../../../server/harness.ts'
import { branchProbe, fauxServer, sourceCopy, temp, until } from '../../../../test/helpers.ts'
import { browserBinary } from '../../../browser/server.ts'
import { Started } from '../../../messages/addresses.ts'
import { Messages } from '../../../messages/api.ts'
import { append } from '../../../messages/log.ts'
import type { WorkspaceInfo } from '../../../workspaces/types.ts'

const demoUrl = (name: string) =>
  `data:text/html,${encodeURIComponent(`<!doctype html>
<title>${name} recipes</title>
<style>body{font:26px system-ui;color:#f6f7fb;background:#17293a;padding:3rem}
#recipe{width:5rem;height:5rem;background:#ffd86b;margin-top:1rem;transition:transform 1.2s linear}
#recipe.saved{transform:translateX(18rem)}</style>
<h1>${name} recipes</h1><button id="save">Save ${name} recipe</button>
<div id="recipe"></div><p id="status">Ready</p>
<script>const recipe = document.querySelector('#recipe');
document.querySelector('#save').onclick=()=>recipe.className='saved';
recipe.ontransitionend=()=>document.querySelector('#status').textContent='${name} recipe saved';</script>`)}`

function record(name: string) {
  return fauxAssistantMessage(
    fauxToolCall(
      'browser_video',
      {
        url: demoUrl(name),
        synthetic: true,
        steps: [{ click: '#save' }, { wait: `#status:text-is("${name} recipe saved")` }],
      },
      { id: `record-${name}` },
    ),
    { stopReason: 'toolUse' },
  )
}

async function play(page: Page, container: Locator, playButton: Locator, clip: string) {
  const video = container.locator('video')
  await playButton.waitFor()
  expect(await video.count()).toBe(0)
  const request = page.waitForResponse((response) => new URL(response.url()).pathname === clip)
  await playButton.click()
  expect((await request).ok()).toBe(true)
  await until(() =>
    video.evaluate((player) => {
      const v = player as HTMLVideoElement
      return v.videoWidth > 0 && v.played.length > 0 && v.played.end(0) > 0.1
    }),
  )
  expect(
    await video.evaluate(async (player, expected) => {
      const v = player as HTMLVideoElement
      v.pause()
      const seeked = new Promise<void>((done) =>
        v.addEventListener('seeked', () => done(), { once: true }),
      )
      const target = v.duration * 0.65
      v.currentTime = target
      await seeked
      return {
        source: new URL(v.currentSrc).pathname === expected,
        decoded: v.getVideoPlaybackQuality().totalVideoFrames > 0,
        seeked: v.currentTime > 0.4 && Math.abs(v.currentTime - target) < 0.1,
      }
    }, clip),
  ).toEqual({ source: true, decoded: true, seeked: true })
}

it('records only opted-in browser calls and plays the earlier, agent-selected clip in the transcript, real question, Inbox and landing', async () => {
  const home = await temp('ultimate-browser-video-')
  const projectRoot = join(home, 'project')
  await mkdir(join(home, '.ultimate'))
  await writeFile(join(home, '.ultimate/settings.json'), '{"extensions":{"disable":["update"]}}')
  await mkdir(projectRoot)
  await git(projectRoot, 'init', '-b', 'main')
  await git(projectRoot, 'config', 'user.email', 'fixture@example.test')
  await git(projectRoot, 'config', 'user.name', 'Fixture')
  await git(projectRoot, 'commit', '--allow-empty', '-m', 'Initial')
  const ultimateRoot = await sourceCopy(home)
  await branchProbe(ultimateRoot)
  const server = await fauxServer({
    ultimateRoot,
    projectRoot,
    home: join(home, 'state'),
    userHome: home,
    port: 0,
  })
  onTestFinished(() => server.close())
  const starter = await server.harness.createConversation(
    { ownership: { kind: 'ownerless' } },
    context,
  )
  const signal = new AbortController().signal
  const { id } = (await server.extensions.invoke(
    'branch-probe',
    'branch',
    {
      from: server.root.id,
      by: starter.id,
      deliver: false,
      isolated: true,
      prompt: 'Review the recipe interaction',
    },
    signal,
  )) as { id: ConversationId }
  const branch = (await server.harness.conversation(id, context))!
  await server.harness.commit(async (tx) => {
    ;(await tx.doc(Started, id)).by = starter.id
  }, context)
  const log = () => server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context)
  const ask = (text: string, video: string, reply = true) =>
    fauxAssistantMessage(
      fauxToolCall(
        'message',
        {
          to: 'user',
          text,
          video,
          reply,
          ...(reply
            ? { questions: [{ text: 'Keep the Lemon interaction?', kind: 'confirm' }] }
            : {}),
        },
        { id: text },
      ),
      { stopReason: 'toolUse' },
    )

  let earlier = ''
  let newer = ''
  const route: FauxResponseFactory = ({ messages }) => {
    server.host.faux!.appendResponses([route])
    const last = messages.findLast((message) => message.role !== 'system')
    if (last?.role === 'user' && last.content === 'Exercise the recipe change')
      return record('Lemon')
    if (last?.role === 'toolResult' && last.toolCallId === 'record-Lemon' && !last.isError) {
      earlier = browserVideoOf(last.details)?.id ?? ''
      return record('Mint')
    }
    if (last?.role === 'toolResult' && last.toolCallId === 'record-Mint' && !last.isError) {
      newer = browserVideoOf(last.details)?.id ?? ''
      return fauxAssistantMessage(
        ['Before', 'After'].map((name) =>
          fauxToolCall(
            'browser',
            {
              url: demoUrl(name),
              steps: [{ eval: 'document.title' }],
            },
            { id: `frame-${name}` },
          ),
        ),
        { stopReason: 'toolUse' },
      )
    }
    if (last?.role === 'toolResult' && last.toolCallId === 'frame-After')
      return ask('One-way video', earlier, false)
    if (last?.role === 'toolResult' && last.toolCallId === 'One-way video' && last.isError)
      return ask('Unknown clip', '00000000-0000-4000-8000-000000000000')
    if (last?.role === 'toolResult' && last.toolCallId === 'Unknown clip' && last.isError)
      return ask('Review the Lemon recipe change.', earlier)
    if (last?.role === 'user' && last.content === 'Land the recipe fixture')
      return fauxAssistantMessage(
        fauxToolCall('workspace', { action: 'submit', divergence: 'None' }),
        { stopReason: 'toolUse' },
      )
    return fauxAssistantMessage('Ready.')
  }
  server.host.faux!.setResponses([route])
  await (
    await branch.submit({ type: 'input', content: 'Exercise the recipe change' }, context)
  ).wait(context)
  const toolResults = (await branch.context(context)).messages.filter(
    (m) => m.role === 'toolResult',
  )
  expect(toolResults.filter((m) => m.toolName === 'browser_video' && m.isError)).toEqual([])
  expect(earlier).toHaveLength(36)
  expect(newer).toHaveLength(36)
  expect(earlier).not.toBe(newer)
  expect((await readdir(join(home, 'state', 'browser-videos'))).toSorted()).toEqual(
    [earlier, newer].toSorted(),
  )
  const sent = (await log())!.messages.filter((item) => item.from === id && item.to === 'user')
  expect(sent).toHaveLength(1)
  const [message] = sent
  expect(message).toMatchObject({
    video: { id: earlier, title: 'Lemon recipes' },
    text: 'Review the Lemon recipe change.',
  })

  const clip = `/api/extensions/browser/files/${earlier}/video`
  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    env: { ...process.env, TMPDIR: undefined },
  })
  onTestFinished(() => browser.close())
  const transcript = await browser.newPage()
  await transcript.goto(`${server.url}/?conversation=${id}`)
  const transcriptResult = transcript.locator(
    `[data-browser-video="tool"][data-browser-clip="${earlier}"]`,
  )
  await play(
    transcript,
    transcriptResult,
    transcriptResult.getByRole('button', { name: /Play video/i }),
    clip,
  )
  const asked = await browser.newPage({ viewport: { width: 390, height: 844 } })
  const requests: string[] = []
  asked.on('request', (req) => {
    if (new URL(req.url()).pathname.startsWith('/api/extensions/browser/files/'))
      requests.push(req.url())
  })
  await asked.goto(`${server.url}/?conversation=${id}`)
  const questionCard = asked.locator(`[data-message-outgoing="${message.id}"]`)
  await questionCard.locator('[data-reel-chip]').waitFor()
  expect(requests).toEqual([])
  await play(asked, questionCard, questionCard.getByRole('button', { name: /Play video/i }), clip)

  const inbox = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await inbox.goto(`${server.url}/?inbox=${message.id}`)
  const reading = inbox.locator(`[data-inbox-item="${message.id}"]`)
  await reading.locator('[data-reel-chip]').waitFor()
  await play(inbox, reading, reading.getByRole('button', { name: /Play video/i }), clip)
  await reading.getByRole('button', { name: /Option 1 · Yes · question 1/ }).click()
  await reading
    .getByRole('button', { name: `Send: answer to message ${message.id}`, exact: true })
    .click()
  await until(
    async () =>
      (await log())?.messages.some((m) => m.re === message.id && m.from === 'user') === true,
  )

  await server.harness.commit(async (tx) => {
    for (let i = 0; i < 300; i++)
      await append(tx, {
        from: id,
        to: 'user',
        text: 'Fixture note',
        reply: false,
        state: 'delivered',
      })
  }, context)
  expect((await log())?.messages.some((item) => item.id === message.id)).toBe(false)

  const worktree = (await server.extensions.invoke(
    'workspaces',
    'info',
    { id },
    signal,
  )) as WorkspaceInfo
  await writeFile(join(worktree.path, 'recipe.txt'), 'Lemon recipe\n')
  await git(worktree.path, 'add', 'recipe.txt')
  await git(worktree.path, 'commit', '-m', 'Keep the Lemon recipe')
  const tip = await git(worktree.path, 'rev-parse', 'HEAD')
  await (
    await branch.submit({ type: 'input', content: 'Land the recipe fixture' }, context)
  ).wait(context)
  await until(async () =>
    (await starter.context(context)).entries.some(
      (entry) => entry.kind === 'workspaces.lander-report',
    ),
  )
  expect(await git(projectRoot, 'rev-parse', 'main')).toBe(tip)
  const report = await browser.newPage()
  await report.goto(`${server.url}/?conversation=${starter.id}`)
  const landing = report.locator('[data-lander-report="landed"] [data-landing="landed"]')
  await landing.getByRole('button', { name: /Show browser videos for landing/ }).click()
  const landingClip = landing.locator('[data-browser-clip]').first()
  await landingClip.waitFor()
  expect(await landingClip.getAttribute('data-browser-clip')).toBe(earlier)
  await play(report, landingClip, landingClip.getByRole('button', { name: /Play video/i }), clip)
})
