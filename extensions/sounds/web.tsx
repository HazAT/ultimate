import { defineWebExtension, island } from '@/sdk'
import { Control } from './chip.solid.tsx'
import * as conductor from './conductor.ts'
import { Player } from './player.solid.tsx'

export default defineWebExtension({
  slots: {
    overlay: [island(Player)],
    'statusline.right': [{ component: island(Control), order: -1 }],
  },
  commands: [
    {
      id: 'sounds.demo',
      title: 'Play the sound of agents demo',
      run: () => conductor.startDemo(),
    },
  ],
})
