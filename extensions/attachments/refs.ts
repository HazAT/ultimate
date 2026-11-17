/** Attachments in the browser: the upload action the composer stores non-image files with. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/** `{ name, data: base64 }` → the absolute path the file was stored at on the host. */
export const UploadAction = actionRef<{ name: string; data: string }, { path: string }>(
  'attachments',
  'upload',
)
