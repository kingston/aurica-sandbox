---
'@aurica/sandbox': minor
---

Proxy `allow` policies can now declare `cacheResponse: { ttlSeconds }` to cache a matched GET 200 response on the host and serve it to later sandboxes from a shared on-disk cache under the state dir. The `cursor` plugin uses this to cache the content-addressed Cursor REH tarball, so only the first sandbox downloads the ~80 MB archive and subsequent ones serve it from disk. The plugin's in-VM REH pre-warm command (and host `Cursor.app` detection) is removed — the first remote-SSH connect now fetches the REH server on demand through the proxy, which the cache fills. Only attach `cacheResponse` to public, unauthenticated, immutable URLs; the cache has no size cap or eviction today.
