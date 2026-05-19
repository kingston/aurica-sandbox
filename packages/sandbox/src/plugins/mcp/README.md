# `mcp` plugin

Lets a sandboxed agent (Claude Code, Cursor, …) reach **remote MCP
servers** — GitHub, Linear, Sentry, etc. — without ever exposing
upstream OAuth tokens to the guest VM.

The plugin runs an on-host MCP gateway that:

- holds the OAuth tokens (one set per upstream, shared across every
  sandbox that opts in),
- terminates Streamable HTTP from the guest, authenticates each
  request, and forwards `tools/list` / `tools/call` to the right
  upstream,
- enforces a **per-sandbox policy list** that scopes which tools may
  be called, and with which argument values.

A guest never sees the upstream token; it only ever holds a synthetic
per-sandbox bearer that the gateway recognises.

---

## Setup at a glance

1. **Declare upstreams once** in `~/.aurica/sandbox/config.json`.
2. **`aurica-sandbox mcp login <name>`** on the host once per upstream
   to complete the OAuth dance — tokens land in
   `~/.aurica/sandbox/credentials.json` (mode 600).
3. **Opt a project in** by listing the upstream under
   `plugins.mcp.servers` in that project's `.aurica/sandbox.json`,
   optionally with a `policies` list to scope what the guest can do.
4. **`aurica-sandbox create <name>`** — the new VM comes up with the
   server already wired into `~/.claude.json`.

---

## User config (`~/.aurica/sandbox/config.json`)

```jsonc
{
  "plugins": {
    "mcp": {
      "upstreams": {
        "github": {
          "url": "https://api.githubcopilot.com/mcp/",
        },
        "linear": {
          "url": "https://mcp.linear.app/sse",
        },
      },
    },
  },
}
```

| Field        | Type   | Notes                                                                                                                     |
| ------------ | ------ | ------------------------------------------------------------------------------------------------------------------------- |
| `url`        | string | Upstream MCP base URL (Streamable HTTP).                                                                                  |
| `clientName` | string | Optional. Sent as `client_name` during Dynamic Client Registration. Some upstreams render it on the OAuth consent screen. |

The upstream name (`"github"`, `"linear"`, …) is the routing key
projects refer to. It must be kebab-case (`[a-z0-9][a-z0-9-]*`).

---

## CLI

```text
aurica-sandbox mcp login   <server>   Run OAuth for <server> in your host browser.
aurica-sandbox mcp list                List configured upstreams + login status.
aurica-sandbox mcp logout  <server>    Drop <server>'s cached credentials.
```

`login` opens your default browser. Tokens are persisted to
`~/.aurica/sandbox/credentials.json` and refreshed automatically by
the gateway when the access token expires.

---

## Project config (`.aurica/sandbox.json`)

Two forms per server entry.

### 1. Bare-string — no restrictions

The guest may call any tool the upstream exposes:

```jsonc
{
  "plugins": {
    "mcp": {
      "servers": ["github", "linear"],
    },
  },
}
```

### 2. Object form — per-tool, per-argument policies

```jsonc
{
  "plugins": {
    "mcp": {
      "servers": [
        {
          "name": "github",
          "policies": [
            {
              "tools": ["search_repositories", "get_pull_request"],
              "arguments": { "owner": "acme" },
              "action": { "type": "allow" },
            },
            {
              "tools": ["create_issue"],
              "arguments": { "owner": "acme", "repo": "widgets" },
              "action": { "type": "allow" },
            },
          ],
          "defaultAction": { "type": "block" },
        },
      ],
    },
  },
}
```

### Field reference

| Field                  | Type                                          | Required | Notes                                                                                                                                       |
| ---------------------- | --------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                 | string                                        | yes      | Must match a key under `plugins.mcp.upstreams` in user config.                                                                              |
| `policies`             | `Policy[]` (non-empty when set)               | no       | When omitted, every tool the upstream exposes is allowed. When set, the server defaults to **block** unless `defaultAction` says otherwise. |
| `policies[].tools`     | `string[]` (non-empty)                        | yes      | Tool names this rule applies to.                                                                                                            |
| `policies[].arguments` | `Record<string, string \| number \| boolean>` | no       | Subset-equality constraint on the call's `arguments`. Every listed key must equal (`===`) the corresponding key on the call.                |
| `policies[].action`    | `{ "type": "allow" }`                         | yes      | v1 supports `allow` only; the discriminated shape leaves room for explicit `block` later.                                                   |
| `defaultAction`        | `{ "type": "allow" \| "block" }`              | no       | Action for calls that match no policy. Defaults to `"block"` when `policies` is set, `"allow"` otherwise.                                   |

### Evaluation semantics

For each `tools/call`:

1. Walk `policies` **in order**. A policy matches when:
   - `params.name` is in `policy.tools`, **and**
   - if `policy.arguments` is set, every listed key equals (`===`)
     the corresponding key on the call's arguments. Extra keys on the
     call are ignored (**subset** equality). A missing key on the call
     **does not match**.
2. First match wins → **allow**.
3. No policy matched → fall through to `defaultAction`.

`tools/list` filtering:

- `defaultAction: "allow"` → guest sees every upstream tool.
- `defaultAction: "block"` → guest sees only the union of tool names
  named by any policy. Argument constraints don't apply at `list`
  time (args are unknown there).

### v1 limitations

| Limitation                                                          | Workaround                                                                                                            |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `policies[].action` is `allow` only.                                | Use `defaultAction: "block"` and add `allow` policies for the carve-outs.                                             |
| `arguments` values must be scalars (`string \| number \| boolean`). | Constrain on a scalar field upstream provides (e.g. `owner`, `repo`). Object / array constraints land in a follow-up. |
| Argument match is exact equality.                                   | Prefer values you know the agent will pass verbatim. `prefix` / `regex` matchers are a follow-up.                     |

---

## Worked example — GitHub MCP, single-org read-only

Goal: an agent that can search and read pull requests in `acme/*`,
but cannot create issues, cannot touch other orgs, and cannot reach
admin endpoints.

**Host setup (one-time):**

```jsonc
// ~/.aurica/sandbox/config.json
{
  "plugins": {
    "mcp": {
      "upstreams": {
        "github": { "url": "https://api.githubcopilot.com/mcp/" },
      },
    },
  },
}
```

```bash
aurica-sandbox mcp login github   # complete OAuth in browser
aurica-sandbox mcp list           # → github: ok
```

**Per-project setup:**

```jsonc
// <project>/.aurica/sandbox.json
{
  "plugins": {
    "mcp": {
      "servers": [
        {
          "name": "github",
          "policies": [
            {
              "tools": [
                "search_repositories",
                "search_code",
                "search_pull_requests",
                "get_pull_request",
                "list_pull_requests",
              ],
              "arguments": { "owner": "acme" },
              "action": { "type": "allow" },
            },
          ],
          "defaultAction": { "type": "block" },
        },
      ],
    },
  },
}
```

**Run it:**

```bash
aurica-sandbox create my-sandbox
orb -m my-sandbox
# inside the VM:
claude mcp list
# → github: connected
```

Inside the sandbox:

- `search_pull_requests({ owner: "acme", q: "..." })` → succeeds.
- `search_pull_requests({ owner: "other-org", q: "..." })` →
  returns a structured error: `tool search_pull_requests call
denied: argument "owner" must equal "acme" (got "other-org")`.
- `create_issue(...)` → blocked (not in any policy, default is
  block): `tool create_issue is not allowed for this sandbox`.

---

## How requests flow

```
guest (sandbox)
  └─ Claude Code → https://aurica.mcp.internal/github/mcp
       └─ host HTTPS proxy: rewrites URL to http://127.0.0.1:<gateway-port>
            └─ MCP gateway (loopback):
                 1. validates per-sandbox bearer
                 2. cross-checks X-Forwarded-For == sandbox IP
                 3. evaluates policies against tools/call params
                 4. dispatches to shared per-upstream MCP Client
                      └─ Streamable HTTP → api.githubcopilot.com
```

The host proxy stays the single chokepoint for egress. The gateway
itself binds loopback only — guests never reach it directly.

---

## Troubleshooting

**`mcp list` shows `github: not logged in` even after `mcp login`.**
Confirm `~/.aurica/sandbox/credentials.json` exists and contains a
`tokens` block under `upstreams.github`. Mode should be 600.

**Guest sees an empty `tools/list`.**
Either `defaultAction` is `block` and no policy names any tool, or
the upstream isn't authenticated. Look for an `_meta` entry with
`aurica.mcp.error: "login_required"` on the response — that's the
gateway telling you to run `mcp login <server>` on the host.

**`tools/call` returns "tool X is not allowed for this sandbox".**
The tool isn't named by any policy and `defaultAction` is `block`.
Add the tool to a policy, or widen `defaultAction`.

**`tools/call` returns `argument "k" must equal "v" (got "w")`.**
A policy named the tool, but its `arguments` constraint didn't match
the call. Either widen the policy (drop the constraint), add a second
policy that matches the new value, or change the call site.

**Source-IP mismatch errors at the gateway.**
The host proxy stamps the originating sandbox IP into
`X-Forwarded-For` and the gateway cross-checks it. If you see these,
the request didn't transit the proxy (misconfigured guest) or the
proxy is forwarding without the XFF header (proxy bug — file an
issue).
