import type { JSX } from '@solidjs/web'
import { definePoint } from '../../web/src/sdk/types.ts'

export const ExtensionDetails = definePoint<{ name: string }, JSX.Element>(
  'onboarding.extension-details',
)
