---
'@aurica/sandbox': minor
---

Adds managed background proxy daemon: `proxy start` launches it, `proxy stop` shuts it down, `proxy log` and `proxy tail` show logs. Proxy commands now autostart the daemon if needed unless `AURICA_NO_AUTOSTART=1` is set. Daemon logs to `~/.aurica/sandbox/proxy.log`, rotating on each start.