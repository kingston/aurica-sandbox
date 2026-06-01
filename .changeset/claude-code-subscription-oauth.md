---
'@aurica/sandbox': minor
---

Add `authMode: 'subscription'` for the `claude-code` plugin. Run `claude /login` inside the sandbox VM to sign in to a Pro/Max/Team/Enterprise account; the host proxy captures the OAuth tokens and the guest only ever sees per-sandbox placeholders. Refresh-token rotation and parallel-401 bursts are handled transparently. `aurica-sandbox claude status|logout` report and clear the cached slot.
