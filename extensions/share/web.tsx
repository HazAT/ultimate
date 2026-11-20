import { defineWebExtension, island } from '@/sdk'
import { ShareTarget } from './receive.solid.tsx'

export default defineWebExtension({ slots: { overlay: [island(ShareTarget)] } })
