self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

function pushData(event) {
  try {
    return event.data?.json() ?? {}
  } catch {
    return {}
  }
}

self.addEventListener('push', (event) => {
  const data = pushData(event)
  const actions = []
  if (typeof data.message === 'number') {
    if (Array.isArray(data.approve)) actions.push({ action: 'approve', title: 'Approve' })
    actions.push({ action: 'reply', type: 'text', title: 'Reply', placeholder: 'Reply…' })
  }
  event.waitUntil(
    self.registration
      .showNotification(data.title || 'Ultimate', {
        body: typeof data.body === 'string' ? data.body : undefined,
        tag: typeof data.tag === 'string' ? data.tag : undefined,
        icon: '/icons/icon-192.png',
        actions,
        data,
      })
      .then(announceShown),
  )
})

async function announceShown() {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  for (const client of windows) client.postMessage({ type: 'ultimate:shown' })
}

self.addEventListener('notificationclick', (event) => {
  const notification = event.notification
  const data = notification.data ?? {}
  const reply = event.action === 'reply' && typeof event.reply === 'string' && event.reply.trim()
  if (typeof data.message === 'number' && (event.action === 'approve' || reply)) {
    event.waitUntil(
      answerAndCloseOrReplaceNotification(
        notification,
        data,
        event.action === 'approve' ? { answers: data.approve } : { text: reply },
      ),
    )
    return
  }
  notification.close()
  event.waitUntil(focusExistingOrOpenWindow(data.path || '/'))
})

async function answerAndCloseOrReplaceNotification(notification, data, args) {
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

async function focusExistingOrOpenWindow(path) {
  const url = new URL(path, self.location.origin).href
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const shown = windows.find((client) => client.focused) ?? windows[0]
  if (!shown) {
    await self.clients.openWindow(url)
    return
  }
  await shown.focus()
  shown.postMessage({ type: 'ultimate:open', url })
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (
    event.request.method === 'POST' &&
    url.origin === self.location.origin &&
    url.pathname === '/share'
  )
    event.respondWith(cacheShareUntilPageConsumes(event.request))
})

async function cacheShareUntilPageConsumes(request) {
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
