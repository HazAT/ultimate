import { defineWebExtension } from '@/sdk'
import { Mermaid } from './mermaid.solid.tsx'

export default defineWebExtension({ codeBlocks: { mermaid: Mermaid } })
