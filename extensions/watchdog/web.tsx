import { attention, defineWebExtension, island } from '@/sdk'
import { Failure, StandingFailure } from './failure.solid.tsx'
import { Idle } from './idle.solid.tsx'

export default defineWebExtension({
  entries: {
    'watchdog.failure': island(Failure),
    'watchdog.standing-failure': attention(island(StandingFailure)),
    'watchdog.idle': island(Idle),
  },
})
