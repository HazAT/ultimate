import { maxImageBytes } from '../../../shared/protocol.ts'

/** Longest side an attached image keeps, as Pi's read tool sends images to models. */
export const maxImageSide = 2000

export type FittedImage = { blob: Blob; note?: string }

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

/**
 * `file` as it can be attached: unchanged when it is within 2 MiB and 2000 px, otherwise scaled down and re-encoded in
 * the browser until it fits, with a note saying what changed. An oversized animated GIF keeps only its first frame.
 */
export async function fitImage(file: File): Promise<FittedImage> {
  // A GIF within the byte limit keeps its animation; a canvas could only keep one frame.
  if (file.type === 'image/gif' && file.size <= maxImageBytes) return { blob: file }
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(
    (failure: unknown) => {
      throw new Error(`Could not read ${file.name || 'pasted image'}`, { cause: failure })
    },
  )
  try {
    const { width, height } = bitmap
    if (file.size <= maxImageBytes && Math.max(width, height) <= maxImageSide) return { blob: file }
    let scale = Math.min(1, maxImageSide / Math.max(width, height))
    for (;;) {
      const w = Math.max(1, Math.round(width * scale))
      const h = Math.max(1, Math.round(height * scale))
      const canvas = new OffscreenCanvas(w, h)
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h)
      for (const quality of [0.9, 0.8, 0.7]) {
        let blob = await canvas.convertToBlob({ type: 'image/webp', quality })
        // Browsers without a WebP encoder answer with PNG: a JPEG source stays JPEG instead.
        if (blob.type !== 'image/webp' && file.type === 'image/jpeg')
          blob = await canvas.convertToBlob({ type: 'image/jpeg', quality })
        if (blob.size <= maxImageBytes) {
          const frame = file.type === 'image/gif' ? ' · first frame only' : ''
          return {
            blob,
            note: `Resized ${megabytes(file.size)} · ${width}×${height} → ${w}×${h}${frame}`,
          }
        }
        if (blob.type === 'image/png') break
      }
      scale *= 0.75
    }
  } finally {
    bitmap.close()
  }
}
