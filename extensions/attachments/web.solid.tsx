import { api, defineWebExtension, FileUpload, provide } from '@/sdk/solid'
import { KEPT_MS, MAX_FILE_BYTES_FOR_12_MB_ACTION } from './limits.shared.ts'
import { UploadAction } from './refs.ts'

async function base64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(binary)
}

async function upload(file: File) {
  return api.action(UploadAction, { name: file.name, data: await base64(file) })
}

const uploads = { upload, maxBytes: MAX_FILE_BYTES_FOR_12_MB_ACTION, keptMs: KEPT_MS }

export default defineWebExtension({ provides: [provide(FileUpload, () => () => uploads)] })
