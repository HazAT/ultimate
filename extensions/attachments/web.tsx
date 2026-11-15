import { api, defineWebExtension, FileUpload, provide } from '@/sdk'
import { KEPT_MS, MAX_FILE_BYTES_FOR_12_MB_ACTION } from './limits.ts'
import { UploadAction } from './refs.ts'

async function base64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(binary)
}

async function upload(file: File) {
  const { path } = await api.action(UploadAction, { name: file.name, data: await base64(file) })
  return path
}

const stableComposerUploads = { upload, maxBytes: MAX_FILE_BYTES_FOR_12_MB_ACTION, keptMs: KEPT_MS }
const useUpload = () => stableComposerUploads

export default defineWebExtension({ provides: [provide(FileUpload, useUpload)] })
