import type { DraftFile, PastedImage } from '@/components/image-paste'

/**
 * Largest share of localStorage one draft's images may take, in base64 characters (about 1.5 MiB of image). Browsers
 * give an origin about 5 M characters, which every draft's text shares; bigger pastes stay in memory only.
 */
export const maxStoredImageChars = 2_000_000

/** The images draft `key` kept across a reload. */
export function storedImages(key: string): PastedImage[] {
  const stored = localStorage.getItem(`${key}.images`)
  return stored ? (JSON.parse(stored) as PastedImage[]) : []
}

/** The uploaded files draft `key` kept across a reload. */
export function storedFiles(key: string): DraftFile[] {
  const stored = localStorage.getItem(`${key}.files`)
  return stored ? (JSON.parse(stored) as DraftFile[]) : []
}

/** Keep draft `key`'s uploaded files across a reload; one still uploading is lost with the page that sends it. */
export function storeFiles(key: string, files: DraftFile[]) {
  const uploaded = files.filter((file) => file.path)
  if (uploaded.length) localStorage.setItem(`${key}.files`, JSON.stringify(uploaded))
  else localStorage.removeItem(`${key}.files`)
}

/** Keep draft `key`'s images across a reload, as its text is kept, unless they are too large to store. */
export function storeImages(key: string, images: PastedImage[]) {
  const name = `${key}.images`
  const size = images.reduce((total, image) => total + image.data.length, 0)
  if (images.length === 0 || size > maxStoredImageChars) {
    localStorage.removeItem(name)
    return
  }
  try {
    localStorage.setItem(name, JSON.stringify(images))
  } catch {
    // Over the storage quota: the images stay in this page's draft and are gone after a reload, as before.
    localStorage.removeItem(name)
  }
}
