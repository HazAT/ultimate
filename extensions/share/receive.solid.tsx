import { createEffect, onSettled } from 'solid-js'
import type { ConversationId } from '@earendil-works/pi-durable'
import {
  ROOT,
  api,
  insertIntoComposer,
  showSurface,
  switchConversation,
  useDocOf,
  writingAs,
} from '@/sdk/solid'
import { StandingAction, StandingDoc } from '../subagents/refs.ts'

type Share = { title: string; text: string; url: string; files: { name: string; type: string }[] }

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

const distinctSharedText = ({ title, text, url }: Share) =>
  [title, text, url]
    .filter(
      (part, index, all) =>
        part &&
        all.indexOf(part) === index &&
        !all.some((other) => other !== part && other.includes(part)),
    )
    .join('\n')

async function dropOnceConversationComposerShows(id: number, files: File[]) {
  const until = Date.now() + 10_000
  while (!document.querySelector(`textarea[data-conversation="${id}"]`)) {
    if (Date.now() > until) throw new Error('The composer did not show')
    await new Promise(requestAnimationFrame)
  }
  const transfer = new DataTransfer()
  for (const file of files) transfer.items.add(file)
  document.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true }))
}

async function receive(id: string, ultimate: () => Promise<ConversationId | undefined>) {
  const { share, files } = await take(id)
  const conversation =
    (await ultimate()) ??
    (await writingAs('app', () => api.action(StandingAction, { name: 'ultimate' })))
  showSurface('agent')
  switchConversation(conversation)
  const text = distinctSharedText(share)
  if (text) insertIntoComposer(conversation, text)
  if (files.length) await dropOnceConversationComposerShows(conversation, files)
}

export function ShareTarget() {
  const standing = useDocOf(() => ROOT, StandingDoc)
  let arrived = () => {}
  const loaded = new Promise<void>((resolve) => (arrived = resolve))
  createEffect(standing, (doc) => {
    if (doc !== undefined) arrived()
  })
  const ultimate = async () => {
    await loaded
    return standing()?.ultimate
  }
  onSettled(() => {
    navigator.serviceWorker
      ?.register('/sw.js')
      .catch((error: unknown) => console.warn('Service worker', error))
    const url = new URL(location.href)
    const id = url.searchParams.get('share')
    if (!id) return
    url.searchParams.delete('share')
    history.replaceState(history.state, '', url)
    receive(id, ultimate).catch((error: unknown) => console.warn('Shared content', error))
  })
  return null
}
