/** Onboarding for other extensions' browser code: the first-run status, starting onboarding, and extension switches. */
import type { ReactNode } from 'react'
import { definePoint } from '@/sdk'

export { SetExtensionAction, StartAction, StatusAction } from './refs.ts'

/**
 * More of an open row in the Extensions panel, below its tools and contract (`mcp` lists its servers there). Input is
 * the extension's name; the provider returns null for the others.
 */
export const ExtensionDetails = definePoint<string, ReactNode>('onboarding.extension-details')
