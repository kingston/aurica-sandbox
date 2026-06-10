# Aurica Sandbox

Ephemeral coding-agent VMs with restricted egress.

Aurica Sandbox spins up disposable Linux VMs (via [OrbStack](https://orbstack.dev/)) for running coding agents like Claude Code or Cursor against your repo, while routing all outbound traffic through a host-side HTTPS proxy that only permits the domains you declare. Per-VM allowlists are enforced by source IP, so a sandbox can talk to GitHub but not your bank.

## What's in the box

- **Per-project VMs.** `aurica-sandbox create` boots a VM, syncs your project, runs init scripts, and leaves it running so you can `shell` straight in.
- **Allowlist-only egress.** A host proxy (mockttp) terminates TLS using a generated CA and rejects any host not declared in `proxy.domains` or `proxy.policies`. It runs as a background daemon that commands start automatically.
- **Credential injection without checkout.** Tokens are read from your host (env vars, `gh auth token`) and substituted into outbound requests by the proxy — the VM never sees raw secrets on disk.
- **Pluggable tooling.** Built-in plugins for `github`, `mise`, `docker`, `claude-code`, `cursor`, and `mcp` declare the domains, env, and init steps each needs. Adding a plugin extends the strict config schema automatically.

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
# Check prerequisites (OrbStack, proxy, config)
asbox doctor

# Scaffold a config into your project, then edit it
asbox init

# Create the sandbox and shell in. The egress proxy autostarts in the
# background on first use — no separate terminal needed.
asbox create
asbox shell

# Run one-off commands, then tear it down
asbox run -- npm test
asbox destroy
```

`create` leaves the VM running so you can `shell` in immediately. Need several
isolated sandboxes from the same base — e.g. one per parallel agent? Build the
primary once as a base image (`asbox create --stopped`) and spin off cheap
copy-on-write clones with `asbox fork`. For a single sandbox you don't need
`fork` at all.

## CLI

All commands default to the project's primary sandbox when `[name]` is omitted.

| Command                        | Purpose                                                              |
| ------------------------------ | -------------------------------------------------------------------- |
| `doctor`                       | Check prerequisites (OrbStack, proxy, CA, config).                   |
| `init`                         | Scaffold `.aurica/sandbox.json`. `--force` to overwrite.             |
| `create [name]`                | Create a VM and run init; left running. `--stopped` for a fork base. |
| `fork [name]`                  | Clone the primary into a new running fork (parallel sandboxes).      |
| `update [name]`                | Re-run `update.sh` hooks to refresh without rebuilding.              |
| `rebuild [name]`               | Destroy and recreate (use after editing `sandbox.json`).             |
| `start [name]` / `stop [name]` | Resume / pause a VM (disk preserved).                                |
| `destroy [name]`               | Tear down a sandbox. `-f` to force; `--cascade` to remove forks.     |
| `list`                         | List registered sandboxes.                                           |
| `shell [name]`                 | SSH into the VM.                                                     |
| `run [name] -- <cmd...>`       | Run a one-shot command inside the VM.                                |
| `proxy start` / `stop`         | Start / stop the background egress-proxy daemon.                     |
| `proxy run`                    | Run the proxy in the foreground (long-running).                      |
| `proxy log` / `tail`           | Print or follow the proxy log.                                       |

Some plugins add their own subcommands once installed — e.g. `claude login` /
`claude status` / `claude logout` (claude-code) and `mcp login` / `mcp status` /
`mcp logout` (mcp) for host-side credential management.

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

## How it works & security

All outbound traffic is gated by a host proxy that enforces a per-VM allowlist by source IP, and credentials are injected by the proxy so the VM never holds raw secrets. For the full model — egress enforcement, credential handling, the CA lifecycle, and what it does and doesn't protect against — see [SECURITY.md](SECURITY.md). For how the proxy, credentials, VM lifecycle, and plugins fit together, see [ARCHITECTURE.md](ARCHITECTURE.md).

---

# For contributors

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, code style, and the PR workflow.

## Repo layout

```
packages/sandbox        # the single workspace package (@aurica/sandbox)
  src/bin               # `aurica-sandbox` CLI entrypoint
  src/cli/commands      # create / fork / update / destroy / start / stop / shell / run / proxy / doctor / ...
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

### Dev env vars (alongside a live install)

`pnpm start` and `pnpm dev` automatically load [.env.development](.env.development) — tracked, shared dev defaults (`AURICA_HOME=./.aurica-dev`, `AURICA_PROXY_PORT=51218`) that keep this checkout isolated from any globally-installed `asbox`. A fresh clone is dev-isolated by default:

```sh
pnpm start proxy        # dev proxy on its own port + state dir
pnpm start create --name dev-myproject
```

Need a one-off override? Either edit `.env.development` locally (don't commit) or set the var in your shell.

## License

MIT — see [LICENSE](LICENSE).
