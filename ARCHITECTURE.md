# Architecture

A high-level map of how `@aurica/sandbox` fits together. For the security
rationale see [SECURITY.md](SECURITY.md); for module layout see the README.

## The pieces

- **CLI** (`src/bin`, `src/cli/commands`) — thin command wrappers (`create`,
  `fork`, `shell`, `doctor`, `proxy …`, …) over `runX` functions. Plugins can
  register their own subcommands at startup.
- **Config** (`src/config`) — Zod schemas and loaders for the project config
  (`.aurica/sandbox.json`) and user config (`~/.aurica/sandbox/config.json`).
  Both are strict-validated; plugin blocks extend the schema automatically.
- **State registry** (`src/state`) — an on-disk JSON registry
  (`~/.aurica/sandbox/state.json`) tracking the proxy and every sandbox.
  Mutations go through an atomic, lock-guarded `withState`.
- **VM provider** (`src/vm`) — a typed `SandboxVMProvider` abstraction. The only
  implementation today is OrbStack (`src/vm/providers/orb`), driven via
  `orbctl`. Command code never imports `orbctl` directly.
- **Proxy** (`src/proxy`) — a mockttp-based host proxy that terminates TLS with
  a generated CA, enforces per-sandbox allowlists, and substitutes credentials.
- **Plugins** (`src/plugins`) — `github`, `mise`, `docker`, `claude-code`,
  `cursor`, `mcp`. Each declares the domains, env, init steps, and (optionally)
  CLI commands or sidecars it needs.
- **Credentials** (`src/credentials`) — host-side token providers (`env`,
  `gh-token`, `vault`) plus a split metadata/secret store.

## Lifecycle: `create`

1. Validate platform and ensure the proxy daemon is running (autostarted if
   needed).
2. Load and validate `.aurica/sandbox.json`; fail fast on bad file/mount paths.
3. Create an `--isolated` VM and wait for its IPv4.
4. Expand the enabled plugins into domains, policies, init commands, and a
   bootstrap script. Register the sandbox in state and signal the proxy to
   reload.
5. Run the layered init pipeline in the VM: base packages → plugin bootstrap →
   user hooks (`~/.aurica/sandbox/init/`) → project hooks
   (`<projectDir>/.aurica/init/`), then lock the VM down with default-DROP
   iptables (everything except the proxy).
6. Leave the VM running (or stop it, with `--stopped`, as a base image to
   `fork`).

`fork` skips the pipeline: it clones the primary (inheriting its disk, proxy
config, and `authSecret`) and runs only `setup-fork.sh` hooks. `orbctl clone`
snapshots the source and restores its prior state, so a running primary is
undisturbed. `fork --branch <hint>` passes the hint to those hooks via an
environment variable; what it does (e.g. `git checkout`) is entirely up to your
`setup-fork.sh`.

## Request path through the proxy

1. A guest request arrives; the proxy maps its source IP to a registered
   sandbox (unregistered IPs are rejected).
2. The destination host is checked against the sandbox's allowlist and
   policies (first match wins); non-allowed hosts get a `403`.
3. Matched requests have mutations applied — notably credential substitution,
   where a host-resolved token replaces an opaque placeholder.
4. Optional response handling: OAuth token capture, response caching.

The response cache (`~/.aurica/sandbox/cache`) is shared across sandboxes and
has no size cap or automatic eviction today — clear the directory manually to
reclaim space.

## Config reload

The proxy watches each registered sandbox's `.aurica/sandbox.json`. On change it
re-derives that sandbox's rules and hot-reloads — no restart, no VM rebuild. The
host's copy of the config is authoritative; because source is _copied_ into the
isolated VM (not bind-mounted), the guest can't alter the egress policy it runs
under.

## Extending it

- **New plugin:** implement the `SandboxPlugin` contract and add it to the
  registry in `src/plugins/registry.ts`. The config schema, expansion order, and
  `init` plugin listing all follow automatically.
- **New VM backend:** implement `SandboxVMProvider` and wire it in at
  `src/vm/index.ts` (the seam where a non-OrbStack backend would slot in).
