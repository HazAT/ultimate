import { ROOT } from '@/sdk'
import { useEffect, useRef } from 'react'
import { api, defineWebExtension, insertIntoComposer, useDocOf, useUltimate } from '@/sdk'
import { StandingAction, StandingDoc } from '../subagents/ui.tsx'

/** What another app shared, as the service worker stashed it (web/public/sw.js). */
type Share = { title: string; text: string; url: string; files: { name: string; type: string }[] }

/** Takes share `id` out of the service worker's cache, files as `File`s. */
async function take(id: string) {
  const cache = await caches.open('ultimate-share')
  const stored = await cache.match(`/share/${id}`)
  if (!stored) throw new Error('The shared content is gone')
  const share = (await stored.json()) as Share
  const files = await Promise.all(
    share.files.map(async ({ name, type }, index) => {
      const blob = (await (await cache.match(`/share/${id}/${index}`))?.blob()) ?? new Blob()
      return new File([blob], name || 'shared', { type: type || blob.type })
    }),
  )
  await Promise.all([
    cache.delete(`/share/${id}`),
    ...share.files.map((_, index) => cache.delete(`/share/${id}/${index}`)),
  ])
  return { share, files }
}

/** The shared title, text and link as one text, each once: Android often repeats the link inside the text. */
const textOf = ({ title, text, url }: Share) =>
  [title, text, url]
    .filter(
      (part, index, all) =>
        part &&
        all.indexOf(part) === index &&
        !all.some((other) => other !== part && other.includes(part)),
    )
    .join('\n')

/**
 * Drops `files` on the page once conversation `id`'s composer shows: the shown composer attaches files dropped anywhere
 * (web/src/app/composer.tsx), resized and uploaded as the paperclip would.
 */
async function drop(id: number, files: File[]) {
  const until = Date.now() + 10_000
  while (!document.querySelector(`textarea[data-conversation="${id}"]`)) {
    if (Date.now() > until) throw new Error('The composer did not show')
    await new Promise(requestAnimationFrame)
  }
  const transfer = new DataTransfer()
  for (const file of files) transfer.items.add(file)
  document.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true }))
}

/**
 * Renders nothing: registers the service worker (it serves the share target and the push extension's notifications)
 * and, on a page a share opened (`/?share=<id>`), puts what was shared into @ultimate's composer, unsent. Files attach
 * as a dropped file would: images inline, others through the attachments extension.
 */
function Share() {
  const ultimate = useDocOf(ROOT, StandingDoc)?.ultimate
  const { showSurface, switchConversation } = useUltimate()
  const latest = useRef({ ultimate, showSurface, switchConversation })
  latest.current = { ultimate, showSurface, switchConversation }
  useEffect(() => {
    navigator.serviceWorker
      ?.register('/sw.js')
      .catch((error: unknown) => console.warn('Service worker', error))
  }, [])
  const [id] = [new URL(location.href).searchParams.get('share')]
  useEffect(() => {
    if (!id) return
    const current = latest.current
    const url = new URL(location.href)
    url.searchParams.delete('share')
    history.replaceState(history.state, '', url)
    take(id)
      .then(async ({ share, files }) => {
        const conversation =
          current.ultimate ?? (await api.action(StandingAction, { name: 'ultimate' }))
        current.showSurface('agent')
        current.switchConversation(conversation)
        const text = textOf(share)
        if (text) insertIntoComposer(conversation, text)
        if (files.length) await drop(conversation, files)
      })
      .catch((error: unknown) => console.warn('Shared content', error))
  }, [id])
  return null
}

export default defineWebExtension({ slots: { overlay: [Share] } })
