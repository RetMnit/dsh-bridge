# DSH Bridge

Lets local agents use DSH (DeepSeek Harness) as a subagent: start sessions with an exact preset, model, workspace and permission, resume an existing session with its own settings, watch progress, read answers and cancel. Work runs either in DSH Desktop, where you can watch it, or in a hidden DSH Host.

It is a DSH bundle with an authenticated named-pipe protocol, plus a Node client. Each caller sees only its own jobs.

## Install

Needs Windows, Node.js 22+ and DSH Desktop of a supported version (`bundle/compatibility.json`); `dsh.cmd` on `PATH`, or `DSH_INSTALL_DIR`. Set up your own DSH login and presets first.

```bash
git clone https://github.com/RetMnit/dsh-bridge.git
cd dsh-bridge
node setup.mjs
```

Then fully quit and reopen DSH Desktop. Setup backs up the DSH profile files it changes. The default workspace for new sessions is `%USERPROFILE%\DSH-Workspace` unless `DSH_BRIDGE_WORKSPACE` says otherwise; a later setup keeps the one already configured.

## Use

```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const state = path.join(os.homedir(), '.dsh-bridge');
const { root } = JSON.parse(fs.readFileSync(path.join(state, 'install.json'), 'utf8'));
const { connect } = await import(pathToFileURL(path.join(root, 'lib/client.mjs')).href);

const dsh = connect();
const job = await dsh.call('headless', 'start', { client: 'my-agent', requestId: 'task-1', prompt: 'Summarize README.md', workspace: 'D:\\Project' });
```

Methods, parameters and the job shape are in [docs/protocol.md](docs/protocol.md).

## Test

```bash
npm test
node tests/acceptance.mjs
```

`npm test` uses a synthetic DSH context. The acceptance run starts a real DSH Host with an isolated home and a local fake model; no real model is called.
