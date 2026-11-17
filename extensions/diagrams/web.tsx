import { render } from 'lovely-mermaid'
import { useMemo } from 'react'
import type { CodeBlockRenderer } from '@/sdk'
import { defineWebExtension } from '@/sdk'

const Mermaid: CodeBlockRenderer = ({ code, incomplete, core }) => {
  const art = useMemo(() => (incomplete ? null : render(code)), [code, incomplete])
  if (!art) return core
  return (
    <pre className="w-full overflow-x-auto rounded-md border bg-terminal p-3 font-mono text-xs leading-tight">
      {art.plain.join('\n')}
    </pre>
  )
}

export default defineWebExtension({ codeBlocks: { mermaid: Mermaid } })
