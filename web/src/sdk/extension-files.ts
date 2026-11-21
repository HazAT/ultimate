/** A same-origin URL for native playback of a private WebM offered by an installed server facet. */
export function extensionFileUrl(extension: string, id: string, key: string) {
  if (![extension, id, key].every((part) => /^[A-Za-z0-9_-]{1,128}$/.test(part)))
    throw new Error('Invalid extension file address')
  return `/api/extensions/${extension}/files/${id}/${key}`
}
