# DSH Bridge — shared DSH executor for local agents

- `bundle/`: the DSH bundle `@local/dsh-bridge` (runs inside DSH Hosts). `lib/`: the Node client callers load from the installed runtime, the Host runner and DSH discovery. `setup.mjs`: install and upgrade. `docs/protocol.md` is the contract; change it with the code, and bump `PROTOCOL` (bundle and `lib/common.mjs` together) only for breaking changes.
- Callers (Codex's dsh-subagent, Claude's Agent Hub, ...) keep their own settings, records and UI. Nothing caller-specific belongs here; each passes its own `client` name.
- Compatibility is decided by `bundle/compatibility.*`: verified builds plus fingerprints of the DSH modules the adapter touches, and a capability check at load. Never relax it to pass a version bump: run `tests/acceptance.mjs` (isolated home, local fake model, real Host) and review the interface first, then add the build.
- Never change a resumed session's workspace, preset, permission or model; never steer or queue into a running session; never exit DSH Desktop. Tests and acceptance never call a real model or use the user's DSH home.
- Installing changes the user's `desktop` profile: back up profile files first (setup does), and tell the user DSH Desktop must restart to load a new bundle.
- `npm test`, then `node setup.mjs`. Release through Git tags once published; do not move tags or force push. No user-specific absolute paths in sources.
