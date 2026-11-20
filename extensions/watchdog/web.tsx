import { defineWebExtension, island } from '@/sdk'
import { Failure } from './failure.solid.tsx'
import { Idle } from './idle.solid.tsx'

export default defineWebExtension({
  entries: { 'watchdog.failure': island(Failure), 'watchdog.idle': island(Idle) },
})
