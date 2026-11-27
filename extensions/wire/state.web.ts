import type { ConversationId } from '@earendil-works/pi-durable'

export const WIRE_PICKED_KEY = 'ext.wire.picked'
export const WIRE_TAB_KEY = 'ext.wire.tab'
export const WIRE_MODE_KEY = 'ext.wire.mode'

export type Picked = { conversation: ConversationId; n: number }
