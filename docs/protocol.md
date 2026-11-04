# DSH Bridge protocol 2

The bridge is a DSH bundle (`@local/dsh-bridge`) that serves an authenticated named pipe from inside a DSH Host. Two Hosts can run it:

| mode | Host | Sessions |
| --- | --- | --- |
| `desktop` | DSH Desktop (profile `desktop`) | the user's own; the user can watch and open them |
| `headless` | a hidden Host (profile `dsh-bridge-worker`) started on demand | a separate store under the bridge state folder |

## Files

`~/.dsh-bridge` (or `DSH_BRIDGE_STATE_DIR`), readable only by the user, SYSTEM and Administrators. It lives in the user profile, not `%LOCALAPPDATA%`: packaged apps (the Claude and Codex desktop apps) see a private copy of AppData, so state there would be invisible to DSH and to each other.

| File | What |
| --- | --- |
| `config.json` | `{ protocolVersion, runtime, home, workerProfile, token, pipes: { desktop, headless }, defaults: { workspace, permission } }` |
| `install.json` | `{ version, protocol, root }`: the Node runtime callers load (`node setup.mjs` writes it) |
| `jobs/<mode>/<jobId>.json` | job records, kept across Host restarts |
| `sessions/`, `storages/` | the headless Host's own DSH data |
| `<mode>-instance.json`, `<mode>-launch.json`, `logs/` | Host bookkeeping |

## Calling

Callers on Node import `<install.root>/lib/client.mjs`: `connect()` returns `call(mode, method, params, { start })`, which starts the Host for `mode` when none answers (DSH Desktop for `desktop`, the hidden worker for `headless`; one caller starts it, others wait) and refuses a Host on another protocol. With `start: false` it only asks a Host that already runs, so a status view never opens DSH Desktop by itself.

On the wire: connect to `pipes[mode]`, write one JSON line `{ id, token, method, params }`, read one JSON line `{ id, result }` or `{ id, error: { code, message } }`.

## Clients

Job methods take `client`, a short lowercase name of the caller (`codex`, `agent-hub`, ...). A client sees and controls only its own jobs, and `requestId`s are per client. Starting again with a `requestId` the client already used returns that job when the arguments are identical and is refused when they differ.

## Methods

| Method | Params | Result |
| --- | --- | --- |
| `doctor` | — | `{ protocolVersion, bridgeVersion, dshVersion, mode, pid, instanceId, profile, capabilities }` |
| `catalog` | — | `{ presets: { presets: [{ id, name?, description?, isDefault }] }, models: { default, groups: [{ id, name, models: [{ id, name, reasoning: { efforts, defaultEffort } }] }] }, permissions: { options, defaultPreset }, workspaces }` (DSH's own shapes) |
| `sessions` | `workspace?`, `query?`, `limit?` | `[{ sessionId, title, cwd, preset, running, blank, updatedAt }]` from this Host's store |
| `start` | `client`, `requestId`, `prompt`, `title?`, `meta?` (≤ 4 KB object kept on the job), and either `sessionId` (continue that session) or `workspace?`, `preset?`, `model? { provider, model, reasoningEffort? }`, `permission?` | job; a new session uses DSH's default preset and the bridge's default workspace and permission for what is left out |
| `list` | `client` | `{ instanceId, cursor, jobs }` |
| `status` | `client`, `jobId` | job |
| `events` | `client`, `afterCursor`, `instanceId`, `timeoutMs?` (≤ 45 000) | `{ instanceId, cursor, jobs }`, at once when anything changed or the Host restarted |
| `cancel` | `client`, `jobId` | job; cancels the session's turn and its child agents |
| `open` | `sessionId`, or `client` and `jobId` | `desktop` only: shows the session in DSH Desktop |
| `prepare` | as `start`, without a prompt | `{ sessionId, effective }`: creates or resolves a session without a model call |
| `shutdown` | — | `headless` only, refused while jobs run |

A resumed session keeps its own workspace, preset, permission and model; asking to change them fails the job before any prompt. One job per session at a time; a session with running child agents is busy. Child sessions are controlled through their parent.

## Job

```text
jobId, client, requestId, title?, meta?, mode, promptSummary, status, phase?, createdAt, updatedAt, finishedAt?,
sessionId?, requested { workspace, preset?, permission?, model? }, effective { workspace, preset, permission, model, tools },
events [{ at, type, seq, ... }] (last 300: turn/start, assistant/message, tool/call, tool/result, turn/end),
result? (last assistant text), stopReason?, actualModel?, usageSamples, error? { code, message },
pendingQuestions?, descendants [{ sessionId, parentSessionId, status }], backgroundJobs, eventCounts
```

`status`: `starting`, `running`, `waiting-user` (the session asked the user a question), `waiting-approval`, then `completed`, `failed`, `cancelled` or `interrupted` (the Host restarted mid-run; inspect before resuming). A job ends only when its session and every local child agent are idle.

## Compatibility

`bundle/compatibility.json` lists the DSH builds this adapter was accepted on and the SHA-256 of the DSH modules it depends on. Another build of the supported family is accepted only when those modules are byte-identical; the bundle also checks at load that every DSH service method it calls exists, and refuses to start otherwise.
