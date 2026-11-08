// Ultimate's service worker. It shows the `push` extension's notifications, answers a question from one (Approve, or
// an inline reply), opens the app when a notification is tapped, and takes what another app shares (the manifest's
// `share_target`). It caches nothing and handles no fetch but the share's POST: every page load still goes to the
// server, so the reload onto a new bundle (server/web.ts) works as without it.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

// A push's JSON (extensions/push/rules.ts): `{ title, body, tag, path, message?, approve? }`. `message` names a question
// to the user, which gets a Reply action, and Approve when `approve` holds the answers it sends.
self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data?.json() ?? {}
  } catch {
    // A payload that is no JSON still shows, as a plain Ultimate notification: every push must show one.
  }
  const actions = []
  if (typeof data.message === 'number') {
    if (Array.isArray(data.approve)) actions.push({ action: 'approve', title: 'Approve' })
    // `type: 'text'` is Chrome's inline reply (Android and desktop, since Chrome 75,
    // https://chromestatus.com/feature/5743740178137088); other browsers show a plain button, which opens the question.
    actions.push({ action: 'reply', type: 'text', title: 'Reply', placeholder: 'Reply…' })
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Ultimate', {
      body: typeof data.body === 'string' ? data.body : undefined,
      tag: typeof data.tag === 'string' ? data.tag : undefined,
      icon: '/icons/icon-192.png',
      actions,
      data,
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  const notification = event.notification
  const data = notification.data ?? {}
  const reply = event.action === 'reply' && typeof event.reply === 'string' && event.reply.trim()
  if (typeof data.message === 'number' && (event.action === 'approve' || reply)) {
    event.waitUntil(
      answer(
        notification,
        data,
        event.action === 'approve' ? { answers: data.approve } : { text: reply },
      ),
    )
    return
  }
  notification.close()
  event.waitUntil(open(data.path || '/'))
})

/**
 * Answers question `data.message` through the questions extension's `answer` action, as its card does. The request is
 * same-origin, so Tailscale Serve adds the user's identity and the server admits it like the page's own. Android keeps
 * a replied notification spinning until it is replaced: success closes it, a failure replaces it with the reason.
 */
async function answer(notification, data, args) {
  let error
  try {
    const response = await fetch('/api/extensions/questions/actions/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: { messageId: data.message, ...args } }),
    })
    if (!response.ok)
      error = (await response.json().catch(() => ({}))).error ?? `HTTP ${response.status}`
  } catch (caught) {
    error = String(caught)
  }
  if (error === undefined) {
    notification.close()
    return
  }
  await self.registration.showNotification(data.title || 'Ultimate', {
    body: `Not answered: ${error}`,
    tag: data.tag,
    icon: '/icons/icon-192.png',
    data: { path: data.path },
  })
}

/** Opens `path` in a window of the app: an open one navigates itself (the push extension's page), else a new one. */
async function open(path) {
  const url = new URL(path, self.location.origin).href
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const shown = windows.find((client) => client.focused) ?? windows[0]
  if (!shown) {
    await self.clients.openWindow(url)
    return
  }
  await shown.focus()
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- A Client's postMessage has no target origin.
  shown.postMessage({ type: 'ultimate:open', url })
}

// The share target posts its form here (manifest.webmanifest). The page reads it from the cache and deletes it
// (extensions/share).
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (
    event.request.method === 'POST' &&
    url.origin === self.location.origin &&
    url.pathname === '/share'
  )
    event.respondWith(share(event.request))
})

async function share(request) {
  const form = await request.formData()
  const id = crypto.randomUUID()
  const cache = await caches.open('ultimate-share')
  const files = form.getAll('files').filter((file) => file instanceof File && file.size > 0)
  await Promise.all(
    files.map((file, index) => cache.put(`/share/${id}/${index}`, new Response(file))),
  )
  const field = (name) => (typeof form.get(name) === 'string' ? form.get(name) : '')
  await cache.put(
    `/share/${id}`,
    Response.json({
      title: field('title'),
      text: field('text'),
      url: field('url'),
      files: files.map((file) => ({ name: file.name, type: file.type })),
    }),
  )
  return Response.redirect(`/?share=${id}`, 303)
}
