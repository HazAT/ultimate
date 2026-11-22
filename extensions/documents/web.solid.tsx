import { FileStackIcon } from '@lucide/solid'
import { defineWebExtension } from '@/sdk/solid'
import { DocumentsPanel } from './panel.solid.tsx'

export default defineWebExtension({
  panels: [
    {
      id: 'documents',
      title: 'Documents',
      icon: FileStackIcon,
      component: DocumentsPanel,
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
