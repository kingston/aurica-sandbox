---
'@aurica/sandbox': minor
---

The host proxy now reconciles the sandbox registry against OrbStack's actual VM states at startup, every 5 minutes, and on demand when a VM started outside the CLI sends its first request — correcting entries left stale when a VM is stopped, started, or deleted out-of-band (refreshing IPs, removing vanished VMs), so `list` stays accurate and egress isn't wrongly denied. A VM started outside the CLI now heals on its first request instead of being blocked.
