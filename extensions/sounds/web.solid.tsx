/** @jsxImportSource @solidjs/web */
import { defineWebExtension } from '@/sdk/solid'
import { Control } from './chip.solid.tsx'
import * as conductor from './conductor.ts'
import { Player } from './player.solid.tsx'

export default defineWebExtension({
  slots: {
    overlay: [Player],
    'statusline.right': [{ component: Control, order: -1 }],
  },
  commands: [
    {
      id: 'sounds.demo',
      title: 'Play the sound of agents demo',
      run: () => conductor.startDemo(),
    },
  ],
})
