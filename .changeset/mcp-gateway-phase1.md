---
'@aurica/sandbox': minor
---

Add MCP gateway support. The `mcp` plugin runs a loopback HTTP gateway alongside the host proxy and exposes per-sandbox upstream MCP servers with a tools-only ACL. `aurica-sandbox mcp login|list|logout` manage OAuth credentials for upstreams. Existing sandbox state files without an `authSecret` field fail schema validation; destroy and recreate sandboxes to upgrade.
