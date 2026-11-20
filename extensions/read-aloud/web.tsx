import { defineWebExtension, island } from '@/sdk'
import { readAloudAction } from './action.solid.tsx'
import * as player from './player.tsx'
import { readingStrip } from './strip.solid.tsx'

const ReadAloudAction = readAloudAction(player)
const ReadingStrip = readingStrip(player)

export default defineWebExtension({
  messageActions: [island(ReadAloudAction)],
  composer: island(ReadingStrip),
})
