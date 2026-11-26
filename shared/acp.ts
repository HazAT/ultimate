import { docRef } from './extension-api.ts'

export type ConfigOption = {
  id: string
  name: string
  category?: string
  value: string
  options: { value: string; name: string }[]
}

export type PermissionAsk = {
  id: string
  title: string
  options: { optionId: string; name: string; kind: string }[]
}

export type AcpSession = {
  sessionId?: string
  status: 'connecting' | 'idle' | 'running' | 'offline' | 'error'
  config: ConfigOption[]
  permission?: PermissionAsk
  usage?: { used: number; size: number }
  error?: string
}

export const AcpSessionDoc = docRef<Partial<AcpSession>>('acp.session')
