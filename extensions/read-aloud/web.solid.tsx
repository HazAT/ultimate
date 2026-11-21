/** @jsxImportSource @solidjs/web */
import { defineWebExtension } from '@/sdk/solid'
import { readAloudAction } from './action.solid.tsx'
import * as player from './player.solid.tsx'
import { readingStrip } from './strip.solid.tsx'

const ReadAloudAction = readAloudAction(player)
const ReadingStrip = readingStrip(player)

export default defineWebExtension({
  messageActions: [ReadAloudAction],
  composer: ReadingStrip,
})
