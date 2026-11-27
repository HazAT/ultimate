export function at(originToKeep: string, link: URL) {
  const url = new URL(originToKeep)
  url.pathname = link.pathname
  url.search = link.search
  url.hash = link.hash
  return url.href
}

const bare = (url: string) => url.replace(/\/$/, '')

export function label(text: string, href: string, opens: string) {
  return bare(text) === bare(href) ? bare(opens) : text
}
