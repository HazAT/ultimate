import { attached } from './attachments.ts'
import type { DraftFile, PastedImage } from './attachments.ts'

export const maxStoredImageChars = 2_000_000

export function storedImages(key: string): PastedImage[] {
  const stored = localStorage.getItem(`${key}.images`)
  return stored ? (JSON.parse(stored) as PastedImage[]) : []
}

export function storedFiles(key: string): DraftFile[] {
  const stored = localStorage.getItem(`${key}.files`)
  return stored ? (JSON.parse(stored) as DraftFile[]) : []
}

function keepOnlyUntilReloadWhenStorageIsFull(name: string, value: unknown[]) {
  try {
    localStorage.setItem(name, JSON.stringify(value))
  } catch {
    localStorage.removeItem(name)
  }
}

export function storeFiles(key: string, files: DraftFile[]) {
  const completedUploads = files.filter(attached)
  if (completedUploads.length)
    keepOnlyUntilReloadWhenStorageIsFull(`${key}.files`, completedUploads)
  else localStorage.removeItem(`${key}.files`)
}

export function storeImages(key: string, images: PastedImage[]) {
  const name = `${key}.images`
  const base64Chars = images.reduce((total, image) => total + image.data.length, 0)
  if (images.length === 0 || base64Chars > maxStoredImageChars) localStorage.removeItem(name)
  else keepOnlyUntilReloadWhenStorageIsFull(name, images)
}
