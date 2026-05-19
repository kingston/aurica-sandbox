## Project

`@aurica/sandbox` — a CLI + library for spinning up ephemeral, disposable Linux VMs (via OrbStack on macOS) to run coding agents against repos with restricted egress. All outbound traffic is routed through a host-side HTTPS proxy that enforces a domain allowlist and injects credentials (e.g. GitHub tokens) from the host without storing secrets in the VM.

## Repo structure

Single-package pnpm monorepo. All source lives in [packages/sandbox/src/](packages/sandbox/src/):

- `bin/` — CLI entry (`aurica-sandbox`)
- `cli/commands/` — command implementations (init, proxy, create, destroy, shell, run, …)
- `config/` — Zod schemas + loaders for project (`.aurica/sandbox.json`) and user config
- `credentials/` — token providers (env, gh-token) and idle cache
- `plugins/` — built-in plugins: `github/`, `mise/`, `docker/`, `claude-code/`, `cursor/`, `mcp/`
- `proxy/` — mockttp-based HTTPS proxy: CA generation, credential-substitution policy, live config reload
- `vm/` — VM provider abstraction; OrbStack provider under `providers/orb`
- `state/` — on-disk sandbox registry
- `utils/` — shared helpers

Stack: TypeScript (Node 24+), pnpm 10, Turbo, oxlint + oxfmt, Vitest, Commander, Zod, mockttp, execa, consola.

## Approach

- Think before acting. Read existing files before writing code.
- Be concise in output but thorough in reasoning.
- Prefer editing over rewriting whole files.
- Do not re-read files you have already read unless the file may have changed.
- Test your code before declaring done.
- No sycophantic openers or closing fluff.
- Keep solutions simple and direct.
- User instructions always override this file.

## Additional Instructions

- Run pnpm check:fix after writing code.
- When adding new packages use pnpm add <package> instead of modifying package.json manually.
- Make sure to add JSDocs to all public exported types, interfaces, functions, and classes.
- Use Consola when logging to the console unless it shoudl be formatted differently e.g. with JSON.
- When writing comments/JSDoc, avoid providing historical justification for the code but keeping it concise and to the point.
  (rewrite if it starts to become too verbose)
- Do not put logic in `index.ts`. Keep it as a barrel that only re-exports from sibling files.
  Put the implementation in a descriptively-named sibling (e.g. `github.plugin.ts`, `foo.service.ts`).
