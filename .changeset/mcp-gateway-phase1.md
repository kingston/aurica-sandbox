---
'@aurica/sandbox': minor
---

Add MCP gateway support (Phase 1).

- New `mcp` plugin that runs a loopback HTTP gateway alongside the host
  proxy and maintains a per-sandbox tenant table built from each
  sandbox's `.aurica/sandbox.json` `plugins.mcp.servers` opt-in.
- New `aurica-sandbox mcp login|list|logout` subcommands, backed by a
  file-backed `OAuthClientProvider` that persists tokens and DCR client
  info to `~/.aurica/sandbox/credentials.json` (mode 600).
- Plugin contract gains two optional hooks: `cliCommands(program, ctx)`
  for plugins to register Commander subcommands, and
  `proxySidecar(ctx)` for plugins to run a long-running helper in the
  same process as the host proxy. Existing plugins are unchanged.
- `state.sandboxes` entries gain a required `authSecret` field — the
  per-sandbox secret the framework hashes into the placeholder bearer
  the gateway validates. Existing state files without one fail schema
  validation; destroy/recreate sandboxes to upgrade.

The gateway proxies `tools/list` and `tools/call` to the configured
upstream and filters tools against the per-sandbox ACL. Methods outside
`tools/*` (resources, prompts, …) return JSON-RPC "Method not found" by
design — surface area is intentionally tools-only for v1.
