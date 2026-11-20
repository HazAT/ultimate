import { defineWebExtension, island } from '@/sdk'
import { Browser, Screenshot } from './calls.solid.tsx'

export default defineWebExtension({
  tools: { screenshot: island(Screenshot), browser: island(Browser) },
})
