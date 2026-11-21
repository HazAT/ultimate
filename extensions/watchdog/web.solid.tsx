/** @jsxImportSource @solidjs/web */
import { defineWebExtension } from '@/sdk/solid'
import { Failure } from './failure.solid.tsx'
import { Idle } from './idle.solid.tsx'

export default defineWebExtension({
  entries: { 'watchdog.failure': Failure, 'watchdog.idle': Idle },
})
