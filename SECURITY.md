# Security model

Aurica Sandbox runs untrusted-ish code (coding agents acting on your repo) in a
disposable VM while keeping two things off-limits: **the network**, except hosts
you explicitly allow, and **your credentials**, which the VM never holds in raw
form. This document describes how that's enforced and what it does and doesn't
protect against.

## The core invariant

> A sandbox can only reach the hosts you declare, and never sees your raw
> secrets.

Everything below exists to uphold that invariant for a **single developer on
their own machine** — the supported deployment. Multi-user / shared-host
hardening (per-user proxy isolation, audit trails) is out of scope.

## How egress is restricted

1. **Isolated VM.** VMs are created isolated from the host filesystem and from
   macOS networking (OrbStack `--isolated --isolate-network`).
2. **Default-DROP in the guest.** During init, the VM applies an iptables
   `OUTPUT` policy of `DROP` (IPv4 and IPv6), allowing only loopback and TCP to
   the host proxy. Everything else is rejected inside the VM before it leaves.
3. **All traffic flows through the host proxy.** The guest's `HTTP_PROXY` /
   `HTTPS_PROXY` point at the host proxy on the OrbStack bridge IP. The proxy
   (mockttp) terminates TLS using a generated CA that the VM trusts, so it can
   read the destination host of every request — including HTTPS — and apply the
   allowlist.
4. **Per-sandbox allowlist keyed by source IP.** The proxy maps each request's
   source IP to a registered sandbox and enforces that sandbox's
   `proxy.domains` / `proxy.policies`. A host not on the list gets a `403`; an
   unregistered source IP is rejected outright. This is why the bridge IP (not
   `host.orb.internal`, which NATs every VM to `127.0.0.1`) is used — collapsing
   all VMs to one source IP would defeat per-sandbox allowlisting.

## How credentials stay off the VM

- Tokens are resolved **on the host** from credential sources (`env:VAR`,
  `gh-token`, `vault:<record>#<field>`) and substituted into outbound requests
  by the proxy. The VM holds only opaque placeholders, never the real secret.
- Host-side secret material lives under `~/.aurica/sandbox/` (override the root
  with `AURICA_HOME`):
  - `secrets.json` — tokens and OAuth blobs, written with file mode `0600`.
  - `credentials.json` — non-secret metadata (expiries, scopes).
  - `ca/key.pem`, `ca/cert.pem` — the proxy CA, also mode `0600`.
    These are protected by filesystem permissions only; there is no OS keychain
    integration today (the vault interface is designed so one can be swapped in
    without changing callers).
- `env:` and `gh-token` sources are never persisted — they're read fresh
  (gh-token is briefly memoized in-process to avoid spawning `gh` on every
  request).
- Each sandbox gets a unique per-VM `authSecret` (bearer), used by in-VM
  services such as the MCP gateway so one sandbox can't impersonate another.

## What this does NOT protect against

- **A malicious allowlisted host.** If you allow a domain, the sandbox can talk
  to it freely. Keep `proxy.domains` minimal.
- **Exfiltration through an allowed channel.** Code that can reach an allowed
  host can send data there. The proxy gates _which_ hosts, not _what_ leaves.
- **Host compromise.** The proxy and secret store run on your host as your user.
  A compromised host is outside the model.
- **CA misuse.** The generated CA is trusted only inside sandbox VMs. Don't
  import it into your host trust store.

## CA lifecycle

The CA is generated once on first proxy start and reused across restarts
(`~/.aurica/sandbox/ca/`). VMs import it during init so HTTPS through the proxy
validates. To rotate it, stop the proxy, delete the `ca/` directory, restart the
proxy, and rebuild any existing sandboxes so they pick up the new CA.

## Reporting a vulnerability

Please open a private security advisory on the repository rather than a public
issue.
