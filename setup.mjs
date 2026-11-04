// Installs the DSH bridge for this Windows user:
// - the bundle into ~/.dsh/bundles/dsh-bridge, enabled in the `desktop` profile and
//   in a hidden `dsh-bridge-worker` profile for headless runs (DSH must restart);
// - ~/.dsh-bridge/config.json (pipes, token, defaults) and the Node runtime
//   callers load (runtime\<version>, named by install.json).
// `--retire-legacy` also removes the Codex-only bridge it replaces (codex-dsh-bridge).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { ROOT, STATE, VERSION, PROTOCOL, atomic, readJson, discoverRuntime } from './lib/common.mjs';

const PACKAGE = '@local/dsh-bridge';
const LEGACY = { package: '@local/codex-dsh-bridge', bundle: 'codex-dsh-bridge', profile: 'codex-worker', state: 'CodexDSHBridge' };
const runtime = discoverRuntime(process.env.DSH_INSTALL_DIR);
const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const bundleDir = path.join(home, 'bundles', 'dsh-bridge');
const link = 'link:' + bundleDir.replaceAll('\\', '/');
const identity = createHash('sha256').update(os.userInfo().username + ':' + home).digest('hex').slice(0, 16);
const legacyState = path.join(process.env.LOCALAPPDATA || os.homedir(), LEGACY.state);

fs.mkdirSync(STATE, { recursive: true });
if (process.platform === 'win32' && !process.env.DSH_BRIDGE_STATE_DIR) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'lib/protect-state.ps1'), '-Path', STATE], { windowsHide: true, stdio: 'pipe' });
  if (result.status !== 0) throw new Error('Could not protect the bridge state folder: ' + result.stderr);
}
const settingsPath = path.join(STATE, 'config.json');
const old = readJson(settingsPath, {});
const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
const backup = path.join(STATE, 'backups', stamp);
// A first install takes its default workspace from the bridge it replaces.
const legacyDefaults = readJson(path.join(legacyState, 'config.json'), {}).defaults ?? {};
const workspace = path.resolve(process.env.DSH_BRIDGE_WORKSPACE || old.defaults?.workspace || legacyDefaults.workspace || path.join(os.homedir(), 'DSH-Workspace'));
fs.mkdirSync(workspace, { recursive: true });
const settings = {
  ...old, protocolVersion: PROTOCOL, runtime, home, workerProfile: 'dsh-bridge-worker',
  token: old.token || randomBytes(32).toString('hex'),
  pipes: { desktop: '\\\\.\\pipe\\dsh-bridge-' + identity + '-desktop', headless: '\\\\.\\pipe\\dsh-bridge-' + identity + '-headless' },
  defaults: { permission: legacyDefaults.permission ?? 'danger-full-access', ...old.defaults, workspace },
};
atomic(settingsPath, settings);

const profileFiles = ['package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];
for (const profile of ['desktop', settings.workerProfile]) {
  for (const file of profileFiles) {
    const from = path.join(home, 'profiles', profile, file);
    if (fs.existsSync(from)) { const to = path.join(backup, profile, file); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); }
  }
}
fs.rmSync(bundleDir, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'bundle'), bundleDir, { recursive: true });

// The hidden worker runs the user's own DSH plugins and providers, with its own
// session store under the bridge state folder and no browser or title calls.
const workerDir = path.join(home, 'profiles', settings.workerProfile);
if (!fs.existsSync(path.join(workerDir, 'package.json'))) {
  fs.mkdirSync(workerDir, { recursive: true });
  const desktopProfile = readJson(path.join(home, 'profiles/desktop/package.json'));
  const dependencies = Object.fromEntries(Object.entries(desktopProfile.dependencies ?? {}).filter(([name]) => name !== LEGACY.package));
  atomic(path.join(workerDir, 'package.json'), { name: 'dsh-profile-' + settings.workerProfile, private: true,
    dependencies: { ...dependencies, [PACKAGE]: link },
    dsh: { profile: { bundles: [...new Set([...(desktopProfile.dsh?.profile?.bundles ?? []).filter(name => name !== LEGACY.package), PACKAGE])] } } });
}
// Rewritten on every setup: the session store follows the state folder.
{
  const quote = value => JSON.stringify(value.replaceAll('\\', '/'));
  fs.writeFileSync(path.join(workerDir, 'cordis.patch.yml'), [
    '- id: web-runtime', '  config:', '    openBrowser: false', '    printUrl: false', '    surfaceContext: false', '    trustedHosts: []',
    '- id: hmr', '  disabled: true', '- id: session-title-llm', '  disabled: true',
    '- id: session-log-deepseek', '  disabled: true', '- id: session-persistence-jsonl', '  config:', '    root: ' + quote(path.join(STATE, 'sessions')),
    '- id: storage-json', '  config:', '    root: ' + quote(path.join(STATE, 'storages')),
    '- id: permission', '  config:', '    presets:', '      read-only:', '        sandbox: read-only', '        approval: ask',
    '      workspace-write:', '        sandbox: workspace-write', '        approval: ask', '      danger-full-access:',
    '        sandbox: danger-full-access', '        approval: never', '    defaultPreset: danger-full-access', '',
  ].join('\n'));
}
const plugin = (profile, ...args) => {
  const result = spawnSync(runtime.executable, ['--expose-internals', runtime.cli, 'plugin', '--profile', profile, ...args], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, shell: false, stdio: 'inherit', timeout: 120000,
  });
  if (result.error || result.status !== 0) throw result.error || new Error(`DSH plugin ${args.join(' ')} exited ${result.status}`);
};
// The plugin command forwards to pnpm; installing does not select the bundle, so enable it explicitly.
function setBundles(profile, edit) {
  const file = path.join(home, 'profiles', profile, 'package.json');
  const manifest = readJson(file);
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  const next = edit(bundles);
  if (JSON.stringify(next) === JSON.stringify(bundles)) return;
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: next } };
  atomic(file, manifest);
}
for (const profile of ['desktop', settings.workerProfile]) {
  plugin(profile, 'add', link, '--ignore-scripts');
  setBundles(profile, bundles => [...new Set([...bundles, PACKAGE])]);
}

if (process.argv.includes('--retire-legacy')) {
  const desktopManifest = readJson(path.join(home, 'profiles/desktop/package.json'));
  if (desktopManifest.dependencies?.[LEGACY.package]) plugin('desktop', 'remove', LEGACY.package);
  setBundles('desktop', bundles => bundles.filter(name => name !== LEGACY.package));
  for (const target of [path.join(home, 'bundles', LEGACY.bundle), path.join(home, 'profiles', LEGACY.profile), legacyState]) fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

// The Node runtime callers import; a checkout can move or change without breaking them.
const target = path.join(STATE, 'runtime', VERSION);
const staging = target + '.staging';
fs.rmSync(staging, { recursive: true, force: true });
for (const entry of ['lib', 'bundle', 'docs', 'package.json', 'README.md']) if (fs.existsSync(path.join(ROOT, entry))) fs.cpSync(path.join(ROOT, entry), path.join(staging, entry), { recursive: true });
fs.rmSync(target, { recursive: true, force: true });
fs.renameSync(staging, target);
const previous = readJson(path.join(STATE, 'install.json'), {});
atomic(path.join(STATE, 'install.json'), { version: VERSION, protocol: PROTOCOL, root: target, installedAt: new Date().toISOString() });
const keep = new Set([VERSION, previous.root && path.basename(previous.root)]);
for (const name of fs.readdirSync(path.join(STATE, 'runtime'))) if (!keep.has(name)) fs.rmSync(path.join(STATE, 'runtime', name), { recursive: true, force: true });

console.log(JSON.stringify({ installed: true, version: VERSION, protocol: PROTOCOL, stateDir: STATE, workerProfile: settings.workerProfile, dsh: runtime.version, backup,
  retiredLegacy: process.argv.includes('--retire-legacy'), next: 'Fully quit and reopen DSH Desktop so it loads the bridge' }));
