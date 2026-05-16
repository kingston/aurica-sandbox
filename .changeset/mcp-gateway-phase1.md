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
- `state.proxy` gains an `mcpGatewayPort` field; `state.sandboxes`
  entries gain a `bearer` field. Both are nullable for backwards
  compatibility with existing state files.

Phase 2 (proxy URL-rewrite policy + guest-side `~/.claude.json` wiring)
lands in a follow-up; the gateway currently accepts authenticated
requests and replies `501 Not Implemented` for the upstream relay.
