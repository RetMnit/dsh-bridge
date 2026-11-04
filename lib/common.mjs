import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyRuntimeCompatibility } from '../bundle/compatibility.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
export const PROTOCOL = 2;
// The user profile, not %LOCALAPPDATA%: packaged apps (the Claude and Codex desktop apps)
// see a private copy of AppData, so a bridge state there is invisible to other apps.
export const STATE = process.env.DSH_BRIDGE_STATE_DIR || path.join(os.homedir(), '.dsh-bridge');
export const MODES = ['desktop', 'headless'];

export class BridgeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (fallback !== undefined && error.code === 'ENOENT') return fallback; throw error; }
};
export function atomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}
export function config(state = STATE) {
  const settings = readJson(path.join(state, 'config.json'), null);
  if (!settings?.token) throw new BridgeError('dsh/not-installed', 'The DSH bridge is not installed; run setup.mjs in Common/dsh-bridge');
  return settings;
}

// One authenticated JSON line each way over the bridge's named pipe.
export function pipeCall(settings, mode, method, params = {}, timeoutMs = 55000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(settings.pipes[mode]);
    socket.setEncoding('utf8');
    const id = randomUUID();
    let buffer = '', done = false;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(new BridgeError('dsh/timeout', 'DSH bridge request timed out: ' + method)), timeoutMs);
    socket.on('connect', () => socket.write(JSON.stringify({ id, token: settings.token, method, params }) + '\n'));
    socket.on('error', error => finish(error));
    socket.on('end', () => finish(new BridgeError('dsh/disconnected', 'DSH bridge disconnected before replying')));
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 16 * 1024 * 1024) return finish(new BridgeError('dsh/size', 'Bridge response exceeded limit'));
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const reply = JSON.parse(buffer.slice(0, newline));
        if (reply.id !== id) throw new BridgeError('dsh/protocol', 'Unexpected response id');
        if (reply.error) finish(new BridgeError(reply.error.code ?? 'dsh/error', reply.error.message));
        else finish(null, reply.result);
      } catch (error) { finish(error); }
    });
  });
}

export function readAsar(archive, rel) {
  const fd = fs.openSync(archive, 'r');
  try {
    const start = Buffer.alloc(16); fs.readSync(fd, start, 0, 16, 0);
    const header = Buffer.alloc(start.readUInt32LE(12)); fs.readSync(fd, header, 0, header.length, 16);
    let entry = JSON.parse(header).files;
    const pieces = rel.split('/');
    for (let i = 0; i < pieces.length; i++) { entry = entry[pieces[i]]; if (!entry) throw new Error('Missing ASAR entry: ' + rel); if (i < pieces.length - 1) entry = entry.files; }
    if (entry.unpacked) return fs.readFileSync(archive + '.unpacked/' + rel);
    const data = Buffer.alloc(Number(entry.size));
    fs.readSync(fd, data, 0, data.length, 8 + start.readUInt32LE(4) + Number(entry.offset));
    return data;
  } finally { fs.closeSync(fd); }
}
// The DSH Desktop installation and whether this bridge supports it (compatibility.json).
export function discoverRuntime(installDir) {
  if (!installDir) {
    for (const directory of (process.env.PATH || '').split(path.delimiter)) {
      if (directory && fs.existsSync(path.join(directory, 'dsh.cmd'))) { installDir = path.resolve(directory, '../../../..'); break; }
    }
  }
  if (!installDir) throw new BridgeError('dsh/missing', 'DSH Desktop was not found: dsh.cmd is not on PATH (set DSH_INSTALL_DIR)');
  const executable = path.join(installDir, 'DeepSeek Harness.exe');
  const archive = path.join(installDir, 'resources/app.asar');
  const desktop = JSON.parse(readAsar(archive, 'package.json'));
  const compatibility = verifyRuntimeCompatibility(desktop, file => readAsar(archive, 'dsh/node_modules/' + file));
  if (!fs.existsSync(executable)) throw new BridgeError('dsh/missing', 'DSH executable not found');
  return { installDir, executable, cli: path.join(archive, 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'), version: desktop.version, buildCommit: desktop.dshBuildCommit, compatibility };
}
