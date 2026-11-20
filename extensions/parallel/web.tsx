import { defineWebExtension, island } from '@/sdk'
import { Fetch, Search } from './calls.solid.tsx'

export default defineWebExtension({
  tools: { web_search: island(Search), web_fetch: island(Fetch) },
})
