import { FileStackIcon } from 'lucide-react'
import { defineWebExtension, island } from '@/sdk'
import { DocumentsPanel } from './panel.solid.tsx'

export default defineWebExtension({
  panels: [
    {
      id: 'documents',
      title: 'Documents',
      icon: FileStackIcon,
      component: island(DocumentsPanel),
      order: 4,
    },
  ],
  commands: [
    {
      id: 'documents.open',
      title: "Show the conversation's documents",
      run: (context) => context.openPanel('documents'),
    },
  ],
})
