# Contributing

Thanks for considering a contribution to `@aurica/sandbox`.

## Prerequisites

- macOS with [OrbStack](https://orbstack.dev/) installed and running (required
  to exercise the VM lifecycle; most unit tests run without it).
- [mise](https://mise.jdx.dev/) — pins Node 24 + pnpm 10 via `mise.toml`.

## Setup

```sh
mise trust && mise install
pnpm install
```

The workspace uses the `@aurica/source` export condition to run TypeScript
sources directly during development — no build step needed.

```sh
pnpm start <cmd>                     # run the CLI from source via tsx
pnpm build                           # turbo build -> tsc per package
pnpm typecheck                       # turbo typecheck
pnpm check                           # oxlint + oxfmt --check + test
pnpm check:fix                       # oxlint --fix + oxfmt + test
pnpm --filter @aurica/sandbox test   # vitest
```

`pnpm start` / `pnpm dev` auto-load [.env.development](.env.development), which
isolates this checkout (`AURICA_HOME=./.aurica-dev`, dev proxy port `51218`)
from any globally-installed `asbox`. A fresh clone is dev-isolated by default.

## Code style

- Run `pnpm check:fix` before pushing — it formats (oxfmt), lints (oxlint), and
  runs tests.
- Add JSDoc to all exported types, interfaces, functions, and classes.
- Keep `index.ts` files as barrels (re-exports only); put implementation in a
  descriptively-named sibling (e.g. `github.plugin.ts`, `doctor.ts`).
- Use Consola (`logger`) for console output unless a specific format (e.g. JSON)
  is required.
- Comments and JSDoc should be concise and describe current behavior — avoid
  historical justification.

## Tests

Tests are colocated as `*.test.ts` next to the code they cover (Vitest).
Prefer extracting pure helpers and unit-testing those; mock the VM provider and
filesystem rather than touching real OrbStack VMs in unit tests.

## Pull requests

- Branch off `main`; PR titles must follow Conventional Commits (enforced by
  CI).
- Add a changeset for any user-facing change: `pnpm changeset`. Keep it focused
  and summarized to a single paragraph describing the user-visible effect.
  Internal-only refactors don't need one.
- CI runs lint, format check, tests, and a dedupe check on every PR.

## Project layout

See the "Repo layout" section of the [README](README.md#repo-layout) and
[ARCHITECTURE.md](ARCHITECTURE.md) for how the proxy, credentials, VM lifecycle,
and plugins fit together.
