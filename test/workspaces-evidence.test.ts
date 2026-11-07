import { expect, it } from 'vitest'
import type { ConversationId, EntryRecord, Tx } from '@earendil-works/pi-durable'
import { capturesApply, resolveEvidence } from '../extensions/workspaces/evidence.ts'
import { maxImageBytes } from '../shared/protocol.ts'

const from = 43 as ConversationId

/** A fake transaction over `entries`, newest first, answering `scanEntries` like the store does. */
const txOf = (entries: EntryRecord[]): Tx =>
  ({
    scanEntries: async (query: { minEntryId?: number; maxEntryId?: number }) => ({
      items: entries.filter(
        (item) =>
          (query.minEntryId === undefined || item.id >= query.minEntryId) &&
          (query.maxEntryId === undefined || item.id <= query.maxEntryId),
      ),
      next: undefined,
    }),
  }) as unknown as Tx

const entry = (id: number, images: { data: string; mimeType: string }[] = [], input = false) =>
  ({
    id,
    conversationId: from,
    kind: input ? 'pi.user' : 'pi.tool-result',
    ...(input ? { input: true } : {}),
    model: [
      {
        role: input ? 'user' : 'toolResult',
        content: images.length
          ? images.map((image) => ({ type: 'image', ...image }))
          : 'no images here',
      },
    ],
  }) as unknown as EntryRecord

it('resolves "latest" to the newest entry with images in the current turn', async () => {
  const turn = [entry(12, [{ data: 'AAAA', mimeType: 'image/png' }]), entry(9, [], true)]
  await expect(resolveEvidence(txOf(turn), from, 'latest')).resolves.toEqual({ entry: 12 })
  // An image-less turn carries no older screenshot along.
  const quiet = [entry(12, [], false), entry(9, [], true)]
  await expect(resolveEvidence(txOf(quiet), from, 'latest')).rejects.toThrow(
    /no images in this turn/,
  )
})

it('resolves an entry id to that entry, refusing one without images, missing or invalid', async () => {
  const entries = [entry(12, [], false), entry(9, [{ data: 'AAAA', mimeType: 'image/png' }])]
  await expect(resolveEvidence(txOf(entries), from, 9)).resolves.toEqual({ entry: 9 })
  await expect(resolveEvidence(txOf(entries), from, 12)).rejects.toThrow(/has no images/)
  await expect(resolveEvidence(txOf(entries), from, 99)).rejects.toThrow(
    /is not in this conversation/,
  )
  await expect(resolveEvidence(txOf(entries), from, 0)).rejects.toThrow(
    /must be "latest" or the id/,
  )
})

it('lands at most four supported images of 2 MiB each', async () => {
  const five = Array.from({ length: 5 }, () => ({ data: 'AAAA', mimeType: 'image/png' }))
  await expect(resolveEvidence(txOf([entry(9, five)]), from, 9)).rejects.toThrow(/at most 4/)
  await expect(
    resolveEvidence(txOf([entry(9, [{ data: 'AAAA', mimeType: 'image/svg+xml' }])]), from, 9),
  ).rejects.toThrow(/unsupported image/)
  await expect(
    resolveEvidence(
      txOf([entry(9, [{ data: 'A'.repeat(3 * maxImageBytes), mimeType: 'image/png' }])]),
      from,
      9,
    ),
  ).rejects.toThrow(/over 2 MiB/)
})

it('wants captures when a diff touches the web core or an extension browser facet', () => {
  expect(capturesApply(['web/src/app/composer.tsx'])).toBe(true)
  expect(capturesApply(['extensions/browser/web.tsx'])).toBe(true)
  expect(capturesApply(['lib/git.ts', 'extensions/browser/web.tsx'])).toBe(true)
  expect(capturesApply(['extensions/browser/server.ts'])).toBe(false)
  expect(capturesApply(['extensions/browser/web/bonus.tsx'])).toBe(false)
  expect(capturesApply([])).toBe(false)
})
