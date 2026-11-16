type UncompressedBytes = number
type EncryptedUploadBytes = number

export interface LastBackup {
  id: string
  at: number
  machine: string
  bytes: UncompressedBytes
  uploaded: EncryptedUploadBytes
}

export interface CloudState {
  status: 'off' | 'local' | 'satellite' | 'on'
  name: string
  chapter?: { name: string; number: number }
  machine?: string
  lastBackup?: LastBackup
  backup?: { done: UncompressedBytes; total: UncompressedBytes; uploaded: EncryptedUploadBytes }
  conflict?: { error: string; latest?: { id: string; machine: string; at: number } }
  lastError?: string
}
