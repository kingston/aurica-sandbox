# Aurica Sandbox

Ephemeral coding-agent VMs with restricted egress.

Aurica Sandbox spins up disposable Linux VMs (via [OrbStack](https://orbstack.dev/)) for running coding agents like Claude Code or Cursor against your repo, while routing all outbound traffic through a host-side HTTPS proxy that only permits the domains you declare. Per-VM allowlists are enforced by source IP, so a sandbox can talk to GitHub but not your bank.

## What's in the box

- **Per-project VMs.** `aurica-sandbox create` boots a VM, syncs your project, runs init scripts, and hands you a shell.
- **Allowlist-only egress.** A foreground host proxy (mockttp) terminates TLS using a generated CA and rejects any host not declared in `proxy.domains` or `proxy.policies`.
- **Credential injection without checkout.** Tokens are read from your host (env vars, `gh auth token`) and substituted into outbound requests by the proxy — the VM never sees raw secrets on disk.
- **Pluggable tooling.** Built-in plugins for `github`, `mise`, `docker`, `claude-code`, and `cursor` declare the domains, env, and init steps each needs. Adding a plugin extends the strict config schema automatically.

## Requirements

- macOS with [OrbStack](https://orbstack.dev/) installed and running.
- Node.js 22 or newer.

## Install

```sh
npm install -g @aurica/sandbox
```

Installs both `aurica-sandbox` and the shorter alias `asbox` on your `PATH`. Use either — they point at the same binary.

## Getting started

```sh
# Scaffold a config into your project
asbox init

# Run the egress proxy in one terminal (foreground, long-running)
asbox proxy

# In another terminal: create + enter a sandbox
asbox create
asbox shell <name>
```

## CLI

| Command                        | Purpose                                                      |
| ------------------------------ | ------------------------------------------------------------ |
| `init`                         | Scaffold `.aurica/sandbox.json`.                             |
| `proxy`                        | Run the host egress proxy (foreground).                      |
| `ca`                           | Print the proxy CA certificate (PEM).                        |
| `create [name]`                | Create a VM and run init. Default name: `<folder>-<branch>`. |
| `rebuild [name]`               | Destroy and recreate (use after editing `sandbox.json`).     |
| `start <name>` / `stop <name>` | Resume / pause a VM (disk preserved).                        |
| `destroy <name>`               | Tear down a sandbox. `-f` to force-destroy unregistered VMs. |
| `list`                         | List registered sandboxes.                                   |
| `shell <name>`                 | SSH into the VM.                                             |
| `run <name> -- <cmd...>`       | Run a one-shot command inside the VM.                        |

## Config

Project config (`.aurica/sandbox.json`) declares the sandbox name, VM resources, allowed proxy domains, and which plugins are enabled. Plugin blocks are opt-in by inclusion and strict-validated against each plugin's schema.

```jsonc
{
  "name": "aurica-sandbox",
  "proxy": { "domains": ["*.astro.build", "*.github.com"] },
  "plugins": {
    "github": {
      "repositories": [{ "name": "kingston/workspace-meta" }],
      "tokenSource": "gh-token",
      "username": "kingston",
    },
    "mise": {},
    "claude-code": {
      "authMode": "oauth-token",
      "tokenSource": "env:CLAUDE_CODE_OAUTH_TOKEN",
    },
    "cursor": {},
  },
}
```

User-level defaults live in `~/.aurica/sandbox/config.json` (VM provider, distro, credential providers, credential-cache TTL, and per-plugin user defaults). See [packages/sandbox/src/config/user.ts](packages/sandbox/src/config/user.ts).

---

# For contributors

## Repo layout

```
packages/sandbox        # the single workspace package (@aurica/sandbox)
  src/bin               # `aurica-sandbox` CLI entrypoint
  src/cli/commands      # create / destroy / start / stop / shell / run / proxy / ...
  src/config            # project + user config schemas (zod)
  src/credentials       # token providers (env, gh-token) and idle cache
  src/plugins           # github, mise, docker, claude-code, cursor
  src/proxy             # mockttp host proxy, CA, policy substitution
  src/vm                # VM provider abstraction; orb provider lives under providers/orb
  src/state             # on-disk sandbox registry
.aurica/sandbox.json    # this repo's own sandbox config (dogfood)
```

## Development

Toolchain: [mise](https://mise.jdx.dev/) pins Node 24 + pnpm 10 via `mise.toml`.

```sh
mise trust && mise install
pnpm install

pnpm start <cmd>  # run the CLI from source via tsx (no build needed)

pnpm build       # turbo build -> tsc -p tsconfig.build.json per package
pnpm typecheck   # turbo typecheck
pnpm check       # oxlint --fix && oxfmt
pnpm --filter @aurica/sandbox test   # vitest
```

The workspace uses the `@aurica/source` export condition to run TypeScript sources directly during development without a build step.

## License

MIT — see [LICENSE](LICENSE).
