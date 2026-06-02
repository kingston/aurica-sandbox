---
'@aurica/sandbox': minor
---

`start`, `stop`, `destroy`, `shell`, and `run` now default to the project's primary sandbox when no name is given, matching `create`, `update`, and `rebuild`. Pass an explicit name to target a specific sandbox or fork. For `run`, a name is only recognized when it precedes the `--` separator (e.g. `run myname -- cmd`); without a name, the command runs against the primary (`run -- cmd` or `run cmd`).
