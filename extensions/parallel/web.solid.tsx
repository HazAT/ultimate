import { defineWebExtension } from '@/sdk/solid'
import { Fetch, Search } from './calls.solid.tsx'

export default defineWebExtension({
  tools: { web_search: Search, web_fetch: Fetch },
})
