import { defineWebExtension } from '@/sdk/solid'
import { ShareTarget } from './receive.solid.tsx'

export default defineWebExtension({ slots: { overlay: [ShareTarget] } })
