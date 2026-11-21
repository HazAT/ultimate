/** @jsxImportSource @solidjs/web */
import { defineWebExtension } from '@/sdk/solid'
import { Note } from './note.solid.tsx'

export default defineWebExtension({
  entries: { 'prompt.build': Note },
})
