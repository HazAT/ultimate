import { maxImageBytes } from '../../../shared/protocol.ts'

export const maxImageSide = 2000

export type FittedImage = { blob: Blob; note?: string }

const thumbWidth = 304
const thumbHeight = 112
const thumbMaxSide = 4 * thumbWidth

export async function thumbnail(image: Blob) {
  const bitmap = await createImageBitmap(image, { imageOrientation: 'from-image' })
  const { width, height } = bitmap
  const scale = Math.min(
    1,
    Math.max(thumbWidth / width, thumbHeight / height),
    thumbMaxSide / Math.max(width, height),
  )
  let canvas: OffscreenCanvas
  try {
    canvas = new OffscreenCanvas(
      Math.max(1, Math.round(width * scale)),
      Math.max(1, Math.round(height * scale)),
    )
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  } finally {
    bitmap.close()
  }
  return canvas.convertToBlob({ type: 'image/webp', quality: 0.9 })
}

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

export async function fitImage(file: File): Promise<FittedImage> {
  const preserveGifAnimation = file.type === 'image/gif' && file.size <= maxImageBytes
  if (preserveGifAnimation) return { blob: file }
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
        const jpegSourceWithoutWebpEncoder =
          blob.type !== 'image/webp' && file.type === 'image/jpeg'
        if (jpegSourceWithoutWebpEncoder)
          blob = await canvas.convertToBlob({ type: 'image/jpeg', quality })
        if (blob.size <= maxImageBytes) {
          const parts = [
            `Resized ${megabytes(file.size)}`,
            ...(w === width ? [] : [`${width}×${height} → ${w}×${h}`]),
            ...(file.type === 'image/gif' ? ['first frame only'] : []),
          ]
          return { blob, note: parts.join(' · ') }
        }
        if (blob.type === 'image/png') break
      }
      scale *= 0.75
    }
  } finally {
    bitmap.close()
  }
}
