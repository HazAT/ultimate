import { defineWebExtension, island } from '@/sdk'
import { Note } from './note.solid.tsx'

export default defineWebExtension({
  entries: { 'prompt.build': island(Note) },
})
