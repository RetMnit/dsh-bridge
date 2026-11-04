// What a caller imports from the installed runtime (see docs/protocol.md):
//   const { root } = JSON.parse(fs.readFileSync(path.join(stateDir, 'install.json'), 'utf8'))
//   const { connect } = await import(pathToFileURL(path.join(root, 'lib/client.mjs')).href)
//   const dsh = connect()
//   await dsh.call('headless', 'start', { client: 'my-agent', requestId, prompt, workspace })
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ROOT, STATE, PROTOCOL, MODES, BridgeError, config, pipeCall, discoverRuntime } from './common.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const offline = error => ['ENOENT', 'ECONNREFUSED', 'EPIPE'].includes(error.code);

export function connect({ state = STATE } = {}) {
  const settings = config(state);
  const boots = new Map();
  const verified = new Set(); // modes whose running Host passed the protocol check
  const identity = createHash('sha256').update(path.resolve(state).toLowerCase()).digest('hex').slice(0, 16);

  function checked(doctor) {
    if (doctor.protocolVersion !== PROTOCOL) throw new BridgeError('dsh/protocol', `DSH runs bridge protocol ${doctor.protocolVersion}; this client needs ${PROTOCOL}. Restart DSH Desktop (or end the hidden Host) so it loads the installed bridge`);
    return doctor;
  }
  // Only one caller starts a Host; the rest wait for its pipe.
  async function launchLock(mode) {
    const lock = net.createServer();
    try { await new Promise((resolve, reject) => { lock.once('error', reject); lock.listen('\\\\.\\pipe\\dsh-bridge-launch-' + identity + '-' + mode, resolve); }); return lock; }
    catch { return null; }
  }
  // Returns the doctor of a running Host for this mode, starting one when none answers.
  async function ensure(mode) {
    if (!MODES.includes(mode)) throw new BridgeError('dsh/mode', 'mode must be desktop or headless');
    discoverRuntime(settings.runtime.installDir);
    try { return checked(await pipeCall(settings, mode, 'doctor', {}, 2000)); }
    catch (error) { if (!offline(error)) throw error; }
    if (!boots.has(mode)) boots.set(mode, (async () => {
      const lock = await launchLock(mode);
      try {
        if (lock) {
          const child = spawn(process.execPath, [path.join(ROOT, 'lib/host-runner.mjs'), mode], {
            windowsHide: true, detached: true, shell: false, stdio: 'ignore', env: { ...process.env, DSH_BRIDGE_STATE_DIR: state },
          });
          child.unref();
        }
        let failure;
        for (let i = 0; i < 150; i++) {
          await delay(300);
          try { return checked(await pipeCall(settings, mode, 'doctor', {}, 1500)); }
          catch (error) { if (error.code === 'dsh/protocol') throw error; failure = error; }
        }
        throw new BridgeError('dsh/start', `DSH ${mode} Host did not become ready (${failure?.message}); see ${path.join(state, 'logs', mode + '.log')}`);
      } finally { lock?.close(); }
    })().finally(() => boots.delete(mode)));
    return boots.get(mode);
  }
  return {
    settings,
    defaults: settings.defaults,
    runtime: () => discoverRuntime(settings.runtime.installDir),
    ensure,
    // Starts the Host for `mode` if needed (`start: false` only asks one already
    // running); either way a Host is checked once for its protocol, and again
    // after the pipe fails (it may have restarted with another bundle).
    async call(mode, method, params = {}, { start = true } = {}) {
      if (start) await ensure(mode);
      else {
        if (!MODES.includes(mode)) throw new BridgeError('dsh/mode', 'mode must be desktop or headless');
        if (!verified.has(mode)) checked(await pipeCall(settings, mode, 'doctor', {}, 2000));
      }
      verified.add(mode);
      try { return await pipeCall(settings, mode, method, params, method === 'events' ? 55000 : 30000); }
      catch (error) { if (!error.code?.startsWith?.('dsh/') || error.code === 'dsh/disconnected') verified.delete(mode); throw error; }
    },
    // Reads whatever runs, starting nothing.
    async doctor() {
      const modes = {};
      for (const mode of MODES) {
        try { modes[mode] = checked(await pipeCall(settings, mode, 'doctor', {}, 2000)); }
        catch (error) {
          // A Host whose bundle failed to start says why in a failure record (see bundle/index.mjs).
          const failure = [state, os.tmpdir()].map(directory => path.join(directory, 'dsh-bridge-' + mode + '-failure.json')).find(file => fs.existsSync(file));
          modes[mode] = { connected: false, error: error.code ?? error.message, ...(failure ? { startupFailure: JSON.parse(fs.readFileSync(failure, 'utf8')) } : {}) };
        }
      }
      return { runtime: discoverRuntime(settings.runtime.installDir), modes };
    },
    // Brings DSH Desktop to the front (it keeps one instance).
    focusDesktop() {
      const runtime = discoverRuntime(settings.runtime.installDir);
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(runtime.executable, [], { env, detached: true, windowsHide: false, shell: false, stdio: 'ignore' });
      child.on('error', () => {}); child.unref();
    },
  };
}
