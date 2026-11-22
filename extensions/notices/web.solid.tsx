import { defineWebExtension } from '@/sdk/solid'
import { Toasts } from './toasts.solid.tsx'

export default defineWebExtension({ slots: { overlay: Toasts } })
