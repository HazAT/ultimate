import { defineWebExtension, island } from '@/sdk'
import { Toasts } from './toasts.solid.tsx'

export default defineWebExtension({ slots: { overlay: island(Toasts) } })
