/** @jsxImportSource @solidjs/web */
import { defineWebExtension } from '@/sdk/solid'
import { Browser, Screenshot } from './calls.solid.tsx'

export default defineWebExtension({
  tools: { screenshot: Screenshot, browser: Browser },
})
