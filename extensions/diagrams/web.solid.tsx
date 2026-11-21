/** @jsxImportSource @solidjs/web */
import { defineWebExtension } from '@/sdk/solid'
import { Mermaid } from './mermaid.solid.tsx'

export default defineWebExtension({ codeBlocks: { mermaid: Mermaid } })
