Share: Ultimate as a share target. Installed as an app (Android Chrome ⋮ → Install app), Ultimate appears in the
system share sheet; what you share opens @ultimate with it in the composer, unsent: the title, text and link as text
(each once), files attached as a drop would attach them (images inline, others uploaded by `attachments`).

The manifest's `share_target` posts a multipart form to `/share`; the service worker (`web/public/sw.js`, which this
extension registers) stashes it in the `ultimate-share` cache and redirects to `/?share=<id>`, and the page takes it
out of the cache and deletes it. An installed app picks up a changed manifest only when Chrome refreshes it (every few
days) or on reinstall.
