---
'@aurica/sandbox': minor
---

The host proxy can now run as a managed background daemon. New `aurica-sandbox proxy start` launches it detached and waits until it's listening before returning; `proxy stop` shuts it down cleanly; `proxy run` keeps the foreground behavior (bare `aurica-sandbox proxy` still runs in the foreground); and `proxy log` / `proxy tail` print or follow the daemon's output. Output is written to `~/.aurica/sandbox/proxy.log`, rotated aside to `proxy.log.1` on each start. Commands that need the proxy (`create`, `fork`, `start`, `run`, `update`) now autostart the daemon in the background instead of failing when it isn't running; set `AURICA_NO_AUTOSTART=1` to opt out (e.g. in CI).
