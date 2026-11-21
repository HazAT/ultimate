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

export function storeFiles(key: string, files: DraftFile[]) {
  const completedUploads = files.filter((file) => file.path)
  if (completedUploads.length)
    localStorage.setItem(`${key}.files`, JSON.stringify(completedUploads))
  else localStorage.removeItem(`${key}.files`)
}

function retainImagesOnlyUntilReload(storageKey: string) {
  localStorage.removeItem(storageKey)
}

export function storeImages(key: string, images: PastedImage[]) {
  const name = `${key}.images`
  const base64Chars = images.reduce((total, image) => total + image.data.length, 0)
  if (images.length === 0 || base64Chars > maxStoredImageChars) {
    localStorage.removeItem(name)
    return
  }
  try {
    localStorage.setItem(name, JSON.stringify(images))
  } catch {
    retainImagesOnlyUntilReload(name)
  }
}
